import { describe, expect, it } from 'vitest';
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  SUDDEN_DEATH_INTERVAL_TICKS,
  SUDDEN_DEATH_START_TICKS,
} from '../src/constants';
import { createBot } from '../src/bot';
import { createGame } from '../src/game';
import type { Game, GameEvent } from '../src/game';
import { createRng } from '../src/rng';
import { SHRINK_ORDER, computeShrinkOrder, shrinkCountAtTick } from '../src/suddenDeath';
import { TileType } from '../src/types';
import type { Direction, PlayerInput } from '../src/types';

function openGrid(): TileType[][] {
  return Array.from({ length: GRID_HEIGHT }, () =>
    Array<TileType>(GRID_WIDTH).fill(TileType.Floor),
  );
}

function run(game: Game, ticks: number, inputs: Record<string, PlayerInput> = {}): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    events.push(...game.tick(inputs));
  }
  return events;
}

function ofType<T extends GameEvent['type']>(
  events: GameEvent[],
  type: T,
): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

/** Open-grid two-player game with both players parked in the never-shrunk center. */
function centeredGame(): Game {
  const game = createGame({ seed: 1, playerIds: ['p1', 'p2'], grid: openGrid() });
  game.state.players[0].x = 6;
  game.state.players[0].y = 6;
  game.state.players[1].x = 8;
  game.state.players[1].y = 6;
  return game;
}

describe('computeShrinkOrder', () => {
  it('walks a ring clockwise from the top-left corner', () => {
    expect(computeShrinkOrder(5, 5, 1)).toEqual([
      // top row left -> right
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 0 },
      { col: 3, row: 0 },
      { col: 4, row: 0 },
      // right col top -> bottom
      { col: 4, row: 1 },
      { col: 4, row: 2 },
      { col: 4, row: 3 },
      { col: 4, row: 4 },
      // bottom row right -> left
      { col: 3, row: 4 },
      { col: 2, row: 4 },
      { col: 1, row: 4 },
      { col: 0, row: 4 },
      // left col bottom -> top
      { col: 0, row: 3 },
      { col: 0, row: 2 },
      { col: 0, row: 1 },
    ]);
  });

  it('covers rings 0-3 of the standard grid exactly once, leaving rows 4-8 x cols 4-10 open', () => {
    // Ring perimeters: 15x13 -> 52, 13x11 -> 44, 11x9 -> 36, 9x7 -> 28.
    expect(SHRINK_ORDER).toHaveLength(160);
    const seen = new Set(SHRINK_ORDER.map((c) => `${c.col},${c.row}`));
    expect(seen.size).toBe(160); // no duplicates
    for (const { col, row } of SHRINK_ORDER) {
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(GRID_WIDTH);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(GRID_HEIGHT);
      // Never touches the protected center region.
      const inCenter = col >= 4 && col <= 10 && row >= 4 && row <= 8;
      expect(inCenter).toBe(false);
    }
    // Every tile outside the center region is covered.
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        const inCenter = col >= 4 && col <= 10 && row >= 4 && row <= 8;
        expect(seen.has(`${col},${row}`)).toBe(!inCenter);
      }
    }
    // Documented start of the spiral.
    expect(SHRINK_ORDER.slice(0, 3)).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 0 },
    ]);
  });
});

describe('shrinkCountAtTick', () => {
  it('is 0 before the start tick, then one tile per interval, capped at the full order', () => {
    expect(shrinkCountAtTick(0)).toBe(0);
    expect(shrinkCountAtTick(SUDDEN_DEATH_START_TICKS - 1)).toBe(0);
    expect(shrinkCountAtTick(SUDDEN_DEATH_START_TICKS)).toBe(1);
    expect(shrinkCountAtTick(SUDDEN_DEATH_START_TICKS + SUDDEN_DEATH_INTERVAL_TICKS - 1)).toBe(1);
    expect(shrinkCountAtTick(SUDDEN_DEATH_START_TICKS + SUDDEN_DEATH_INTERVAL_TICKS)).toBe(2);
    expect(shrinkCountAtTick(SUDDEN_DEATH_START_TICKS + 159 * SUDDEN_DEATH_INTERVAL_TICKS)).toBe(160);
    expect(shrinkCountAtTick(1_000_000)).toBe(160);
  });
});

