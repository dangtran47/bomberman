import { describe, expect, it } from 'vitest';
import { GRID_HEIGHT, GRID_WIDTH } from '../src/constants';
import { createGame } from '../src/game';
import { SPAWN_POINTS, generateMap } from '../src/map';
import { MAPS, WINTER_MAP, compileMap, getMapDef } from '../src/maps';
import type { MapDef } from '../src/maps';
import { TileType } from '../src/types';

const LEGEND: MapDef['legend'] = {
  '.': { tile: TileType.Floor },
  '#': { tile: TileType.HardBlock },
  x: { tile: TileType.SoftBlock, visual: 'crate' },
  i: { tile: TileType.Floor, ice: true },
  '?': { tile: TileType.Floor, maybeSoft: true },
};

function baseRows(char = '.'): string[] {
  return Array.from({ length: GRID_HEIGHT }, () => char.repeat(GRID_WIDTH));
}

function setChar(rows: string[], col: number, row: number, char: string): void {
  rows[row] = rows[row].slice(0, col) + char + rows[row].slice(col + 1);
}

/** Clears each spawn tile and its two inward neighbors so validation passes. */
function clearSpawns(rows: string[]): string[] {
  for (const { col, row } of SPAWN_POINTS) {
    const dx = col < GRID_WIDTH / 2 ? 1 : -1;
    const dy = row < GRID_HEIGHT / 2 ? 1 : -1;
    setChar(rows, col, row, '.');
    setChar(rows, col + dx, row, '.');
    setChar(rows, col, row + dy, '.');
  }
  return rows;
}

function def(rows: string[], extra: Partial<MapDef> = {}): MapDef {
  return { id: 'test', name: 'Test', theme: 'classic', rows, legend: LEGEND, ...extra };
}

describe('compileMap validation', () => {
  it('rejects a wrong row count', () => {
    expect(() => compileMap(def(baseRows().slice(1)), 1)).toThrow(/expected 13 rows/);
  });

  it('rejects a wrong row length', () => {
    const rows = baseRows();
    rows[4] = '.'.repeat(GRID_WIDTH - 1);
    expect(() => compileMap(def(rows), 1)).toThrow(/row 4 has 14 chars/);
  });

  it('rejects a char that is not in the legend', () => {
    const rows = baseRows();
    setChar(rows, 5, 5, 'Z');
    expect(() => compileMap(def(rows), 1)).toThrow(/char "Z" at row 5 col 5/);
  });

  it('rejects a blocked spawn tile or blocked inward neighbor', () => {
    const blockedSpawn = baseRows();
    setChar(blockedSpawn, 0, 0, '#');
    expect(() => compileMap(def(blockedSpawn), 1)).toThrow(/spawn \(0, 0\) needs floor at \(0, 0\)/);

    const blockedNeighbor = baseRows();
    setChar(blockedNeighbor, 0, 11, 'x'); // inward neighbor of the (0, 12) spawn
    expect(() => compileMap(def(blockedNeighbor), 1)).toThrow(
      /spawn \(0, 12\) needs floor at \(0, 11\)/,
    );
  });

  it('rejects a prop whose footprint is not all hard blocks', () => {
    const rows = baseRows();
    const props = [{ visual: 'house', col: 6, row: 5, cols: 3, rows: 3 }];
    expect(() => compileMap(def(rows, { props }), 1)).toThrow(
      /prop "house" needs a hard block at \(6, 5\)/,
    );
  });

  it('rejects a prop that runs off the grid', () => {
    const rows = baseRows('#');
    clearSpawns(rows);
    const props = [{ visual: 'house', col: GRID_WIDTH - 1, row: 5, cols: 3, rows: 1 }];
    expect(() => compileMap(def(rows, { props }), 1)).toThrow(/prop "house" .* is out of bounds/);
  });
});

