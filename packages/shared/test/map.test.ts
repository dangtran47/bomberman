import { describe, expect, it } from 'vitest';
import { GRID_HEIGHT, GRID_WIDTH } from '../src/constants';
import { SPAWN_POINTS, generateMap } from '../src/map';
import { TileType } from '../src/types';

describe('generateMap', () => {
  it('produces a 13-row by 15-col grid', () => {
    const map = generateMap(1);
    expect(map).toHaveLength(GRID_HEIGHT);
    expect(GRID_HEIGHT).toBe(13);
    expect(GRID_WIDTH).toBe(15);
    for (const row of map) {
      expect(row).toHaveLength(GRID_WIDTH);
    }
  });

  it('places hard blocks exactly at odd col, odd row positions', () => {
    const map = generateMap(7);
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        if (col % 2 === 1 && row % 2 === 1) {
          expect(map[row][col]).toBe(TileType.HardBlock);
        } else {
          expect(map[row][col]).not.toBe(TileType.HardBlock);
        }
      }
    }
  });

  it('clears spawn corners and their two orthogonal neighbors toward center', () => {
    const map = generateMap(99);
    expect(SPAWN_POINTS).toEqual([
      { col: 0, row: 0 },
      { col: 14, row: 0 },
      { col: 0, row: 12 },
      { col: 14, row: 12 },
    ]);
    for (const { col, row } of SPAWN_POINTS) {
      const dx = col === 0 ? 1 : -1;
      const dy = row === 0 ? 1 : -1;
      expect(map[row][col]).toBe(TileType.Floor);
      expect(map[row][col + dx]).toBe(TileType.Floor);
      expect(map[row + dy][col]).toBe(TileType.Floor);
    }
  });

  it('is deterministic for the same seed', () => {
    expect(generateMap(2024)).toEqual(generateMap(2024));
  });

  it('differs between different seeds', () => {
    const a = generateMap(1);
    const b = generateMap(2);
    let differing = 0;
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        if (a[row][col] !== b[row][col]) differing++;
      }
    }
    expect(differing).toBeGreaterThan(0);
  });

  it('places a sane number of soft blocks', () => {
    const map = generateMap(555);
    const hardBlocks = 7 * 6; // odd cols (7) x odd rows (6)
    const eligible = GRID_WIDTH * GRID_HEIGHT - hardBlocks;
    let softBlocks = 0;
    for (const row of map) {
      for (const tile of row) {
        if (tile === TileType.SoftBlock) softBlocks++;
      }
    }
    expect(softBlocks).toBeGreaterThan(0);
    expect(softBlocks).toBeLessThan(eligible);
  });
});
