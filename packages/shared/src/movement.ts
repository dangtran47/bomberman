import {
  GRID_HEIGHT,
  GRID_WIDTH,
  ICE_GLIDE_SPEED_MULT,
  ICE_GLIDE_TICKS,
  ICE_TURN_DELAY_TICKS,
  TICK_RATE,
  kickSlideInterval,
} from './constants';
import { TileType } from './types';
import type { Direction } from './types';

export interface MovementPlayer {
  x: number; y: number; speed: number;
  kickTicks: number;
  momentumDir: Direction | null; momentumTicks: number; turnTicks: number;
  laneDir: Direction | null; turnGrace: number;
}
export interface MovementBomb {
  col: number; row: number;
  slideDC: number; slideDR: number; slideCooldown: number; slideInterval: number;
}
export interface MovementWorld { grid: TileType[][]; ice: boolean[][]; bombs: MovementBomb[]; }

const EPS = 1e-9;

/**
 * Per-tick movement dispatcher. Off ice this is exactly the classic
 * "move while the key is held" behaviour; on ice the player carries a
 * momentum heading that resists turns and keeps gliding once the input is
 * released.
 */
export function stepPlayer(
  world: MovementWorld,
  player: MovementPlayer,
  direction: Direction | null,
): void {
  if (!isIce(world, Math.round(player.x), Math.round(player.y))) {
    player.turnTicks = 0;
    if (direction) driveIce(world, player, direction);
    else clearMomentum(player);
    return;
  }

  if (direction) {
    if (player.momentumDir === null || player.momentumDir === direction) {
      player.turnTicks = 0;
      driveIce(world, player, direction);
      return;
    }
    // Turning on ice: the old heading holds for a few ticks before it takes.
    player.turnTicks++;
    if (player.turnTicks >= ICE_TURN_DELAY_TICKS) {
      player.turnTicks = 0;
      driveIce(world, player, direction);
    } else {
      driveIce(world, player, player.momentumDir);
    }
    return;
  }

  // Released on ice: glide on in the last heading, decaying linearly.
  if (player.momentumDir === null || player.momentumTicks <= 0) {
    clearMomentum(player);
    return;
  }
  const mult = ICE_GLIDE_SPEED_MULT * (player.momentumTicks / ICE_GLIDE_TICKS);
  const blocked = movePlayer(world, player, player.momentumDir, mult);
  player.momentumTicks--;
  if (blocked || player.momentumTicks <= 0) clearMomentum(player);
}

/** Moves at full speed and (re)charges the glide budget unless a wall stops it. */
function driveIce(world: MovementWorld, player: MovementPlayer, direction: Direction): void {
  const blocked = movePlayer(world, player, direction);
  if (blocked) {
    clearMomentum(player);
    return;
  }
  player.momentumDir = direction;
  player.momentumTicks = ICE_GLIDE_TICKS;
}

function clearMomentum(player: MovementPlayer): void {
  player.momentumDir = null;
  player.momentumTicks = 0;
}

function isIce(world: MovementWorld, col: number, row: number): boolean {
  if (col < 0 || col >= GRID_WIDTH || row < 0 || row >= GRID_HEIGHT) return false;
  return world.ice[row][col];
}

/**
 * Axis-locked movement with corner slide: to move along an axis the player
 * must be aligned to the perpendicular lane; if not, the tick's movement
 * budget is spent sliding into the lane the player was already heading for
 * (see `laneAhead`), and any remainder goes into the requested direction.
 * `budgetMult` scales the tick's budget (ice glide); returns true when the
 * player was stopped short, either by the tile ahead or by an unreachable lane.
 */