describe('sudden death', () => {
  it('starts exactly at SUDDEN_DEATH_START_TICKS with the (0,0) corner', () => {
    const game = centeredGame();
    const before = run(game, SUDDEN_DEATH_START_TICKS - 1);
    expect(ofType(before, 'arenaShrink')).toHaveLength(0);
    const at = run(game, 1); // tick SUDDEN_DEATH_START_TICKS
    expect(ofType(at, 'arenaShrink')).toEqual([{ type: 'arenaShrink', col: 0, row: 0 }]);
    expect(game.state.grid[0][0]).toBe(TileType.HardBlock);
  });

  it('converts one tile per interval in the documented spiral order', () => {
    const game = centeredGame();
    run(game, SUDDEN_DEATH_START_TICKS); // consume the first conversion
    const shrinks: { tick: number; col: number; row: number }[] = [];
    // The next 20 intervals: conversions 2..21, one per SUDDEN_DEATH_INTERVAL_TICKS.
    for (let i = 0; i < 20 * SUDDEN_DEATH_INTERVAL_TICKS; i++) {
      for (const e of game.tick({})) {
        if (e.type === 'arenaShrink') shrinks.push({ tick: game.state.tick, col: e.col, row: e.row });
      }
    }
    expect(shrinks.map(({ col, row }) => ({ col, row }))).toEqual(SHRINK_ORDER.slice(1, 21));
    for (const { tick } of shrinks) {
      expect((tick - SUDDEN_DEATH_START_TICKS) % SUDDEN_DEATH_INTERVAL_TICKS).toBe(0);
    }
  });

  it('kills a player standing on the converted tile and ends the game via the win check', () => {
    const game = createGame({ seed: 1, playerIds: ['p1', 'p2'], grid: openGrid() });
    // p1 stays on the (0,0) spawn; p2 parked in the center.
    game.state.players[1].x = 7;
    game.state.players[1].y = 6;
    const events = run(game, SUDDEN_DEATH_START_TICKS);
    expect(ofType(events, 'playerDied')).toEqual([
      { type: 'playerDied', playerId: 'p1', col: 0, row: 0 },
    ]);
    expect(ofType(events, 'gameEnded')).toEqual([{ type: 'gameEnded', winnerId: 'p2' }]);
    expect(game.state.players[0].alive).toBe(false);
    expect(game.state.status).toBe('finished');
  });

  it('declares a draw when the shrink kills the last players simultaneously', () => {
    const game = createGame({ seed: 1, playerIds: ['p1', 'p2'], grid: openGrid() });
    // Both players on (0,0), the first converted tile (players do not collide).
    game.state.players[1].x = 0;
    game.state.players[1].y = 0;
    const events = run(game, SUDDEN_DEATH_START_TICKS);
    expect(ofType(events, 'playerDied')).toHaveLength(2);
    expect(ofType(events, 'gameEnded')).toEqual([{ type: 'gameEnded', winnerId: null }]);
    expect(game.state.winnerId).toBeNull();
  });

  it('removes a bomb and a powerup sitting on the converted tile', () => {
    const game = createGame({ seed: 1, playerIds: ['p1', 'p2', 'p3'], grid: openGrid() });
    // p2/p3 in the center so the game keeps running after p1 dies at (0,0).
    game.state.players[1].x = 7;
    game.state.players[1].y = 6;
    game.state.players[2].x = 7;
    game.state.players[2].y = 7;
    run(game, SUDDEN_DEATH_START_TICKS - 10);
    run(game, 1, { p1: { direction: null, placeBomb: true } }); // tick 2391, fuse ends 2451
    expect(game.state.bombs).toHaveLength(1);
    game.state.powerups.push({ col: 0, row: 0, type: 0 });
    const events = run(game, 9); // through tick 2400: (0,0) converts
    expect(ofType(events, 'arenaShrink')).toEqual([{ type: 'arenaShrink', col: 0, row: 0 }]);
    expect(game.state.bombs).toEqual([]);
    expect(game.state.powerups).toEqual([]);
    expect(game.state.players[0].alive).toBe(false);
    expect(game.state.players[0].activeBombs).toBe(0); // slot freed with the crushed bomb
    // The crushed bomb never detonates.
    const later = run(game, 60);
    expect(ofType(later, 'bombExploded')).toHaveLength(0);
  });

  it('stops after ring 4, leaving the center region playable', () => {
    const game = centeredGame();
    const events = run(game, SUDDEN_DEATH_START_TICKS + 160 * SUDDEN_DEATH_INTERVAL_TICKS);
    expect(ofType(events, 'arenaShrink')).toHaveLength(160);
    const extra = run(game, 100);
    expect(ofType(extra, 'arenaShrink')).toHaveLength(0);
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        const inCenter = col >= 4 && col <= 10 && row >= 4 && row <= 8;
        expect(game.state.grid[row][col]).toBe(inCenter ? TileType.Floor : TileType.HardBlock);
      }
    }
    expect(game.state.status).toBe('running');
    expect(game.state.players.every((p) => p.alive)).toBe(true);
  });

  it('stays deterministic across the sudden-death boundary', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const dirs: (Direction | null)[] = ['up', 'down', 'left', 'right', null];
    const rng = createRng(99);
    const script: Record<string, PlayerInput>[] = [];
    for (let t = 0; t < SUDDEN_DEATH_START_TICKS + 20 * SUDDEN_DEATH_INTERVAL_TICKS; t++) {
      const inputs: Record<string, PlayerInput> = {};
      for (const id of ids) {
        inputs[id] = { direction: dirs[Math.floor(rng() * dirs.length)], placeBomb: false };
      }
      script.push(inputs);
    }
    const make = (): Game => createGame({ seed: 777, playerIds: ids, grid: openGrid() });
    const g1 = make();
    const g2 = make();
    const events1: GameEvent[] = [];
    const events2: GameEvent[] = [];
    for (const inputs of script) {
      events1.push(...g1.tick(inputs));
      events2.push(...g2.tick(inputs));
    }
    expect(ofType(events1, 'arenaShrink').length).toBeGreaterThan(0); // boundary crossed
    expect(g1.state).toEqual(g2.state);
    expect(events1).toEqual(events2);
  });

  it('bot flees a tile that is about to be converted', () => {
    const game = createGame({ seed: 1, playerIds: ['p1', 'p2'], grid: openGrid() });
    game.state.players[1].x = 7;
    game.state.players[1].y = 6;
    game.state.tick = SUDDEN_DEATH_START_TICKS - 5; // (0,0) converts in 5 ticks
    const bot = createBot('p1', createRng(1));
    // Nearest tile outside the imminent-shrink danger zone is (0,1), one step down.
    expect(bot.computeInput(game.state)).toEqual({ direction: 'down', placeBomb: false });
  });
});
