import Phaser from 'phaser';
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  TICK_MS,
  TileType,
  createBot,
  createGame,
  createRng,
  generateMap,
} from '@bomberman/shared';
import type { Bot, Direction, Game, GameEvent, PlayerInput, PowerupType } from '@bomberman/shared';
import type { GameRoomConnection, NetRoomState } from '../net';
import { TEX, TILE_SIZE } from '../textures';

export type GameSceneData =
  | { mode: 'offline'; seed: number }
  | { mode: 'online'; connection: GameRoomConnection };

export const HUD_HEIGHT = 40;

const HUMAN_ID = 'p0';
const PLAYER_IDS = ['p0', 'p1', 'p2', 'p3'];
/** Max sim steps per frame; if further behind, the backlog is dropped. */
const MAX_STEPS_PER_FRAME = 5;
/** Exponential smoothing factor for online sprite positions (per frame). */
const ONLINE_LERP = 0.35;
/** Online: resend the current input this often even without changes. */
const KEEPALIVE_MS = 100;

const DEPTH = {
  floor: 0,
  block: 1,
  powerup: 2,
  bomb: 3,
  explosion: 4,
  player: 5,
  hud: 10,
  overlay: 20,
} as const;

/** Key codes mapped to a direction (arrows + WASD). */
const DIRECTION_KEYS: [key: string, dir: Direction][] = [
  ['UP', 'up'],
  ['W', 'up'],
  ['DOWN', 'down'],
  ['S', 'down'],
  ['LEFT', 'left'],
  ['A', 'left'],
  ['RIGHT', 'right'],
  ['D', 'right'],
];

const cellKey = (col: number, row: number): string => `${col},${row}`;
const toX = (col: number): number => col * TILE_SIZE + TILE_SIZE / 2;
const toY = (row: number): number => HUD_HEIGHT + row * TILE_SIZE + TILE_SIZE / 2;

/**
 * Plain snapshot shape the render path consumes each tick/frame. The offline
 * sim's GameState satisfies it structurally; online mode adapts the synced
 * Colyseus schema into it.
 */
export interface RenderPlayer {
  id: string;
  x: number;
  y: number;
  alive: boolean;
  speed: number;
  bombCount: number;
  blastRadius: number;
  activeBombs: number;
}

export interface RenderState {
  grid: TileType[][];
  players: RenderPlayer[];
  bombs: { id: number; col: number; row: number }[];
  explosions: { col: number; row: number }[];
  powerups: { col: number; row: number; type: PowerupType }[];
}

/**
 * One match. Offline: local sim (p0) vs 3 bots on a fixed-tick accumulator.
 * Online: authoritative server state rendered with interpolation only (no
 * client-side prediction); inputs are sent as messages.
 */
export class GameScene extends Phaser.Scene {
  private mode: 'offline' | 'online' = 'offline';
  private myId = HUMAN_ID;

  // offline
  private sim: Game | null = null; // named to avoid Phaser.Scene#game
  private bots: Bot[] = [];
  private accumulator = 0;
  /** Set on Space press (edge-triggered), consumed by the next sim tick. */
  private pendingBomb = false;

  // online
  private connection: GameRoomConnection | null = null;
  private grid: TileType[][] | null = null;
  private appliedDestroyed = 0;
  private lastSentDirection: Direction | null = null;
  private keepaliveMs = 0;
  private roomClosed = false;
  private onRoomLeave = (): void => {
    this.roomClosed = true;
    if (!this.gameOver) this.scene.start('Menu', { error: 'Disconnected from server' });
  };

  private gameOver = false;

  private directionKeys: [Phaser.Input.Keyboard.Key, Direction][] = [];
  private spaceKey!: Phaser.Input.Keyboard.Key;

  private playerSprites = new Map<string, Phaser.GameObjects.Image>();
  private softBlockSprites = new Map<string, Phaser.GameObjects.Image>();
  private bombSprites = new Map<number, Phaser.GameObjects.Image>();
  private explosionSprites = new Map<string, Phaser.GameObjects.Image>();
  private powerupSprites = new Map<string, { sprite: Phaser.GameObjects.Image; texture: string }>();

  private hudText!: Phaser.GameObjects.Text;

  constructor() {
    super('Game');
  }

