import { describe, expect, it } from 'vitest';
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  KICK_DURATION_TICKS,
  MAX_SPEED,
  SUDDEN_DEATH_START_TICKS,
  kickSlideInterval,
} from '../src/constants';
import { createGame } from '../src/game';
import type { Game, GameEvent } from '../src/game';
import { createRng } from '../src/rng';
import { SHRINK_ORDER } from '../src/suddenDeath';
import { PowerupType, TileType } from '../src/types';
import type { Bomb, Direction, PlayerInput } from '../src/types';

const move = (direction: Direction): PlayerInput => ({ direction, placeBomb: false });

function openGrid(): TileType[][] {
  return Array.from({ length: GRID_HEIGHT }, () =>
    Array<TileType>(GRID_WIDTH).fill(TileType.Floor),
  );
}

function run(game: Game, ticks: number, inputs: Record<string, PlayerInput> = {}): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks; i++) events.push(...game.tick(inputs));
  return events;
}

function player(game: Game, id: string) {
  const found = game.state.players.find((p) => p.id === id);
  if (!found) throw new Error(`no player ${id}`);
  return found;
}

function explosionTiles(game: Game): string[] {
  return game.state.explosions.map((c) => `${c.col},${c.row}`).sort();
}

function ofType<T extends GameEvent['type']>(
  events: GameEvent[],
  type: T,
): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

function twoPlayerGame(grid: TileType[][] = openGrid(), seed = 1): Game {
  return createGame({ seed, playerIds: ['p1', 'p2'], grid });
}

/** Push a bomb straight into game state (bypasses placement/ownership checks). */
function addBomb(game: Game, bomb: Partial<Bomb> & Pick<Bomb, 'col' | 'row'>): Bomb {
  const full: Bomb = {
    id: bomb.id ?? 999,
    col: bomb.col,
    row: bomb.row,
    ownerId: bomb.ownerId ?? 'p2',
    fuseTicks: bomb.fuseTicks ?? 5000,
    blastRadius: bomb.blastRadius ?? 1,
    slideDC: bomb.slideDC ?? 0,
    slideDR: bomb.slideDR ?? 0,
    slideCooldown: bomb.slideCooldown ?? 0,
    slideInterval: bomb.slideInterval ?? 0,
  };
  game.state.bombs.push(full);
  return full;
}

describe('kick pickup and decay', () => {
  it('sets kickTicks on pickup, decays 1/tick while alive, expires to 0, and re-pickup resets', () => {
    const game = twoPlayerGame();
    game.state.powerups.push({ col: 1, row: 0, type: PowerupType.Kick });
    run(game, 4, { p1: move('right') }); // collects at (1,0) on the 4th tick
    expect(player(game, 'p1').kickTicks).toBe(KICK_DURATION_TICKS);

    run(game, KICK_DURATION_TICKS - 1); // idle
    expect(player(game, 'p1').kickTicks).toBe(1);
    run(game, 1);
    expect(player(game, 'p1').kickTicks).toBe(0);
    run(game, 1);
    expect(player(game, 'p1').kickTicks).toBe(0); // clamped, never negative

    // re-pickup on the tile the (now idle) player is standing on resets to full
    const col = Math.round(player(game, 'p1').x);
    game.state.powerups.push({ col, row: 0, type: PowerupType.Kick });
    run(game, 1);
    expect(player(game, 'p1').kickTicks).toBe(KICK_DURATION_TICKS);
  });
});

describe('kick pushing bombs', () => {
  it('does not move a bomb when the pusher has no kick', () => {
    const game = twoPlayerGame();
    const bomb = addBomb(game, { col: 1, row: 0 });
    run(game, 10, { p1: move('right') });
    expect(player(game, 'p1').x).toBe(0); // still blocked at tile center
    expect(bomb.col).toBe(1);
    expect(bomb.slideDC).toBe(0);
    expect(bomb.slideDR).toBe(0);
  });

  it('slides a bomb one tile per speed-derived interval and lets the pusher follow', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.kickTicks = KICK_DURATION_TICKS;
    const interval = kickSlideInterval(p1.speed); // base speed 3 -> 2 ticks/tile
    const bomb = addBomb(game, { col: 1, row: 0 });

    run(game, interval, { p1: move('right') });
    expect(bomb.col).toBe(2); // advanced exactly one tile
    expect(bomb.slideDC).toBe(1);
    expect(bomb.slideInterval).toBe(interval);
    run(game, interval, { p1: move('right') });
    expect(bomb.col).toBe(3); // one more tile after another interval

    expect(player(game, 'p1').x).toBeGreaterThan(0); // pusher trailed the bomb
    run(game, 4, { p1: move('right') });
    expect(Math.round(player(game, 'p1').x)).toBe(1); // entered the vacated tile
  });

  it('gives a faster kicker a shorter slide interval', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.kickTicks = KICK_DURATION_TICKS;
    p1.speed = MAX_SPEED; // speed boosted
    const bomb = addBomb(game, { col: 1, row: 0 });

    run(game, 1, { p1: move('right') });
    expect(bomb.slideInterval).toBe(kickSlideInterval(MAX_SPEED));
    expect(bomb.slideInterval).toBeLessThan(kickSlideInterval(3)); // faster -> shorter interval
  });
});

