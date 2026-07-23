import { GRID_HEIGHT, GRID_WIDTH } from './constants';
import { SHRINK_ORDER, shrinkCountAtTick } from './suddenDeath';
import { TileType } from './types';
import type { GameState } from './game';
import type { Direction, PlayerInput } from './types';

export interface Bot {
  /**
   * Computes this tick's input from the current state. Stateless between
   * ticks — everything is recomputed from the state each call; the only side
   * effect is consuming the injected rng when the idle rule picks a random
   * direction. Same state sequence + same-seeded rng => identical inputs.
   */
  computeInput(state: GameState): PlayerInput;
}

/** BFS depth limit for the powerup-collection rule. */
const POWERUP_SEARCH_DEPTH = 8;

/** Tiles converting to HardBlock within this many ticks count as dangerous. */
const SHRINK_LOOKAHEAD_TICKS = 40; // 2s

/** Fixed neighbor scan order keeps BFS tie-breaking deterministic without rng. */
const NEIGHBOR_STEPS: { dc: number; dr: number; dir: Direction }[] = [
  { dc: 0, dr: -1, dir: 'up' },
  { dc: 0, dr: 1, dir: 'down' },
  { dc: -1, dr: 0, dir: 'left' },
  { dc: 1, dr: 0, dir: 'right' },
];

function key(col: number, row: number): number {
  return row * GRID_WIDTH + col;
}

function inBounds(col: number, row: number): boolean {
  return col >= 0 && col < GRID_WIDTH && row >= 0 && row < GRID_HEIGHT;
}

/** Per-computeInput lookup tables derived once from the state. */
interface BotContext {
  state: GameState;
  /** Tiles occupied by a bomb (block movement, chain-stop blast rays). */
  bombTiles: Set<number>;
  /** Tiles currently covered by an active explosion (entering kills). */
  burning: Set<number>;
  /** burning ∪ future blast cells of every ticking bomb, any fuse. */
  danger: Set<number>;
}

/**
 * Visits the cells a bomb at (col,row) with the given radius would blast,
 * mirroring game.ts ray rules: stop before HardBlock, include a SoftBlock
 * then stop, include a bomb cell then stop (it chain-detonates; its own
 * cross is accounted for separately since every bomb is walked).
 */
function forEachBlastCell(
  state: GameState,
  bombTiles: Set<number>,
  col: number,
  row: number,
  radius: number,
  visit: (col: number, row: number) => void,
): void {
  visit(col, row);
  for (const { dc, dr } of NEIGHBOR_STEPS) {
    for (let step = 1; step <= radius; step++) {
      const c = col + dc * step;
      const r = row + dr * step;
      if (!inBounds(c, r)) break;
      const tile = state.grid[r][c];
      if (tile === TileType.HardBlock) break;
      visit(c, r);
      if (tile === TileType.SoftBlock) break;
      if (bombTiles.has(key(c, r))) break;
    }
  }
}

function buildContext(state: GameState): BotContext {
  const bombTiles = new Set<number>();
  for (const bomb of state.bombs) bombTiles.add(key(bomb.col, bomb.row));
  const burning = new Set<number>();
  for (const cell of state.explosions) burning.add(key(cell.col, cell.row));
  const danger = new Set<number>(burning);
  for (const bomb of state.bombs) {
    forEachBlastCell(state, bombTiles, bomb.col, bomb.row, bomb.blastRadius, (c, r) =>
      danger.add(key(c, r)),
    );
  }
  // Sudden death: tiles about to be crushed are dangerous too. Already-converted
  // tiles are HardBlock and impassable, so only upcoming ones matter.
  const upcomingEnd = shrinkCountAtTick(state.tick + SHRINK_LOOKAHEAD_TICKS);
  for (let i = shrinkCountAtTick(state.tick); i < upcomingEnd; i++) {
    const cell = SHRINK_ORDER[i];
    danger.add(key(cell.col, cell.row));
  }
  return { state, bombTiles, burning, danger };
}

