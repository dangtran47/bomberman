import {
  BASE_BLAST_RADIUS,
  BASE_BOMB_COUNT,
  BASE_SPEED,
  BOMB_FUSE_TICKS,
  EXPLOSION_DURATION_TICKS,
  FREEZE_DURATION_TICKS,
  GRACE_CAP,
  GRID_HEIGHT,
  GRID_WIDTH,
  GUN_AMMO_PER_PICKUP,
  HAMMER_USES_PER_PICKUP,
  KICK_DURATION_TICKS,
  MAX_BLAST_RADIUS,
  MAX_BOMB_COUNT,
  MAX_SPEED,
  MINE_AMMO_PER_PICKUP,
  PING_CAP_MS,
  POWERUP_DROP_CHANCE,
  SHIELD_DURATION_TICKS,
  SKILL_ACTION_COOLDOWN_TICKS,
  SPEED_INCREMENT,
  SUDDEN_DEATH_INTERVAL_TICKS,
  SUDDEN_DEATH_START_TICKS,
  minePhase,
  powerupTypeForRoll,
} from './constants';
import { SPAWN_POINTS, generateMap } from './map';
import { compileMap, getMapDef } from './maps';
import { stepPlayer } from './movement';
import type { MovementWorld } from './movement';
import { SHRINK_ORDER } from './suddenDeath';
import { createRng } from './rng';
import { PowerupType, TileType } from './types';
import type { Bomb, Direction, ExplosionCell, Mine, Player, PlayerInput, Powerup } from './types';

export type GameStatus = 'running' | 'finished';

export interface GameState {
  tick: number;
  grid: TileType[][];
  /** Row-major slippery-tile mask; all false on procedural maps. */
  ice: boolean[][];
  players: Player[];
  bombs: Bomb[];
  mines: Mine[];
  explosions: ExplosionCell[];
  powerups: Powerup[];
  status: GameStatus;
  winnerId: string | null; // null while running, or a draw once finished
}

export type GameEvent =
  | { type: 'bombPlaced'; bombId: number; ownerId: string; col: number; row: number }
  | {
      type: 'bombExploded';
      bombId: number;
      ownerId: string;
      col: number;
      row: number;
      cells: { col: number; row: number }[];
    }
  | { type: 'minePlaced'; mineId: number; ownerId: string; col: number; row: number }
  | { type: 'mineExploded'; mineId: number; ownerId: string; col: number; row: number }
  | { type: 'blockDestroyed'; col: number; row: number }
  | { type: 'powerupSpawned'; col: number; row: number; powerupType: PowerupType }
  | {
      type: 'powerupCollected';
      playerId: string;
      col: number;
      row: number;
      powerupType: PowerupType;
    }
  | { type: 'playerDied'; playerId: string; col: number; row: number }
  | {
      type: 'gunFired';
      playerId: string;
      col: number; // shooter tile
      row: number;
      dir: Direction;
      hitCol: number | null; // cell the ray stopped on, null if it left the grid
      hitRow: number | null;
    }
  | { type: 'hammerSwung'; playerId: string; col: number; row: number } // col/row = struck tile
  | { type: 'arenaShrink'; col: number; row: number }
  | { type: 'gameEnded'; winnerId: string | null };

export type GameInputs = Map<string, PlayerInput> | Record<string, PlayerInput>;

export interface Game {
  /** Live authoritative state; treat as read-only outside the simulation. */
  state: GameState;
  /** Advances one fixed tick. Missing inputs default to idle. No-op once finished. */
  tick(inputs: GameInputs): GameEvent[];
}

export interface CreateGameOptions {
  seed: number;
  playerIds: string[];
  /** Test hook: overrides generateMap(seed). Row-major [row][col]; deep-copied. */
  grid?: TileType[][];
  /** Registry map to compile; unknown or empty falls back to generateMap(seed). */
  mapId?: string;
}

const IDLE_INPUT: PlayerInput = { direction: null, placeBomb: false };