function movePlayer(
  world: MovementWorld,
  player: MovementPlayer,
  direction: Direction,
  budgetMult = 1,
): boolean {
  let budget = (player.speed / TICK_RATE) * budgetMult;
  const horizontal = direction === 'left' || direction === 'right';

  let perp = horizontal ? player.y : player.x;
  // Turn onset: the new direction is perpendicular to the lane we were
  // committed to. If a latency budget says we only just overran the junction,
  // snap the perpendicular coordinate back onto it and turn there instead of
  // sliding forward to the next tile (the overshoot players feel online).
  if (player.turnGrace > EPS && player.laneDir !== null && player.laneDir !== direction) {
    const leavingHorizontally = player.laneDir === 'left' || player.laneDir === 'right';
    if (leavingHorizontally !== horizontal) {
      const junction = Math.round(perp);
      const offset = Math.abs(junction - perp);
      if (offset > EPS && offset <= player.turnGrace + EPS) {
        const col = horizontal ? Math.round(player.x) : junction;
        const row = horizontal ? junction : Math.round(player.y);
        if (canEnter(world, col, row)) {
          if (horizontal) player.y = junction;
          else player.x = junction;
          perp = junction;
        }
      }
    }
  }
  const lane = laneAhead(world, player, perp, horizontal);
  if (lane === null) return true;
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
      return false;
    }
  }
  if (budget <= EPS) return false;
  // Aligned from here on, so this direction owns the lane commitment: whatever
  // offset it leaves behind must be resolved in its own direction next tick.
  player.laneDir = direction;

  const sign = direction === 'down' || direction === 'right' ? 1 : -1;
  const pos = horizontal ? player.x : player.y;
  const cur = Math.round(pos);
  const target = pos + sign * budget;
  const nextCol = horizontal ? cur + sign : Math.round(player.x);
  const nextRow = horizontal ? Math.round(player.y) : cur + sign;
  let next: number;
  let blocked = false;
  if (canEnter(world, nextCol, nextRow)) {
    next = target;
  } else {
    blocked = true;
    // Kick: with the skill active, a bomb blocking the tile ahead slides off
    // in the movement direction; the player still clamps this tick.
    if (
      player.kickTicks > 0 &&
      nextCol >= 0 &&
      nextCol < GRID_WIDTH &&
      nextRow >= 0 &&
      nextRow < GRID_HEIGHT &&
      world.grid[nextRow][nextCol] === TileType.Floor
    ) {
      const bomb = bombAt(world, nextCol, nextRow);
      if (bomb) {
        // Direction may be overwritten mid-slide (e.g. an enemy kick), but the
        // cooldown is only armed from rest — otherwise a held push would reset
        // it every tick and the bomb would never advance.
        const wasStationary = bomb.slideDC === 0 && bomb.slideDR === 0;
        bomb.slideDC = horizontal ? sign : 0;
        bomb.slideDR = horizontal ? 0 : sign;
        bomb.slideInterval = kickSlideInterval(player.speed);
        if (wasStationary) bomb.slideCooldown = bomb.slideInterval;
      }
    }
    // Blocked ahead: may still advance up to the center of the current tile.
    next = sign > 0 ? Math.min(target, Math.max(cur, pos)) : Math.max(target, Math.min(cur, pos));
  }
  if (horizontal) player.x = next;
  else player.y = next;
  return blocked;
}

/**
 * The lane an off-lane player is allowed to settle into. Being off-lane only
 * ever comes from a move along the perpendicular axis, so the lane that move
 * was heading for is the one we keep: pulling the player back into the lane
 * they just left reverses their own input and throws their aim off. Returns
 * null when that lane has since been closed (a bomb dropped into it), which
 * makes the caller refuse the move rather than fall back to the lane behind.
 */
function laneAhead(
  world: MovementWorld,
  player: MovementPlayer,
  perp: number,
  horizontal: boolean,
): number | null {
  const nearest = Math.round(perp);
  if (Math.abs(nearest - perp) <= EPS) return nearest;

  const commit = player.laneDir;
  const perpendicular =
    commit !== null &&
    (horizontal ? commit === 'up' || commit === 'down' : commit === 'left' || commit === 'right');
  if (!perpendicular) return nearest; // no commitment to honour; keep the classic slide
  const lane = commit === 'down' || commit === 'right' ? Math.ceil(perp) : Math.floor(perp);
  if (lane === nearest) return lane; // already past the halfway point, so already inside that tile

  const col = horizontal ? Math.round(player.x) : lane;
  const row = horizontal ? lane : Math.round(player.y);
  return canEnter(world, col, row) ? lane : null;
}

/**
 * A tile can be entered if it is in bounds, is floor, and holds no bomb.
 * Only the tile ahead is ever checked, so a player still standing on their
 * own just-placed bomb can walk off it but cannot re-enter once gone.
 */
export function canEnter(world: MovementWorld, col: number, row: number): boolean {
  if (col < 0 || col >= GRID_WIDTH || row < 0 || row >= GRID_HEIGHT) return false;
  if (world.grid[row][col] !== TileType.Floor) return false;
  return !world.bombs.some((b) => b.col === col && b.row === row);
}

function bombAt(world: MovementWorld, col: number, row: number): MovementBomb | undefined {
  return world.bombs.find((b) => b.col === col && b.row === row);
}