describe('kicked bomb impact detonation', () => {
  it('detonates at its last floor tile when it hits a hard block', () => {
    const grid = openGrid();
    grid[0][6] = TileType.HardBlock;
    const game = twoPlayerGame(grid);
    addBomb(game, { col: 5, row: 0, slideDC: 1, slideCooldown: 1 });
    const events = run(game, 1);
    expect(ofType(events, 'bombExploded')).toHaveLength(1);
    expect(explosionTiles(game)).toContain('5,0');
    expect(game.state.grid[0][6]).toBe(TileType.HardBlock); // hard block survives
    expect(game.state.bombs).toEqual([]);
  });

  it('detonates and destroys a soft block it slides into', () => {
    const grid = openGrid();
    grid[0][6] = TileType.SoftBlock;
    const game = twoPlayerGame(grid);
    addBomb(game, { col: 5, row: 0, slideDC: 1, slideCooldown: 1 });
    const events = run(game, 1);
    expect(ofType(events, 'bombExploded')).toHaveLength(1);
    const tiles = explosionTiles(game);
    expect(tiles).toContain('5,0');
    expect(tiles).toContain('6,0');
    expect(game.state.grid[0][6]).toBe(TileType.Floor);
    expect(ofType(events, 'blockDestroyed')).toEqual([
      expect.objectContaining({ col: 6, row: 0 }),
    ]);
    expect(game.state.bombs).toEqual([]);
  });

  it('detonates at its last floor tile when it slides out of bounds', () => {
    const game = twoPlayerGame();
    addBomb(game, { col: 7, row: GRID_HEIGHT - 1, slideDR: 1, slideCooldown: 1 });
    const events = run(game, 1);
    expect(ofType(events, 'bombExploded')).toHaveLength(1);
    expect(explosionTiles(game)).toContain(`7,${GRID_HEIGHT - 1}`);
    expect(game.state.bombs).toEqual([]);
  });

  it('chain-detonates a second bomb it slides into', () => {
    const game = twoPlayerGame();
    addBomb(game, { id: 1, col: 5, row: 0, slideDC: 1, slideCooldown: 1 });
    addBomb(game, { id: 2, col: 6, row: 0 }); // stationary blocker
    const events = run(game, 1);
    expect(ofType(events, 'bombExploded')).toHaveLength(2);
    const tiles = explosionTiles(game);
    expect(tiles).toContain('5,0');
    expect(tiles).toContain('6,0');
    expect(game.state.bombs).toEqual([]);
  });

  it('detonates at the current tile when its fuse expires mid-slide', () => {
    const game = twoPlayerGame();
    // Won't move this tick (cooldown high) but the fuse runs out first.
    addBomb(game, { col: 5, row: 0, slideDC: 1, slideCooldown: 5, fuseTicks: 1 });
    const events = run(game, 1);
    expect(ofType(events, 'bombExploded')).toHaveLength(1);
    expect(explosionTiles(game)).toContain('5,0');
    expect(game.state.bombs).toEqual([]);
  });

  it('is crushed without detonating when sudden death converts its tile', () => {
    const game = twoPlayerGame();
    const { col, row } = SHRINK_ORDER[1]; // (1,0): free of player spawns
    // High cooldown so moveSlidingBombs does not advance it before the shrink.
    addBomb(game, { col, row, slideDC: 1, slideCooldown: 50 });
    game.state.tick = SUDDEN_DEATH_START_TICKS + 9; // next tick -> elapsed 10, index 1
    const events = run(game, 1);
    expect(ofType(events, 'arenaShrink')).toEqual([
      expect.objectContaining({ col, row }),
    ]);
    expect(ofType(events, 'bombExploded')).toHaveLength(0);
    expect(game.state.bombs).toEqual([]);
    expect(game.state.explosions).toEqual([]);
    expect(game.state.grid[row][col]).toBe(TileType.HardBlock);
  });
});

describe('kick determinism', () => {
  it('two games with the same seed, kick granted, and scripted inputs stay JSON-equal over 200 ticks', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const dirs: (Direction | null)[] = ['up', 'down', 'left', 'right', null];
    const rng = createRng(99);
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
    const build = (): Game => {
      const g = createGame({ seed: 777, playerIds: ids });
      for (const p of g.state.players) p.kickTicks = KICK_DURATION_TICKS;
      return g;
    };
    const g1 = build();
    const g2 = build();
    for (const inputs of script) {
      g1.tick(inputs);
      g2.tick(inputs);
    }
    expect(JSON.stringify(g1.state)).toBe(JSON.stringify(g2.state));
  });
});