/** Fixed ray order keeps RNG consumption (powerup rolls) deterministic. */
const RAY_DIRECTIONS: [dc: number, dr: number][] = [
  [0, -1], // up
  [0, 1], // down
  [-1, 0], // left
  [1, 0], // right
];

const DIRECTION_STEPS: Record<Direction, [dc: number, dr: number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

export function createGame(opts: CreateGameOptions): Game {
  return new GameImpl(opts);
}

function readInput(inputs: GameInputs, id: string): PlayerInput {
  const input = inputs instanceof Map ? inputs.get(id) : inputs[id];
  return input ?? IDLE_INPUT;
}

function tileKey(col: number, row: number): string {
  return `${col},${row}`;
}

function emptyIceMask(): boolean[][] {
  return Array.from({ length: GRID_HEIGHT }, () => Array<boolean>(GRID_WIDTH).fill(false));
}

function applyPowerup(player: Player, type: PowerupType, players: Player[]): void {
  switch (type) {
    case PowerupType.ExtraBomb:
      player.bombCount = Math.min(MAX_BOMB_COUNT, player.bombCount + 1);
      break;
    case PowerupType.BiggerBlast:
      player.blastRadius = Math.min(MAX_BLAST_RADIUS, player.blastRadius + 1);
      break;
    case PowerupType.Speed:
      player.speed = Math.min(MAX_SPEED, player.speed + SPEED_INCREMENT);
      break;
    // The three skills are exclusive: a pickup always replaces whatever is
    // held, so a player carries at most one (re-pickup of the same one refills).
    case PowerupType.Kick:
      clearSkills(player);
      player.kickTicks = KICK_DURATION_TICKS;
      break;
    case PowerupType.Gun:
      clearSkills(player);
      player.gunAmmo = GUN_AMMO_PER_PICKUP;
      break;
    case PowerupType.Hammer:
      clearSkills(player);
      player.hammerUses = HAMMER_USES_PER_PICKUP;
      break;
    case PowerupType.Mine:
      clearSkills(player);
      player.mineAmmo = MINE_AMMO_PER_PICKUP;
      break;
    // Passive buff: it sits outside the exclusive skill slot, so a held
    // weapon is kept and a re-pickup just refreshes the timer.
    case PowerupType.Shield:
      player.shieldTicks = SHIELD_DURATION_TICKS;
      break;
    // Freeze-time is instant: it holds no slot and clears nothing on the picker.
    // Orthogonal to the shield: a shielded victim still freezes, and stays immune.
    case PowerupType.FreezeTime:
      for (const other of players) {
        if (other === player || !other.alive) continue;
        other.frozenTicks = FREEZE_DURATION_TICKS;
      }
      break;
  }
}

/** Drops every held skill. Stat upgrades (bombs, blast, speed) are untouched. */
function clearSkills(player: Player): void {
  player.kickTicks = 0;
  player.gunAmmo = 0;
  player.hammerUses = 0;
  player.mineAmmo = 0;
}

class GameImpl implements Game {
  readonly state: GameState;
  private readonly rng: () => number;
  private nextBombId = 1;
  private nextMineId = 1;

  constructor({ seed, playerIds, grid, mapId }: CreateGameOptions) {
    if (playerIds.length < 2 || playerIds.length > SPAWN_POINTS.length) {
      throw new Error(`playerIds must have 2-${SPAWN_POINTS.length} entries, got ${playerIds.length}`);
    }
    this.rng = createRng(seed);
    // Grid override wins (test hook), then a registry map, then the procedural map.
    const def = grid ? undefined : getMapDef(mapId);
    const compiled = def ? compileMap(def, seed) : undefined;
    this.state = {
      tick: 0,
      grid: grid ? grid.map((row) => [...row]) : (compiled?.grid ?? generateMap(seed)),
      ice: compiled?.ice ?? emptyIceMask(),
      players: playerIds.map((id, i) => ({
        id,
        x: SPAWN_POINTS[i].col,
        y: SPAWN_POINTS[i].row,
        alive: true,
        speed: BASE_SPEED,
        bombCount: BASE_BOMB_COUNT,
        blastRadius: BASE_BLAST_RADIUS,
        activeBombs: 0,
        kickTicks: 0,
        gunAmmo: 0,
        hammerUses: 0,
        mineAmmo: 0,
        shieldTicks: 0,
        frozenTicks: 0,
        actionCooldown: 0,
        triggerHeld: false,
        skillTriggerHeld: false,
        facing: 'down',
        momentumDir: null,
        momentumTicks: 0,
        turnTicks: 0,
        laneDir: null,
        turnGrace: 0,
        deathTick: null,
      })),
      bombs: [],
      mines: [],
      explosions: [],
      powerups: [],
      status: 'running',
      winnerId: null,
    };
  }

  tick(inputs: GameInputs): GameEvent[] {
    const s = this.state;
    if (s.status === 'finished') return [];
    s.tick++;
    const events: GameEvent[] = [];

    for (const player of s.players) {
      if (!player.alive) continue;
      if (player.kickTicks > 0) player.kickTicks--;
      if (player.shieldTicks > 0) player.shieldTicks--;
      const input = readInput(inputs, player.id);
      // Latency-scaled turn latitude: how far the player expects to have drifted
      // past a junction while their turn was in flight. 0 offline (no ping).
      const oneWaySec = Math.min(input.pingMs ?? 0, PING_CAP_MS) / 2 / 1000;
      player.turnGrace = Math.min(GRACE_CAP, player.speed * oneWaySec);
      // Frozen solid: inputs still maintain trigger bookkeeping (so nothing
      // fires spuriously on unfreeze) but no action or movement happens.
      const frozen = player.frozenTicks > 0;
      if (input.direction && !frozen) player.facing = input.direction; // aims the skills too
      // Space is one button: while a skill is held it triggers that skill and
      // places no bombs, and it fires on the press (a held trigger would burn
      // the whole magazine at the cooldown's rate).
      // A press that started as a skill trigger stays one until the key comes
      // back up: emptying the magazine mid-hold must not turn into a bomb.
      const armed = player.gunAmmo > 0 || player.hammerUses > 0 || player.mineAmmo > 0;
      const pressed = input.placeBomb && !player.triggerHeld;
      player.triggerHeld = input.placeBomb;
      if (!input.placeBomb) player.skillTriggerHeld = false;
      else if (armed) player.skillTriggerHeld = true;
      if (input.placeBomb && !armed && !player.skillTriggerHeld && !frozen) {
        this.placeBomb(player, events);
      }
      if (player.actionCooldown > 0) player.actionCooldown--;
      if (!frozen) {
        if (input.fireGun || (pressed && player.gunAmmo > 0)) this.fireGun(player, events);
        if (input.swingHammer || (pressed && player.hammerUses > 0)) this.swingHammer(player, events);
        if (input.placeMine || (pressed && player.mineAmmo > 0)) this.placeMine(player, events);
      }
      stepPlayer(this.world, player, input.direction ?? null);
      if (player.frozenTicks > 0) player.frozenTicks--;
    }

    this.ageExplosions();
    this.moveSlidingBombs();
    this.detonateDueBombs(events);
    this.tickMines(events);
    this.applySuddenDeath(events);
    this.applyDeaths(events);
    this.collectPowerups(events);
    this.checkWin(events);
    return events;
  }

  private placeBomb(player: Player, events: GameEvent[]): void {
    const col = Math.round(player.x);
    const row = Math.round(player.y);
    if (player.activeBombs >= player.bombCount) return;
    if (this.state.bombs.some((b) => b.col === col && b.row === row)) return;
    const bomb: Bomb = {
      id: this.nextBombId++,
      col,
      row,
      ownerId: player.id,
      fuseTicks: BOMB_FUSE_TICKS,
      blastRadius: player.blastRadius,
      slideDC: 0,
      slideDR: 0,
      slideCooldown: 0,
      slideInterval: 0,
    };
    this.state.bombs.push(bomb);
    player.activeBombs++;
    events.push({ type: 'bombPlaced', bombId: bomb.id, ownerId: player.id, col, row });
  }

  /**
   * Drops a mine on the player's own tile. Mines share the tile with nothing:
   * one per tile, and never on a bomb (which keeps a mine from ever setting a
   * bomb off, since its blast covers its own tile only).
   */
  private placeMine(player: Player, events: GameEvent[]): void {
    const col = Math.round(player.x);
    const row = Math.round(player.y);
    if (player.mineAmmo <= 0) return;
    if (this.state.mines.some((m) => m.col === col && m.row === row)) return;
    if (this.state.bombs.some((b) => b.col === col && b.row === row)) return;
    const mine: Mine = { id: this.nextMineId++, col, row, ownerId: player.id, ticks: 0 };
    this.state.mines.push(mine);
    player.mineAmmo--;
    events.push({ type: 'minePlaced', mineId: mine.id, ownerId: player.id, col, row });
  }

  /**
   * Fires one shot along `facing` from the shooter's tile. The ray stops on the
   * first hard block, soft block (destroyed, with a blast's drop roll) or rival
   * player (killed); bombs and powerups are passed over.
   */
  private fireGun(player: Player, events: GameEvent[]): void {
    if (player.gunAmmo <= 0 || player.actionCooldown > 0) return;
    const s = this.state;
    player.gunAmmo--;
    player.actionCooldown = SKILL_ACTION_COOLDOWN_TICKS;

    const col = Math.round(player.x);
    const row = Math.round(player.y);
    const [dc, dr] = DIRECTION_STEPS[player.facing];
    let hitCol: number | null = null;
    let hitRow: number | null = null;
    let softHit = false;
    let victim: Player | undefined;
    let shotBomb: Bomb | undefined;

    for (let step = 1; ; step++) {
      const c = col + dc * step;
      const r = row + dr * step;
      if (c < 0 || c >= GRID_WIDTH || r < 0 || r >= GRID_HEIGHT) break;
      const tile = s.grid[r][c];
      if (tile === TileType.HardBlock) {
        hitCol = c;
        hitRow = r;
        break;
      }
      if (tile === TileType.SoftBlock) {
        hitCol = c;
        hitRow = r;
        softHit = true;
        break;
      }
      // A bomb takes the shot and goes off with it; the ray stops there.
      const bomb = s.bombs.find((b) => b.col === c && b.row === r);
      if (bomb) {
        hitCol = c;
        hitRow = r;
        shotBomb = bomb;
        break;
      }
      victim = this.alivePlayerAt(c, r, player);
      if (victim) {
        hitCol = c;
        hitRow = r;
        break;
      }
    }

    events.push({
      type: 'gunFired',
      playerId: player.id,
      col,
      row,
      dir: player.facing,
      hitCol,
      hitRow,
    });
    if (softHit && hitCol !== null && hitRow !== null) this.destroySoftBlock(hitCol, hitRow, events);
    // Same as the hammer: detonateDueBombs runs later this tick and takes it to 0.
    else if (shotBomb) shotBomb.fuseTicks = 1;
    // A shielded victim absorbs the shot: the ray still stopped there, but no kill.
    else if (victim && victim.shieldTicks <= 0) this.killPlayer(victim, events);
  }

  /**
   * Hits the tile directly ahead: destroys a soft block or kills whoever stands
   * there. Swinging at the grid edge is a no-op and costs nothing.
   */
  private swingHammer(player: Player, events: GameEvent[]): void {
    if (player.hammerUses <= 0 || player.actionCooldown > 0) return;
    const [dc, dr] = DIRECTION_STEPS[player.facing];
    const col = Math.round(player.x) + dc;
    const row = Math.round(player.y) + dr;
    if (col < 0 || col >= GRID_WIDTH || row < 0 || row >= GRID_HEIGHT) return;

    player.hammerUses--;
    player.actionCooldown = SKILL_ACTION_COOLDOWN_TICKS;
    events.push({ type: 'hammerSwung', playerId: player.id, col, row });

    if (this.state.grid[row][col] === TileType.SoftBlock) {
      this.destroySoftBlock(col, row, events);
      return;
    }
    // Smacking a bomb sets it off: detonateDueBombs runs later this same tick
    // and takes the fuse to 0 (same trick as a kicked bomb hitting a wall).
    const bomb = this.state.bombs.find((b) => b.col === col && b.row === row);
    if (bomb) {
      bomb.fuseTicks = 1;
      return;
    }
    const victim = this.alivePlayerAt(col, row, player);
    if (victim && victim.shieldTicks <= 0) this.killPlayer(victim, events);
  }

  private alivePlayerAt(col: number, row: number, except: Player): Player | undefined {
    return this.state.players.find(
      (p) => p.alive && p !== except && Math.round(p.x) === col && Math.round(p.y) === row,
    );
  }

  /** Skill-destroyed block: same event and same drop rolls as an explosion ray. */
  private destroySoftBlock(col: number, row: number, events: GameEvent[]): void {
    const s = this.state;
    s.grid[row][col] = TileType.Floor;
    events.push({ type: 'blockDestroyed', col, row });
    if (this.rng() < POWERUP_DROP_CHANCE) {
      const type = powerupTypeForRoll(this.rng()) as PowerupType;
      // Dropped on the block's own tile, so nothing can pick it up this tick.
      s.powerups.push({ col, row, type });
      events.push({ type: 'powerupSpawned', col, row, powerupType: type });
    }
  }

  /** The one death path: every kill clears the skills and emits playerDied. */
  private killPlayer(player: Player, events: GameEvent[]): void {
    const col = Math.round(player.x);
    const row = Math.round(player.y);
    player.alive = false;
    player.deathTick = this.state.tick;
    clearSkills(player);
    player.actionCooldown = 0;
    player.turnTicks = 0;
    player.momentumDir = null;
    player.momentumTicks = 0;
    events.push({ type: 'playerDied', playerId: player.id, col, row });
  }

  private get world(): MovementWorld {
    return { grid: this.state.grid, ice: this.state.ice, bombs: this.state.bombs };
  }

  private ageExplosions(): void {
    const s = this.state;
    for (const cell of s.explosions) cell.ticksLeft--;
    s.explosions = s.explosions.filter((cell) => cell.ticksLeft > 0);
  }

  private moveSlidingBombs(): void {
    const s = this.state;
    for (const bomb of s.bombs) {
      if (bomb.slideDC === 0 && bomb.slideDR === 0) continue;
      bomb.slideCooldown--;
      if (bomb.slideCooldown > 0) continue;
      const nextCol = bomb.col + bomb.slideDC;
      const nextRow = bomb.row + bomb.slideDR;
      const blocked =
        nextCol < 0 || nextCol >= GRID_WIDTH || nextRow < 0 || nextRow >= GRID_HEIGHT ||
        s.grid[nextRow][nextCol] !== TileType.Floor ||
        s.bombs.some((b) => b !== bomb && b.col === nextCol && b.row === nextRow);
      if (blocked) {
        // Explode on impact this same tick: detonateDueBombs (runs next) will see
        // fuseTicks<=0 and detonate at the bomb's current tile, cross rays and all.
        bomb.slideDC = 0;
        bomb.slideDR = 0;
        bomb.fuseTicks = 1;
      } else {
        bomb.col = nextCol;
        bomb.row = nextRow;
        bomb.slideCooldown = bomb.slideInterval || 1;
      }
    }
  }

  private detonateDueBombs(events: GameEvent[]): void {
    const s = this.state;
    const queue: Bomb[] = [];
    for (const bomb of s.bombs) {
      bomb.fuseTicks--;
      if (bomb.fuseTicks <= 0) queue.push(bomb);
    }
    if (queue.length === 0) return;

    const detonated = new Set<Bomb>(queue);
    const affected = new Map<string, { col: number; row: number }>();
    const spawned: Powerup[] = [];

    // Queue grows as rays chain-detonate other bombs; all resolve this tick.
    for (let i = 0; i < queue.length; i++) {
      const bomb = queue[i];
      const cells: { col: number; row: number }[] = [{ col: bomb.col, row: bomb.row }];
      const destroyed: { col: number; row: number }[] = [];
      for (const [dc, dr] of RAY_DIRECTIONS) {
        for (let step = 1; step <= bomb.blastRadius; step++) {
          const col = bomb.col + dc * step;
          const row = bomb.row + dr * step;
          if (col < 0 || col >= GRID_WIDTH || row < 0 || row >= GRID_HEIGHT) break;
          const tile = s.grid[row][col];
          if (tile === TileType.HardBlock) break;
          if (tile === TileType.SoftBlock) {
            cells.push({ col, row });
            destroyed.push({ col, row });
            s.grid[row][col] = TileType.Floor;
            if (this.rng() < POWERUP_DROP_CHANCE) {
              const type = powerupTypeForRoll(this.rng()) as PowerupType;
              spawned.push({ col, row, type });
            }
            break;
          }
          cells.push({ col, row });
          const other = s.bombs.find((b) => b.col === col && b.row === row);
          if (other) {
            if (!detonated.has(other)) {
              detonated.add(other);
              queue.push(other);
            }
            break;
          }
        }
      }
      events.push({
        type: 'bombExploded',
        bombId: bomb.id,
        ownerId: bomb.ownerId,
        col: bomb.col,
        row: bomb.row,
        cells,
      });
      for (const { col, row } of destroyed) events.push({ type: 'blockDestroyed', col, row });
      for (const cell of cells) affected.set(tileKey(cell.col, cell.row), cell);
    }

    s.bombs = s.bombs.filter((b) => !detonated.has(b));
    for (const bomb of queue) {
      const owner = s.players.find((p) => p.id === bomb.ownerId);
      if (owner) owner.activeBombs--;
    }

    // Blasts burn powerups already on the ground; powerups dropped by this
    // very explosion survive it (they are added afterwards).
    s.powerups = s.powerups.filter((p) => !affected.has(tileKey(p.col, p.row)));
    for (const powerup of spawned) {
      s.powerups.push(powerup);
      events.push({
        type: 'powerupSpawned',
        col: powerup.col,
        row: powerup.row,
        powerupType: powerup.type,
      });
    }

    for (const { col, row } of affected.values()) {
      const existing = s.explosions.find((c) => c.col === col && c.row === row);
      if (existing) existing.ticksLeft = EXPLOSION_DURATION_TICKS;
      else s.explosions.push({ col, row, ticksLeft: EXPLOSION_DURATION_TICKS });
    }
  }

  /**
   * Ages every mine and detonates the triggered ones. A blast covering the tile
   * sets a mine off whatever its phase; from the armed phase on, so does any
   * alive player standing on it, the owner included. The detonation burns the
   * mine's own tile only, through the usual explosion cell, so the burning,
   * death and powerup rules that run after it need no special case.
   */
  private tickMines(events: GameEvent[]): void {
    const s = this.state;
    if (s.mines.length === 0) return;
    const burning = new Set(s.explosions.map((c) => tileKey(c.col, c.row)));
    const detonated: Mine[] = [];
    for (const mine of s.mines) {
      mine.ticks++;
      const triggered =
        burning.has(tileKey(mine.col, mine.row)) ||
        (minePhase(mine.ticks) > 0 &&
          s.players.some(
            (p) => p.alive && Math.round(p.x) === mine.col && Math.round(p.y) === mine.row,
          ));
      if (triggered) detonated.push(mine);
    }
    if (detonated.length === 0) return;

    const gone = new Set(detonated);
    s.mines = s.mines.filter((m) => !gone.has(m));
    for (const mine of detonated) {
      events.push({
        type: 'mineExploded',
        mineId: mine.id,
        ownerId: mine.ownerId,
        col: mine.col,
        row: mine.row,
      });
      const existing = s.explosions.find((c) => c.col === mine.col && c.row === mine.row);
      if (existing) existing.ticksLeft = EXPLOSION_DURATION_TICKS;
      else s.explosions.push({ col: mine.col, row: mine.row, ticksLeft: EXPLOSION_DURATION_TICKS });
    }
  }

  /**
   * Sudden death: from SUDDEN_DEATH_START_TICKS on, one tile per interval is
   * converted to HardBlock following SHRINK_ORDER. A bomb caught on the tile
   * is crushed (its slot returned to the owner, it never detonates), a mine or
   * a powerup is destroyed, and a player standing there dies. Explosion cells
   * are left alone — they expire naturally. A bomb whose fuse ends this very
   * tick still detonates first (detonation runs before the shrink).
   */
  private applySuddenDeath(events: GameEvent[]): void {
    const s = this.state;
    if (s.tick < SUDDEN_DEATH_START_TICKS) return;
    const elapsed = s.tick - SUDDEN_DEATH_START_TICKS;
    if (elapsed % SUDDEN_DEATH_INTERVAL_TICKS !== 0) return;
    const index = elapsed / SUDDEN_DEATH_INTERVAL_TICKS;
    if (index >= SHRINK_ORDER.length) return;

    const { col, row } = SHRINK_ORDER[index];
    s.grid[row][col] = TileType.HardBlock;
    events.push({ type: 'arenaShrink', col, row });

    for (const bomb of s.bombs) {
      if (bomb.col !== col || bomb.row !== row) continue;
      const owner = s.players.find((p) => p.id === bomb.ownerId);
      if (owner) owner.activeBombs--;
    }
    s.bombs = s.bombs.filter((b) => b.col !== col || b.row !== row);
    s.mines = s.mines.filter((m) => m.col !== col || m.row !== row);
    s.powerups = s.powerups.filter((p) => p.col !== col || p.row !== row);

    for (const player of s.players) {
      if (!player.alive) continue;
      if (Math.round(player.x) === col && Math.round(player.y) === row) {
        this.killPlayer(player, events);
      }
    }
  }

  private applyDeaths(events: GameEvent[]): void {
    const s = this.state;
    if (s.explosions.length === 0) return;
    const burning = new Set(s.explosions.map((c) => tileKey(c.col, c.row)));
    for (const player of s.players) {
      if (!player.alive || player.shieldTicks > 0) continue;
      const col = Math.round(player.x);
      const row = Math.round(player.y);
      if (burning.has(tileKey(col, row))) this.killPlayer(player, events);
    }
  }

  private collectPowerups(events: GameEvent[]): void {
    const s = this.state;
    if (s.powerups.length === 0) return;
    const burning = new Set(s.explosions.map((c) => tileKey(c.col, c.row)));
    for (const player of s.players) {
      if (!player.alive) continue;
      const col = Math.round(player.x);
      const row = Math.round(player.y);
      if (burning.has(tileKey(col, row))) continue; // cannot collect under an explosion
      const index = s.powerups.findIndex((p) => p.col === col && p.row === row);
      if (index === -1) continue;
      const [powerup] = s.powerups.splice(index, 1);
      applyPowerup(player, powerup.type, s.players);
      events.push({
        type: 'powerupCollected',
        playerId: player.id,
        col,
        row,
        powerupType: powerup.type,
      });
    }
  }

  private checkWin(events: GameEvent[]): void {
    const s = this.state;
    const alive = s.players.filter((p) => p.alive);
    if (alive.length > 1) return;
    s.status = 'finished';
    s.winnerId = alive.length === 1 ? alive[0].id : null;
    events.push({ type: 'gameEnded', winnerId: s.winnerId });
  }
}
