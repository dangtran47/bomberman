import { Room } from 'colyseus';
import type { Client } from 'colyseus';
import type { Delayed } from '@colyseus/core';
import { $changes } from '@colyseus/schema';
import {
  BASE_BLAST_RADIUS,
  BASE_BOMB_COUNT,
  BASE_SPEED,
  CHARACTER_COUNT,
  GRID_WIDTH,
  SPAWN_POINTS,
  TICK_MS,
  computePlacements,
  createBot,
  createGame,
  createRng,
  getMapDef,
} from '@bomberman/shared';
import type { Bot, Game, GameState } from '@bomberman/shared';
import { registerRoomCode, releaseRoomCode } from '../roomCodes';
import { InputQueue } from './inputQueue';
import { PlayerSchema, RoomState, copySimToSchema } from './schema';
import type { Phase } from './schema';

const MAX_PLAYERS = 4;
const MAX_NICKNAME_LENGTH = 12;
const FINISHED_IDLE_MS = 180_000;

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
  private readonly inputQueue = new InputQueue();
  private sim: Game | null = null;
  private bots: { id: string; bot: Bot }[] = [];
  private teardownTimer: Delayed | null = null;

  // Perf probe for the "lag climbs across consecutive matches in one room"
  // report: per-match tick timings plus heap / schema-encoder ref growth,
  // logged by logMatchPerf() when each match finishes.
  private matchNumber = 0;
  private tickCount = 0;
  private tickTotalMs = 0;
  private tickMaxMs = 0;

  onCreate(): void {
    this.state = new RoomState();
    this.state.code = registerRoomCode(this.roomId);
    this.setMetadata({ code: this.state.code });

    this.onMessage('input', (client, message: unknown) => {
      if (this.state.phase !== 'playing') return;
      const playerId = this.slots.get(client.sessionId);
      if (playerId) this.inputQueue.push(playerId, message);
    });

    // Ping echo for client-side RTT measurement; replies only to the sender in
    // any phase. The payload is the client's timestamp, bounced back untouched.
    this.onMessage('ping', (client, t: unknown) => {
      if (typeof t === 'number') client.send('pong', t);
    });

    this.onMessage('toggleBots', (client) => {
      if (this.state.phase !== 'lobby' || !this.isHost(client)) return;
      this.state.fillBots = !this.state.fillBots;
    });

    this.onMessage('setMap', (client, message: unknown) => {
      if (this.state.phase !== 'lobby' || !this.isHost(client)) return;
      const id = (message as { mapId?: unknown })?.mapId;
      if (typeof id !== 'string') return;
      // '' is the classic procedural map; anything else must be a known map.
      if (id !== '' && !getMapDef(id)) return;
      this.state.mapId = id;
    });

    this.onMessage('pickCharacter', (client, message: unknown) => {
      if (this.state.phase !== 'lobby') return;
      const playerId = this.slots.get(client.sessionId);
      if (!playerId) return;
      const c = (message as { character?: unknown })?.character;
      if (!Number.isInteger(c) || (c as number) < 0 || (c as number) >= CHARACTER_COUNT) return;
      for (const [id, p] of this.state.players) {
        if (id !== playerId && p.character === c) {
          client.send('error', { message: 'Character already taken' });
          return;
        }
      }
      const me = this.state.players.get(playerId);
      if (me) me.character = c as number;
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
      // Defensive: pickCharacter enforces uniqueness, but never start on a dupe.
      const seen = new Set<number>();
      for (const p of this.state.players.values()) {
        if (p.isBot) continue;
        if (seen.has(p.character)) {
          client.send('error', { message: 'Two players have the same character' });
          return;
        }
        seen.add(p.character);
      }
      this.startGame();
    });

    this.onMessage('backToLobby', (client) => {
      if (this.state.phase !== 'finished' || !this.isHost(client)) return;
      this.returnToLobby();
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
    player.character = this.freeCharacter(); // before insert: don't count self
    this.state.players.set(playerId, player);

    if (this.state.hostId === '') this.state.hostId = playerId;
  }

  onLeave(client: Client): void {
    const playerId = this.slots.get(client.sessionId);
    if (!playerId) return;
    this.slots.delete(client.sessionId);
    this.inputQueue.remove(playerId);

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
    if (this.slots.size === 0) {
      void this.disconnect();
      return;
    }

    // Host succession must run in every phase: backToLobby is host-gated, so a
    // departed host would otherwise deadlock the results screen for everyone.
    if (this.state.hostId === playerId) {
      this.state.hostId = this.slots.values().next().value!;
    }
  }

  onDispose(): void {
    releaseRoomCode(this.state.code);
  }

  // --- game lifecycle ---

  private startGame(): void {
    void this.lock();
    this.matchNumber++;
    this.tickCount = 0;
    this.tickTotalMs = 0;
    this.tickMaxMs = 0;
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
      bot.character = this.freeCharacter(); // before insert so each bot picks distinctly
      this.state.players.set(id, bot);
    }

    // Fresh match: clear any lingering placements from a prior round.
    for (const p of this.state.players.values()) p.placement = 0;

    this.sim = createGame({ seed, playerIds, mapId: this.state.mapId });
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
    const tickStart = performance.now();
    const inputs = this.inputQueue.consume();
    for (const { id, bot } of this.bots) {
      inputs.set(id, bot.computeInput(this.sim.state));
    }

    const events = this.sim.tick(inputs);
    copySimToSchema(this.sim.state, this.state);

    // Ack the last input applied per human slot; clients reconcile against it.
    for (const playerId of this.slots.values()) {
      const ps = this.state.players.get(playerId);
      if (ps) ps.lastInputSeq = this.inputQueue.acked(playerId);
    }

    // Accumulate before the event sweep so the match's final tick is counted
    // (finishGame below reads these to log the match summary).
    const tickMs = performance.now() - tickStart;
    this.tickCount++;
    this.tickTotalMs += tickMs;
    if (tickMs > this.tickMaxMs) this.tickMaxMs = tickMs;

    for (const event of events) {
      if (event.type === 'blockDestroyed') {
        this.state.destroyedBlocks.push(event.row * GRID_WIDTH + event.col);
      } else if (event.type === 'arenaShrink') {
        this.state.arenaShrunk.push(event.row * GRID_WIDTH + event.col);
      } else if (event.type === 'gameEnded') {
        this.finishGame(event.winnerId);
      }
    }
  }

  /**
   * Dev-only (SIM_DEBUG_STATE=1): the authoritative sim state, served raw over
   * http for the local multiplayer sim harness. The harness runs the bot
   * brains in its own process against this truth — no patch delay, no
   * client-side reconstruction — while still sending their inputs through the
   * real browser clients, which is the path the sim exists to exercise.
   */
  debugSimState(): { phase: Phase; state: GameState } | null {
    if (!this.sim) return null;
    return { phase: this.state.phase, state: this.sim.state };
  }

  private finishGame(winnerId: string | null): void {
    this.setSimulationInterval(undefined);
    if (this.sim) {
      const placements = computePlacements(this.sim.state.players);
      for (const { id, placement } of placements) {
        const ps = this.state.players.get(id);
        if (ps) ps.placement = placement;
      }
    }
    if (winnerId) {
      const w = this.state.players.get(winnerId);
      if (w) w.wins++;
    }
    this.state.phase = 'finished';
    this.state.winnerId = winnerId ?? '';
    this.logMatchPerf();
    // Idle out the finished room only if nobody heads back to the lobby.
    this.teardownTimer = this.clock.setTimeout(() => void this.disconnect(), FINISHED_IDLE_MS);
  }

  /**
   * One line per finished match. If the cross-match leak hypothesis holds,
   * `refsTotal` (schema encoder refCount entries — never deleted for the life
   * of the room) climbs by tens of thousands per match while `refsLive` stays
   * flat, and heap/avgTick drift upward with it. Flat numbers refute it.
   */
  private logMatchPerf(): void {
    let refs = 'refsTotal=? refsLive=?';
    try {
      // Encoder internals (undocumented): state's ChangeTree -> shared Root.
      const root = (this.state as unknown as {
        [$changes]?: { root?: { refCount: object; changeTrees: object } };
      })[$changes]?.root;
      if (root) {
        refs = `refsTotal=${Object.keys(root.refCount).length} refsLive=${Object.keys(root.changeTrees).length}`;
      }
    } catch {
      /* introspection only — never let it break a match */
    }
    const heapMb = (process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1);
    const avgTick = this.tickCount > 0 ? (this.tickTotalMs / this.tickCount).toFixed(3) : '0';
    console.log(
      `[perf] room=${this.roomId} match=${this.matchNumber} ticks=${this.tickCount} ` +
        `avgTickMs=${avgTick} maxTickMs=${this.tickMaxMs.toFixed(1)} heapMB=${heapMb} ${refs}`,
    );
  }

  private returnToLobby(): void {
    this.teardownTimer?.clear();
    this.teardownTimer = null;
    this.sim = null;
    this.bots = [];
    this.inputQueue.clear();

    const humanIds = new Set(this.slots.values());
    for (const [id, ps] of [...this.state.players]) {
      if (ps.isBot || !humanIds.has(id)) this.state.players.delete(id);
    }
    // Defensive: onLeave reassigns the host in every phase, so this should
    // never fire — but a lobby must not end up hostless.
    if (!this.state.players.has(this.state.hostId)) {
      const next = this.slots.values().next();
      this.state.hostId = next.done ? '' : next.value;
    }
    for (const [id, ps] of this.state.players) {
      const slotIndex = Number(id.slice(1));
      ps.x = SPAWN_POINTS[slotIndex].col;
      ps.y = SPAWN_POINTS[slotIndex].row;
      ps.alive = true;
      ps.bombCount = BASE_BOMB_COUNT;
      ps.blastRadius = BASE_BLAST_RADIUS;
      ps.speed = BASE_SPEED;
      ps.activeBombs = 0;
      ps.kickTicks = 0;
      ps.gunAmmo = 0;
      ps.hammerUses = 0;
      ps.mineAmmo = 0;
      ps.frozenTicks = 0;
      ps.facing = 'down';
      // The queue was cleared, so acks restart at 0: never publish a stale seq
      // from the last match to a client that restarts its sequence at 1.
      ps.lastInputSeq = 0;
      // keep character, wins, placement (placement shows last result until next match)
    }
    this.state.bombs.clear();
    this.state.mines.clear();
    this.state.explosions.clear();
    this.state.powerups.clear();
    this.state.destroyedBlocks.clear();
    this.state.arenaShrunk.clear();
    this.state.winnerId = '';
    this.state.tick = 0;
    this.state.seed = 0;
    this.state.phase = 'lobby';
    void this.unlock();
  }

  // --- helpers ---

  private isHost(client: Client): boolean {
    return this.slots.get(client.sessionId) === this.state.hostId;
  }

  private freeCharacter(): number {
    const taken = new Set<number>();
    for (const p of this.state.players.values()) taken.add(p.character);
    for (let i = 0; i < CHARACTER_COUNT; i++) if (!taken.has(i)) return i;
    return 0; // all taken (impossible with CHARACTER_COUNT >= MAX_PLAYERS)
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
  const cleaned =
    typeof raw === 'string' ? raw.replace(/[^\x20-\x7E]/g, '').trim() : '';
  const trimmed = cleaned.slice(0, MAX_NICKNAME_LENGTH).trim();
  return trimmed !== '' ? trimmed : `Player ${slotIndex + 1}`;
}
