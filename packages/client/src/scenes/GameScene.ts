import Phaser from 'phaser';
import {
  FREEZE_DURATION_TICKS,
  GRID_HEIGHT,
  GRID_WIDTH,
  KICK_WARNING_TICKS,
  MINE_ARM_TICKS,
  MINE_BURY_TICKS,
  PowerupType,
  SHIELD_WARNING_TICKS,
  SUDDEN_DEATH_START_TICKS,
  TICK_MS,
  TICK_RATE,
  TileType,
  compileMap,
  computePlacements,
  createBot,
  createGame,
  createRng,
  generateMap,
  getMapDef,
  minePhase,
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
import { SKILL_KEY_LABEL } from '../controls';
import { GamepadInput } from '../gamepad';
import { INTERP_DELAY_MS, SnapshotBuffer } from '../interpolation';
import type { GameRoomConnection, NetPlayer, NetRoomState } from '../net';
import { Predictor } from '../prediction';
import type { Obstacle, PredictedPlayer } from '../prediction';
import {
  FREEZE_TINT,
  KICK_TINT,
  SHIELD_TINT,
  SPRITE_SIZE,
  TEX,
  TEXT_RES,
  TILE_SIZE,
  addImage,
} from '../textures';
import type { TexRef } from '../textures';
import { buildSkillsTable } from '../skillsTable';
import type { LobbySceneData } from './LobbyScene';

export type GameSceneData =
  | { mode: 'offline'; seed: number; mapId?: string }
  | { mode: 'online'; connection: GameRoomConnection };

export const HUD_HEIGHT = 40;
/**
 * Gap (px) between the HUD bar and the first grid row. Feet sit at the cell
 * center, so a top-row character's head pokes ~20px above the grid; this margin
 * gives that head room instead of crowding the HUD. Also framed by a border.
 */
export const GRID_TOP_MARGIN = 24;
/**
 * Thickness (px) of the ornamental frame band drawn around the play field, and
 * therefore the grid's inset from the left/right/bottom canvas edges. The top
 * band fits inside GRID_TOP_MARGIN, so only the other three sides need slack.
 */
export const GRID_FRAME_WIDTH = 18;

const HUMAN_ID = 'p0';
const PLAYER_IDS = ['p0', 'p1', 'p2', 'p3'];
/** Max sim steps per frame; if further behind, the backlog is dropped. */
const MAX_STEPS_PER_FRAME = 10;
/** Time constant (ms) for bleeding off prediction corrections. */
const PREDICTION_ERROR_SMOOTH_MS = 100;
/** Correction size (tiles) past which a visible glide reads worse than a snap. */
const PREDICTION_ERROR_SNAP_TILES = 1.5;
/** Online: measure round-trip time by echoing a ping this often. */
const PING_INTERVAL_MS = 2000;
/**
 * Online: how long an optimistically collected powerup stays hidden while we
 * wait for the server to confirm it. Confirmation normally lands within
 * ~RTT + one tick, so a full second means something went wrong (the server saw
 * us somewhere else, or blocked) — give up and put the sprite back.
 */
const PICKUP_ROLLBACK_MS = 1000;

/** Inset (px per side) of a winter block sprite inside its tile, so the floor
 * shows through as a gap and the block reads as a raised object. */
const BLOCK_INSET = 3;

/**
 * Winter art that reads as a free-standing object (lifted like a character for a
 * 3D stand). Flat wall/panel art — the stone wall, window, brick — stays flat on
 * its tile; lifting those looks like they float. Keyed by atlas frame.
 */
const RAISED_BLOCK_FRAMES = new Set([
  'winter_soft_bottles',
  'winter_soft_cans',
  'winter_soft_sled',
  'winter_block_snowball',
]);

const DEPTH = {
  background: -1,
  floor: 0,
  /** Flat on-tile art (floor, flat wall/panel blocks, props): never occludes
   * neighbours, so it sits at the bottom of the stack under all raised art. */
  flat: 1,
  /** Field border: above the flat perimeter walls it hides, below every raised
   * object (which is interior, so the frame must not draw over it). */
  frame: 5,
  // Raised world objects (raised blocks, bombs, powerups, players) are y-sorted
  // by row via worldDepth() and land in the band (row+1)*ROW_DEPTH .. + layer.
  /** Transient effects (explosions, tracers, flashes, skill badges): drawn on
   * top of every world object. */
  effect: 900,
  hud: 1000,
  overlay: 2000,
  /** Skills reference panel: above the results overlay so players can still
   * open it to read up on power-ups after a match ends. */
  skills: 3000,
} as const;

/**
 * Global y-sort granularity: one grid row's worth of depth. Larger than any
 * same-cell WORLD_LAYER offset, so a lower row (bigger y) ALWAYS draws over the
 * row above it. This is what lets a block/bomb/player standing in a lower tile
 * occlude whatever pokes down into it from the tile above.
 */
const ROW_DEPTH = 10;
/** Same-cell draw order for co-located raised objects (offsets < ROW_DEPTH). */
const WORLD_LAYER = { mine: 0, block: 1, powerup: 2, bomb: 3, player: 4 } as const;
/**
 * Depth for a raised world object at grid `row` (may be fractional for smooth
 * player motion). Lower rows get a strictly larger depth than the row above,
 * across every object type — one global y-sort instead of per-type layers.
 */
function worldDepth(row: number, layer: number): number {
  return (row + 1) * ROW_DEPTH + layer;
}
/**
 * Vertical offset (px, + = down) of the bottom-anchored sprite from its cell
 * center. Seats the feet a bit below center — grounded, but not on the tile's
 * bottom edge (TILE_SIZE/2 = 24, the old too-low look). 0 puts feet at dead
 * center (too high/floaty); the shadow tracks this same offset.
 */
const PLAYER_FOOT_OFFSET = 12;
/** Walking bob: vertical sine amplitude (px) and frequency (Hz). Visual only. */
const WALK_BOB_PX = 1.5;
const WALK_BOB_HZ = 8;
/** Position delta (tiles/frame) below which a player counts as standing still. */
const WALK_EPSILON = 0.002;
/** Keep bobbing this long after the last position change: sim positions only move on 20Hz ticks. */
const WALK_HOLD_MS = 120;
/** Bomb pulse tween grows the sprite to this multiple of its base scale. */
const BOMB_PULSE = 1.15;
/** Mine blink period (ms): body lights while armed. */
const MINE_BLINK_MS = 250;
/**
 * Online, only the mine's phase is synced, so the render path's tick count is
 * rebuilt at that phase's first tick. It is never read as an age — `minePhase`
 * turns it straight back into the phase it came from.
 */
const MINE_PHASE_TICKS = [0, MINE_ARM_TICKS, MINE_BURY_TICKS];
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
/**
 * Foot shadow: a soft dark ellipse anchored under the local player's rendered
 * sprite. Anchoring to the sprite (not the logical cell center) keeps the
 * shadow glued to the feet wherever the sprite is actually drawn.
 */
const FOOT_SHADOW = {
  color: 0x000000,
  /** Ellipse radii (px) at the cell center. */
  radiusX: 14,
  radiusY: 5,
  /** Fine vertical nudge (px, + = down) to seat the ellipse on the shoe base. */
  footDrop: 0,
  /** Fill opacity. */
  fillAlpha: 0.28,
} as const;
/**
 * Ornamental frame around the play field, separating it from the HUD and the
 * canvas edges: four mitered dark-stone bands shaded as if lit from the top
 * left, block seams on the tile grid, brass trim on the inner edge, corner
 * plates and rivets. Kept dark and desaturated so it frames the warm floor
 * instead of competing with it.
 */
const GRID_FRAME = {
  width: GRID_FRAME_WIDTH,
  /** Per-side band colors; top lightest (lit), bottom darkest. */
  top: 0x4e3c2f,
  left: 0x4a3a2d,
  right: 0x36281f,
  bottom: 0x2a1f18,
  /** Stone seam lines across the bands, spaced one tile apart. */
  seam: 0x140e0a,
  /** Hairline width, the near-black canvas edge, and the recessed inner edge. */
  hairline: 2,
  outline: 0x0a0705,
  innerLine: 0x100b08,
  /** Warm 1px gleam just inside the outer edge on the lit (top/left) sides. */
  gleam: 0x6b5340,
  /** Brass trim line at the inner edge, and the corner plate fill. */
  trim: 0xc79a52,
  plate: 0x5c4635,
  /** Brass rivet: body, ring and gleam highlight. */
  rivetRadius: 3.5,
  rivetFill: 0xd9a862,
  rivetRing: 0x2a1809,
  rivetGleam: 0xfff0d0,
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
  { key: 'mine', type: PowerupType.Mine, value: (p) => p.mineAmmo, showCount: true },
  { key: 'shield', type: PowerupType.Shield, value: (p) => p.shieldTicks, showCount: false },
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
const toX = (col: number): number => GRID_FRAME_WIDTH + col * TILE_SIZE + TILE_SIZE / 2;
const toY = (row: number): number =>
  HUD_HEIGHT + GRID_TOP_MARGIN + row * TILE_SIZE + TILE_SIZE / 2;

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
  mineAmmo: number;
  shieldTicks: number;
  frozenTicks: number;
  facing: Direction;
}

/** One overhead skill icon (plus its count label for consumable skills). */
interface SkillBadge {
  icon: Phaser.GameObjects.Image;
  count: Phaser.GameObjects.Text | null;
}

/** Synced bombs as movement obstacles; the ownership flags decide whose way
 * each one is in (its owner walks off their own until they leave the tile). */
function serverObstacles(s: NetRoomState): Obstacle[] {
  const bombs: Obstacle[] = [];
  s.bombs.forEach((b) =>
    bombs.push({ col: b.col, row: b.row, ownerId: b.ownerId, ownerOnTile: b.ownerOnTile }),
  );
  return bombs;
}

/** Rebase snapshot of our own synced player, '' mapped back to null. */
function predictedFromNet(p: NetPlayer): PredictedPlayer {
  return {
    id: p.id,
    x: p.x,
    y: p.y,
    speed: p.speed,
    kickTicks: p.kickTicks,
    frozenTicks: p.frozenTicks,
    laneDir: (p.laneDir || null) as PredictedPlayer['laneDir'],
    turnGrace: 0,
    alive: p.alive,
    bombCount: p.bombCount,
    activeBombs: p.activeBombs,
  };
}

/**
 * One rendered mine. `phase` is the phase its visuals were built for, so a
 * change is spotted by comparing against the snapshot; `blink` is that phase's
 * timer, owned by the entry so it dies with the sprite.
 */
interface MineSprite {
  sprite: Phaser.GameObjects.Image;
  phase: number;
  blink: Phaser.Time.TimerEvent | null;
}

export interface RenderState {
  tick: number;
  grid: TileType[][];
  players: RenderPlayer[];
  bombs: { id: number; col: number; row: number; slideInterval: number }[];
  /** `ticks` is the sim's age; the render path only reads it via `minePhase`. */
  mines: { id: number; col: number; row: number; ticks: number }[];
  explosions: { col: number; row: number }[];
  powerups: { col: number; row: number; type: PowerupType }[];
}

/**
 * One match. Offline: local sim (p0) vs 3 bots on a fixed-tick accumulator.
 * Online: authoritative server state, with our own player predicted locally on
 * the same fixed tick and reconciled against the server's input acks; remote
 * players are rendered from the snapshot buffer, INTERP_DELAY_MS in the past.
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
  private predictor: Predictor | null = null;
  /** Time-stamped remote positions; sampled INTERP_DELAY_MS in the past. */
  private snapshots = new SnapshotBuffer();
  /** Rendered-minus-predicted offset, decayed toward 0 (~100ms) to hide corrections. */
  private predictionError = { x: 0, y: 0 };
  private lastAcked = 0;
  /** Slippery-tile mask for prediction; all false on non-winter maps. */
  private iceMask: boolean[][] = [];
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
  /** Gamepad mirror of the direction keys + Space, polled once per frame. */
  private pad!: GamepadInput;
  /**
   * Latched skill presses. A frame can run zero sim steps (or skip an input
   * send), so an edge-triggered press is held here until it is consumed.
   */
  private pendingGun = false;
  private pendingHammer = false;
  private pendingMine = false;
  /** Online: latched Space press, routed to whichever skill is held. */
  private pendingTrigger = false;
  /**
   * Online: this Space press already served a skill, so it must not turn into a
   * bomb when the magazine empties mid-hold. Cleared when Space comes back up.
   */
  private triggerServedSkill = false;

  private playerSprites = new Map<string, Phaser.GameObjects.Image>();
  /** Per-player walking-bob state: sine phase, last-seen position, bob hold left (ms). */
  private walkAnim = new Map<string, { phase: number; lastX: number; lastY: number; holdMs: number }>();
  /**
   * Position each tick-quantized player held *before* the last executed sim step.
   * Rendering blends it with the current position by the leftover-accumulator
   * fraction, so 20Hz sim positions come out as 60fps motion. Populated for every
   * player offline, and for our own predicted player only online — remote players
   * are already smoothed by the snapshot buffer.
   */
  private prevTickPos = new Map<string, { x: number; y: number }>();
  /** Start-of-match arrow over the local player; null once it has faded out. */
  private myPointer: Phaser.GameObjects.Triangle | null = null;
  /** Hover offset for the arrow, tweened separately so it can also follow. */
  private myPointerBob = { y: 0 };
  /** Crosshair over the tile a held hammer would strike; null until armed. */
  private hammerTarget: Phaser.GameObjects.Graphics | null = null;
  /** Soft shadow under the local player's feet, grounding them to their cell. */
  private myFootShadow: Phaser.GameObjects.Graphics | null = null;
  /** Overhead skill icons per player, keyed by SKILL_BADGES entry. */
  private skillBadges = new Map<string, Map<string, SkillBadge>>();
  /** Previous-frame badge values per player, to detect a 0 -> >0 pickup. */
  private prevSkillValues = new Map<string, Map<string, number>>();
  /** Online: last-seen gun/hammer counts, to derive skill FX from state diffs. */
  private prevGunAmmo = new Map<string, number>();
  private prevHammerUses = new Map<string, number>();
  private softBlockSprites = new Map<string, Phaser.GameObjects.Image>();
  private bombSprites = new Map<number, { sprite: Phaser.GameObjects.Image; col: number; row: number }>();
  private mineSprites = new Map<number, MineSprite>();
  private explosionSprites = new Map<string, Phaser.GameObjects.Image>();
  private powerupSprites = new Map<string, { sprite: Phaser.GameObjects.Image; ref: TexRef }>();
  /** Cells whose bomb vanished this reconcile pass — the explosion's origin. */
  private explosionCenters = new Set<string>();
  /**
   * Online: cells whose powerup we hid the moment our predicted body stepped
   * onto it, mapped to the deadline past which we stop waiting for the server
   * and unhide. Sprite + sound only; every stat stays server-authoritative.
   */
  private pendingPickups = new Map<string, number>();

  private hudText!: Phaser.GameObjects.Text;
  private suddenDeathText!: Phaser.GameObjects.Text;

  /** In-game skills reference overlay: objects + visibility flag. */
  private skillsPanel: Phaser.GameObjects.GameObject[] = [];
  private skillsShown = false;

  constructor() {
    super('Game');
  }

  create(data: GameSceneData): void {
    if (import.meta.env.DEV) (window as never as { __scene?: unknown }).__scene = this;
    this.mode = data.mode;
    this.accumulator = 0;
    this.gameOver = false;
    this.appliedDestroyed = 0;
    this.appliedShrunk = 0;
    this.predictor = null;
    this.snapshots = new SnapshotBuffer();
    this.predictionError = { x: 0, y: 0 };
    this.lastAcked = 0;
    this.pingMs = null;
    this.pingTimerMs = 0;
    this.roomClosed = false;
    this.suddenDeathWarned = false;
    this.pendingGun = false;
    this.pendingHammer = false;
    this.pendingMine = false;
    this.pendingTrigger = false;
    this.triggerServedSkill = false;
    this.prevAlive.clear();
    this.prevGunAmmo.clear();
    this.prevHammerUses.clear();
    this.playerSprites.clear();
    this.walkAnim.clear();
    this.prevTickPos.clear();
    this.myPointer = null;
    this.myPointerBob.y = 0;
    this.hammerTarget = null;
    this.myFootShadow = null;
    this.skillBadges.clear();
    this.prevSkillValues.clear();
    this.softBlockSprites.clear();
    this.bombSprites.clear();
    this.mineSprites.clear();
    this.explosionSprites.clear();
    this.powerupSprites.clear();
    this.explosionCenters.clear();
    this.pendingPickups.clear();
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
      // Predict our own player only. An older server has no ack field to
      // reconcile against, so we render its state unpredicted instead.
      const own = data.connection.room.state.players.get(this.myId);
      if (own && typeof own.lastInputSeq === 'number') {
        this.predictor = new Predictor(predictedFromNet(own));
      }
      data.connection.room.state.players.forEach((p, id) =>
        this.characterByPlayer.set(id, p.character),
      );
      // Every patch is a snapshot of where the server says everyone is;
      // rendering samples this history INTERP_DELAY_MS in the past. Our own
      // player is recorded too: it is unused while predicted, but against an
      // old server (no acks, no predictor) it is what smooths our own sprite.
      const onPatch = (): void => {
        const positions = new Map<string, { x: number; y: number }>();
        data.connection.room.state.players.forEach((p, id) => {
          positions.set(id, { x: p.x, y: p.y });
        });
        this.snapshots.push(performance.now(), positions);
      };
      data.connection.room.onStateChange(onPatch);
      data.connection.room.onLeave(this.onRoomLeave);
      // The room outlives this scene across rematches, so every handler
      // registered here must come off on shutdown — a leaked one stacks up
      // once per match.
      const offPong = data.connection.room.onMessage('pong', (t: number) => {
        this.pingMs = Math.max(0, Math.round(performance.now() - t));
      });
      this.events.once('shutdown', () => {
        data.connection.room.onStateChange.remove(onPatch);
        data.connection.room.onLeave.remove(this.onRoomLeave);
        offPong();
      });
      initial = this.renderStateFromRoom();
    }

    this.setupInput();
    this.drawStaticGrid(initial);
    this.createPlayerSprites(initial);
    this.createHud();
    this.reconcile(initial);
    this.updateHud(initial);
    this.positionPlayers(initial, 1, 0);
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
    this.iceMask =
      this.compiled?.ice ?? Array.from({ length: GRID_HEIGHT }, () => Array<boolean>(GRID_WIDTH).fill(false));
    this.theme = def?.theme ?? 'classic';
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
      // Snapshot before every step, so after the loop this holds the state the
      // LAST executed step started from — the near end of the render blend.
      for (const p of this.sim!.state.players) this.prevTickPos.set(p.id, { x: p.x, y: p.y });
      this.stepSim();
      steps++;
    }
    // Fell too far behind (tab hidden, etc.): drop the backlog instead of spiraling.
    if (this.accumulator >= TICK_MS) this.accumulator = 0;

    // Leftover time since the last tick, as a fraction of one tick.
    const alpha = Math.min(1, this.accumulator / TICK_MS);
    this.positionPlayers(this.sim!.state, 1, delta, alpha);
  }

  private stepSim(): void {
    const state = this.sim!.state;
    const inputs: Record<string, PlayerInput> = {
      // Holding Space keeps placing; the sim self-limits via bomb caps + per-tile.
      // Gun/hammer are one-shot: the latch is cleared as this tick consumes it.
      [HUMAN_ID]: {
        direction: this.currentDirection(),
        placeBomb: this.triggerHeld(),
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
      case 'mineExploded':
        audio.explosion();
        break;
      case 'minePlaced':
        audio.bombPlace();
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

    // Trigger routing stays per-frame so no key edge is lost between steps.
    // While a skill is held, Space is the skill trigger instead: it goes out as
    // an edge-latched skill flag and never as `placeBomb`, so a held Space can
    // never empty the magazine in a fraction of a second.
    this.pollSkillKeys();
    const direction = this.currentDirection();
    const armed = this.myArmedSkill();
    if (armed === 'gun' && this.pendingTrigger) this.pendingGun = true;
    if (armed === 'hammer' && this.pendingTrigger) this.pendingHammer = true;
    if (armed === 'mine' && this.pendingTrigger) this.pendingMine = true;
    this.pendingTrigger = false;
    const triggerHeld = this.triggerHeld();
    if (!triggerHeld) this.triggerServedSkill = false;
    else if (armed !== null) this.triggerServedSkill = true;
    const bombHeld = armed === null && triggerHeld && !this.triggerServedSkill;

    // One sequenced input per sim step: the server applies each for exactly one
    // tick, so held-key duration (and therefore distance) is reproduced exactly.
    this.accumulator += delta;
    let steps = 0;
    while (this.accumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= TICK_MS;
      this.stepOnline(direction, bombHeld);
      steps++;
    }
    // Fell too far behind (tab hidden, etc.): drop the backlog instead of spiraling.
    if (this.accumulator >= TICK_MS) this.accumulator = 0;

    // Grid deltas land before the replay below, not after it in renderStateFromRoom:
    // an ack that arrives together with a block destruction must replay against the
    // opened tile, or the replay walks into a wall the server already removed. Both
    // are index-tracked and idempotent, so the later call is a no-op.
    this.applyDestroyedBlocks(room.state);
    this.applyArenaShrunk(room.state);

    // Reconcile: rebase onto the server's last-applied input, replay the rest.
    const own = room.state.players.get(this.myId);
    // Bot-driven session (__botDirect): the scene sends no seq'd inputs, so no
    // acks ever arrive and the reconcile below never runs — the predictor
    // would freeze while the server moves this player, and the own window
    // renders its sprite tiles away from where every other window (and the
    // server) has it. Track the server state directly instead; the sub-tick
    // render blend still smooths the patch-rate steps.
    const botDirectView =
      import.meta.env.DEV && (window as unknown as { __botDirect?: boolean }).__botDirect === true;
    if (botDirectView && this.predictor && own) {
      Object.assign(this.predictor.player, predictedFromNet(own));
    } else if (this.predictor && own && own.lastInputSeq !== this.lastAcked) {
      const err = this.predictor.reconcile(
        predictedFromNet(own),
        own.lastInputSeq,
        this.grid!,
        this.iceMask,
        serverObstacles(room.state),
      );
      this.predictionError.x += err.dx;
      this.predictionError.y += err.dy;
      // The rebase moved the predicted position by -err; shift the render blend's
      // near end by the same amount so it stays on the new basis. Without this the
      // correction the error term is hiding leaks back in as an alpha-scaled jump.
      const prev = this.prevTickPos.get(this.myId);
      if (prev) {
        prev.x -= err.dx;
        prev.y -= err.dy;
      }
      // Past the threshold (a resumed stall, say) glide across the arena would be
      // worse than the single-frame jump, so drop the correction and snap.
      if (Math.hypot(this.predictionError.x, this.predictionError.y) > PREDICTION_ERROR_SNAP_TILES) {
        this.predictionError.x = 0;
        this.predictionError.y = 0;
      }
      this.lastAcked = own.lastInputSeq;
    }
    // Corrections slide out over ~100ms instead of snapping.
    const decay = Math.exp(-delta / PREDICTION_ERROR_SMOOTH_MS);
    this.predictionError.x *= decay;
    this.predictionError.y *= decay;

    // Claim the powerup under our predicted feet before the server gets to it,
    // so the sprite and the sound land on the frame we walk in rather than a
    // round trip later. renderStateFromRoom then hides it for us.
    this.trackOptimisticPickup();

    const state = this.renderStateFromRoom();
    this.reconcile(state);
    // Retiring pending entries has to come after reconcile: the pass that sees
    // the server's own removal still needs the entry to know it already played
    // that pickup sound optimistically.
    this.sweepPendingPickups();
    this.trackOnlineDeaths(state);
    this.trackOnlineSkillUse(state);
    this.updateHud(state);
    // Everything snaps, because every target is already smooth: our own predicted
    // player by the sub-tick blend below (plus its prediction error decay),
    // everyone else by the interpolation buffer.
    const alpha = Math.min(1, this.accumulator / TICK_MS);
    this.positionPlayers(state, 1, delta, alpha);

    if (room.state.phase === 'finished' && !this.gameOver) {
      this.showRanking();
    }
  }

  /** One predicted client tick: advance the local player and send its input. */
  private stepOnline(direction: Direction | null, bombHeld: boolean): void {
    const room = this.connection!.room;
    const serverBombs = serverObstacles(room.state);

    let seq = 0;
    if (this.predictor) {
      // Near end of the render blend: where we were before this step ran.
      this.prevTickPos.set(this.myId, { x: this.predictor.player.x, y: this.predictor.player.y });
      const input = this.predictor.step(
        direction,
        bombHeld,
        this.grid!,
        this.iceMask,
        serverBombs,
        this.pingMs ?? 0,
      );
      // Turn grace teleports the sim onto the junction (up to GRACE_CAP tiles
      // in one tick). Feed the jump into the same error accumulator reconcile
      // corrections use — the sprite glides there over ~100ms instead of
      // popping — and rebase the sub-tick blend's near end like reconcile does.
      const snap = this.predictor.lastGraceSnap;
      if (snap) {
        this.predictionError.x -= snap.dx;
        this.predictionError.y -= snap.dy;
        const prev = this.prevTickPos.get(this.myId);
        if (prev) {
          prev.x += snap.dx;
          prev.y += snap.dy;
        }
      }
      this.predictor.ageBombs();
      seq = input.seq;
    }
    // Dev/sim hook: the multiplayer-sim bot driver sets __botDirect and sends
    // legacy inputs on the room itself — the seq'd stream here would both
    // outrank those sends and build queue backlog (bursty rAF catch-up ticks
    // overfill the server's per-tick input queue, adding ~250ms of permanent
    // input latency in headless windows).
    const botDirect =
      import.meta.env.DEV && (window as unknown as { __botDirect?: boolean }).__botDirect === true;
    if (!this.roomClosed && !botDirect) {
      // seq 0 (no predictor) lands in the server's legacy latest-wins path.
      room.send('input', {
        seq,
        direction,
        placeBomb: bombHeld,
        fireGun: this.pendingGun,
        swingHammer: this.pendingHammer,
        placeMine: this.pendingMine,
        pingMs: this.pingMs ?? 0,
      });
      this.pendingGun = false;
      this.pendingHammer = false;
      this.pendingMine = false;
    }
  }

  /**
   * Optimistic pickup: our own body is predicted, so it reaches a powerup about
   * a round trip before the server's collection shows up in the synced state,
   * and the item sits visibly under our feet in the meantime. Standing on one
   * therefore hides it and plays the sound right away, and the cell is
   * remembered so the sprite can come back if the server disagrees. Purely
   * cosmetic — speed/bombs/blast still only move when the server says so.
   */
  private trackOptimisticPickup(): void {
    const predictor = this.predictor;
    if (!predictor || !predictor.player.alive) return;
    const s: NetRoomState = this.connection!.room.state;
    if (s.powerups.length === 0) return;

    const col = Math.round(predictor.player.x);
    const row = Math.round(predictor.player.y);
    const key = cellKey(col, row);
    if (this.pendingPickups.has(key)) return;

    let here = false;
    s.powerups.forEach((p) => {
      if (p.col === col && p.row === row) here = true;
    });
    if (!here) return;
    // Mirrors the sim: nothing is collected under an explosion, so claiming a
    // powerup on a burning cell would always be rolled back (and we are dying).
    let burning = false;
    s.explosions.forEach((e) => {
      if (e.col === col && e.row === row) burning = true;
    });
    if (burning) return;

    this.pendingPickups.set(key, performance.now() + PICKUP_ROLLBACK_MS);
    audio.powerup();
  }

  /**
   * Retires pending pickups. A cell the server no longer lists a powerup on is
   * confirmed (or the item burned) — the sprite is already gone and the sound
   * already played, so just drop the entry. A cell past its deadline is a
   * refusal: dropping it makes renderStateFromRoom surface the powerup again on
   * the next frame, and reconcilePowerups rebuilds the sprite.
   */
  private sweepPendingPickups(): void {
    if (this.pendingPickups.size === 0) return;
    const live = new Set<string>();
    this.connection!.room.state.powerups.forEach((p) => live.add(cellKey(p.col, p.row)));
    const now = performance.now();
    for (const [key, expiry] of this.pendingPickups) {
      if (!live.has(key) || now >= expiry) this.pendingPickups.delete(key);
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
        mineAmmo: p.mineAmmo,
        shieldTicks: p.shieldTicks,
        frozenTicks: p.frozenTicks,
        facing: p.facing,
      }),
    );
    players.sort((a, b) => a.id.localeCompare(b.id));
    // Our own player renders from the raw prediction; positionPlayers blends it
    // across the sub-tick and adds the decaying correction on top of that blend.
    // Once the server says we are dead, the ghost falls back to its coordinates —
    // and the blend's near end goes with it, since it is on the other basis.
    if (this.predictor) {
      const own = players.find((p) => p.id === this.myId);
      if (own && own.alive) {
        own.x = this.predictor.player.x;
        own.y = this.predictor.player.y;
      } else {
        this.prevTickPos.delete(this.myId);
      }
    }
    // Remote players render slightly in the past, interpolated between the two
    // snapshots bracketing that time. Positions only — every other field stays
    // at the server's latest value.
    const renderT = performance.now() - INTERP_DELAY_MS;
    for (const p of players) {
      if (p.id === this.myId && this.predictor) continue;
      const s = this.snapshots.sample(p.id, renderT);
      if (s) {
        p.x = s.x;
        p.y = s.y;
      }
    }

    const bombs: RenderState['bombs'] = [];
    s.bombs.forEach((b) => bombs.push({ id: b.id, col: b.col, row: b.row, slideInterval: b.slideInterval }));
    if (this.predictor) {
      for (const b of this.predictor.bombs) {
        // Skip predicted bombs the server has since confirmed on the same tile.
        if (!bombs.some((sb) => sb.col === b.col && sb.row === b.row)) {
          bombs.push({ id: b.id, col: b.col, row: b.row, slideInterval: 0 });
        }
      }
    }
    // Mines stay server-authoritative — no prediction, so the synced phase is the
    // only source: map it back to a representative tick count for the renderer.
    const mines: RenderState['mines'] = [];
    s.mines.forEach((m) =>
      mines.push({ id: m.id, col: m.col, row: m.row, ticks: MINE_PHASE_TICKS[m.phase] ?? 0 }),
    );
    const explosions: RenderState['explosions'] = [];
    s.explosions.forEach((e) => explosions.push({ col: e.col, row: e.row }));
    const powerups: RenderState['powerups'] = [];
    // Powerups we already claimed optimistically are reported as gone, which is
    // what makes their sprite vanish the instant we step on them.
    s.powerups.forEach((p) => {
      if (this.pendingPickups.has(cellKey(p.col, p.row))) return;
      powerups.push({ col: p.col, row: p.row, type: p.type });
    });

    return { tick: s.tick, grid: this.grid!, players, bombs, mines, explosions, powerups };
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
    this.pad = new GamepadInput();
  }

  /**
   * Latches this frame's trigger press and reads the pad. JustDown consumes
   * the edge, so it must be polled exactly once per frame regardless of how many
   * sim steps or input sends follow.
   */
  private pollSkillKeys(): void {
    this.pad.poll(this.time.now);
    if (Phaser.Input.Keyboard.JustDown(this.spaceKey) || this.pad.consumeTriggerPress()) {
      this.pendingTrigger = true;
    }
  }

  /** Space or the pad's trigger button: bomb, gun, hammer and mine all ride this one. */
  private triggerHeld(): boolean {
    return this.spaceKey.isDown || this.pad.triggerHeld;
  }

  /**
   * Which skill Space triggers right now, or null when it still places bombs.
   * Online only: offline the sim reads the held key and edges it itself.
   */
  private myArmedSkill(): 'gun' | 'hammer' | 'mine' | null {
    const me = this.connection?.room.state.players.get(this.myId);
    if (!me) return null;
    if (me.gunAmmo > 0) return 'gun';
    if (me.hammerUses > 0) return 'hammer';
    if (me.mineAmmo > 0) return 'mine';
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
    // Pad press times share the keyboard's clock, so both sources sort together.
    for (const [dir, time] of this.pad.heldDirections()) {
      if (time > latestTime) {
        latestTime = time;
        latest = dir;
      }
    }
    return latest;
  }

  // --- rendering ---

  private drawStaticGrid(state: RenderState): void {
    // Backdrop spans the top margin too, so a top-row head pokes onto floor
    // rather than the HUD bar. The HUD bar above stays solid dark.
    const fieldTop = HUD_HEIGHT;
    const fieldHeight = GRID_TOP_MARGIN + GRID_HEIGHT * TILE_SIZE + GRID_FRAME_WIDTH;
    addImage(this, 0, fieldTop, TEX.background)
      .setOrigin(0, 0)
      .setDisplaySize(this.scale.width, fieldHeight)
      .setDepth(DEPTH.background);
    this.drawFieldFrame(fieldTop, fieldTop + fieldHeight);

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
        .setDepth(DEPTH.flat);
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
   * Winter block sprite. Free-standing object art (RAISED_BLOCK_FRAMES) renders
   * like a character: bottom-anchored on the ground line (cell center +
   * PLAYER_FOOT_OFFSET) so it rises upward and pokes into the tile above for a 3D
   * stand. Flat wall/panel art sits centered on its tile. No shadow — only
   * characters cast one.
   */
  private addWinterBlock(col: number, row: number, ref: TexRef): Phaser.GameObjects.Image {
    const size = TILE_SIZE - BLOCK_INSET * 2;
    const raised = RAISED_BLOCK_FRAMES.has(ref.frame);
    const img = addImage(this, toX(col), toY(row), ref)
      .setDisplaySize(size, size)
      // Raised art y-sorts with bombs/players; flat wall/panel art stays low.
      .setDepth(raised ? worldDepth(row, WORLD_LAYER.block) : DEPTH.flat);
    if (raised) {
      // Bottom-anchored on the player's ground line; art rises and pokes above.
      img.setOrigin(0.5, 1).setY(toY(row) + PLAYER_FOOT_OFFSET);
    }
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
    // Flat depth so the field frame can hide the perimeter cones' outer faces.
    const img = addImage(this, toX(col), toY(row), TEX.hardBlock).setDepth(DEPTH.flat);
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
      .setDepth(DEPTH.effect);
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
      .setDepth(DEPTH.effect);
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
      // Bottom-center anchored, feet at the cell center for a 3D look.
      const sprite = addImage(this, toX(player.x), toY(player.y) + PLAYER_FOOT_OFFSET, ref)
        .setOrigin(0.5, 1)
        .setDepth(worldDepth(player.y, WORLD_LAYER.player));
      sprite.setScale(SPRITE_SIZE.playerHeight / sprite.height);
      this.playerSprites.set(player.id, sprite);
    }
  }

  /**
   * Moves player sprites; lerp=1 snaps, lower values smooth toward the target.
   * `alpha` is the sub-tick fraction used to blend tick-quantized players (those
   * with a `prevTickPos` entry) between their previous and current tick position,
   * so a 20Hz sim renders as continuous 60fps motion. Visual only: nothing here
   * writes back into any state the sim, predictor or network reads.
   */
  private positionPlayers(
    state: Pick<RenderState, 'players'>,
    lerp: number,
    delta: number,
    alpha = 1,
  ): void {
    for (const player of state.players) {
      const sprite = this.playerSprites.get(player.id);
      if (!sprite) continue;

      let rx = player.x;
      let ry = player.y;
      const prev = this.prevTickPos.get(player.id);
      if (prev) {
        rx = prev.x + (player.x - prev.x) * alpha;
        ry = prev.y + (player.y - prev.y) * alpha;
        // Online own player: the render state carries the bare prediction, so the
        // decaying correction rides on top of the blend (tile units, pre-toX()).
        if (this.predictor && player.id === this.myId) {
          rx += this.predictionError.x;
          ry += this.predictionError.y;
        }
      }
      const tx = toX(rx);
      const ty = toY(ry) + PLAYER_FOOT_OFFSET; // feet at cell center

      let anim = this.walkAnim.get(player.id);
      if (!anim) {
        anim = { phase: 0, lastX: player.x, lastY: player.y, holdMs: 0 };
        this.walkAnim.set(player.id, anim);
      }
      // Movement is judged on the tick position, which only changes every 50ms,
      // so a single moving step holds the bob alive over the frames in between.
      const stepped =
        Math.abs(player.x - anim.lastX) > WALK_EPSILON ||
        Math.abs(player.y - anim.lastY) > WALK_EPSILON;
      anim.lastX = player.x;
      anim.lastY = player.y;
      anim.holdMs = stepped ? WALK_HOLD_MS : Math.max(0, anim.holdMs - delta);
      const moving = player.alive && anim.holdMs > 0;
      anim.phase = moving ? anim.phase + (delta / 1000) * WALK_BOB_HZ * Math.PI * 2 : 0;
      const bob = moving ? Math.abs(Math.sin(anim.phase)) * -WALK_BOB_PX : 0;

      sprite.setPosition(sprite.x + (tx - sprite.x) * lerp, sprite.y + (ty + bob - sprite.y) * lerp);
      sprite.setDepth(worldDepth(ry, WORLD_LAYER.player));
      sprite.setAlpha(player.alive ? 1 : 0.3); // dead players linger as ghosts
      // Tint precedence: frozen (ice blue) > shield (gold, blinking over the
      // last 2s) > kick's cyan/red scheme. Freeze winning the sprite loses no
      // information: the overhead shield badge still marks that buff.
      // Freeze and shield gate on `alive` because the sim leaves frozenTicks /
      // shieldTicks set on a dead player — kick needs no gate, death zeroes
      // kickTicks. Ghosts therefore render untinted, whatever they held.
      const shieldWarning = player.shieldTicks > 0 && player.shieldTicks <= SHIELD_WARNING_TICKS;
      const shieldBlinkOn = Math.floor(player.shieldTicks / 5) % 2 === 0;
      const warning = player.kickTicks > 0 && player.kickTicks <= KICK_WARNING_TICKS;
      const blinkOn = Math.floor(player.kickTicks / 5) % 2 === 0;
      // Freeze windup: the lock has not engaged yet — blink as a telegraph.
      const freezeWindup = player.frozenTicks > FREEZE_DURATION_TICKS;
      const freezeBlinkOn = Math.floor(player.frozenTicks / 5) % 2 === 0;
      if (player.alive && player.frozenTicks > 0) {
        if (!freezeWindup || freezeBlinkOn) sprite.setTint(FREEZE_TINT);
        else sprite.clearTint();
      }
      else if (player.alive && player.shieldTicks > SHIELD_WARNING_TICKS) sprite.setTint(SHIELD_TINT);
      else if (player.alive && shieldWarning) {
        if (shieldBlinkOn) sprite.setTint(SHIELD_TINT);
        else sprite.clearTint();
      } else if (player.kickTicks > KICK_WARNING_TICKS) sprite.setTint(KICK_TINT);
      else if (warning) {
        if (blinkOn) sprite.setTint(KICK_WARNING_TINT);
        else sprite.clearTint();
      } else sprite.clearTint();

      this.updateSkillBadges(player, sprite, warning, blinkOn);

      if (this.myPointer && player.id === this.myId) {
        const place = this.myPointerPlacement(sprite);
        this.myPointer.setPosition(sprite.x, place.y).setRotation(place.flip ? Math.PI : 0);
      }
      if (player.id === this.myId) {
        this.updateHammerTarget(player);
        this.updateMyFootShadow(player, sprite);
      }
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

  /**
   * Moves the foot shadow under the local player's rendered sprite, so it stays
   * glued to the feet instead of snapping to the logical cell. Hidden once dead.
   */
  private updateMyFootShadow(me: RenderPlayer, sprite: Phaser.GameObjects.Image): void {
    if (!me.alive) {
      this.myFootShadow?.setVisible(false);
      return;
    }
    if (!this.myFootShadow) this.myFootShadow = this.createFootShadow();
    this.myFootShadow.setVisible(true).setPosition(sprite.x, sprite.y + FOOT_SHADOW.footDrop);
  }

  /**
   * Ornamental frame filling the margin around the play field: mitered bands
   * shaded as if lit from the top-left, masonry seams on the tile grid, corner
   * plates over the miter joints, brass trim at the inner edge and rivets. Drawn
   * above the blocks (the perimeter is hard blocks, which would otherwise hide
   * three sides) but below players, so top-row heads poking into the top margin
   * still render over it.
   */
  private drawFieldFrame(top: number, bottom: number): void {
    const { width: t, hairline: hl } = GRID_FRAME;
    const right = this.scale.width;
    const g = this.add.graphics().setDepth(DEPTH.frame);
    const band = (color: number, points: number[][]): void => {
      g.fillStyle(color, 1);
      g.fillPoints(
        points.map(([x, y]) => new Phaser.Geom.Point(x, y)),
        true
      );
    };
    band(GRID_FRAME.top, [
      [0, top],
      [right, top],
      [right - t, top + t],
      [t, top + t],
    ]);
    band(GRID_FRAME.bottom, [
      [t, bottom - t],
      [right - t, bottom - t],
      [right, bottom],
      [0, bottom],
    ]);
    band(GRID_FRAME.left, [
      [0, top],
      [t, top + t],
      [t, bottom - t],
      [0, bottom],
    ]);
    band(GRID_FRAME.right, [
      [right, top],
      [right, bottom],
      [right - t, bottom - t],
      [right - t, top + t],
    ]);
    // Stone seams, one per tile boundary, so the frame reads as masonry and its
    // rhythm lines up with the grid inside it.
    g.lineStyle(1, GRID_FRAME.seam, 1);
    for (let col = 1; col < GRID_WIDTH; col++) {
      const x = t + col * TILE_SIZE;
      g.lineBetween(x, top, x, top + t);
      g.lineBetween(x, bottom - t, x, bottom);
    }
    for (let row = 1; row < GRID_HEIGHT; row++) {
      const y = top + GRID_TOP_MARGIN + row * TILE_SIZE;
      g.lineBetween(0, y, t, y);
      g.lineBetween(right - t, y, right, y);
    }
    // Corner plates cover the miter joints, where the seams would collide.
    g.fillStyle(GRID_FRAME.plate, 1);
    g.lineStyle(1, GRID_FRAME.trim, 1);
    for (const [x, y] of [
      [0, top],
      [right - t, top],
      [0, bottom - t],
      [right - t, bottom - t],
    ]) {
      g.fillRect(x, y, t, t);
      g.strokeRect(x, y, t, t);
    }
    // Outer hairline is inset by half its width so the canvas doesn't clip it.
    g.lineStyle(hl, GRID_FRAME.outline, 1);
    g.strokeRect(hl / 2, top + hl / 2, right - hl, bottom - top - hl);
    // Warm gleam on the lit sides, then brass trim and a shadow line at the
    // inner edge so the field reads as recessed behind the frame.
    g.lineStyle(1, GRID_FRAME.gleam, 1);
    g.lineBetween(hl, top + hl + 1, right - hl, top + hl + 1);
    g.lineBetween(hl + 1, top + hl, hl + 1, bottom - hl);
    g.lineStyle(1, GRID_FRAME.trim, 1);
    g.strokeRect(t - 2, top + t - 2, right - 2 * t + 4, bottom - top - 2 * t + 4);
    g.lineStyle(hl, GRID_FRAME.innerLine, 1);
    g.strokeRect(t - hl / 2, top + t - hl / 2, right - 2 * t + hl, bottom - top - 2 * t + hl);

    const mid = t / 2;
    const midX = right / 2;
    const midY = (top + bottom) / 2;
    for (const [x, y] of [
      [mid, top + mid],
      [right - mid, top + mid],
      [mid, bottom - mid],
      [right - mid, bottom - mid],
      [midX, top + mid],
      [midX, bottom - mid],
      [mid, midY],
      [right - mid, midY],
    ]) {
      this.drawRivet(g, x, y);
    }
  }

  private drawRivet(g: Phaser.GameObjects.Graphics, x: number, y: number): void {
    const { rivetRadius: r, rivetFill, rivetRing, rivetGleam } = GRID_FRAME;
    g.fillStyle(rivetRing, 0.85);
    g.fillCircle(x, y, r + 1);
    g.fillStyle(rivetFill, 1);
    g.fillCircle(x, y, r);
    g.fillStyle(rivetGleam, 0.9);
    g.fillCircle(x - r * 0.35, y - r * 0.35, r * 0.35);
  }

  private createFootShadow(): Phaser.GameObjects.Graphics {
    const { color, radiusX, radiusY, fillAlpha } = FOOT_SHADOW;
    // Drawn centered on (0,0); setPosition places it under the feet. Sits on the
    // floor, beneath blocks, bombs and players.
    const g = this.add.graphics().setDepth(DEPTH.floor + 0.1);
    g.fillStyle(color, fillAlpha);
    g.fillEllipse(0, 0, radiusX * 2, radiusY * 2);
    return g;
  }

  private createHammerTarget(): Phaser.GameObjects.Graphics {
    const { color, width, inset } = HAMMER_TARGET;
    const arm = TILE_SIZE / 2 - inset;
    const g = this.add.graphics().setDepth(DEPTH.effect);
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
        const icon = addImage(this, x, rowY, TEX.powerup[skill.type]).setDepth(DEPTH.effect);
        icon.setScale(SKILL_BADGE_HEIGHT / Math.max(icon.width, icon.height));
        const count = skill.showCount
          ? this.add
              .text(x, rowY + SKILL_BADGE_HEIGHT / 2, '', {
                fontFamily: 'monospace',
                fontSize: '11px',
                color: '#ffffff',
                resolution: TEXT_RES,
              })
              .setOrigin(0.5, 0.5)
              .setDepth(DEPTH.effect)
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
    this.reconcileMines(state);
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
                  .setDepth(DEPTH.flat),
          );
        } else if (!isSoft && sprite) {
          sprite.destroy();
          this.softBlockSprites.delete(key);
        }
      }
    }
  }

  private reconcileBombs(state: RenderState): void {
    // Adoption first: the frame the server confirms one of our predicted bombs,
    // the predicted id leaves the render state and the server id arrives in the
    // same pass. Re-keying the sprite before the removal sweep below keeps the
    // very same sprite alive — no flicker, and no second bomb-place sound.
    for (const bomb of state.bombs) {
      if (bomb.id <= 0 || this.bombSprites.has(bomb.id)) continue;
      for (const [pid, pentry] of this.bombSprites) {
        if (pid < 0 && pentry.col === bomb.col && pentry.row === bomb.row) {
          this.bombSprites.delete(pid);
          this.bombSprites.set(bomb.id, pentry);
          break;
        }
      }
    }

    const liveIds = new Set(state.bombs.map((b) => b.id));
    this.explosionCenters.clear();
    for (const [id, entry] of this.bombSprites) {
      if (!liveIds.has(id)) {
        // A vanished server bomb marks its cell as the explosion origin this
        // pass; predicted bombs (id < 0) vanish by adoption, not explosion.
        if (id > 0) this.explosionCenters.add(cellKey(entry.col, entry.row));
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
          // Re-sort as it crosses rows so it occludes / is occluded correctly.
          existing.sprite.setDepth(worldDepth(bomb.row, WORLD_LAYER.bomb));
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
      // Reached only by genuinely new bombs (an adopted one hit `existing`
      // above), so a predicted bomb plays this once, when it first appears.
      if (this.mode === 'online') audio.bombPlace(); // offline plays via bombPlaced event
      const sprite = addImage(this, toX(bomb.col), toY(bomb.row), TEX.bomb).setDepth(
        worldDepth(bomb.row, WORLD_LAYER.bomb),
      );
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

  /**
   * Mines never move and are never predicted, so this is add/remove plus a
   * phase watch: a mine that left the map detonated, and its boom is already
   * drawn (and sounded) by the explosion cell it spawned.
   */
  private reconcileMines(state: RenderState): void {
    const liveIds = new Set(state.mines.map((m) => m.id));
    for (const [id, entry] of this.mineSprites) {
      if (!liveIds.has(id)) {
        entry.blink?.remove();
        entry.sprite.destroy();
        this.mineSprites.delete(id);
      }
    }
    for (const mine of state.mines) {
      const phase = minePhase(mine.ticks);
      const existing = this.mineSprites.get(mine.id);
      if (existing) {
        if (existing.phase !== phase) {
          existing.phase = phase;
          this.showMinePhase(existing, phase);
        }
        continue;
      }
      if (this.mode === 'online') audio.bombPlace(); // offline plays via minePlaced event
      const sprite = addImage(this, toX(mine.col), toY(mine.row), TEX.mine.dull).setDepth(
        worldDepth(mine.row, WORLD_LAYER.mine),
      );
      const entry: MineSprite = { sprite, phase, blink: null };
      this.showMinePhase(entry, phase);
      this.mineSprites.set(mine.id, entry);
    }
  }

  /**
   * Dresses a mine for one phase: inert lies still, armed alternates its lights,
   * buried hides the sprite entirely (bomb blasts can destroy mines, so full
   * invisibility is fair). Each phase owns its repeating timer, so the one
   * before it is always cleared first.
   */
  private showMinePhase(entry: MineSprite, phase: number): void {
    entry.blink?.remove();
    entry.blink = null;
    const { sprite } = entry;
    if (phase === 2) {
      sprite.setVisible(false);
      return;
    }
    sprite.setVisible(true);
    this.setMineFrame(sprite, TEX.mine.dull, SPRITE_SIZE.mineHeight);
    if (phase !== 1) return;
    let lit = false;
    entry.blink = this.time.addEvent({
      delay: MINE_BLINK_MS,
      loop: true,
      callback: () => {
        lit = !lit;
        this.setMineFrame(sprite, lit ? TEX.mine.lit : TEX.mine.dull, SPRITE_SIZE.mineHeight);
      },
    });
  }

  /** The mine frames are drawn at different sizes, so a swap has to rescale. */
  private setMineFrame(sprite: Phaser.GameObjects.Image, ref: TexRef, height: number): void {
    sprite.setTexture(ref.key, ref.frame);
    sprite.setScale(height / sprite.height);
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
        .setDepth(DEPTH.effect);
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
          // ...unless we claimed this cell optimistically, in which case the
          // sound already played on the frame we stepped onto it.
          if (collected && !this.pendingPickups.has(key)) audio.powerup();
        }
        this.tweens.killTweensOf(entry.sprite);
        entry.sprite.destroy();
        this.powerupSprites.delete(key);
      }
    }
    for (const [key, { ref }] of live) {
      if (this.powerupSprites.has(key)) continue;
      const [col, row] = key.split(',').map(Number);
      const sprite = addImage(this, toX(col), toY(row), ref).setDepth(
        worldDepth(row, WORLD_LAYER.powerup),
      );
      sprite.setScale(SPRITE_SIZE.powerupHeight / Math.max(sprite.width, sprite.height));
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
      // Above the results overlay: players can still open the skills panel post-match.
      .setDepth(DEPTH.skills)
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
    if (me.mineAmmo > 0) line += `  Mines[${SKILL_KEY_LABEL}]: ${me.mineAmmo}`;
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
    const width = 600;
    const height = 314; // header + 9 skill rows + controls footer, with margin
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const panel = this.add
      .rectangle(cx, cy, width, height, 0x11121c, 0.98)
      .setStrokeStyle(2, 0xffe040)
      .setDepth(DEPTH.skills);
    const rows = buildSkillsTable(this, cx - width / 2 + 16, cy - height / 2 + 14);
    for (const o of rows) (o as Phaser.GameObjects.Image).setDepth(DEPTH.skills + 1);
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

    // Win/lose banner sits above the standings, which float on the full-screen
    // dim (no boxed panel). Layout is anchored to a fixed content height.
    const won = room.state.winnerId === this.myId;
    const banner = addImage(this, cx, cy, won ? TEX.youWin : TEX.youLose).setDepth(DEPTH.overlay + 1);
    banner.setScale(300 / banner.width);

    const panelHeight = 340;
    const panelCenterY = cy + banner.displayHeight / 2;
    const panelTop = panelCenterY - panelHeight / 2;
    banner.setY(panelTop - 8 - banner.displayHeight / 2);

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
    const goOn = (): void => room.send('backToLobby');

    // The host can disconnect while the results are up, in which case the
    // server promotes another player. Controls are rebuilt whenever the
    // rendered role no longer matches the state, so a promoted client swaps
    // "waiting for host…" for the Continue button instead of being stuck.
    let controls: Phaser.GameObjects.Text | null = null;
    let renderedHost: boolean | null = null;
    const buildControls = (): void => {
      const isHost = room.state.hostId === this.myId;
      if (isHost === renderedHost) return;
      renderedHost = isHost;
      controls?.destroy();
      this.input.keyboard?.off('keydown-ENTER', goOn);
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
        cont.on('pointerdown', goOn);
        // Host-only: Enter continues. The scene's keyboard listeners are dropped
        // on shutdown, so a resent message after leaving is not a concern.
        this.input.keyboard?.on('keydown-ENTER', goOn);
        controls = cont;
      } else {
        controls = this.add
          .text(cx, controlsY, 'waiting for host…', {
            fontFamily: 'monospace',
            fontSize: '20px',
            color: '#999999',
            resolution: TEXT_RES,
          })
          .setOrigin(0.5)
          .setDepth(DEPTH.overlay + 1);
      }
    };
    buildControls();

    // State-watch: rebuild the controls on host promotion, and once the host
    // continues and the server flips back to lobby, return to the Lobby scene
    // (update() early-returns while gameOver).
    const onStateChange = (): void => {
      buildControls();
      if (room.state.phase === 'lobby') {
        room.onStateChange.remove(onStateChange);
        this.scene.start('Lobby', { connection: this.connection! } satisfies LobbySceneData);
      }
    };
    room.onStateChange(onStateChange);
    this.events.once('shutdown', () => room.onStateChange.remove(onStateChange));

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
      room.onStateChange.remove(onStateChange);
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