describe('compileMap output', () => {
  it('maps legend chars to tiles, ice and visuals', () => {
    const rows = baseRows();
    setChar(rows, 3, 2, '#');
    setChar(rows, 4, 2, 'x');
    setChar(rows, 5, 2, 'i');
    const compiled = compileMap(def(rows), 1);
    expect(compiled.grid).toHaveLength(GRID_HEIGHT);
    expect(compiled.grid[2][3]).toBe(TileType.HardBlock);
    expect(compiled.grid[2][4]).toBe(TileType.SoftBlock);
    expect(compiled.grid[2][5]).toBe(TileType.Floor);
    expect(compiled.ice[2][5]).toBe(true);
    expect(compiled.ice[2][4]).toBe(false);
    expect(compiled.visuals[2][4]).toBe('crate');
    expect(compiled.visuals[2][3]).toBeNull();
    expect(compiled.props).toEqual([]);
  });

  it('rolls `?` cells deterministically per seed off the game rng', () => {
    const rows = clearSpawns(baseRows('?'));
    const a = compileMap(def(rows), 2024);
    const b = compileMap(def(rows), 2024);
    expect(a.grid).toEqual(b.grid);

    const other = compileMap(def(rows), 99);
    let differing = 0;
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        if (a.grid[row][col] !== other.grid[row][col]) differing++;
      }
    }
    expect(differing).toBeGreaterThan(0); // ~180 coin flips: identical is impossible in practice

    // Only Floor or SoftBlock ever comes out of a `?`.
    const kinds = new Set(a.grid.flat());
    expect(kinds.has(TileType.HardBlock)).toBe(false);
    expect(kinds.has(TileType.SoftBlock)).toBe(true);
  });
});

describe('registry', () => {
  it('exposes the winter map and nothing for unknown ids', () => {
    expect(MAPS.winter).toBe(WINTER_MAP);
    expect(getMapDef('winter')).toBe(WINTER_MAP);
    expect(getMapDef('')).toBeUndefined();
    expect(getMapDef('nope')).toBeUndefined();
    expect(getMapDef(undefined)).toBeUndefined();
  });
});

describe('winter map', () => {
  it('compiles and matches its own legend cell for cell', () => {
    const compiled = compileMap(WINTER_MAP, 1);
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        const char = WINTER_MAP.rows[row][col];
        const cell = WINTER_MAP.legend[char];
        expect(compiled.grid[row][col]).toBe(cell.tile);
        expect(compiled.ice[row][col]).toBe(char === 'i');
      }
    }
  });

  it('has ice tiles and keeps them walkable floor', () => {
    const compiled = compileMap(WINTER_MAP, 1);
    let iceCells = 0;
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        if (!compiled.ice[row][col]) continue;
        iceCells++;
        expect(compiled.grid[row][col]).toBe(TileType.Floor);
      }
    }
    expect(iceCells).toBeGreaterThan(0);
  });

  it('backs the 3x3 house prop with nine hard blocks', () => {
    const compiled = compileMap(WINTER_MAP, 1);
    expect(compiled.props).toEqual([{ visual: 'house', col: 6, row: 5, cols: 3, rows: 3 }]);
    for (let row = 5; row < 8; row++) {
      for (let col = 6; col < 9; col++) {
        expect(compiled.grid[row][col]).toBe(TileType.HardBlock);
      }
    }
  });

  it('is seed-independent apart from `?` cells (it uses none today)', () => {
    expect(compileMap(WINTER_MAP, 1).grid).toEqual(compileMap(WINTER_MAP, 2).grid);
  });
});

describe('createGame mapId', () => {
  it('compiles the map and its ice mask when a known mapId is given', () => {
    const game = createGame({ seed: 5, playerIds: ['a', 'b'], mapId: 'winter' });
    const compiled = compileMap(WINTER_MAP, 5);
    expect(game.state.grid).toEqual(compiled.grid);
    expect(game.state.ice).toEqual(compiled.ice);
  });

  it('falls back to generateMap with an all-false ice mask', () => {
    for (const mapId of [undefined, '', 'nope']) {
      const game = createGame({ seed: 5, playerIds: ['a', 'b'], mapId });
      expect(game.state.grid).toEqual(generateMap(5));
      expect(game.state.ice.flat().some(Boolean)).toBe(false);
    }
  });

  it('lets an explicit grid override win over mapId', () => {
    const grid = Array.from({ length: GRID_HEIGHT }, () =>
      Array<TileType>(GRID_WIDTH).fill(TileType.Floor),
    );
    const game = createGame({ seed: 5, playerIds: ['a', 'b'], grid, mapId: 'winter' });
    expect(game.state.grid).toEqual(grid);
    expect(game.state.ice.flat().some(Boolean)).toBe(false);
  });
});
