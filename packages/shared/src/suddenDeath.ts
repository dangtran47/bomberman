import {
  GRID_HEIGHT,
  GRID_WIDTH,
  SUDDEN_DEATH_INTERVAL_TICKS,
  SUDDEN_DEATH_RINGS,
  SUDDEN_DEATH_START_TICKS,
} from './constants';

export interface ShrinkCell {
  col: number;
  row: number;
}

/**
 * Clockwise inward spiral of the outer `rings` rings: for each ring, top row
 * left->right, right col top->bottom, bottom row right->left, left col
 * bottom->top. Pure arithmetic, no RNG.
 */
export function computeShrinkOrder(width: number, height: number, rings: number): ShrinkCell[] {
  const order: ShrinkCell[] = [];
  for (let k = 0; k < rings; k++) {
    const top = k;
    const bottom = height - 1 - k;
    const left = k;
    const right = width - 1 - k;
    if (top > bottom || left > right) break;
    for (let col = left; col <= right; col++) order.push({ col, row: top });
    for (let row = top + 1; row <= bottom; row++) order.push({ col: right, row });
    if (bottom > top) {
      for (let col = right - 1; col >= left; col--) order.push({ col, row: bottom });
    }
    if (right > left) {
      for (let row = bottom - 1; row > top; row--) order.push({ col: left, row });
    }
  }
  return order;
}

/**
 * Conversion order for the standard grid. Rings 0-3 (160 tiles) are converted;
 * the shrink then stops, leaving the center region rows 4-8 x cols 4-10 open.
 */
export const SHRINK_ORDER: readonly ShrinkCell[] = computeShrinkOrder(
  GRID_WIDTH,
  GRID_HEIGHT,
  SUDDEN_DEATH_RINGS,
);

/** Number of tiles converted once the given tick has been simulated. */
export function shrinkCountAtTick(tick: number): number {
  if (tick < SUDDEN_DEATH_START_TICKS) return 0;
  const intervals = Math.floor((tick - SUDDEN_DEATH_START_TICKS) / SUDDEN_DEATH_INTERVAL_TICKS);
  return Math.min(SHRINK_ORDER.length, intervals + 1);
}