  create(data: GameSceneData): void {
    this.mode = data.mode;
    this.accumulator = 0;
    this.gameOver = false;
    this.pendingBomb = false;
    this.appliedDestroyed = 0;
    this.lastSentDirection = null;
    this.keepaliveMs = 0;
    this.roomClosed = false;
    this.playerSprites.clear();
    this.softBlockSprites.clear();
    this.bombSprites.clear();
    this.explosionSprites.clear();
    this.powerupSprites.clear();

    let initial: RenderState;
    if (data.mode === 'offline') {
      this.myId = HUMAN_ID;
      this.connection = null;
      this.grid = null;
      this.sim = createGame({ seed: data.seed, playerIds: PLAYER_IDS });
      this.bots = PLAYER_IDS.slice(1).map((id, i) => createBot(id, createRng(data.seed + i + 1)));
      initial = this.sim.state;
    } else {
      this.connection = data.connection;
      this.myId = data.connection.playerId;
      this.sim = null;
      this.bots = [];
      this.grid = generateMap(data.connection.room.state.seed);
      data.connection.room.onLeave(this.onRoomLeave);
      this.events.once('shutdown', () => {
        data.connection.room.onLeave.remove(this.onRoomLeave);
      });
      initial = this.renderStateFromRoom();
    }

    this.setupInput();
    this.drawStaticGrid(initial);
    this.createPlayerSprites(initial);
    this.createHud();
    this.reconcile(initial);
    this.updateHud(initial);
    this.positionPlayers(initial, 1);
  }

  update(_time: number, delta: number): void {
    if (this.gameOver) return;
    if (this.mode === 'offline') this.updateOffline(delta);
    else this.updateOnline(delta);
  }

  // --- offline: local simulation ---

  private updateOffline(delta: number): void {
    if (Phaser.Input.Keyboard.JustDown(this.spaceKey)) this.pendingBomb = true;

    this.accumulator += delta;
    let steps = 0;
    while (this.accumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= TICK_MS;
      this.stepSim();
      steps++;
    }
    // Fell too far behind (tab hidden, etc.): drop the backlog instead of spiraling.
    if (this.accumulator >= TICK_MS) this.accumulator = 0;

    this.positionPlayers(this.sim!.state, 1);
  }

  private stepSim(): void {
    const state = this.sim!.state;
    const inputs: Record<string, PlayerInput> = {
      [HUMAN_ID]: { direction: this.currentDirection(), placeBomb: this.pendingBomb },
    };
    this.pendingBomb = false;
    for (const [i, bot] of this.bots.entries()) {
      inputs[PLAYER_IDS[i + 1]] = bot.computeInput(state);
    }

    const events = this.sim!.tick(inputs);
    this.reconcile(state);
    this.updateHud(state);
    for (const event of events) this.handleEvent(event);
  }

  private handleEvent(event: GameEvent): void {
    if (event.type === 'gameEnded') this.showGameOver(event.winnerId);
  }

  // --- online: render server state, send inputs ---

  private updateOnline(delta: number): void {
    const room = this.connection!.room;

    // Input: send on change, on bomb press, and periodically as keepalive.
    const direction = this.currentDirection();
    const bombPressed = Phaser.Input.Keyboard.JustDown(this.spaceKey);
    this.keepaliveMs += delta;
    if (
      !this.roomClosed &&
      (direction !== this.lastSentDirection || bombPressed || this.keepaliveMs >= KEEPALIVE_MS)
    ) {
      room.send('input', { direction, placeBomb: bombPressed });
      this.lastSentDirection = direction;
      this.keepaliveMs = 0;
    }

    const state = this.renderStateFromRoom();
    this.reconcile(state);
    this.updateHud(state);
    this.positionPlayers(state, ONLINE_LERP);

    if (room.state.phase === 'finished') {
      this.showGameOver(room.state.winnerId === '' ? null : room.state.winnerId);
    }
  }

