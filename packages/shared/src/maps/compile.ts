import { GRID_HEIGHT, GRID_WIDTH } from '../constants';
import { SPAWN_POINTS } from '../map';
import { createRng } from '../rng';
import { TileType } from '../types';
import type { CompiledMap, MapDef, MapProp } from './types';

/**
 * `?` cells roll from their own RNG stream, never the game's: the powerup
 * rolls in game.ts must stay on the exact same sequence they had before maps
 * existed (golden-seed tests) regardless of which map is being played.
 */
const MAYBE_SOFT_SEED_MIX = 0x9e3779b9;
const MAYBE_SOFT_CHANCE = 0.5;

/**
 * Expands a MapDef into concrete sim/render matrices for one seed.
 * Validation is loud: a broken matrix is an authoring bug, never something the
 * sim should silently paper over (client and server compile the same def).
 */
export function compileMap(def: MapDef, seed: number): CompiledMap {
  if (def.rows.length !== GRID_HEIGHT) {
    throw new Error(`map "${def.id}": expected ${GRID_HEIGHT} rows, got ${def.rows.length}`);
  }

  const rng = createRng((seed ^ MAYBE_SOFT_SEED_MIX) >>> 0);
  const grid: TileType[][] = [];
  const ice: boolean[][] = [];
  const visuals: (string | null)[][] = [];

  for (let row = 0; row < GRID_HEIGHT; row++) {
    const line = def.rows[row];
    if (line.length !== GRID_WIDTH) {
      throw new Error(
        `map "${def.id}": row ${row} has ${line.length} chars, expected ${GRID_WIDTH}`,
      );
    }
    const tiles: TileType[] = [];
    const iceRow: boolean[] = [];
    const visualRow: (string | null)[] = [];
    for (let col = 0; col < GRID_WIDTH; col++) {
      const char = line[col];
      const cell = def.legend[char];
      if (!cell) {
        throw new Error(`map "${def.id}": char "${char}" at row ${row} col ${col} is not in the legend`);
      }
      // Rolled row-major so the same seed always yields the same layout.
      const tile = cell.maybeSoft
        ? rng() < MAYBE_SOFT_CHANCE
          ? TileType.SoftBlock
          : TileType.Floor
        : cell.tile;
      tiles.push(tile);
      iceRow.push(cell.ice === true);
      visualRow.push(cell.visual ?? null);
    }
    grid.push(tiles);
    ice.push(iceRow);
    visuals.push(visualRow);
  }

  validateSpawns(def, grid);
  const props = def.props ?? [];
  validateProps(def, grid, props);

  return { grid, ice, visuals, props };
}

/** Spawn tile plus its two orthogonal neighbors toward the center must be walkable. */
function validateSpawns(def: MapDef, grid: TileType[][]): void {
  const spawns = def.spawnPoints ?? SPAWN_POINTS;
  for (const { col, row } of spawns) {
    if (col < 0 || col >= GRID_WIDTH || row < 0 || row >= GRID_HEIGHT) {
      throw new Error(`map "${def.id}": spawn (${col}, ${row}) is out of bounds`);
    }
    const dx = col < GRID_WIDTH / 2 ? 1 : -1;
    const dy = row < GRID_HEIGHT / 2 ? 1 : -1;
    const required = [
      { col, row },
      { col: col + dx, row },
      { col, row: row + dy },
    ];
    for (const cell of required) {
      if (grid[cell.row]?.[cell.col] !== TileType.Floor) {
        throw new Error(
          `map "${def.id}": spawn (${col}, ${row}) needs floor at (${cell.col}, ${cell.row})`,
        );
      }
    }
  }
}

/** A prop is drawn as one sprite over cells the sim must already treat as solid. */
function validateProps(def: MapDef, grid: TileType[][], props: MapProp[]): void {
  for (const prop of props) {
    if (prop.cols < 1 || prop.rows < 1) {
      throw new Error(`map "${def.id}": prop "${prop.visual}" must cover at least one cell`);
    }
    if (
      prop.col < 0 ||
      prop.row < 0 ||
      prop.col + prop.cols > GRID_WIDTH ||
      prop.row + prop.rows > GRID_HEIGHT
    ) {
      throw new Error(`map "${def.id}": prop "${prop.visual}" at (${prop.col}, ${prop.row}) is out of bounds`);
    }
    for (let row = prop.row; row < prop.row + prop.rows; row++) {
      for (let col = prop.col; col < prop.col + prop.cols; col++) {
        if (grid[row][col] !== TileType.HardBlock) {
          throw new Error(
            `map "${def.id}": prop "${prop.visual}" needs a hard block at (${col}, ${row})`,
          );
        }
      }
    }
  }
}
