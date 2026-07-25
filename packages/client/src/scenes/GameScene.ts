import Phaser from 'phaser';
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  KICK_WARNING_TICKS,
  PowerupType,
  SUDDEN_DEATH_START_TICKS,
  TICK_MS,
  TICK_RATE,
  MAPS,
  TileType,
  compileMap,
  computePlacements,
  createBot,
  createGame,
  createRng,
  generateMap,
  getMapDef,
} from '@bomberman/shared';
import type {
  Bot,
  CompiledMap,
  Direction,
  Game,
  GameEvent,
  PlayerInput,
} from '@bomberman/shared';
import { audio } from '../audio';
import { GUN_KEY, HAMMER_KEY, SKILL_KEY_LABEL } from '../controls';
import type { GameRoomConnection, NetRoomState } from '../net';
import { KICK_TINT, SPRITE_SIZE, TEX, TEXT_RES, TILE_SIZE, addImage } from '../textures';
import type { TexRef } from '../textures';
import { buildSkillsTable } from '../skillsTable';
import type { LobbySceneData } from './LobbyScene';

export type GameSceneData =
  | { mode: 'offline'; seed: number; mapId?: string }
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

/** Inset (px per side) of a winter block sprite inside its tile, so the floor
 * shows through as a gap and the block reads as a raised object. */
const BLOCK_INSET = 3;

/** Drop shadow drawn under winter blocks to lift them off the floor. */
const BLOCK_SHADOW = { color: 0x0a1a2c, alpha: 0.45, offset: 3 } as const;