  /** Adapts the synced schema into the plain RenderState the render path eats. */
  private renderStateFromRoom(): RenderState {
    const s: NetRoomState = this.connection!.room.state;
    this.applyDestroyedBlocks(s);

    const players: RenderPlayer[] = [];
    s.players.forEach((p) =>
      players.push({
        id: p.id,
        x: p.x,
        y: p.y,
        alive: p.alive,
        speed: p.speed,
        bombCount: p.bombCount,
        blastRadius: p.blastRadius,
        activeBombs: p.activeBombs,
      }),
    );
    players.sort((a, b) => a.id.localeCompare(b.id));

    const bombs: RenderState['bombs'] = [];
    s.bombs.forEach((b) => bombs.push({ id: b.id, col: b.col, row: b.row }));
    const explosions: RenderState['explosions'] = [];
    s.explosions.forEach((e) => explosions.push({ col: e.col, row: e.row }));
    const powerups: RenderState['powerups'] = [];
    s.powerups.forEach((p) => powerups.push({ col: p.col, row: p.row, type: p.type }));

    return { grid: this.grid!, players, bombs, explosions, powerups };
  }

  /** Applies newly appended destroyedBlocks indices to the locally generated grid. */
  private applyDestroyedBlocks(s: NetRoomState): void {
    const applied = this.appliedDestroyed;
    s.destroyedBlocks.forEach((index, i) => {
      if (i < applied) return;
      const row = Math.floor(index / GRID_WIDTH);
      const col = index % GRID_WIDTH;
      this.grid![row][col] = TileType.Floor;
    });
    this.appliedDestroyed = s.destroyedBlocks.length;
  }

  // --- input ---

  private setupInput(): void {
    const keyboard = this.input.keyboard!;
    this.directionKeys = DIRECTION_KEYS.map(([key, dir]) => [keyboard.addKey(key), dir]);
    this.spaceKey = keyboard.addKey('SPACE');
  }

  /** Last-pressed-wins: among held direction keys, the most recent one. */
  private currentDirection(): Direction | null {
    let latest: Direction | null = null;
    let latestTime = -1;
    for (const [key, dir] of this.directionKeys) {
      if (key.isDown && key.timeDown > latestTime) {
        latestTime = key.timeDown;
        latest = dir;
      }
    }
    return latest;
  }

  // --- rendering ---

