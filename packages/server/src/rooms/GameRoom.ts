import { Room } from 'colyseus';
import type { Client } from 'colyseus';
import { GRID_WIDTH, SPAWN_POINTS, TICK_MS, createBot, createGame, createRng } from '@bomberman/shared';
import type { Bot, Game } from '@bomberman/shared';
import { registerRoomCode, releaseRoomCode } from '../roomCodes';
import { InputBuffer } from './inputBuffer';
import { PlayerSchema, RoomState, copySimToSchema } from './schema';

const MAX_PLAYERS = 4;
const MAX_NICKNAME_LENGTH = 12;
const POST_GAME_LINGER_MS = 30_000;

/** FNV-1a hash of a string, folded to a uint32 — per-room deterministic seed. */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

interface JoinOptions {
  nickname?: unknown;
}

export class GameRoom extends Room<RoomState> {
  maxClients = MAX_PLAYERS;

  /** sessionId -> playerId slot (humans only), in join order for host succession. */
  private readonly slots = new Map<string, string>();
  private readonly inputBuffer = new InputBuffer();
  private sim: Game | null = null;
  private bots: { id: string; bot: Bot }[] = [];

  onCreate(): void {
    this.state = new RoomState();
    this.state.code = registerRoomCode(this.roomId);
    this.setMetadata({ code: this.state.code });

    this.onMessage('input', (client, message: unknown) => {
      if (this.state.phase !== 'playing') return;
      const playerId = this.slots.get(client.sessionId);
      if (playerId) this.inputBuffer.set(playerId, message);
    });

    this.onMessage('toggleBots', (client) => {
      if (this.state.phase !== 'lobby' || !this.isHost(client)) return;
      this.state.fillBots = !this.state.fillBots;
    });

    this.onMessage('start', (client) => {
      if (this.state.phase !== 'lobby') return;
      if (!this.isHost(client)) return;
      const humans = this.slots.size;
      const participants = this.state.fillBots ? MAX_PLAYERS : humans;
      if (participants < 2) {
        client.send('error', { message: 'Need at least 2 players to start' });
        return;
      }
      this.startGame();
    });
  }

  onJoin(client: Client, options?: JoinOptions): void {
    const playerId = this.freeSlot();
    this.slots.set(client.sessionId, playerId);

    const slotIndex = Number(playerId.slice(1));
    const player = new PlayerSchema();
    player.id = playerId;
    player.sessionId = client.sessionId;
    player.nickname = sanitizeNickname(options?.nickname, slotIndex);
    player.x = SPAWN_POINTS[slotIndex].col;
    player.y = SPAWN_POINTS[slotIndex].row;
    this.state.players.set(playerId, player);

    if (this.state.hostId === '') this.state.hostId = playerId;
  }

  onLeave(client: Client): void {
    const playerId = this.slots.get(client.sessionId);
    if (!playerId) return;
    this.slots.delete(client.sessionId);
    this.inputBuffer.remove(playerId);

    if (this.state.phase === 'lobby') {
      this.state.players.delete(playerId);
      if (this.state.hostId === playerId) {
        const nextHost = this.slots.values().next();
        this.state.hostId = nextHost.done ? '' : nextHost.value;
      }
      return;
    }

    // Mid-game / post-game: the character idles (inputs null). If no humans
    // remain there is nobody left to serve — tear the room down.
    if (this.slots.size === 0) void this.disconnect();
  }

  onDispose(): void {
    releaseRoomCode(this.state.code);
  }

  // --- game lifecycle ---

  private startGame(): void {
    void this.lock();
    const seed = hashSeed(`${this.state.code}:${Date.now()}`);

    // Humans keep their slots; bots fill the remaining ones when enabled.
    const humanIds = new Set(this.slots.values());
    const botIds: string[] = [];
    if (this.state.fillBots) {
      for (let i = 0; i < MAX_PLAYERS; i++) {
        const id = `p${i}`;
        if (!humanIds.has(id)) botIds.push(id);
      }
    }
    const playerIds = [...humanIds, ...botIds].sort();

    for (const [index, id] of botIds.entries()) {
      const slotIndex = Number(id.slice(1));
      const bot = new PlayerSchema();
      bot.id = id;
      bot.nickname = `Bot ${index + 1}`;
      bot.isBot = true;
      bot.x = SPAWN_POINTS[slotIndex].col;
      bot.y = SPAWN_POINTS[slotIndex].row;
      this.state.players.set(id, bot);
    }

    this.sim = createGame({ seed, playerIds });
    this.bots = botIds.map((id, i) => ({ id, bot: createBot(id, createRng(seed + i)) }));

    // Spawn corners are assigned by index in playerIds, which can differ from
    // the slot number when a lobby slot was vacated; mirror the sim's truth.
    copySimToSchema(this.sim.state, this.state);

    this.state.seed = seed;
    this.state.phase = 'playing';
    this.setSimulationInterval(() => this.simTick(), TICK_MS);
  }

  private simTick(): void {
    if (!this.sim) return;
    const inputs = this.inputBuffer.consume();
    for (const { id, bot } of this.bots) {
      inputs.set(id, bot.computeInput(this.sim.state));
    }

    const events = this.sim.tick(inputs);
    copySimToSchema(this.sim.state, this.state);

    for (const event of events) {
      if (event.type === 'blockDestroyed') {
        this.state.destroyedBlocks.push(event.row * GRID_WIDTH + event.col);
      } else if (event.type === 'gameEnded') {
        this.finishGame(event.winnerId);
      }
    }
  }

  private finishGame(winnerId: string | null): void {
    this.setSimulationInterval(undefined);
    this.state.phase = 'finished';
    this.state.winnerId = winnerId ?? '';
    // Let players linger on the results screen, then close up shop.
    this.clock.setTimeout(() => void this.disconnect(), POST_GAME_LINGER_MS);
  }

  // --- helpers ---

  private isHost(client: Client): boolean {
    return this.slots.get(client.sessionId) === this.state.hostId;
  }

  private freeSlot(): string {
    const taken = new Set(this.slots.values());
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!taken.has(`p${i}`)) return `p${i}`;
    }
    throw new Error('room is full');
  }
}

function sanitizeNickname(raw: unknown, slotIndex: number): string {
  const trimmed = typeof raw === 'string' ? raw.trim().slice(0, MAX_NICKNAME_LENGTH) : '';
  return trimmed !== '' ? trimmed : `Player ${slotIndex + 1}`;
}