const DEPTH = {
  background: -1,
  floor: 0,
  blockShadow: 0.5,
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
/** Tint for kick visuals in the final warning window (about to expire). */
const KICK_WARNING_TINT = 0xff4040;
/** On-screen height (px) of one overhead skill badge, and the row's pitch. */
const SKILL_BADGE_HEIGHT = 22;
const SKILL_BADGE_STEP = 20;
/**
 * Start-of-match "this is you" arrow: an overhead triangle that bobs above the
 * local player's head for the first seconds, then fades out for good.
 */
const MY_POINTER = {
  width: 20,
  height: 16,
  color: 0xffe040,
  /** Gap between the player's head and the arrow's tip. */
  gap: 34,
  /** Bob amplitude (px) and one-way duration of the hover tween. */
  bob: 6,
  bobMs: 420,
  /** Fully visible for this long, then fades over fadeMs and is destroyed. */
  holdMs: 2600,
  fadeMs: 500,
} as const;
/** Hammer aim crosshair: a red X drawn over the tile the swing would strike. */
const HAMMER_TARGET = {
  color: 0xff4040,
  width: 4,
  /** Inset of each X arm from the tile edge. */
  inset: 12,
} as const;
/** Gun tracer: color, thickness and fade time of the shot line. */
const TRACER_COLOR = 0xffe040;
const TRACER_WIDTH = 3;
const TRACER_FADE_MS = 180;
/** Tile flash (sudden death, hammer impact) fade time. */
const TILE_FLASH_MS = 250;

/** Overhead badges, in draw order; `value` reads the synced count off a player. */
const SKILL_BADGES: {
  key: string;
  type: PowerupType;
  value: (p: RenderPlayer) => number;
  /** Timers (kick) show no number; consumable counts do. */
  showCount: boolean;
}[] = [
  { key: 'kick', type: PowerupType.Kick, value: (p) => p.kickTicks, showCount: false },
  { key: 'gun', type: PowerupType.Gun, value: (p) => p.gunAmmo, showCount: true },
  { key: 'hammer', type: PowerupType.Hammer, value: (p) => p.hammerUses, showCount: true },
];

/** Grid delta per facing direction (mirrors the sim's step table). */
const DIR_STEP: Record<Direction, [dc: number, dr: number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

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
  kickTicks: number;
  gunAmmo: number;
  hammerUses: number;
  facing: Direction;
}

/** One overhead skill icon (plus its count label for consumable skills). */
interface SkillBadge {
  icon: Phaser.GameObjects.Image;
  count: Phaser.GameObjects.Text | null;
}

export interface RenderState {
  tick: number;
  grid: TileType[][];
  players: RenderPlayer[];
  bombs: { id: number; col: number; row: number; slideInterval: number }[];
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

  /** Chosen arena; '' = classic procedural (kept for the "play again" restart). */
  private mapId = '';
  /** Compiled registry map (ice/visuals/props) — null on the classic map. */
  private compiled: CompiledMap | null = null;
  private theme: 'classic' | 'winter' = 'classic';

  // offline
  private sim: Game | null = null; // named to avoid Phaser.Scene#game
  private bots: Bot[] = [];
  private accumulator = 0;

  /** Character index per player id; drives skin selection in both modes. */
  private characterByPlayer = new Map<string, number>();

  // online
  private connection: GameRoomConnection | null = null;
  private grid: TileType[][] | null = null;
  private appliedDestroyed = 0;
  private appliedShrunk = 0;
  private lastSentDirection: Direction | null = null;
  /** Online: last-sent bomb-held flag, to resend promptly on change. */
  private lastSentBomb = false;
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
  private gunKey!: Phaser.Input.Keyboard.Key;
  private hammerKey!: Phaser.Input.Keyboard.Key;
  /**
   * Latched skill presses. A frame can run zero sim steps (or skip an input
   * send), so an edge-triggered key is held here until it is consumed.
   */
  private pendingGun = false;
  private pendingHammer = false;
  /** Online: latched Space press, routed to whichever skill is held. */
  private pendingTrigger = false;
  /**
   * Online: this Space press already served a skill, so it must not turn into a
   * bomb when the magazine empties mid-hold. Cleared when Space comes back up.
   */
  private triggerServedSkill = false;

  private playerSprites = new Map<string, Phaser.GameObjects.Image>();
  /** Start-of-match arrow over the local player; null once it has faded out. */
  private myPointer: Phaser.GameObjects.Triangle | null = null;
  /** Hover offset for the arrow, tweened separately so it can also follow. */
  private myPointerBob = { y: 0 };
  /** Crosshair over the tile a held hammer would strike; null until armed. */
  private hammerTarget: Phaser.GameObjects.Graphics | null = null;
  /** Overhead skill icons per player, keyed by SKILL_BADGES entry. */
  private skillBadges = new Map<string, Map<string, SkillBadge>>();
  /** Previous-frame badge values per player, to detect a 0 -> >0 pickup. */
  private prevSkillValues = new Map<string, Map<string, number>>();
  /** Online: last-seen gun/hammer counts, to derive skill FX from state diffs. */
  private prevGunAmmo = new Map<string, number>();
  private prevHammerUses = new Map<string, number>();
  private softBlockSprites = new Map<string, Phaser.GameObjects.Image>();
  private bombSprites = new Map<number, { sprite: Phaser.GameObjects.Image; col: number; row: number }>();
  private explosionSprites = new Map<string, Phaser.GameObjects.Image>();
  private powerupSprites = new Map<string, { sprite: Phaser.GameObjects.Image; ref: TexRef }>();
  /** Cells whose bomb vanished this reconcile pass — the explosion's origin. */
  private explosionCenters = new Set<string>();

  private hudText!: Phaser.GameObjects.Text;
  private suddenDeathText!: Phaser.GameObjects.Text;

  /** In-game skills reference overlay: objects + visibility flag. */
  private skillsPanel: Phaser.GameObjects.GameObject[] = [];
  private skillsShown = false;

  constructor() {
    super('Game');
  }

  create(data: GameSceneData): void {
    this.mode = data.mode;
    this.accumulator = 0;
    this.gameOver = false;
    this.appliedDestroyed = 0;
    this.appliedShrunk = 0;
    this.lastSentDirection = null;
    this.lastSentBomb = false;
    this.keepaliveMs = 0;
    this.pingMs = null;
    this.pingTimerMs = 0;
    this.roomClosed = false;
    this.suddenDeathWarned = false;
    this.pendingGun = false;
    this.pendingHammer = false;
    this.pendingTrigger = false;
    this.triggerServedSkill = false;
    this.prevAlive.clear();
    this.prevGunAmmo.clear();
    this.prevHammerUses.clear();
    this.playerSprites.clear();
    this.myPointer = null;
    this.myPointerBob.y = 0;
    this.hammerTarget = null;
    this.skillBadges.clear();
    this.prevSkillValues.clear();
    this.softBlockSprites.clear();
    this.bombSprites.clear();
    this.explosionSprites.clear();
    this.powerupSprites.clear();
    this.explosionCenters.clear();
    this.characterByPlayer.clear();
    this.skillsPanel = [];
    this.skillsShown = false;

    let initial: RenderState;
    if (data.mode === 'offline') {
      this.myId = HUMAN_ID;
      this.connection = null;
      this.grid = null;
      this.resolveMap(data.mapId ?? '', data.seed);
      this.sim = createGame({ seed: data.seed, playerIds: PLAYER_IDS, mapId: this.mapId });
      this.bots = PLAYER_IDS.slice(1).map((id, i) => createBot(id, createRng(data.seed + i + 1)));
      // Offline: character = slot number (intentional; no picker offline).
      for (const id of PLAYER_IDS) this.characterByPlayer.set(id, Number(id.slice(1)));
      initial = this.sim.state;
    } else {
      this.connection = data.connection;
      this.myId = data.connection.playerId;
      this.sim = null;
      this.bots = [];
      // The server never syncs the grid: it is recompiled here from the same
      // (mapId, seed) pair, then patched by the destroyedBlocks deltas.
      const seed = data.connection.room.state.seed;
      this.resolveMap(data.connection.room.state.mapId, seed);
      this.grid = this.compiled ? this.compiled.grid.map((row) => [...row]) : generateMap(seed);
      data.connection.room.state.players.forEach((p, id) =>
        this.characterByPlayer.set(id, p.character),
      );
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
    this.showMyPointer();
  }

  /**
   * Points out which of the four look-alike characters is yours at the start of
   * a match. The arrow follows the sprite (positionPlayers moves it), hovers on
   * a tween, then fades out and is gone for the rest of the match.
   */
  private showMyPointer(): void {
    const sprite = this.playerSprites.get(this.myId);
    if (!sprite) return;
    const { width, height, color, bob, bobMs, holdMs, fadeMs } = MY_POINTER;
    // Downward-pointing triangle, tip at the bottom (toward the head).
    const place = this.myPointerPlacement(sprite);
    const arrow = this.add
      .triangle(sprite.x, place.y, 0, 0, width, 0, width / 2, height, color)
      .setRotation(place.flip ? Math.PI : 0)
      .setDepth(DEPTH.hud - 1);
    this.myPointer = arrow;
    this.tweens.add({
      targets: this.myPointerBob,
      y: -bob,
      duration: bobMs,
      ease: 'Sine.easeInOut',
      yoyo: true,
      repeat: -1,
    });
    this.tweens.add({
      targets: arrow,
      alpha: 0,
      delay: holdMs,
      duration: fadeMs,
      onComplete: () => {
        arrow.destroy();
        if (this.myPointer === arrow) this.myPointer = null;
      },
    });
  }

  /**
   * Arrow placement: above the head by default (tip down), clear of the
   * overhead skill badge row. Near the top of the map that spot clips behind
   * the HUD bar, so flip the arrow below the feet (tip up) instead.
   */
  private myPointerPlacement(sprite: Phaser.GameObjects.Image): { y: number; flip: boolean } {
    const { gap, height } = MY_POINTER;
    const above = sprite.y - SPRITE_SIZE.playerHeight - gap + this.myPointerBob.y;
    if (above - height / 2 < HUD_HEIGHT + 4) {
      return { y: sprite.y + gap - this.myPointerBob.y, flip: true };
    }
    return { y: above, flip: false };
  }

  /**
   * Resolves the arena once per match. An unknown or empty id leaves the scene
   * on the classic procedural path (compiled === null), byte-identical to
   * before maps existed.
   */
  private resolveMap(mapId: string, seed: number): void {
    const def = getMapDef(mapId);
    this.mapId = def ? mapId : '';
    this.compiled = def ? compileMap(def, seed) : null;
    this.theme = def?.theme ?? 'classic';
    // TEMP DEBUG (remove): why does winter render classic?
    console.log('[MAPDBG] resolveMap', {
      requested: mapId,
      resolved: this.mapId,
      theme: this.theme,
      compiled: this.compiled !== null,
      floorFrame: this.floorRef(1, 1),
      winterFloorFrame: this.textures.exists('gameplay6')
        ? this.textures.get('gameplay6').has('winter_floor')
        : 'page-missing',
      registryKeys: Object.keys(MAPS),
    });
  }

  update(_time: number, delta: number): void {
    if (this.gameOver) return;
    if (this.mode === 'offline') this.updateOffline(delta);
    else this.updateOnline(delta);
  }

  // --- offline: local simulation ---

  private updateOffline(delta: number): void {
    this.pollSkillKeys();
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
      // Holding Space keeps placing; the sim self-limits via bomb caps + per-tile.
      // Gun/hammer are one-shot: the latch is cleared as this tick consumes it.
      [HUMAN_ID]: {
        direction: this.currentDirection(),
        placeBomb: this.spaceKey.isDown,
        fireGun: this.pendingGun,
        swingHammer: this.pendingHammer,
      },
    };
    this.pendingGun = false;
    this.pendingHammer = false;
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
      case 'gunFired':
        audio.gunShot();
        this.showTracer(event.col, event.row, event.dir, event.hitCol, event.hitRow);
        break;
      case 'hammerSwung':
        audio.hammerHit();
        this.flashTile(event.col, event.row, TRACER_COLOR);
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

    // Input: send on change, on bomb-held change, on a latched skill press, and
    // periodically as keepalive. Holding Space resends `true` each keepalive so
    // the server keeps dropping bombs as fast as its caps allow; release sends
    // `false` promptly. A skill flag goes out on the very next send and is then
    // cleared — the server sticky-ORs it, so a later `false` keepalive is harmless.
    //
    // While a skill is held, Space is the skill trigger instead: it goes out as
    // an edge-latched skill flag and never as `placeBomb`. The server's buffer
    // clears `placeBomb` every tick, so a held Space arrives as a fresh press on
    // each keepalive — which would empty the magazine in a fraction of a second.
    this.pollSkillKeys();
    const direction = this.currentDirection();
    const armed = this.myArmedSkill();
    if (armed === 'gun' && this.pendingTrigger) this.pendingGun = true;
    if (armed === 'hammer' && this.pendingTrigger) this.pendingHammer = true;
    this.pendingTrigger = false;
    if (!this.spaceKey.isDown) this.triggerServedSkill = false;
    else if (armed !== null) this.triggerServedSkill = true;
    const bombHeld = armed === null && this.spaceKey.isDown && !this.triggerServedSkill;
    this.keepaliveMs += delta;
    if (
      !this.roomClosed &&
      (direction !== this.lastSentDirection ||
        bombHeld !== this.lastSentBomb ||
        this.pendingGun ||
        this.pendingHammer ||
        this.keepaliveMs >= KEEPALIVE_MS)
    ) {
      room.send('input', {
        direction,
        placeBomb: bombHeld,
        fireGun: this.pendingGun,
        swingHammer: this.pendingHammer,
      });
      this.pendingGun = false;
      this.pendingHammer = false;
      this.lastSentDirection = direction;
      this.lastSentBomb = bombHeld;
      this.keepaliveMs = 0;
    }

    const state = this.renderStateFromRoom();
    this.reconcile(state);
    this.trackOnlineDeaths(state);
    this.trackOnlineSkillUse(state);
    this.updateHud(state);
    this.positionPlayers(state, ONLINE_LERP);

    if (room.state.phase === 'finished' && !this.gameOver) {
      this.showRanking();
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
        kickTicks: p.kickTicks,
        gunAmmo: p.gunAmmo,
        hammerUses: p.hammerUses,
        facing: p.facing,
      }),
    );
    players.sort((a, b) => a.id.localeCompare(b.id));

    const bombs: RenderState['bombs'] = [];
    s.bombs.forEach((b) => bombs.push({ id: b.id, col: b.col, row: b.row, slideInterval: b.slideInterval }));
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

  /**
   * Online: gun/hammer FX derive from a drop in the synced counts. The tracer
   * end is re-scanned locally (the shot itself is not synced), so a shot that
   * broke a block draws one tile long — close enough for a 180ms flash.
   */
  private trackOnlineSkillUse(state: RenderState): void {
    for (const player of state.players) {
      const col = Math.round(player.x);
      const row = Math.round(player.y);

      const prevGun = this.prevGunAmmo.get(player.id);
      if (prevGun !== undefined && player.gunAmmo < prevGun) {
        audio.gunShot();
        const [hitCol, hitRow] = this.scanRay(state, col, row, player.facing, player.id);
        this.showTracer(col, row, player.facing, hitCol, hitRow);
      }
      this.prevGunAmmo.set(player.id, player.gunAmmo);

      const prevHammer = this.prevHammerUses.get(player.id);
      if (prevHammer !== undefined && player.hammerUses < prevHammer) {
        audio.hammerHit();
        const [dc, dr] = DIR_STEP[player.facing];
        this.flashTile(col + dc, row + dr, TRACER_COLOR);
      }
      this.prevHammerUses.set(player.id, player.hammerUses);
    }
  }

  /** First blocking cell along `dir` (block or other player); null if it leaves the grid. */
  private scanRay(
    state: RenderState,
    col: number,
    row: number,
    dir: Direction,
    shooterId: string,
  ): [col: number | null, row: number | null] {
    const [dc, dr] = DIR_STEP[dir];
    for (let step = 1; ; step++) {
      const c = col + dc * step;
      const r = row + dr * step;
      if (c < 0 || c >= GRID_WIDTH || r < 0 || r >= GRID_HEIGHT) return [null, null];
      if (state.grid[r][c] !== TileType.Floor) return [c, r];
      const hitPlayer = state.players.some(
        (p) => p.alive && p.id !== shooterId && Math.round(p.x) === c && Math.round(p.y) === r,
      );
      if (hitPlayer) return [c, r];
    }
  }

  // --- input ---

  private setupInput(): void {
    const keyboard = this.input.keyboard!;
    this.directionKeys = DIRECTION_KEYS.map(([key, dir]) => [keyboard.addKey(key), dir]);
    this.spaceKey = keyboard.addKey('SPACE');
    this.gunKey = keyboard.addKey(GUN_KEY);
    this.hammerKey = keyboard.addKey(HAMMER_KEY);
  }

  /**
   * Latches this frame's skill key presses. JustDown consumes the edge, so it
   * must be polled exactly once per frame regardless of how many sim steps or
   * input sends follow.
   */
  private pollSkillKeys(): void {
    if (Phaser.Input.Keyboard.JustDown(this.gunKey)) this.pendingGun = true;
    if (Phaser.Input.Keyboard.JustDown(this.hammerKey)) this.pendingHammer = true;
    if (Phaser.Input.Keyboard.JustDown(this.spaceKey)) this.pendingTrigger = true;
  }

  /**
   * Which skill Space triggers right now, or null when it still places bombs.
   * Online only: offline the sim reads the held key and edges it itself.
   */
  private myArmedSkill(): 'gun' | 'hammer' | null {
    const me = this.connection?.room.state.players.get(this.myId);
    if (!me) return null;
    if (me.gunAmmo > 0) return 'gun';
    if (me.hammerUses > 0) return 'hammer';
    return null;
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

    // Prop footprints are drawn as one sprite, so their per-cell wall art is skipped.
    const propCells = new Set<string>();
    for (const prop of this.compiled?.props ?? []) {
      for (let row = prop.row; row < prop.row + prop.rows; row++) {
        for (let col = prop.col; col < prop.col + prop.cols; col++) propCells.add(cellKey(col, row));
      }
    }

    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        addImage(this, toX(col), toY(row), this.floorRef(col, row))
          .setDisplaySize(TILE_SIZE, TILE_SIZE)
          .setDepth(DEPTH.floor);
        if (state.grid[row][col] === TileType.HardBlock && !propCells.has(cellKey(col, row))) {
          this.addHardBlock(col, row);
        }
      }
    }

    for (const prop of this.compiled?.props ?? []) {
      const ref = TEX.winter.house; // only prop art so far; keyed by visual once there are more
      addImage(
        this,
        toX(prop.col + (prop.cols - 1) / 2),
        toY(prop.row + (prop.rows - 1) / 2),
        ref,
      )
        .setDisplaySize(prop.cols * TILE_SIZE, prop.rows * TILE_SIZE)
        .setDepth(DEPTH.block);
    }
  }

  /** Floor art for one cell: themed ice/alt variants, or the classic tile. */
  private floorRef(col: number, row: number): TexRef {
    if (this.theme !== 'winter') return TEX.floor;
    if (this.compiled?.ice[row][col]) return TEX.winter.iceFloor;
    // Checkerboard the two plain variants so the sheet ice reads as a rink.
    return (col + row) % 2 === 0 ? TEX.winter.floor : TEX.winter.floorAlt;
  }

  /**
   * Winter block sprite: the art inset inside its tile with a drop shadow, so
   * it stands off the shaded floor even when both use the same snow/ice tile.
   * The shadow is a child of the returned image and dies with it.
   */
  private addWinterBlock(col: number, row: number, ref: TexRef): Phaser.GameObjects.Image {
    const size = TILE_SIZE - BLOCK_INSET * 2;
    const { color, alpha, offset } = BLOCK_SHADOW;
    const shadow = addImage(this, toX(col) + offset, toY(row) + offset, ref)
      .setDisplaySize(size, size)
      .setDepth(DEPTH.blockShadow)
      .setTintFill(color)
      .setAlpha(alpha);
    const img = addImage(this, toX(col), toY(row), ref)
      .setDisplaySize(size, size)
      .setDepth(DEPTH.block);
    img.once(Phaser.GameObjects.Events.DESTROY, () => shadow.destroy());
    return img;
  }

  /**
   * Hard block: classic traffic cone (scaled by height, centered on the tile)
   * or the flat winter wall inset on the tile with a shadow.
   */
  private addHardBlock(col: number, row: number): Phaser.GameObjects.Image {
    if (this.theme === 'winter') {
      return this.addWinterBlock(col, row, TEX.winter.hardBlock);
    }
    const img = addImage(this, toX(col), toY(row), TEX.hardBlock).setDepth(DEPTH.block);
    return img.setScale(SPRITE_SIZE.hardBlockHeight / img.height);
  }

  /** Renders a sudden-death conversion: permanent hard block + brief flash. */
  private showShrunkTile(col: number, row: number): void {
    this.addHardBlock(col, row);
    this.flashTile(col, row, 0xffffff);
  }

  /** Brief full-tile flash (sudden-death conversion, hammer impact). */
  private flashTile(col: number, row: number, color: number): void {
    if (col < 0 || col >= GRID_WIDTH || row < 0 || row >= GRID_HEIGHT) return;
    const flash = this.add
      .rectangle(toX(col), toY(row), TILE_SIZE, TILE_SIZE, color, 0.8)
      .setDepth(DEPTH.explosion);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: TILE_FLASH_MS,
      onComplete: () => flash.destroy(),
    });
  }

  /**
   * Gun tracer: a fading line from the shooter's tile to the cell the ray
   * stopped on, plus a flash there. A null hit means the shot left the grid,
   * so the line runs to the far edge.
   */
  private showTracer(
    col: number,
    row: number,
    dir: Direction,
    hitCol: number | null,
    hitRow: number | null,
  ): void {
    const [dc, dr] = DIR_STEP[dir];
    const endCol = hitCol ?? (dc > 0 ? GRID_WIDTH - 1 : dc < 0 ? 0 : col);
    const endRow = hitRow ?? (dr > 0 ? GRID_HEIGHT - 1 : dr < 0 ? 0 : row);
    const tracer = this.add
      .line(0, 0, toX(col), toY(row), toX(endCol), toY(endRow), TRACER_COLOR)
      .setOrigin(0, 0)
      .setLineWidth(TRACER_WIDTH)
      .setDepth(DEPTH.explosion);
    this.tweens.add({
      targets: tracer,
      alpha: 0,
      duration: TRACER_FADE_MS,
      onComplete: () => tracer.destroy(),
    });
    if (hitCol !== null && hitRow !== null) this.flashTile(hitCol, hitRow, TRACER_COLOR);
  }

  private createPlayerSprites(state: RenderState): void {
    for (const player of state.players) {
      // Character index (from picker online, slot offline) selects the skin.
      const ref = TEX.players[this.characterByPlayer.get(player.id) ?? 0];
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
      // Kick active: solid cyan tint; over the last warning ticks blink to red.
      const warning = player.kickTicks > 0 && player.kickTicks <= KICK_WARNING_TICKS;
      const blinkOn = Math.floor(player.kickTicks / 5) % 2 === 0;
      if (player.kickTicks > KICK_WARNING_TICKS) sprite.setTint(KICK_TINT);
      else if (warning) {
        if (blinkOn) sprite.setTint(KICK_WARNING_TINT);
        else sprite.clearTint();
      } else sprite.clearTint();

      this.updateSkillBadges(player, sprite, warning, blinkOn);

      if (this.myPointer && player.id === this.myId) {
        const place = this.myPointerPlacement(sprite);
        this.myPointer.setPosition(sprite.x, place.y).setRotation(place.flip ? Math.PI : 0);
      }
      if (player.id === this.myId) this.updateHammerTarget(player);
    }
  }

  /**
   * Red X over the tile the held hammer will hit, so melee aim is obvious.
   * Follows the local player's facing; hidden while the hammer isn't the armed
   * skill (a held gun takes the trigger first), the player is dead, or the
   * target tile is off-grid.
   */
  private updateHammerTarget(me: RenderPlayer): void {
    const armed = me.alive && me.hammerUses > 0 && me.gunAmmo === 0;
    const [dc, dr] = DIR_STEP[me.facing];
    const col = Math.round(me.x) + dc;
    const row = Math.round(me.y) + dr;
    const onGrid = col >= 0 && col < GRID_WIDTH && row >= 0 && row < GRID_HEIGHT;
    if (!armed || !onGrid) {
      this.hammerTarget?.setVisible(false);
      return;
    }
    if (!this.hammerTarget) this.hammerTarget = this.createHammerTarget();
    this.hammerTarget.setVisible(true).setPosition(toX(col), toY(row));
  }

  private createHammerTarget(): Phaser.GameObjects.Graphics {
    const { color, width, inset } = HAMMER_TARGET;
    const arm = TILE_SIZE / 2 - inset;
    const g = this.add.graphics().setDepth(DEPTH.player - 0.5);
    g.lineStyle(width, color, 0.9);
    g.beginPath();
    g.moveTo(-arm, -arm);
    g.lineTo(arm, arm);
    g.moveTo(arm, -arm);
    g.lineTo(-arm, arm);
    g.strokePath();
    this.tweens.add({
      targets: g,
      alpha: { from: 0.45, to: 1 },
      duration: 480,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    return g;
  }

  /**
   * Maintains the overhead skill icon row for one player, driven purely from
   * the synced counts so every client sees the same pickup + expiry cues. The
   * row is centered over the head and only holds the skills currently owned.
   */
  private updateSkillBadges(
    player: RenderPlayer,
    sprite: Phaser.GameObjects.Image,
    warning: boolean,
    blinkOn: boolean,
  ): void {
    let badges = this.skillBadges.get(player.id);
    if (!badges) {
      badges = new Map();
      this.skillBadges.set(player.id, badges);
    }
    let prev = this.prevSkillValues.get(player.id);
    if (!prev) {
      prev = new Map();
      this.prevSkillValues.set(player.id, prev);
    }

    const active = player.alive ? SKILL_BADGES.filter((s) => s.value(player) > 0) : [];
    const activeKeys = new Set(active.map((s) => s.key));
    for (const [key, badge] of badges) {
      if (activeKeys.has(key)) continue;
      badge.icon.destroy();
      badge.count?.destroy();
      badges.delete(key);
    }

    // Sits just above the (bottom-anchored) player sprite's head.
    const rowY = sprite.y - SPRITE_SIZE.playerHeight - 6;
    active.forEach((skill, i) => {
      const value = skill.value(player);
      const x = sprite.x + (i - (active.length - 1) / 2) * SKILL_BADGE_STEP;
      let badge = badges.get(skill.key);
      if (!badge) {
        const icon = addImage(this, x, rowY, TEX.powerup[skill.type]).setDepth(DEPTH.player + 1);
        icon.setScale(SKILL_BADGE_HEIGHT / icon.height);
        const count = skill.showCount
          ? this.add
              .text(x, rowY + SKILL_BADGE_HEIGHT / 2, '', {
                fontFamily: 'monospace',
                fontSize: '11px',
                color: '#ffffff',
                resolution: TEXT_RES,
              })
              .setOrigin(0.5, 0.5)
              .setDepth(DEPTH.player + 1)
          : null;
        badge = { icon, count };
        badges.set(skill.key, badge);
        // Pickup pop: quick scale-down settle when the skill first turns on.
        if ((prev.get(skill.key) ?? 0) === 0) {
          const base = icon.scale;
          this.tweens.add({ targets: icon, scale: { from: base * 1.6, to: base }, duration: 200 });
        }
      }
      badge.icon.setPosition(x, rowY);
      badge.count?.setPosition(x, rowY + SKILL_BADGE_HEIGHT / 2).setText(String(value));
      // Kick is the only timed skill: blink it red over its final ticks.
      const blinkOff = skill.key === 'kick' && warning && !blinkOn;
      if (skill.key === 'kick' && warning) badge.icon.setTint(KICK_WARNING_TINT);
      else badge.icon.clearTint();
      badge.icon.setVisible(!blinkOff);
      badge.count?.setVisible(!blinkOff);
    });

    for (const skill of SKILL_BADGES) prev.set(skill.key, skill.value(player));
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

  /** Soft-block art for one cell: the map's `visual` hint, or the classic crate. */
  private softBlockRef(col: number, row: number): TexRef {
    if (this.theme !== 'winter') return TEX.softBlock;
    const visual = this.compiled?.visuals[row][col];
    return (visual ? TEX.winter.softByVisual[visual] : undefined) ?? TEX.winter.softByVisual.brick;
  }

  private reconcileSoftBlocks(state: RenderState): void {
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        const key = cellKey(col, row);
        const isSoft = state.grid[row][col] === TileType.SoftBlock;
        const sprite = this.softBlockSprites.get(key);
        if (isSoft && !sprite) {
          const ref = this.softBlockRef(col, row);
          this.softBlockSprites.set(
            key,
            this.theme === 'winter'
              ? this.addWinterBlock(col, row, ref)
              : addImage(this, toX(col), toY(row), ref)
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
      const existing = this.bombSprites.get(bomb.id);
      if (existing) {
        // Sliding (kicked) bomb: tween the sprite to its new tile.
        if (existing.col !== bomb.col || existing.row !== bomb.row) {
          existing.col = bomb.col;
          existing.row = bomb.row;
          this.tweens.add({
            targets: existing.sprite,
            x: toX(bomb.col),
            y: toY(bomb.row),
            duration: Math.max(1, bomb.slideInterval) * TICK_MS,
            ease: 'Linear',
          });
        }
        continue;
      }
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
    const live = new Map(
      state.powerups.map((p) => [cellKey(p.col, p.row), { ref: TEX.powerup[p.type] }]),
    );
    for (const [key, entry] of this.powerupSprites) {
      if (live.get(key)?.ref !== entry.ref) {
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
    for (const [key, { ref }] of live) {
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
        resolution: TEXT_RES,
      })
      .setOrigin(0, 0.5)
      .setDepth(DEPTH.hud);
    const muteButton = this.add
      .text(this.scale.width - 12, HUD_HEIGHT / 2, audio.isMuted() ? '🔇' : '🔊', {
        fontSize: '20px',
        resolution: TEXT_RES,
      })
      .setOrigin(1, 0.5)
      .setDepth(DEPTH.hud)
      .setInteractive({ useHandCursor: true });
    muteButton.on('pointerdown', () => {
      muteButton.setText(audio.toggleMuted() ? '🔇' : '🔊');
    });
    const helpButton = this.add
      .text(this.scale.width - 48, HUD_HEIGHT / 2, 'ℹ️', { fontSize: '18px', resolution: TEXT_RES })
      .setOrigin(1, 0.5)
      .setDepth(DEPTH.hud)
      .setInteractive({ useHandCursor: true });
    helpButton.on('pointerdown', () => this.toggleSkillsPanel());
    this.events.once('shutdown', () => this.destroySkillsPanel());
    this.suddenDeathText = this.add
      .text(this.scale.width - 84, HUD_HEIGHT / 2, '', {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: '#ffe040',
        resolution: TEXT_RES,
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
    if (me.kickTicks > 0) line += `  Kick: ${Math.ceil(me.kickTicks / TICK_RATE)}s`;
    // Counters carry the trigger: while armed, Space fires instead of bombing.
    if (me.gunAmmo > 0) line += `  Gun[${SKILL_KEY_LABEL}]: ${me.gunAmmo}`;
    if (me.hammerUses > 0) line += `  Hammer[${SKILL_KEY_LABEL}]: ${me.hammerUses}`;
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

  // --- skills reference overlay ---

  /** Shows/hides the in-game power-up reference panel (built once, lazily). */
  private toggleSkillsPanel(): void {
    if (this.skillsPanel.length === 0) this.buildSkillsPanel();
    this.skillsShown = !this.skillsShown;
    for (const o of this.skillsPanel) (o as Phaser.GameObjects.Image).setVisible(this.skillsShown);
  }

  private buildSkillsPanel(): void {
    const width = 540;
    const height = 205; // header + 6 skill rows
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const panel = this.add
      .rectangle(cx, cy, width, height, 0x11121c, 0.98)
      .setStrokeStyle(2, 0xffe040)
      .setDepth(DEPTH.overlay);
    const rows = buildSkillsTable(this, cx - width / 2 + 16, cy - height / 2 + 14);
    for (const o of rows) (o as Phaser.GameObjects.Image).setDepth(DEPTH.overlay + 1);
    this.skillsPanel = [panel, ...rows];
    for (const o of this.skillsPanel) (o as Phaser.GameObjects.Image).setVisible(false);
  }

  private destroySkillsPanel(): void {
    for (const o of this.skillsPanel) o.destroy();
    this.skillsPanel = [];
    this.skillsShown = false;
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
          resolution: TEXT_RES,
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
            resolution: TEXT_RES,
          })
          .setOrigin(0.5)
          .setDepth(DEPTH.overlay);
      }
    }

    // Offline final standings: p0 = "You", p1..p3 = "Bot n".
    const placements = computePlacements(this.sim!.state.players);
    placements.forEach((pl, i) => {
      const label = pl.id === HUMAN_ID ? 'You' : `Bot ${Number(pl.id.slice(1))}`;
      this.add
        .text(cx, cy - 10 + i * 26, `${ordinal(pl.placement)}  ${label}`, {
          fontFamily: 'monospace',
          fontSize: '20px',
          color: pl.id === HUMAN_ID ? '#ffe040' : '#ffffff',
          resolution: TEXT_RES,
        })
        .setOrigin(0.5)
        .setDepth(DEPTH.overlay);
    });

    const playAgain = (): void => {
      this.scene.restart({
        mode: 'offline',
        seed: Date.now() >>> 0,
        mapId: this.mapId,
      } satisfies GameSceneData);
    };

    const again = this.add
      .text(cx, cy + 110, 'Play again  [Enter]', {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: '#ffe040',
        resolution: TEXT_RES,
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.overlay)
      .setInteractive({ useHandCursor: true });
    again.on('pointerover', () => again.setColor('#ffffff'));
    again.on('pointerout', () => again.setColor('#ffe040'));
    again.on('pointerdown', playAgain);
    // Enter is the keyboard equivalent of the button (once: one restart only).
    this.input.keyboard?.once('keydown-ENTER', playAgain);

    const back = this.add
      .text(cx, cy + 150, 'Back to menu', {
        fontFamily: 'monospace',
        fontSize: '22px',
        color: '#999999',
        resolution: TEXT_RES,
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.overlay)
      .setInteractive({ useHandCursor: true });
    back.on('pointerover', () => back.setColor('#ffffff'));
    back.on('pointerout', () => back.setColor('#999999'));
    back.on('pointerdown', () => {
      this.scene.start('Menu');
    });
  }

  // --- online ranking screen ---

  private showRanking(): void {
    this.gameOver = true;
    const room = this.connection!.room;
    if (room.state.winnerId === this.myId) audio.win();
    else audio.death();

    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0.6)
      .setOrigin(0, 0)
      .setDepth(DEPTH.overlay);

    const panel = addImage(this, cx, cy, TEX.leaderboard).setDepth(DEPTH.overlay);
    panel.setScale(460 / panel.width);
    const panelTop = cy - (panel.displayHeight / 2);

    this.add
      .text(cx, panelTop + 28, 'RESULTS', {
        fontFamily: 'monospace',
        fontSize: '32px',
        fontStyle: 'bold',
        color: '#ffffff',
        resolution: TEXT_RES,
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.overlay + 1);

    // Collect + rank players by placement (0 = not set sorts last), then id.
    const rows: { id: string; nickname: string; character: number; wins: number; placement: number }[] = [];
    room.state.players.forEach((p, id) =>
      rows.push({ id, nickname: p.nickname, character: p.character, wins: p.wins, placement: p.placement }),
    );
    rows.sort((a, b) => a.placement - b.placement || a.id.localeCompare(b.id));

    const rowStartY = panelTop + 72;
    const rowGap = 40;
    rows.forEach((r, i) => {
      const ry = rowStartY + i * rowGap;
      this.add
        .text(cx - 190, ry, ordinal(r.placement), {
          fontFamily: 'monospace',
          fontSize: '18px',
          color: '#ffe040',
          resolution: TEXT_RES,
        })
        .setOrigin(0, 0.5)
        .setDepth(DEPTH.overlay + 1);
      const portrait = addImage(this, cx - 120, ry, TEX.players[r.character] ?? TEX.players[0]).setDepth(
        DEPTH.overlay + 1,
      );
      portrait.setScale(28 / portrait.height);
      this.add
        .text(cx - 95, ry, r.nickname, {
          fontFamily: 'monospace',
          fontSize: '18px',
          color: r.id === this.myId ? '#ffe040' : '#ffffff',
          resolution: TEXT_RES,
        })
        .setOrigin(0, 0.5)
        .setDepth(DEPTH.overlay + 1);
      this.add
        .text(cx + 190, ry, `Wins: ${r.wins}`, {
          fontFamily: 'monospace',
          fontSize: '16px',
          color: '#cccccc',
          resolution: TEXT_RES,
        })
        .setOrigin(1, 0.5)
        .setDepth(DEPTH.overlay + 1);
    });

    const controlsY = rowStartY + rows.length * rowGap + 20;
    const isHost = room.state.hostId === this.myId;

    // Phase-watch: once the host continues and the server flips back to lobby,
    // return to the Lobby scene (update() early-returns while gameOver).
    const onPhase = (): void => {
      if (room.state.phase === 'lobby') {
        room.onStateChange.remove(onPhase);
        this.scene.start('Lobby', { connection: this.connection! } satisfies LobbySceneData);
      }
    };
    room.onStateChange(onPhase);
    this.events.once('shutdown', () => room.onStateChange.remove(onPhase));

    if (isHost) {
      const cont = this.add
        .text(cx, controlsY, 'Continue', {
          fontFamily: 'monospace',
          fontSize: '28px',
          color: '#ffe040',
          resolution: TEXT_RES,
        })
        .setOrigin(0.5)
        .setDepth(DEPTH.overlay + 1)
        .setInteractive({ useHandCursor: true });
      cont.on('pointerover', () => cont.setColor('#ffffff'));
      cont.on('pointerout', () => cont.setColor('#ffe040'));
      const goOn = (): void => room.send('backToLobby');
      cont.on('pointerdown', goOn);
      // Host-only: Enter continues. The scene's keyboard listeners are dropped
      // on shutdown, so a resent message after leaving is not a concern.
      this.input.keyboard?.on('keydown-ENTER', goOn);
    } else {
      this.add
        .text(cx, controlsY, 'waiting for host…', {
          fontFamily: 'monospace',
          fontSize: '20px',
          color: '#999999',
          resolution: TEXT_RES,
        })
        .setOrigin(0.5)
        .setDepth(DEPTH.overlay + 1);
    }

    const leave = this.add
      .text(cx, controlsY + 40, 'Leave', {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: '#999999',
        resolution: TEXT_RES,
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.overlay + 1)
      .setInteractive({ useHandCursor: true });
    leave.on('pointerover', () => leave.setColor('#ffffff'));
    leave.on('pointerout', () => leave.setColor('#999999'));
    leave.on('pointerdown', () => {
      room.onStateChange.remove(onPhase);
      if (!this.roomClosed) void room.leave();
      this.scene.start('Menu');
    });
  }
}

/** 1 -> "1st", 2 -> "2nd", etc. (English ordinals). */
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
