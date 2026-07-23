import {
  BASE_BLAST_RADIUS,
  BASE_BOMB_COUNT,
  BASE_SPEED,
  BOMB_FUSE_TICKS,
  EXPLOSION_DURATION_TICKS,
  GRID_HEIGHT,
  GRID_WIDTH,
  MAX_BLAST_RADIUS,
  MAX_BOMB_COUNT,
  MAX_SPEED,
  POWERUP_DROP_CHANCE,
  SPEED_INCREMENT,
  SUDDEN_DEATH_INTERVAL_TICKS,
  SUDDEN_DEATH_START_TICKS,
  TICK_RATE,
} from './constants';
import { SPAWN_POINTS, generateMap } from './map';
import { SHRINK_ORDER } from './suddenDeath';
import { createRng } from './rng';
import { PowerupType, TileType } from './types';
import type { Bomb, Direction, ExplosionCell, Player, PlayerInput, Powerup } from './types';

export type GameStatus = 'running' | 'finished';

export interface GameState {
  tick: number;
  grid: TileType[][];
  players: Player[];
  bombs: Bomb[];
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
}

const IDLE_INPUT: PlayerInput = { direction: null, placeBomb: false };
const EPS = 1e-9;

/** Fixed ray order keeps RNG consumption (powerup rolls) deterministic. */
const RAY_DIRECTIONS: [dc: number, dr: number][] = [
  [0, -1], // up
  [0, 1], // down
  [-1, 0], // left
  [1, 0], // right
];

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

function applyPowerup(player: Player, type: PowerupType): void {
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
  }
}

class GameImpl implements Game {
  readonly state: GameState;
  private readonly rng: () => number;
  private nextBombId = 1;

  constructor({ seed, playerIds, grid }: CreateGameOptions) {
    if (playerIds.length < 2 || playerIds.length > SPAWN_POINTS.length) {
      throw new Error(`playerIds must have 2-${SPAWN_POINTS.length} entries, got ${playerIds.length}`);
    }
    this.rng = createRng(seed);
    this.state = {
      tick: 0,
      grid: grid ? grid.map((row) => [...row]) : generateMap(seed),
      players: playerIds.map((id, i) => ({
        id,
        x: SPAWN_POINTS[i].col,
        y: SPAWN_POINTS[i].row,
        alive: true,
        speed: BASE_SPEED,
        bombCount: BASE_BOMB_COUNT,
        blastRadius: BASE_BLAST_RADIUS,
        activeBombs: 0,
      })),
      bombs: [],
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
      const input = readInput(inputs, player.id);
      if (input.placeBomb) this.placeBomb(player, events);
      if (input.direction) this.movePlayer(player, input.direction);
    }

    this.ageExplosions();
    this.detonateDueBombs(events);
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
    };
    this.state.bombs.push(bomb);
    player.activeBombs++;
    events.push({ type: 'bombPlaced', bombId: bomb.id, ownerId: player.id, col, row });
  }

  /**
   * Axis-locked movement with corner slide: to move along an axis the player
   * must be aligned to the perpendicular lane; if not, the tick's movement
   * budget is spent sliding toward the nearest lane first, and any remainder
   * goes into the requested direction.
   */
  private movePlayer(player: Player, direction: Direction): void {
    let budget = player.speed / TICK_RATE;
    const horizontal = direction === 'left' || direction === 'right';

    const perp = horizontal ? player.y : player.x;
    const lane = Math.round(perp);
    const dist = Math.abs(lane - perp);
    if (dist > EPS) {
      if (dist <= budget + EPS) {
        // Snap exactly onto the lane so alignment checks stay exact.
        if (horizontal) player.y = lane;
        else player.x = lane;
        budget = Math.max(0, budget - dist);
      } else {
        const step = Math.sign(lane - perp) * budget;
        if (horizontal) player.y += step;
        else player.x += step;
        return;
      }
    }
    if (budget <= EPS) return;

    const sign = direction === 'down' || direction === 'right' ? 1 : -1;
    const pos = horizontal ? player.x : player.y;
    const cur = Math.round(pos);
    const target = pos + sign * budget;
    const nextCol = horizontal ? cur + sign : Math.round(player.x);
    const nextRow = horizontal ? Math.round(player.y) : cur + sign;
    let next: number;
    if (this.canEnter(nextCol, nextRow)) {
      next = target;
    } else {
      // Blocked ahead: may still advance up to the center of the current tile.
      next = sign > 0 ? Math.min(target, Math.max(cur, pos)) : Math.max(target, Math.min(cur, pos));
    }
    if (horizontal) player.x = next;
    else player.y = next;
  }

  /**
   * A tile can be entered if it is in bounds, is floor, and holds no bomb.
   * Only the tile ahead is ever checked, so a player still standing on their
   * own just-placed bomb can walk off it but cannot re-enter once gone.
   */
  private canEnter(col: number, row: number): boolean {
    if (col < 0 || col >= GRID_WIDTH || row < 0 || row >= GRID_HEIGHT) return false;
    if (this.state.grid[row][col] !== TileType.Floor) return false;
    return !this.state.bombs.some((b) => b.col === col && b.row === row);
  }

  private ageExplosions(): void {
    const s = this.state;
    for (const cell of s.explosions) cell.ticksLeft--;
    s.explosions = s.explosions.filter((cell) => cell.ticksLeft > 0);
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
              const type = Math.floor(this.rng() * 3) as PowerupType;
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
   * Sudden death: from SUDDEN_DEATH_START_TICKS on, one tile per interval is
   * converted to HardBlock following SHRINK_ORDER. A bomb caught on the tile
   * is crushed (its slot returned to the owner, it never detonates), a
   * powerup is destroyed, and a player standing there dies. Explosion cells
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
    s.powerups = s.powerups.filter((p) => p.col !== col || p.row !== row);

    for (const player of s.players) {
      if (!player.alive) continue;
      if (Math.round(player.x) === col && Math.round(player.y) === row) {
        player.alive = false;
        events.push({ type: 'playerDied', playerId: player.id, col, row });
      }
    }
  }

  private applyDeaths(events: GameEvent[]): void {
    const s = this.state;
    if (s.explosions.length === 0) return;
    const burning = new Set(s.explosions.map((c) => tileKey(c.col, c.row)));
    for (const player of s.players) {
      if (!player.alive) continue;
      const col = Math.round(player.x);
      const row = Math.round(player.y);
      if (burning.has(tileKey(col, row))) {
        player.alive = false;
        events.push({ type: 'playerDied', playerId: player.id, col, row });
      }
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
      applyPowerup(player, powerup.type);
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
