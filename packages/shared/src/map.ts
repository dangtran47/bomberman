import { GRID_HEIGHT, GRID_WIDTH, SOFT_BLOCK_DENSITY } from './constants';
import { createRng } from './rng';
import { TileType } from './types';

export const SPAWN_POINTS: readonly Readonly<{ col: number; row: number }>[] = Object.freeze([
  Object.freeze({ col: 0, row: 0 }),
  Object.freeze({ col: GRID_WIDTH - 1, row: 0 }),
  Object.freeze({ col: 0, row: GRID_HEIGHT - 1 }),
  Object.freeze({ col: GRID_WIDTH - 1, row: GRID_HEIGHT - 1 }),
]);

/**
 * Generates a row-major [row][col] grid: hard blocks on the classic odd/odd
 * checkerboard, soft blocks scattered on remaining floor with the seeded RNG,
 * and spawn corners (plus their two orthogonal neighbors toward center) cleared.
 */
export function generateMap(seed: number): TileType[][] {
  const rng = createRng(seed);
  const map: TileType[][] = [];

  for (let row = 0; row < GRID_HEIGHT; row++) {
    const tiles: TileType[] = [];
    for (let col = 0; col < GRID_WIDTH; col++) {
      if (col % 2 === 1 && row % 2 === 1) {
        tiles.push(TileType.HardBlock);
      } else if (rng() < SOFT_BLOCK_DENSITY) {
        tiles.push(TileType.SoftBlock);
      } else {
        tiles.push(TileType.Floor);
      }
    }
    map.push(tiles);
  }

  for (const { col, row } of SPAWN_POINTS) {
    const dx = col === 0 ? 1 : -1;
    const dy = row === 0 ? 1 : -1;
    map[row][col] = TileType.Floor;
    map[row][col + dx] = TileType.Floor;
    map[row + dy][col] = TileType.Floor;
  }

  return map;
}
