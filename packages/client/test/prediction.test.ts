import { describe, expect, it } from 'vitest';
import { createGame, TileType } from '@bomberman/shared';
import type { Direction } from '@bomberman/shared';
import { Predictor } from '../src/prediction';
import type { PredictedPlayer } from '../src/prediction';

const F = TileType.Floor;
const H = TileType.HardBlock;

function boxGrid(): TileType[][] {
  return Array.from({ length: 13 }, (_, r) =>
    Array.from({ length: 15 }, (_, c) =>
      r === 0 || r === 12 || c === 0 || c === 14 ? H : F,
    ),
  );
}
function emptyIce(): boolean[][] {
  return Array.from({ length: 13 }, () => Array<boolean>(15).fill(false));
}
function spawn(): PredictedPlayer {
  return {
    x: 1, y: 1, speed: 3, kickTicks: 0,
    momentumDir: null, momentumTicks: 0, turnTicks: 0,
    laneDir: null, turnGrace: 0,
    alive: true, bombCount: 1, activeBombs: 0,
  };
}

/**
 * Reference: the real sim fed the same inputs. The sim spawns p0 in the corner
 * (0,0), which boxGrid walls off, so it is moved onto spawn()'s tile first.
 */
function referenceRun(inputs: { direction: Direction | null; placeBomb: boolean }[]) {
  const game = createGame({ seed: 1, playerIds: ['p0', 'p1'], grid: boxGrid() });
  const start = spawn();
  game.state.players[0].x = start.x;
  game.state.players[0].y = start.y;
  for (const input of inputs) game.tick({ p0: input });
  return game.state.players[0];
}

describe('Predictor', () => {
  it('prediction matches the sim exactly for movement inputs', () => {
    const inputs = (
      ['right', 'right', 'down', null, 'down', 'left', 'up', 'right', 'right', 'right'] as
      (Direction | null)[]
    ).map((direction) => ({ direction, placeBomb: false }));

    const p = new Predictor(spawn());
    for (const input of inputs) p.step(input.direction, false, boxGrid(), emptyIce(), []);
    const ref = referenceRun(inputs);
    expect(p.player.x).toBeCloseTo(ref.x, 12);
    expect(p.player.y).toBeCloseTo(ref.y, 12);
  });

  it('rebase + replay converges to the same position as pure prediction', () => {
    const dirs: (Direction | null)[] = ['right', 'right', 'right', 'down', 'down', 'down'];
    const pure = new Predictor(spawn());
    for (const d of dirs) pure.step(d, false, boxGrid(), emptyIce(), []);

    // Same inputs, but the server acks after tick 3 with the exact sim state.
    const acked = new Predictor(spawn());
    for (const d of dirs.slice(0, 3)) acked.step(d, false, boxGrid(), emptyIce(), []);
    const serverAt3 = referenceRun(dirs.slice(0, 3).map((direction) => ({ direction, placeBomb: false })));
    for (const d of dirs.slice(3)) acked.step(d, false, boxGrid(), emptyIce(), []);
    const err = acked.reconcile(
      { ...spawn(), ...pickPredicted(serverAt3) },
      3,
      boxGrid(),
      emptyIce(),
      [],
    );
    expect(err.dx).toBeCloseTo(0, 9);
    expect(err.dy).toBeCloseTo(0, 9);
    expect(acked.player.x).toBeCloseTo(pure.player.x, 9);
    expect(acked.player.y).toBeCloseTo(pure.player.y, 9);
    expect(acked.pending.length).toBe(3);
  });

  it('places an optimistic bomb that blocks its own tile after walking off', () => {
    const p = new Predictor(spawn());
    p.step(null, true, boxGrid(), emptyIce(), []);
    expect(p.bombs).toHaveLength(1);
    expect(p.bombs[0]).toMatchObject({ col: 1, row: 1 });
    expect(p.player.activeBombs).toBe(1);
    // Walk off, then try to walk back on: blocked by own predicted bomb.
    for (let i = 0; i < 10; i++) p.step('right', false, boxGrid(), emptyIce(), []);
    const off = p.player.x;
    expect(off).toBeGreaterThan(1.4);
    for (let i = 0; i < 10; i++) p.step('left', false, boxGrid(), emptyIce(), []);
    expect(p.player.x).toBeGreaterThanOrEqual(2 - 1e-9);
  });

  it('does not place beyond the bomb cap and refunds on reconcile', () => {
    const p = new Predictor(spawn());
    p.step(null, true, boxGrid(), emptyIce(), []);
    p.step(null, true, boxGrid(), emptyIce(), []); // cap = 1: second is refused
    expect(p.bombs).toHaveLength(1);
    expect(p.player.activeBombs).toBe(1);
    // Server acks both inputs but reports no bomb (rejected) and activeBombs 0.
    p.reconcile(spawn(), 2, boxGrid(), emptyIce(), []);
    expect(p.bombs).toHaveLength(0);
    expect(p.player.activeBombs).toBe(0);
  });

  it('stops predicting once dead', () => {
    const p = new Predictor(spawn());
    p.reconcile({ ...spawn(), alive: false }, 0, boxGrid(), emptyIce(), []);
    const before = p.player.x;
    p.step('right', false, boxGrid(), emptyIce(), []);
    expect(p.player.x).toBe(before);
  });
});

function pickPredicted(sim: { x: number; y: number; alive: boolean; speed: number; bombCount: number; activeBombs: number; kickTicks: number; momentumDir: Direction | null; momentumTicks: number; turnTicks: number; laneDir: Direction | null }): Partial<PredictedPlayer> {
  const { x, y, alive, speed, bombCount, activeBombs, kickTicks, momentumDir, momentumTicks, turnTicks, laneDir } = sim;
  return { x, y, alive, speed, bombCount, activeBombs, kickTicks, momentumDir, momentumTicks, turnTicks, laneDir };
}