  private drawStaticGrid(state: RenderState): void {
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        this.add.image(toX(col), toY(row), TEX.floor).setDepth(DEPTH.floor);
        if (state.grid[row][col] === TileType.HardBlock) {
          this.add.image(toX(col), toY(row), TEX.hardBlock).setDepth(DEPTH.block);
        }
      }
    }
  }

  private createPlayerSprites(state: RenderState): void {
    for (const player of state.players) {
      // Slot number (p0-p3) picks the color, consistent across both modes.
      const slot = Number(player.id.slice(1)) || 0;
      const sprite = this.add
        .image(toX(player.x), toY(player.y), TEX.players[slot % TEX.players.length])
        .setDepth(DEPTH.player);
      this.playerSprites.set(player.id, sprite);
    }
  }

  /** Moves player sprites; lerp=1 snaps, lower values smooth (online). */
  private positionPlayers(state: Pick<RenderState, 'players'>, lerp: number): void {
    for (const player of state.players) {
      const sprite = this.playerSprites.get(player.id);
      if (!sprite) continue;
      const tx = toX(player.x);
      const ty = toY(player.y);
      sprite.setPosition(sprite.x + (tx - sprite.x) * lerp, sprite.y + (ty - sprite.y) * lerp);
      sprite.setAlpha(player.alive ? 1 : 0.3); // dead players linger as ghosts
    }
  }

  /**
   * Reconciles dynamic sprites against the snapshot (15x13 grid — cheap).
   * State-driven rather than event-driven so the same path serves both the
   * local sim and server snapshots.
   */
  private reconcile(state: RenderState): void {
    this.reconcileSoftBlocks(state);
    this.reconcileBombs(state);
    this.reconcileExplosions(state);
    this.reconcilePowerups(state);
  }

  private reconcileSoftBlocks(state: RenderState): void {
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        const key = cellKey(col, row);
        const isSoft = state.grid[row][col] === TileType.SoftBlock;
        const sprite = this.softBlockSprites.get(key);
        if (isSoft && !sprite) {
          this.softBlockSprites.set(
            key,
            this.add.image(toX(col), toY(row), TEX.softBlock).setDepth(DEPTH.block),
          );
        } else if (!isSoft && sprite) {
          sprite.destroy();
          this.softBlockSprites.delete(key);
        }
      }
    }
  }

  private reconcileBombs(state: RenderState): void {
    const liveIds = new Set(state.bombs.map((b) => b.id));
    for (const [id, sprite] of this.bombSprites) {
      if (!liveIds.has(id)) {
        this.tweens.killTweensOf(sprite);
        sprite.destroy();
        this.bombSprites.delete(id);
      }
    }
    for (const bomb of state.bombs) {
      if (this.bombSprites.has(bomb.id)) continue;
      const sprite = this.add.image(toX(bomb.col), toY(bomb.row), TEX.bomb).setDepth(DEPTH.bomb);
      this.tweens.add({
        targets: sprite,
        scale: { from: 1, to: 1.15 },
        duration: 300,
        yoyo: true,
        repeat: -1,
      });
      this.bombSprites.set(bomb.id, sprite);
    }
  }

  private reconcileExplosions(state: RenderState): void {
    const live = new Set(state.explosions.map((c) => cellKey(c.col, c.row)));
    for (const [key, sprite] of this.explosionSprites) {
      if (!live.has(key)) {
        sprite.destroy();
        this.explosionSprites.delete(key);
      }
    }
    for (const cell of state.explosions) {
      const key = cellKey(cell.col, cell.row);
      if (this.explosionSprites.has(key)) continue;
      this.explosionSprites.set(
        key,
        this.add.image(toX(cell.col), toY(cell.row), TEX.explosion).setDepth(DEPTH.explosion),
      );
    }
  }

  private reconcilePowerups(state: RenderState): void {
    const live = new Map(state.powerups.map((p) => [cellKey(p.col, p.row), TEX.powerup[p.type]]));
    for (const [key, entry] of this.powerupSprites) {
      if (live.get(key) !== entry.texture) {
        entry.sprite.destroy();
        this.powerupSprites.delete(key);
      }
    }
    for (const [key, texture] of live) {
      if (this.powerupSprites.has(key)) continue;
      const [col, row] = key.split(',').map(Number);
      this.powerupSprites.set(key, {
        sprite: this.add.image(toX(col), toY(row), texture).setDepth(DEPTH.powerup),
        texture,
      });
    }
  }

  // --- HUD ---

  private createHud(): void {
    this.add
      .rectangle(0, 0, this.scale.width, HUD_HEIGHT, 0x111111)
      .setOrigin(0, 0)
      .setDepth(DEPTH.hud);
    this.hudText = this.add
      .text(12, HUD_HEIGHT / 2, '', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: '#ffffff',
      })
      .setOrigin(0, 0.5)
      .setDepth(DEPTH.hud);
  }

  private updateHud(state: RenderState): void {
    const me = state.players.find((p) => p.id === this.myId);
    const aliveCount = state.players.filter((p) => p.alive).length;
    if (!me) return;
    this.hudText.setText(
      `Bombs: ${me.bombCount}   Blast: ${me.blastRadius}   Speed: ${me.speed.toFixed(1)}   Alive: ${aliveCount}`,
    );
  }

  // --- game over ---

  private showGameOver(winnerId: string | null): void {
    this.gameOver = true;
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0.6)
      .setOrigin(0, 0)
      .setDepth(DEPTH.overlay);

    let message: string;
    if (winnerId === this.myId) message = 'You win!';
    else if (winnerId === null) message = 'Draw';
    else if (this.mode === 'online') {
      const nickname = this.connection!.room.state.players.get(winnerId)?.nickname;
      message = `${nickname ?? winnerId} wins!`;
    } else message = 'You lose';

    this.add
      .text(cx, cy - 40, message, {
        fontFamily: 'monospace',
        fontSize: '48px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.overlay);

    const back = this.add
      .text(cx, cy + 40, 'Back to menu', {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: '#ffe040',
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.overlay)
      .setInteractive({ useHandCursor: true });
    back.on('pointerover', () => back.setColor('#ffffff'));
    back.on('pointerout', () => back.setColor('#ffe040'));
    back.on('pointerdown', () => {
      if (this.mode === 'online' && !this.roomClosed) void this.connection!.room.leave();
      this.scene.start('Menu');
    });
  }
}
