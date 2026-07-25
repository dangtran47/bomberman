import { describe, expect, it } from 'vitest';
import {
  BASE_SPEED,
  GRID_HEIGHT,
  GRID_WIDTH,
  ICE_GLIDE_SPEED_MULT,
  ICE_GLIDE_TICKS,
  ICE_TURN_DELAY_TICKS,
  TICK_RATE,
} from '../src/constants';
import { createGame } from '../src/game';
import type { Game, GameState } from '../src/game';
import { createRng } from '../src/rng';
import { TileType } from '../src/types';
import type { Direction, PlayerInput } from '../src/types';

const STEP = BASE_SPEED / TICK_RATE; // 0.15 tiles per tick at base speed
const IDLE: PlayerInput = { direction: null, placeBomb: false };
const move = (direction: Direction): PlayerInput => ({ direction, placeBomb: false });

function openGrid(): TileType[][] {
  return Array.from({ length: GRID_HEIGHT }, () =>
    Array<TileType>(GRID_WIDTH).fill(TileType.Floor),
  );
}

function run(game: Game, ticks: number, inputs: Record<string, PlayerInput> = {}): void {
  for (let i = 0; i < ticks; i++) game.tick(inputs);
}

function player(game: Game, id: string) {
  const found = game.state.players.find((p) => p.id === id);
  if (!found) throw new Error(`no player ${id}`);
  return found;
}

/** Ice is only ever produced by a compiled map; tests flip the mask directly. */
function iceAll(state: GameState): void {
  for (const row of state.ice) row.fill(true);
}

function game(grid: TileType[][] = openGrid(), ice = true): Game {
  const g = createGame({ seed: 1, playerIds: ['p1', 'p2'], grid });
  if (ice) iceAll(g.state);
  return g;
}

/** Expected glide distance for a released heading with `left` ticks of budget. */
function glideStep(left: number): number {
  return STEP * ICE_GLIDE_SPEED_MULT * (left / ICE_GLIDE_TICKS);
}

describe('ice glide', () => {
  it('keeps drifting after the input is released, decaying to a stop', () => {
    const g = game();
    run(g, 4, { p1: move('right') });
    const p1 = player(g, 'p1');
    expect(p1.x).toBeCloseTo(4 * STEP, 10);
    expect(p1.momentumDir).toBe('right');
    expect(p1.momentumTicks).toBe(ICE_GLIDE_TICKS);

    const deltas: number[] = [];
    for (let i = 0; i < ICE_GLIDE_TICKS; i++) {
      const before = p1.x;
      run(g, 1, { p1: IDLE });
      deltas.push(p1.x - before);
    }
    // Linear decay: full ICE_GLIDE_TICKS budget down to one tick's worth.
    for (let i = 0; i < deltas.length; i++) {
      expect(deltas[i]).toBeCloseTo(glideStep(ICE_GLIDE_TICKS - i), 10);
    }
    expect(p1.momentumDir).toBeNull();
    expect(p1.momentumTicks).toBe(0);

    const resting = p1.x;
    run(g, 5, { p1: IDLE });
    expect(p1.x).toBe(resting); // glide budget spent: fully stopped
  });

  it('does not glide off ice', () => {
    const g = game(openGrid(), false);
    run(g, 4, { p1: move('right') });
    const p1 = player(g, 'p1');
    expect(p1.x).toBeCloseTo(4 * STEP, 10);
    expect(p1.momentumDir).toBe('right');

    run(g, 5, { p1: IDLE });
    expect(p1.x).toBeCloseTo(4 * STEP, 10); // stops dead the tick the key is released
    expect(p1.momentumDir).toBeNull();
    expect(p1.momentumTicks).toBe(0);
  });
});

