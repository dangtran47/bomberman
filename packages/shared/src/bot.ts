import {
  BOT_GUN_ATTACK_CHANCE,
  BOT_HAMMER_ATTACK_CHANCE,
  GRID_HEIGHT,
  GRID_WIDTH,
  MINE_ARM_TICKS,
} from './constants';
import { SHRINK_ORDER, shrinkCountAtTick } from './suddenDeath';
import { TileType } from './types';
import type { GameState } from './game';
import type { Direction, PlayerInput } from './types';

export interface Bot {
  /**
   * Computes this tick's input from the current state. Deterministic: the
   * only cross-tick memory is the current dig target (dropped as soon as it
   * stops qualifying) and the injected rng consumed by the idle rule, so the
   * same state sequence + same-seeded rng => identical inputs.
   */
  computeInput(state: GameState): PlayerInput;
  /** Which rule produced the last input (diagnostics; e.g. 'flee', 'dig>3,7'). */
  readonly lastRule?: string;
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
  /** burning ∪ future blast cells of every ticking bomb ∪ live mine tiles. */
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
  // A live (armed or buried) mine kills on contact, exactly like standing in
  // an explosion — it goes into `burning`, the set every flood uses as a hard
  // transit block. Leaving it only in `danger` let flee() and the escape
  // check route straight across armed mines "temporarily", which is how bots
  // died pacing around their own minefields.
  for (const mine of state.mines) {
    if (mine.ticks >= MINE_ARM_TICKS) burning.add(key(mine.col, mine.row));
  }
  const danger = new Set<number>(burning);
  for (const bomb of state.bombs) {
    forEachBlastCell(state, bombTiles, bomb.col, bomb.row, bomb.blastRadius, (c, r) =>
      danger.add(key(c, r)),
    );
  }
  // Mines threaten their own tile only, and never block movement (so they stay
  // out of bombTiles). Inert ones count too: crossing one is safe, but the bot
  // has no notion of "leave before it arms", and standing on the mine it just
  // dropped until it goes live is the most common way to die to one.
  for (const mine of state.mines) danger.add(key(mine.col, mine.row));
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
  // A mine's tile is threatened from the tick it arms, and a live one goes off
  // the instant it is stepped on — the arming countdown is its fuse.
  for (const mine of ctx.state.mines) {
    put(mine.col, mine.row, Math.max(0, MINE_ARM_TICKS - mine.ticks));
  }
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
 * away (best effort), else stand still. Returns the chosen safe tile so the
 * caller can stick with it across ticks instead of re-picking (equidistant
 * safe tiles flip sides as the bot moves, which danced it in place inside a
 * blast zone).
 */
function flee(
  ctx: BotContext,
  col: number,
  row: number,
): { input: PlayerInput; goal: { col: number; row: number } | null } {
  const blockBurning = (c: number, r: number) => ctx.burning.has(key(c, r));
  const nodes = flood(ctx, col, row, blockBurning);
  for (let i = 0; i < nodes.length; i++) {
    if (!ctx.danger.has(key(nodes[i].col, nodes[i].row))) {
      return {
        input: { direction: firstStep(nodes, i), placeBomb: false },
        goal: { col: nodes[i].col, row: nodes[i].row },
      };
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
  if (best === 0) return { input: { direction: null, placeBomb: false }, goal: null };
  return { input: { direction: firstStep(nodes, best), placeBomb: false }, goal: null };
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
 * Where a gun or hammer held at (col,row) should aim to hit something worth
 * hitting — an enemy first, else a soft block — or null if this tile has no
 * target. The rules mirror game.ts: the hammer only reaches the tile ahead,
 * the gun's ray runs until a hard block, a soft block, a bomb or a player.
 * Bomb tiles are never a target: setting a fuse off next to the bot is suicide.
 */
function skillAim(
  ctx: BotContext,
  weapon: 'gun' | 'hammer',
  col: number,
  row: number,
  enemyTiles: Set<number>,
): { dir: Direction; enemy: boolean } | null {
  let softAim: Direction | null = null;
  for (const { dc, dr, dir } of NEIGHBOR_STEPS) {
    const reach = weapon === 'hammer' ? 1 : Number.POSITIVE_INFINITY;
    for (let step = 1; step <= reach; step++) {
      const c = col + dc * step;
      const r = row + dr * step;
      if (!inBounds(c, r)) break;
      const tile = ctx.state.grid[r][c];
      if (tile === TileType.HardBlock) break;
      if (tile === TileType.SoftBlock) {
        if (softAim === null) softAim = dir;
        break;
      }
      if (ctx.bombTiles.has(key(c, r))) break;
      if (enemyTiles.has(key(c, r))) return { dir, enemy: true }; // kill beats digging
    }
  }
  return softAim === null ? null : { dir: softAim, enemy: false };
}

/**
 * Skill rule, used instead of the bomb rule while a gun or hammer is held:
 * space triggers the skill and places no bomb, so digging and attacking both
 * go through the weapon. Aims and fires from the current tile when there is a
 * target, else walks to the nearest safe tile that has one. The direction is
 * sent alongside the fire flag because game.ts aims off `facing`, which the
 * same tick's direction sets. Returns null when no target is reachable so the
 * caller falls through to the idle rule.
 */
function useSkill(
  ctx: BotContext,
  weapon: 'gun' | 'hammer',
  col: number,
  row: number,
  cooldown: number,
  enemyTiles: Set<number>,
  blockUnsafe: (col: number, row: number) => boolean,
  rng: () => number,
): PlayerInput | null {
  const aim = skillAim(ctx, weapon, col, row, enemyTiles);
  if (aim !== null) {
    // Cooling down: hold position on a tile that already has a target rather
    // than wander off; the cooldown ticks down and the swing lands next.
    if (cooldown > 0) return { direction: null, placeBomb: false };
    // Combat nerf: attacking an enemy only lands on a fraction of ready ticks,
    // so the bot hesitates instead of killing the instant it lines up (gives
    // the player a dodge window). Digging soft blocks always fires.
    if (aim.enemy) {
      const chance = weapon === 'hammer' ? BOT_HAMMER_ATTACK_CHANCE : BOT_GUN_ATTACK_CHANCE;
      if (rng() >= chance) return { direction: null, placeBomb: false }; // hold fire this tick
    }
    return weapon === 'gun'
      ? { direction: aim.dir, placeBomb: false, fireGun: true }
      : { direction: aim.dir, placeBomb: false, swingHammer: true };
  }
  const nodes = flood(ctx, col, row, blockUnsafe);
  for (let i = 1; i < nodes.length; i++) {
    if (skillAim(ctx, weapon, nodes[i].col, nodes[i].row, enemyTiles) !== null) {
      return { direction: firstStep(nodes, i), placeBomb: false };
    }
  }
  return null;
}

/**
 * Creates a bot controller for the given player. The caller owns the rng
 * (pass a seeded instance, e.g. createRng(seed)); the bot never calls
 * Math.random, so identical states and rng seeds yield identical inputs.
 */
export function createBot(playerId: string, rng: () => number): Bot {
  /**
   * Remembered dig/attack spot from the last decision. Re-planning from
   * scratch every tick is unstable: one step toward a target moves the BFS
   * start tile, the fixed tie-break order then prefers an equidistant spot on
   * the other side, and the bot walks back — an oscillation that keeps it
   * pacing between frontiers without ever standing on a bomb spot (in-browser
   * matches stalled exactly this way). The target is kept only while it still
   * qualifies (reachable, hits something, escapable), so this stays
   * deterministic: same state sequence + same rng still yields the same
   * inputs.
   */
  let digTarget: { col: number; row: number } | null = null;
  /** Sticky flee destination — re-picking every tick danced bots inside blasts. */
  let fleeTarget: { col: number; row: number } | null = null;
  /** Sticky powerup destination, kept while the powerup is still there. */
  let collectTarget: { col: number; row: number } | null = null;
  /** Idle heading, held until blocked/unsafe — a fresh random pick per tick
   * jiggled the bot one cell up/down forever. */
  let roamDir: Direction | null = null;
  let lastRule = '';
  const out = (rule: string, input: PlayerInput): PlayerInput => {
    lastRule = rule;
    return input;
  };
  return {
    get lastRule() {
      return lastRule;
    },
    computeInput(state: GameState): PlayerInput {
      const me = state.players.find((p) => p.id === playerId);
      if (!me || !me.alive) return out('dead', { direction: null, placeBomb: false });

      const col = Math.round(me.x);
      const row = Math.round(me.y);
      const ctx = buildContext(state);
      const blockUnsafe = (c: number, r: number) =>
        ctx.burning.has(key(c, r)) || ctx.danger.has(key(c, r));

      // 1. Survive: current tile is threatened -> get out. Stick with the safe
      // tile chosen on the first threatened tick while it stays safe and
      // reachable; equidistant safe tiles otherwise flip sides as the bot
      // moves and it dances one cell back and forth inside the blast.
      if (ctx.danger.has(key(col, row))) {
        if (fleeTarget !== null) {
          const t = fleeTarget;
          if (!ctx.danger.has(key(t.col, t.row))) {
            const blockBurning = (c: number, r: number) => ctx.burning.has(key(c, r));
            const nodes = flood(ctx, col, row, blockBurning);
            const idx = nodes.findIndex((n) => n.col === t.col && n.row === t.row);
            if (idx > 0) {
              return out(`flee>${t.col},${t.row}`, {
                direction: firstStep(nodes, idx),
                placeBomb: false,
              });
            }
          }
          fleeTarget = null;
        }
        const fled = flee(ctx, col, row);
        fleeTarget = fled.goal;
        return out('flee', fled.input);
      }
      fleeTarget = null; // safe again: next threat plans fresh

      // 2. Collect: nearest powerup reachable via safe tiles within 8 steps.
      // Sticky for the same reason as fleeing — two powerups at similar
      // distance must not alternate as the rounded position shifts.
      if (state.powerups.length > 0) {
        const nodes = flood(ctx, col, row, blockUnsafe, POWERUP_SEARCH_DEPTH);
        if (collectTarget !== null) {
          const t = collectTarget;
          const still = state.powerups.some((p) => p.col === t.col && p.row === t.row);
          const idx = still ? nodes.findIndex((n) => n.col === t.col && n.row === t.row) : -1;
          if (idx > 0) {
            return out(`collect>${t.col},${t.row}`, {
              direction: firstStep(nodes, idx),
              placeBomb: false,
            });
          }
          collectTarget = null; // taken, unreachable, or we are standing on it
        }
        const goal = nodes.findIndex((n) =>
          state.powerups.some((p) => p.col === n.col && p.row === n.row),
        );
        if (goal > 0) {
          collectTarget = { col: nodes[goal].col, row: nodes[goal].row };
          return out('collect', { direction: firstStep(nodes, goal), placeBomb: false });
        }
      }

      const enemyTiles = new Set<number>();
      for (const p of state.players) {
        if (p.id !== playerId && p.alive) enemyTiles.add(key(Math.round(p.x), Math.round(p.y)));
      }

      // 2.5 Unload mines. Held mine ammo hijacks the trigger server-side
      // (game.ts: `armed` includes mineAmmo), so no bomb can be placed until
      // the mines are gone — a bot that "places a bomb" while holding mines
      // actually drops a mine at its feet and then wonders why nothing
      // explodes. Drop them deliberately instead: current tile, when it is
      // mine- and bomb-free and a safe neighbor exists to step off to (the
      // mine only ever threatens its own tile). The tile joins the danger set
      // next tick, so rule 1 walks the bot off before the mine arms (3s).
      if (me.mineAmmo > 0) {
        const tileFree = !ctx.bombTiles.has(key(col, row)) && !state.mines.some((m) => m.col === col && m.row === row);
        const canStepOff = NEIGHBOR_STEPS.some(({ dc, dr }) => {
          const c = col + dc;
          const r = row + dr;
          return isPassable(ctx, c, r) && !blockUnsafe(c, r);
        });
        if (tileFree && canStepOff) {
          return out('mine:dump', { direction: null, placeBomb: false, placeMine: true });
        }
        // Bad spot (own bomb underfoot, mine already here, or no way off):
        // fall through — the walk rules move the bot and it retries elsewhere.
      }

      // 3. Attack/dig. A held gun or hammer takes over the trigger, so no bomb
      // can be placed until it is spent — use the weapon instead of standing
      // on a bomb spot forever. Kick leaves bombs working, so it is ignored.
      const weapon = me.hammerUses > 0 ? 'hammer' : me.gunAmmo > 0 ? 'gun' : null;
      if (weapon) {
        const action = useSkill(
          ctx,
          weapon,
          col,
          row,
          me.actionCooldown,
          enemyTiles,
          blockUnsafe,
          rng,
        );
        if (action) return out(`skill:${weapon}`, action);
        // No target reachable: fall through to idle (never placeBomb, which
        // would burn a swing at whatever the bot happens to be facing).
      } else {
        // Nearest safe-reachable tile whose bomb would hit a soft block or an
        // enemy AND that leaves an escape route. Spots without one are skipped
        // rather than given up on: taking only the nearest hit-tile stranded a
        // bot whose own tile qualified but was too tight to survive — it fell
        // through to idle and paced there forever, while a tile or two away sat
        // a spot it could have bombed from. Checking the escape before walking
        // also stops the bot from committing to a target it will refuse on
        // arrival, which is the same pacing loop one tile wide.
        const nodes = flood(ctx, col, row, blockUnsafe);
        // Stick with the remembered target while it still qualifies; only a
        // vanished/blocked/unescapable target triggers a re-selection.
        if (digTarget !== null) {
          const t = digTarget;
          const idx = nodes.findIndex((n) => n.col === t.col && n.row === t.row);
          if (
            idx < 0 ||
            !bombWouldHit(ctx, me.blastRadius, t.col, t.row, enemyTiles) ||
            !canEscapeOwnBomb(ctx, me.blastRadius, t.col, t.row)
          ) {
            digTarget = null;
          } else if (idx > 0) {
            return out(`dig>${t.col},${t.row}`, { direction: firstStep(nodes, idx), placeBomb: false });
          } else {
            digTarget = null; // arrived: place below (or idle if out of bombs)
            if (me.activeBombs < me.bombCount)
              return out('place', { direction: null, placeBomb: true });
          }
        }
        if (digTarget === null) {
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (!bombWouldHit(ctx, me.blastRadius, node.col, node.row, enemyTiles)) continue;
            if (!canEscapeOwnBomb(ctx, me.blastRadius, node.col, node.row)) continue;
            if (i > 0) {
              digTarget = { col: node.col, row: node.row };
              return out(`dig+${node.col},${node.row}`, {
                direction: firstStep(nodes, i),
                placeBomb: false,
              });
            }
            // Standing on a usable spot: place unless every bomb is already
            // out, in which case idling until one detonates beats squatting.
            if (me.activeBombs < me.bombCount)
              return out('place', { direction: null, placeBomb: true });
            break;
          }
        }
      }

      // 4. Idle: roam in a persistent direction, turning only when the tile
      // ahead stops being safe floor. Re-rolling the direction every tick made
      // the bot vibrate around one cell.
      if (roamDir !== null) {
        const step = NEIGHBOR_STEPS.find((s) => s.dir === roamDir)!;
        const c = col + step.dc;
        const r = row + step.dr;
        if (isPassable(ctx, c, r) && !blockUnsafe(c, r)) {
          return out('idle:roam', { direction: roamDir, placeBomb: false });
        }
        roamDir = null;
      }
      const options: Direction[] = [];
      for (const { dc, dr, dir } of NEIGHBOR_STEPS) {
        const c = col + dc;
        const r = row + dr;
        if (isPassable(ctx, c, r) && !blockUnsafe(c, r)) options.push(dir);
      }
      if (options.length === 0) return out('idle:stand', { direction: null, placeBomb: false });
      roamDir = options[Math.floor(rng() * options.length)];
      return out('idle:roam', { direction: roamDir, placeBomb: false });
    },
  };
}
