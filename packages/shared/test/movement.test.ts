import { describe, expect, it } from 'vitest';
import { createGame, stepPlayer, TileType } from '../src';
import type { Direction, MovementPlayer, MovementWorld } from '../src';

const F = TileType.Floor;
const H = TileType.HardBlock;

/** 5x5 open box: hard border, floor inside. */
function boxGrid(): TileType[][] {
  return Array.from({ length: 13 }, (_, r) =>
    Array.from({ length: 15 }, (_, c) =>
      r === 0 || r === 12 || c === 0 || c === 14 ? H : F,
    ),
  );
}

function freshPlayer(x: number, y: number): MovementPlayer {
  return {
    x, y, speed: 3, kickTicks: 0,
    momentumDir: null, momentumTicks: 0, turnTicks: 0,
    laneDir: null, turnGrace: 0,
  };
}

function emptyIce(): boolean[][] {
  return Array.from({ length: 13 }, () => Array<boolean>(15).fill(false));
}

describe('stepPlayer (extracted movement)', () => {
  it('replaying the same input sequence twice gives identical trajectories', () => {
    const seq: (Direction | null)[] = [
      'right', 'right', 'right', 'down', 'down', null, 'left', 'left', 'up', 'right',
    ];
    const run = (): { x: number; y: number }[] => {
      const world: MovementWorld = { grid: boxGrid(), ice: emptyIce(), bombs: [] };
      const p = freshPlayer(1, 1);
      return seq.map((d) => {
        stepPlayer(world, p, d);
        return { x: p.x, y: p.y };
      });
    };
    expect(run()).toEqual(run());
  });

  it('matches GameImpl movement for a scripted input sequence', () => {
    const grid = boxGrid();
    const game = createGame({ seed: 1, playerIds: ['p0', 'p1'], grid });
    const sim = game.state.players[0];
    // Spawn (0,0) sits inside boxGrid's hard border, so the sim player could
    // never move there and the comparison would be vacuous; start both on floor.
    sim.x = 1;
    sim.y = 1;
    const world: MovementWorld = { grid: boxGrid(), ice: emptyIce(), bombs: [] };
    const local = freshPlayer(sim.x, sim.y);

    const seq: (Direction | null)[] = [
      'right', 'right', 'down', 'down', 'right', null, null, 'up', 'left', 'left',
      'down', 'right', 'right', 'right', 'up', 'up', null, 'down', 'left', null,
    ];
    for (const d of seq) {
      game.tick({ p0: { direction: d, placeBomb: false } });
      stepPlayer(world, local, d);
      expect(local.x).toBeCloseTo(sim.x, 12);
      expect(local.y).toBeCloseTo(sim.y, 12);
    }
  });

  it('is blocked by a bomb on the tile ahead', () => {
    const world: MovementWorld = {
      grid: boxGrid(),
      ice: emptyIce(),
      bombs: [{ col: 2, row: 1, slideDC: 0, slideDR: 0, slideCooldown: 0, slideInterval: 0 }],
    };
    const p = freshPlayer(1, 1);
    for (let i = 0; i < 20; i++) stepPlayer(world, p, 'right');
    expect(p.x).toBeLessThanOrEqual(1 + 1e-9);
  });
});
