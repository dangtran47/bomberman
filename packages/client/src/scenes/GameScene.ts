import Phaser from 'phaser';
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  SUDDEN_DEATH_START_TICKS,
  TICK_MS,
  TICK_RATE,
  TileType,
  createBot,
  createGame,
  createRng,
  generateMap,
} from '@bomberman/shared';
import type { Bot, Direction, Game, GameEvent, PlayerInput, PowerupType } from '@bomberman/shared';
import { audio } from '../audio';
import type { GameRoomConnection, NetRoomState } from '../net';
import { SPRITE_SIZE, TEX, TILE_SIZE, addImage } from '../textures';
import type { TexRef } from '../textures';

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
/** Online: measure round-trip time by echoing a ping this often. */
const PING_INTERVAL_MS = 2000;

const DEPTH = {
  background: -1,
  floor: 0,
  block: 1,
  powerup: 2,
  bomb: 3,
  explosion: 4,
  player: 5,
  hud: 10,
  overlay: 20,
} as const;

/**
 * Players are depth-sorted by grid y so lower players draw over higher ones
 * (their heads poke into the tile above). Scaled down to stay below DEPTH.hud.
 */
const PLAYER_DEPTH_PER_ROW = 0.1;
/** Bomb pulse tween grows the sprite to this multiple of its base scale. */
const BOMB_PULSE = 1.15;
/** Max random tilt (radians) applied to each explosion pom, visual only. */
const EXPLOSION_MAX_TILT = 0.3;
/** Powerup bob tween amplitude in pixels. */
const POWERUP_BOB = 4;

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
  tick: number;
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
  private appliedShrunk = 0;
  private lastSentDirection: Direction | null = null;
  private keepaliveMs = 0;
  /** Latest measured round-trip time (ms); null until the first pong arrives. */
  private pingMs: number | null = null;
  /** Accumulates toward the next ping send (online only). */
  private pingTimerMs = 0;
  private roomClosed = false;
  private onRoomLeave = (): void => {
    this.roomClosed = true;
    if (!this.gameOver) this.scene.start('Menu', { error: 'Disconnected from server' });
  };

  private gameOver = false;
  /** Sudden-death alarm fired (once per match, when the countdown hits 10s). */
  private suddenDeathWarned = false;
  /** Online: last-seen alive flags, to derive death sounds from state diffs. */
  private prevAlive = new Map<string, boolean>();

  private directionKeys: [Phaser.Input.Keyboard.Key, Direction][] = [];
  private spaceKey!: Phaser.Input.Keyboard.Key;

  private playerSprites = new Map<string, Phaser.GameObjects.Image>();
  private softBlockSprites = new Map<string, Phaser.GameObjects.Image>();
  private bombSprites = new Map<number, { sprite: Phaser.GameObjects.Image; col: number; row: number }>();
  private explosionSprites = new Map<string, Phaser.GameObjects.Image>();
  private powerupSprites = new Map<string, { sprite: Phaser.GameObjects.Image; ref: TexRef }>();
  /** Cells whose bomb vanished this reconcile pass — the explosion's origin. */
  private explosionCenters = new Set<string>();

  private hudText!: Phaser.GameObjects.Text;
  private suddenDeathText!: Phaser.GameObjects.Text;

  constructor() {
    super('Game');
  }

  create(data: GameSceneData): void {
    this.mode = data.mode;
    this.accumulator = 0;
    this.gameOver = false;
    this.pendingBomb = false;
    this.appliedDestroyed = 0;
    this.appliedShrunk = 0;
    this.lastSentDirection = null;
    this.keepaliveMs = 0;
    this.pingMs = null;
    this.pingTimerMs = 0;
    this.roomClosed = false;
    this.suddenDeathWarned = false;
    this.prevAlive.clear();
    this.playerSprites.clear();
    this.softBlockSprites.clear();
    this.bombSprites.clear();
    this.explosionSprites.clear();
    this.powerupSprites.clear();
    this.explosionCenters.clear();

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
      data.connection.room.onMessage('pong', (t: number) => {
        this.pingMs = Math.max(0, Math.round(performance.now() - t));
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
    switch (event.type) {
      case 'bombPlaced':
        audio.bombPlace();
        break;
      case 'bombExploded':
        audio.explosion();
        break;
      case 'powerupCollected':
        audio.powerup();
        break;
      case 'playerDied':
        audio.death();
        break;
      case 'arenaShrink':
        this.showShrunkTile(event.col, event.row);
        break;
      case 'gameEnded':
        this.showGameOver(event.winnerId);
        break;
    }
  }

  // --- online: render server state, send inputs ---

  private updateOnline(delta: number): void {
    const room = this.connection!.room;

    // Ping: fire immediately on the first online tick, then every interval.
    if (!this.roomClosed && (this.pingTimerMs <= 0 || this.pingTimerMs >= PING_INTERVAL_MS)) {
      room.send('ping', performance.now());
      this.pingTimerMs = 0;
    }
    this.pingTimerMs += delta;

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
    this.trackOnlineDeaths(state);
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
    this.applyArenaShrunk(s);

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

    return { tick: s.tick, grid: this.grid!, players, bombs, explosions, powerups };
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

  /** Applies newly appended sudden-death conversions to the local grid + visuals. */
  private applyArenaShrunk(s: NetRoomState): void {
    const applied = this.appliedShrunk;
    s.arenaShrunk.forEach((index, i) => {
      if (i < applied) return;
      const row = Math.floor(index / GRID_WIDTH);
      const col = index % GRID_WIDTH;
      this.grid![row][col] = TileType.HardBlock;
      this.showShrunkTile(col, row);
    });
    this.appliedShrunk = s.arenaShrunk.length;
  }

  /** Online: events are not streamed, so death sounds derive from alive-flag diffs. */
  private trackOnlineDeaths(state: RenderState): void {
    for (const player of state.players) {
      if (this.prevAlive.get(player.id) === true && !player.alive) audio.death();
      this.prevAlive.set(player.id, player.alive);
    }
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
    // Desert backdrop under the grid only; the HUD bar above stays solid dark.
    addImage(this, 0, HUD_HEIGHT, TEX.background)
      .setOrigin(0, 0)
      .setDisplaySize(this.scale.width, GRID_HEIGHT * TILE_SIZE)
      .setDepth(DEPTH.background);
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        addImage(this, toX(col), toY(row), TEX.floor)
          .setDisplaySize(TILE_SIZE, TILE_SIZE)
          .setDepth(DEPTH.floor);
        if (state.grid[row][col] === TileType.HardBlock) {
          this.addHardBlock(col, row);
        }
      }
    }
  }

  /** Traffic-cone hard block, scaled by height and centered on the tile. */
  private addHardBlock(col: number, row: number): Phaser.GameObjects.Image {
    const img = addImage(this, toX(col), toY(row), TEX.hardBlock).setDepth(DEPTH.block);
    return img.setScale(SPRITE_SIZE.hardBlockHeight / img.height);
  }

  /** Renders a sudden-death conversion: permanent hard block + brief flash. */
  private showShrunkTile(col: number, row: number): void {
    this.addHardBlock(col, row);
    const flash = this.add
      .rectangle(toX(col), toY(row), TILE_SIZE, TILE_SIZE, 0xffffff, 0.8)
      .setDepth(DEPTH.explosion);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 250,
      onComplete: () => flash.destroy(),
    });
  }

  private createPlayerSprites(state: RenderState): void {
    for (const player of state.players) {
      // Slot number (p0-p3) picks the character, consistent across both modes.
      const slot = Number(player.id.slice(1)) || 0;
      const ref = TEX.players[slot % TEX.players.length];
      // Anchored bottom-center at the tile bottom (classic Bomberman look).
      const sprite = addImage(this, toX(player.x), toY(player.y) + TILE_SIZE / 2, ref)
        .setOrigin(0.5, 1)
        .setDepth(DEPTH.player);
      sprite.setScale(SPRITE_SIZE.playerHeight / sprite.height);
      this.playerSprites.set(player.id, sprite);
    }
  }

  /** Moves player sprites; lerp=1 snaps, lower values smooth (online). */
  private positionPlayers(state: Pick<RenderState, 'players'>, lerp: number): void {
    for (const player of state.players) {
      const sprite = this.playerSprites.get(player.id);
      if (!sprite) continue;
      const tx = toX(player.x);
      const ty = toY(player.y) + TILE_SIZE / 2; // bottom-anchored
      sprite.setPosition(sprite.x + (tx - sprite.x) * lerp, sprite.y + (ty - sprite.y) * lerp);
      sprite.setDepth(DEPTH.player + player.y * PLAYER_DEPTH_PER_ROW);
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
            addImage(this, toX(col), toY(row), TEX.softBlock)
              .setDisplaySize(TILE_SIZE, TILE_SIZE)
              .setDepth(DEPTH.block),
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
    this.explosionCenters.clear();
    for (const [id, entry] of this.bombSprites) {
      if (!liveIds.has(id)) {
        // A vanished bomb marks its cell as the explosion origin this pass.
        this.explosionCenters.add(cellKey(entry.col, entry.row));
        this.tweens.killTweensOf(entry.sprite);
        entry.sprite.destroy();
        this.bombSprites.delete(id);
      }
    }
    for (const bomb of state.bombs) {
      if (this.bombSprites.has(bomb.id)) continue;
      if (this.mode === 'online') audio.bombPlace(); // offline plays via bombPlaced event
      const sprite = addImage(this, toX(bomb.col), toY(bomb.row), TEX.bomb).setDepth(DEPTH.bomb);
      const base = SPRITE_SIZE.bombHeight / sprite.height;
      sprite.setScale(base);
      this.tweens.add({
        targets: sprite,
        scale: { from: base, to: base * BOMB_PULSE },
        duration: 300,
        yoyo: true,
        repeat: -1,
      });
      this.bombSprites.set(bomb.id, { sprite, col: bomb.col, row: bomb.row });
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
    let appeared = false;
    for (const cell of state.explosions) {
      const key = cellKey(cell.col, cell.row);
      if (this.explosionSprites.has(key)) continue;
      appeared = true;
      // Pink pom at the bomb's origin cell, yellow poms along the arms.
      const ref = this.explosionCenters.has(key) ? TEX.explosionCenter : TEX.explosion;
      const sprite = addImage(this, toX(cell.col), toY(cell.row), ref)
        .setDisplaySize(TILE_SIZE, TILE_SIZE)
        .setRotation(Phaser.Math.FloatBetween(-EXPLOSION_MAX_TILT, EXPLOSION_MAX_TILT))
        .setDepth(DEPTH.explosion);
      this.explosionSprites.set(key, sprite);
    }
    // One boom per frame no matter how many cells appeared (offline: event-driven).
    if (appeared && this.mode === 'online') audio.explosion();
  }

  private reconcilePowerups(state: RenderState): void {
    const live = new Map(state.powerups.map((p) => [cellKey(p.col, p.row), TEX.powerup[p.type]]));
    for (const [key, entry] of this.powerupSprites) {
      if (live.get(key) !== entry.ref) {
        // Online pickup sound: the powerup vanished under a living player
        // (burned/crushed powerups vanish with nobody standing there).
        if (this.mode === 'online') {
          const [col, row] = key.split(',').map(Number);
          const collected = state.players.some(
            (p) => p.alive && Math.round(p.x) === col && Math.round(p.y) === row,
          );
          if (collected) audio.powerup();
        }
        this.tweens.killTweensOf(entry.sprite);
        entry.sprite.destroy();
        this.powerupSprites.delete(key);
      }
    }
    for (const [key, ref] of live) {
      if (this.powerupSprites.has(key)) continue;
      const [col, row] = key.split(',').map(Number);
      const sprite = addImage(this, toX(col), toY(row), ref).setDepth(DEPTH.powerup);
      sprite.setScale(SPRITE_SIZE.powerupHeight / sprite.height);
      this.tweens.add({
        targets: sprite,
        y: sprite.y - POWERUP_BOB,
        duration: 500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
      this.powerupSprites.set(key, { sprite, ref });
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
        fontSize: '14px',
        color: '#ffffff',
      })
      .setOrigin(0, 0.5)
      .setDepth(DEPTH.hud);
    const muteButton = this.add
      .text(this.scale.width - 12, HUD_HEIGHT / 2, audio.isMuted() ? '🔇' : '🔊', {
        fontSize: '20px',
      })
      .setOrigin(1, 0.5)
      .setDepth(DEPTH.hud)
      .setInteractive({ useHandCursor: true });
    muteButton.on('pointerdown', () => {
      muteButton.setText(audio.toggleMuted() ? '🔇' : '🔊');
    });
    this.suddenDeathText = this.add
      .text(this.scale.width - 48, HUD_HEIGHT / 2, '', {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#ffe040',
      })
      .setOrigin(1, 0.5)
      .setDepth(DEPTH.hud);
  }

  private updateHud(state: RenderState): void {
    this.updateSuddenDeathHud(state.tick);
    const me = state.players.find((p) => p.id === this.myId);
    const aliveCount = state.players.filter((p) => p.alive).length;
    if (!me) return;
    let line = `Bombs: ${me.bombCount}  Blast: ${me.blastRadius}  Speed: ${me.speed.toFixed(1)}  Alive: ${aliveCount}`;
    if (this.mode === 'online') {
      line += `  Ping: ${this.pingMs === null ? '--' : `${this.pingMs}ms`}`;
    }
    this.hudText.setText(line);
  }

  private updateSuddenDeathHud(tick: number): void {
    const ticksLeft = SUDDEN_DEATH_START_TICKS - tick;
    if (ticksLeft <= 0) {
      this.suddenDeathText.setText('SUDDEN DEATH').setColor('#ff5040');
      return;
    }
    if (ticksLeft <= 10 * TICK_RATE && !this.suddenDeathWarned) {
      this.suddenDeathWarned = true;
      audio.suddenDeathWarning();
    }
    const seconds = Math.ceil(ticksLeft / TICK_RATE);
    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, '0');
    this.suddenDeathText.setText(`Sudden death in ${m}:${s}`);
  }

  // --- game over ---

  private showGameOver(winnerId: string | null): void {
    this.gameOver = true;
    if (winnerId === this.myId) audio.win();
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0.6)
      .setOrigin(0, 0)
      .setDepth(DEPTH.overlay);

    if (winnerId === null) {
      this.add
        .text(cx, cy - 60, 'Draw', {
          fontFamily: 'monospace',
          fontSize: '48px',
          color: '#ffffff',
          fontStyle: 'bold',
        })
        .setOrigin(0.5)
        .setDepth(DEPTH.overlay);
    } else {
      const won = winnerId === this.myId;
      const ref = won ? TEX.youWin : TEX.youLose;
      const banner = addImage(this, cx, cy - 100, ref).setDepth(DEPTH.overlay);
      banner.setScale(SPRITE_SIZE.bannerWidth / banner.width);
      if (!won && this.mode === 'online') {
        const nickname = this.connection!.room.state.players.get(winnerId)?.nickname;
        this.add
          .text(cx, cy + 30, `${nickname ?? winnerId} wins!`, {
            fontFamily: 'monospace',
            fontSize: '28px',
            color: '#ffffff',
          })
          .setOrigin(0.5)
          .setDepth(DEPTH.overlay);
      }
    }

    const back = this.add
      .text(cx, cy + 90, 'Back to menu', {
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
