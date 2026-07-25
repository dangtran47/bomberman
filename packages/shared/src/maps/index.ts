import { WINTER_MAP } from './winter';
import type { MapDef } from './types';

/** Every selectable non-procedural map, keyed by id. '' means classic procedural. */
export const MAPS: Record<string, MapDef> = {
  [WINTER_MAP.id]: WINTER_MAP,
};

/** Undefined for '' or an unknown id — callers fall back to generateMap(seed). */
export function getMapDef(id: string | undefined): MapDef | undefined {
  if (!id) return undefined;
  return MAPS[id];
}

export * from './types';
export * from './compile';
export * from './winter';
