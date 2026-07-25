import type { Player } from './types';

export interface Placement {
  id: string;
  placement: number; // 1-based; ties share the lower number (competition ranking 1-2-2-4)
}

/**
 * Ranks players best-first: survivors (alive) outrank the dead; among the dead,
 * a later deathTick outranks an earlier one. Ties (same alive/deathTick) share a
 * placement; the next distinct group's placement is its 0-based sort index + 1.
 * A survivor is treated as deathTick = +Infinity for ordering.
 */
export function computePlacements(
  players: readonly Pick<Player, 'id' | 'alive' | 'deathTick'>[],
): Placement[] {
  const rankOf = (p: Pick<Player, 'alive' | 'deathTick'>): number =>
    p.alive ? Number.POSITIVE_INFINITY : (p.deathTick ?? -1);
  const sorted = [...players].sort((a, b) => rankOf(b) - rankOf(a));
  const result: Placement[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const prev = i > 0 ? sorted[i - 1] : null;
    const tied = prev !== null && rankOf(prev) === rankOf(p);
    const placement = tied ? result[i - 1].placement : i + 1;
    result.push({ id: p.id, placement });
  }
  return result;
}
