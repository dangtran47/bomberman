import type { TileType } from '../types';

/**
 * What a single legend character expands to. `visual` is a purely cosmetic
 * hint for the renderer (the sim only ever looks at `tile`), and `maybeSoft`
 * marks a cell whose soft block is rolled per-seed at compile time.
 */
export interface CellDef {
  tile: TileType;
  ice?: boolean;
  visual?: string;
  maybeSoft?: boolean;
}

/** Multi-cell decoration (e.g. the winter house); every footprint cell must be HardBlock. */
export interface MapProp {
  visual: string;
  col: number;
  row: number;
  cols: number;
  rows: number;
}

/** Editable, matrix-based map definition. One row string per grid row. */
export interface MapDef {
  id: string;
  name: string;
  theme: 'classic' | 'winter';
  rows: string[]; // GRID_HEIGHT strings x GRID_WIDTH chars
  legend: Record<string, CellDef>;
  props?: MapProp[];
  spawnPoints?: { col: number; row: number }[];
}

export interface CompiledMap {
  grid: TileType[][];
  ice: boolean[][];
  visuals: (string | null)[][];
  props: MapProp[];
}