/** Movement passability, matching game.ts canEnter: in-bounds floor with no bomb. */
function isPassable(ctx: BotContext, col: number, row: number): boolean {
  return (
    inBounds(col, row) &&
    ctx.state.grid[row][col] === TileType.Floor &&
    !ctx.bombTiles.has(key(col, row))
  );
}

interface FloodNode {
  col: number;
  row: number;
  parent: number; // index into the nodes array, -1 for the start
  depth: number;
}

/**
 * BFS flood fill from the start tile (always included, even if it holds a
 * bomb the bot is standing on). Neighbors must be passable and not rejected
 * by transitBlocked. Nodes are in visit order, so the first node matching a
 * goal predicate is a nearest goal, tie-broken by the fixed scan order.
 */
function flood(
  ctx: BotContext,
  startCol: number,
  startRow: number,
  transitBlocked: (col: number, row: number) => boolean,
  maxDepth = Number.POSITIVE_INFINITY,
): FloodNode[] {
  const nodes: FloodNode[] = [{ col: startCol, row: startRow, parent: -1, depth: 0 }];
  const seen = new Set<number>([key(startCol, startRow)]);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.depth >= maxDepth) continue;
    for (const { dc, dr } of NEIGHBOR_STEPS) {
      const c = node.col + dc;
      const r = node.row + dr;
      if (!inBounds(c, r)) continue;
      const k = key(c, r);
      if (seen.has(k)) continue;
      if (!isPassable(ctx, c, r)) continue;
      if (transitBlocked(c, r)) continue;
      seen.add(k);
      nodes.push({ col: c, row: r, parent: i, depth: node.depth + 1 });
    }
  }
  return nodes;
}

/** Direction of the first step on the path from the start node to nodes[goalIndex]. */
function firstStep(nodes: FloodNode[], goalIndex: number): Direction | null {
  let i = goalIndex;
  while (nodes[i].parent > 0) i = nodes[i].parent;
  if (nodes[i].parent === -1) return null; // goal is the start tile
  const dc = nodes[i].col - nodes[0].col;
  const dr = nodes[i].row - nodes[0].row;
  for (const step of NEIGHBOR_STEPS) {
    if (step.dc === dc && step.dr === dr) return step.dir;
  }
  return null;
}

/** Ticks until the earliest detonation threatening each dangerous tile (0 = burning now). */
function computeDangerTimes(ctx: BotContext): Map<number, number> {
  const times = new Map<number, number>();
  const put = (c: number, r: number, t: number) => {
    const k = key(c, r);
    const prev = times.get(k);
    if (prev === undefined || t < prev) times.set(k, t);
  };
  for (const cell of ctx.state.explosions) put(cell.col, cell.row, 0);
  for (const bomb of ctx.state.bombs) {
    forEachBlastCell(ctx.state, ctx.bombTiles, bomb.col, bomb.row, bomb.blastRadius, (c, r) =>
      put(c, r, bomb.fuseTicks),
    );
  }
  return times;
}

/**
 * Survive rule: path to the nearest safe tile, transiting future-blast tiles
 * if needed but never active explosions. If nothing safe is reachable, head
 * for the reachable tile whose earliest threatening detonation is furthest
 * away (best effort), else stand still.
 */
function flee(ctx: BotContext, col: number, row: number): PlayerInput {
  const blockBurning = (c: number, r: number) => ctx.burning.has(key(c, r));
  const nodes = flood(ctx, col, row, blockBurning);
  for (let i = 0; i < nodes.length; i++) {
    if (!ctx.danger.has(key(nodes[i].col, nodes[i].row))) {
      return { direction: firstStep(nodes, i), placeBomb: false };
    }
  }
  const times = computeDangerTimes(ctx);
  let best = 0;
  let bestTime = times.get(key(col, row)) ?? -1;
  for (let i = 1; i < nodes.length; i++) {
    const t = times.get(key(nodes[i].col, nodes[i].row)) ?? Number.POSITIVE_INFINITY;
    if (t > bestTime) {
      best = i;
      bestTime = t;
    }
  }
  if (best === 0) return { direction: null, placeBomb: false };
  return { direction: firstStep(nodes, best), placeBomb: false };
}