describe('ice turn delay', () => {
  it('holds the old heading for ICE_TURN_DELAY_TICKS before a turn takes', () => {
    const g = game();
    const p1 = player(g, 'p1');
    p1.x = 3;
    p1.y = 3;
    run(g, 1, { p1: move('right') });
    expect(p1.momentumDir).toBe('right');

    // Opposing input: the player keeps sliding along the old heading meanwhile.
    for (let i = 1; i < ICE_TURN_DELAY_TICKS; i++) {
      const beforeX = p1.x;
      run(g, 1, { p1: move('up') });
      expect(p1.momentumDir).toBe('right');
      expect(p1.turnTicks).toBe(i);
      expect(p1.x).toBeCloseTo(beforeX + STEP, 10); // still drifting right
      expect(p1.y).toBe(3);
    }

    const beforeX = p1.x;
    run(g, 1, { p1: move('up') });
    expect(p1.momentumDir).toBe('up'); // heading finally switches
    expect(p1.turnTicks).toBe(0);
    expect(p1.facing).toBe('up');
    // Still finishing the lane it was sliding into before it can travel up.
    expect(p1.x).toBeCloseTo(beforeX + STEP, 10);
    expect(p1.y).toBe(3);
  });

  it('turns immediately off ice', () => {
    const g = game(openGrid(), false);
    const p1 = player(g, 'p1');
    p1.x = 3;
    p1.y = 3;
    run(g, 1, { p1: move('right') });
    run(g, 1, { p1: move('up') });
    expect(p1.momentumDir).toBe('up'); // no turn delay to sit through
    expect(p1.turnTicks).toBe(0);
  });

  it('takes a new heading immediately when at rest', () => {
    const g = game();
    const p1 = player(g, 'p1');
    p1.x = 3;
    p1.y = 3;
    run(g, 1, { p1: move('down') });
    expect(p1.momentumDir).toBe('down');
    expect(p1.y).toBeCloseTo(3 + STEP, 10);
  });
});

describe('ice and walls', () => {
  it('kills momentum when the tile ahead is blocked', () => {
    const grid = openGrid();
    grid[0][3] = TileType.HardBlock;
    const g = game(grid);
    const p1 = player(g, 'p1');
    p1.x = 2; // hard block directly ahead

    run(g, 1, { p1: move('right') });
    expect(p1.x).toBe(2); // clamped at the tile center, as off ice
    expect(p1.momentumDir).toBeNull();
    expect(p1.momentumTicks).toBe(0);

    run(g, 5, { p1: IDLE });
    expect(p1.x).toBe(2); // nothing left to glide with
  });

  it('stops a drift that runs into a wall', () => {
    const grid = openGrid();
    grid[0][4] = TileType.HardBlock;
    const g = game(grid);
    const p1 = player(g, 'p1');
    p1.x = 2.4; // still short of tile 3's center, so the wall is not "ahead" yet

    run(g, 1, { p1: move('right') });
    expect(p1.momentumDir).toBe('right');
    run(g, 1, { p1: IDLE }); // glides on and clamps against the wall
    const stopped = p1.x;
    expect(stopped).toBeLessThanOrEqual(3);
    expect(p1.momentumDir).toBeNull();
    expect(p1.momentumTicks).toBe(0);

    run(g, 5, { p1: IDLE });
    expect(p1.x).toBe(stopped);
  });
});

describe('off-ice movement is unchanged', () => {
  it('follows the classic per-tick positions for a scripted run', () => {
    const g = game(openGrid(), false);
    const p1 = player(g, 'p1');

    run(g, 5, { p1: move('right') });
    expect(p1.x).toBeCloseTo(5 * STEP, 10);
    expect(p1.y).toBe(0);

    run(g, 3, { p1: IDLE });
    expect(p1.x).toBeCloseTo(5 * STEP, 10); // idle ticks never move anyone

    // Corner slide: from x=0.75 it takes one full tick plus 0.10 of the next to
    // reach the x=1 lane, and the leftover 0.05 plus two full ticks go into y.
    run(g, 4, { p1: move('down') });
    expect(p1.x).toBe(1);
    expect(p1.y).toBeCloseTo(0.05 + 2 * STEP, 10);
    expect(p1.turnTicks).toBe(0);
  });
});

describe('ice determinism', () => {
  it('two games with the same ice mask and scripted inputs stay JSON-equal', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const dirs: (Direction | null)[] = ['up', 'down', 'left', 'right', null];
    const rng = createRng(4242);
    const script: Record<string, PlayerInput>[] = [];
    for (let t = 0; t < 200; t++) {
      const inputs: Record<string, PlayerInput> = {};
      for (const id of ids) {
        inputs[id] = {
          direction: dirs[Math.floor(rng() * dirs.length)],
          placeBomb: rng() < 0.2,
        };
      }
      script.push(inputs);
    }
    const build = (): Game => createGame({ seed: 777, playerIds: ids, mapId: 'winter' });
    const g1 = build();
    const g2 = build();
    expect(g1.state.ice.flat().some(Boolean)).toBe(true); // the winter map really is icy
    for (const inputs of script) {
      g1.tick(inputs);
      g2.tick(inputs);
    }
    expect(JSON.stringify(g1.state)).toBe(JSON.stringify(g2.state));
  });
});
