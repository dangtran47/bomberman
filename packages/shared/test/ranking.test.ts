import { describe, expect, it } from 'vitest';
import { computePlacements } from '../src/ranking';
import type { Player } from '../src/types';

type Ranked = Pick<Player, 'id' | 'alive' | 'deathTick'>;

const p = (id: string, alive: boolean, deathTick: number | null): Ranked => ({
  id,
  alive,
  deathTick,
});

function placementOf(result: { id: string; placement: number }[], id: string): number {
  const found = result.find((r) => r.id === id);
  if (!found) throw new Error(`no placement for ${id}`);
  return found.placement;
}

describe('computePlacements', () => {
  it('gives the single survivor placement 1', () => {
    const result = computePlacements([
      p('a', false, 10),
      p('b', true, null),
      p('c', false, 20),
    ]);
    expect(placementOf(result, 'b')).toBe(1);
  });

  it('ranks distinct deathTicks 4/3/2/1 by death order (later death = better)', () => {
    const result = computePlacements([
      p('a', false, 10),
      p('b', false, 20),
      p('c', false, 30),
      p('d', false, 40),
    ]);
    expect(placementOf(result, 'd')).toBe(1); // died last
    expect(placementOf(result, 'c')).toBe(2);
    expect(placementOf(result, 'b')).toBe(3);
    expect(placementOf(result, 'a')).toBe(4); // died first
  });

  it('shares placement 1 for two dying on the final tick with no survivor', () => {
    const result = computePlacements([
      p('a', false, 5),
      p('b', false, 5),
      p('c', false, 40),
      p('d', false, 40),
    ]);
    expect(placementOf(result, 'c')).toBe(1);
    expect(placementOf(result, 'd')).toBe(1); // tie shares the lower number
    expect(placementOf(result, 'a')).toBe(3); // next distinct group is sort index + 1
    expect(placementOf(result, 'b')).toBe(3);
  });

  it('gives every survivor placement 1 when all are alive', () => {
    const result = computePlacements([
      p('a', true, null),
      p('b', true, null),
      p('c', true, null),
      p('d', true, null),
    ]);
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(placementOf(result, id)).toBe(1);
    }
  });
});