/** Would a bomb dropped at (col,row) with this radius hit a soft block or an enemy? */
function bombWouldHit(
  ctx: BotContext,
  radius: number,
  col: number,
  row: number,
  enemyTiles: Set<number>,
): boolean {
  let hit = false;
  forEachBlastCell(ctx.state, ctx.bombTiles, col, row, radius, (c, r) => {
    if (ctx.state.grid[r][c] === TileType.SoftBlock || enemyTiles.has(key(c, r))) hit = true;
  });
  return hit;
}

/**
 * No-suicide check: with the would-be bomb's blast added to the current
 * danger map, is at least one safe tile still reachable from (col,row)?
 */
function canEscapeOwnBomb(ctx: BotContext, radius: number, col: number, row: number): boolean {
  const augmented = new Set(ctx.danger);
  forEachBlastCell(ctx.state, ctx.bombTiles, col, row, radius, (c, r) => augmented.add(key(c, r)));
  const blockBurning = (c: number, r: number) => ctx.burning.has(key(c, r));
  const nodes = flood(ctx, col, row, blockBurning);
  return nodes.some((n) => !augmented.has(key(n.col, n.row)));
}

/**
 * Creates a bot controller for the given player. The caller owns the rng
 * (pass a seeded instance, e.g. createRng(seed)); the bot never calls
 * Math.random, so identical states and rng seeds yield identical inputs.
 */
export function createBot(playerId: string, rng: () => number): Bot {
  return {
    computeInput(state: GameState): PlayerInput {
      const me = state.players.find((p) => p.id === playerId);
      if (!me || !me.alive) return { direction: null, placeBomb: false };

      const col = Math.round(me.x);
      const row = Math.round(me.y);
      const ctx = buildContext(state);
      const blockUnsafe = (c: number, r: number) =>
        ctx.burning.has(key(c, r)) || ctx.danger.has(key(c, r));

      // 1. Survive: current tile is threatened -> get out.
      if (ctx.danger.has(key(col, row))) return flee(ctx, col, row);

      // 2. Collect: nearest powerup reachable via safe tiles within 8 steps.
      if (state.powerups.length > 0) {
        const nodes = flood(ctx, col, row, blockUnsafe, POWERUP_SEARCH_DEPTH);
        const goal = nodes.findIndex((n) =>
          state.powerups.some((p) => p.col === n.col && p.row === n.row),
        );
        if (goal > 0) return { direction: firstStep(nodes, goal), placeBomb: false };
      }

      // 3. Attack/dig: nearest safe-reachable tile whose bomb would hit a
      // soft block or an enemy; place only if an escape route survives it.
      const enemyTiles = new Set<number>();
      for (const p of state.players) {
        if (p.id !== playerId && p.alive) enemyTiles.add(key(Math.round(p.x), Math.round(p.y)));
      }
      const nodes = flood(ctx, col, row, blockUnsafe);
      const goal = nodes.findIndex((n) =>
        bombWouldHit(ctx, me.blastRadius, n.col, n.row, enemyTiles),
      );
      if (goal === 0) {
        if (me.activeBombs < me.bombCount && canEscapeOwnBomb(ctx, me.blastRadius, col, row)) {
          return { direction: null, placeBomb: true };
        }
        // Standing on the spot but placing is unsafe or capacity is used up:
        // fall through to idle rather than freeze forever.
      } else if (goal > 0) {
        return { direction: firstStep(nodes, goal), placeBomb: false };
      }

      // 4. Idle: random adjacent safe tile via the injected rng, else stand still.
      const options: Direction[] = [];
      for (const { dc, dr, dir } of NEIGHBOR_STEPS) {
        const c = col + dc;
        const r = row + dr;
        if (isPassable(ctx, c, r) && !blockUnsafe(c, r)) options.push(dir);
      }
      if (options.length === 0) return { direction: null, placeBomb: false };
      return { direction: options[Math.floor(rng() * options.length)], placeBomb: false };
    },
  };
}
