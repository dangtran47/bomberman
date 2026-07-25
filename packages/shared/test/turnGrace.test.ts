import { describe, expect, it } from 'vitest';
import { createGame } from '../src/game';
import type { Game } from '../src/game';
import { GRID_HEIGHT, GRID_WIDTH } from '../src/constants';
import { TileType } from '../src/types';
import type { PlayerInput } from '../src/types';

function openGrid(): TileType[][] {
  return Array.from({ length: GRID_HEIGHT }, () =>
    Array<TileType>(GRID_WIDTH).fill(TileType.Floor),
  );
}

function game(): Game {
  return createGame({ seed: 1, playerIds: ['p1', 'p2'], grid: openGrid() });
}

function p1(g: Game) {
  const p = g.state.players.find((x) => x.id === 'p1');
  if (!p) throw new Error('no p1');
  return p;
}

// Player moving right, just past column 5 (x=5.3), on row 7. A turn 'up' arrives
// with 200ms ping -> grace = min(0.45, 3 * 0.1) = 0.3, which covers the 0.3
// overshoot, so x snaps back to 5 and the player moves up instead of overshooting.
const up = (pingMs: number): PlayerInput => ({ direction: 'up', placeBomb: false, pingMs });

describe('turn grace', () => {
  it('snaps the turn back onto the junction when within ping-scaled grace', () => {
    const g = game();
    const p = p1(g);
    p.x = 5.3;
    p.y = 7;
    p.laneDir = 'right';
    g.tick({ p1: up(200) });
    expect(p.x).toBeCloseTo(5, 6); // snapped back to the junction column
    expect(p.y).toBeLessThan(7); // moved up this tick
  });

  it('does not snap when the overshoot exceeds grace (bounded by GRACE_CAP)', () => {
    const g = game();
    const p = p1(g);
    p.x = 5.4; // 0.4 past the junction
    p.y = 7;
    p.laneDir = 'right';
    g.tick({ p1: up(200) }); // grace 0.3 < 0.4
    expect(p.x).toBeGreaterThan(5.4); // slides forward toward column 6 (overshoot path intact)
    expect(p.y).toBeCloseTo(7, 6); // has not turned up yet
  });

  it('is inert offline (no pingMs -> grace 0 -> forward slide unchanged)', () => {
    const g = game();
    const p = p1(g);
    p.x = 5.3;
    p.y = 7;
    p.laneDir = 'right';
    g.tick({ p1: { direction: 'up', placeBomb: false } }); // no pingMs
    expect(p.x).toBeGreaterThan(5.3); // slides forward toward column 6
    expect(p.y).toBeCloseTo(7, 6);
  });
});
