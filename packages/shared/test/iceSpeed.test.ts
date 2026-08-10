import { describe, expect, it } from 'vitest';
import {
  BASE_SPEED,
  GRID_HEIGHT,
  GRID_WIDTH,
  ICE_SPEED_MULT,
  TICK_RATE,
} from '../src/constants';
import { createGame } from '../src/game';
import type { Game, GameState } from '../src/game';
import { createRng } from '../src/rng';
import { TileType } from '../src/types';
import type { Direction, PlayerInput } from '../src/types';

const STEP = BASE_SPEED / TICK_RATE; // tiles per tick at base speed
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

describe('ice speed lanes', () => {
  it('moves ICE_SPEED_MULT times faster on ice', () => {
    const g = game();
    run(g, 4, { p1: move('right') });
    expect(player(g, 'p1').x).toBeCloseTo(4 * STEP * ICE_SPEED_MULT, 10);
  });

  it('moves at normal speed off ice', () => {
    const g = game(openGrid(), false);
    run(g, 4, { p1: move('right') });
    expect(player(g, 'p1').x).toBeCloseTo(4 * STEP, 10);
  });

  it('stops dead the tick the key is released — no glide', () => {
    const g = game();
    run(g, 4, { p1: move('right') });
    const p1 = player(g, 'p1');
    const stopped = p1.x;
    run(g, 10, { p1: IDLE });
    expect(p1.x).toBe(stopped);
    expect(p1.y).toBe(0);
  });

  it('reverses immediately — no momentum resisting the turn', () => {
    const g = game();
    const p1 = player(g, 'p1');
    p1.x = 3;
    p1.y = 3;
    run(g, 2, { p1: move('right') });
    expect(p1.x).toBeCloseTo(3 + 2 * STEP * ICE_SPEED_MULT, 10);
    run(g, 1, { p1: move('left') });
    expect(p1.x).toBeCloseTo(3 + STEP * ICE_SPEED_MULT, 10); // stepped straight back
  });

  it('boost only applies while the current tile is ice', () => {
    const g = game(openGrid(), false);
    g.state.ice[3][3] = true; // a single ice tile
    const p1 = player(g, 'p1');
    p1.x = 3;
    p1.y = 3;
    run(g, 1, { p1: move('right') });
    expect(p1.x).toBeCloseTo(3 + STEP * ICE_SPEED_MULT, 10); // boosted while on the ice tile
    p1.x = 4; // rounded tile is plain floor again
    run(g, 1, { p1: move('right') });
    expect(p1.x).toBeCloseTo(4 + STEP, 10); // back to normal speed
  });

  it('clamps against a wall like normal movement', () => {
    const grid = openGrid();
    grid[0][3] = TileType.HardBlock;
    const g = game(grid);
    const p1 = player(g, 'p1');
    p1.x = 2; // hard block directly ahead

    run(g, 3, { p1: move('right') });
    expect(p1.x).toBe(2); // clamped at the tile center, exactly as off ice
    run(g, 5, { p1: IDLE });
    expect(p1.x).toBe(2);
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
