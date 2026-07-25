import { describe, expect, it } from 'vitest';
import {
  BASE_BLAST_RADIUS,
  BASE_BOMB_COUNT,
  BASE_SPEED,
  BOMB_FUSE_TICKS,
  GRID_HEIGHT,
  GRID_WIDTH,
  MAX_BLAST_RADIUS,
  MAX_BOMB_COUNT,
  MAX_SPEED,
} from '../src/constants';
import { createGame } from '../src/game';
import type { Game, GameEvent } from '../src/game';
import { generateMap } from '../src/map';
import { createRng } from '../src/rng';
import { PowerupType, TileType } from '../src/types';
import type { Direction, PlayerInput } from '../src/types';

// Seeds mined against createRng so the game's FIRST powerup roll is known.
// Type roll is Math.floor(rng() * POWERUP_TYPE_COUNT) with POWERUP_TYPE_COUNT=4:
// seed 7 -> drop ExtraBomb, seed 15 -> drop BiggerBlast, seed 8 -> drop Speed,
// seed 1 -> no drop (first roll 0.627 >= POWERUP_DROP_CHANCE).
const SEED_EXTRA_BOMB = 7;
const SEED_BIGGER_BLAST = 15;
const SEED_SPEED = 8;
const SEED_NO_DROP = 1;

const STEP = BASE_SPEED / 20; // 0.15 tiles per tick at base speed

const move = (direction: Direction): PlayerInput => ({ direction, placeBomb: false });
const dropBomb = (): PlayerInput => ({ direction: null, placeBomb: true });

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

function twoPlayerGame(grid: TileType[][] = openGrid(), seed = SEED_NO_DROP): Game {
  return createGame({ seed, playerIds: ['p1', 'p2'], grid });
}

describe('createGame', () => {
  it('spawns players at the corner spawn points in playerIds order with base stats', () => {
    const game = createGame({ seed: 5, playerIds: ['a', 'b', 'c'] });
    expect(game.state.tick).toBe(0);
    expect(game.state.status).toBe('running');
    expect(game.state.winnerId).toBeNull();
    expect(game.state.bombs).toEqual([]);
    expect(game.state.explosions).toEqual([]);
    expect(game.state.powerups).toEqual([]);
    const positions = game.state.players.map((p) => [p.id, p.x, p.y]);
    expect(positions).toEqual([
      ['a', 0, 0],
      ['b', 14, 0],
      ['c', 0, 12],
    ]);
    for (const p of game.state.players) {
      expect(p.alive).toBe(true);
      expect(p.speed).toBe(BASE_SPEED);
      expect(p.bombCount).toBe(BASE_BOMB_COUNT);
      expect(p.blastRadius).toBe(BASE_BLAST_RADIUS);
      expect(p.activeBombs).toBe(0);
    }
  });

  it('uses generateMap(seed) for the grid by default', () => {
    const game = createGame({ seed: 5, playerIds: ['a', 'b'] });
    expect(game.state.grid).toEqual(generateMap(5));
  });

  it('deep-copies a provided grid override', () => {
    const grid = openGrid();
    const game = createGame({ seed: 1, playerIds: ['a', 'b'], grid });
    grid[0][1] = TileType.HardBlock;
    expect(game.state.grid[0][1]).toBe(TileType.Floor);
  });

  it('rejects fewer than 2 or more than 4 players', () => {
    expect(() => createGame({ seed: 1, playerIds: ['a'] })).toThrow();
    expect(() => createGame({ seed: 1, playerIds: ['a', 'b', 'c', 'd', 'e'] })).toThrow();
  });
});

describe('movement', () => {
  it('moves speed/TICK_RATE tiles per tick', () => {
    const game = twoPlayerGame();
    run(game, 1, { p1: move('right') });
    expect(player(game, 'p1').x).toBeCloseTo(STEP, 10);
    expect(player(game, 'p1').y).toBe(0);
    run(game, 1, { p1: move('right') });
    expect(player(game, 'p1').x).toBeCloseTo(2 * STEP, 10);
  });

  it('is blocked by soft blocks', () => {
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock;
    const game = twoPlayerGame(grid);
    run(game, 5, { p1: move('right') });
    expect(player(game, 'p1').x).toBe(0);
  });

  it('is blocked by hard blocks', () => {
    const grid = openGrid();
    grid[0][1] = TileType.HardBlock;
    const game = twoPlayerGame(grid);
    run(game, 5, { p1: move('right') });
    expect(player(game, 'p1').x).toBe(0);
  });

  it('corner-slides toward the nearest lane before moving in the new direction', () => {
    const game = twoPlayerGame();
    run(game, 2, { p1: move('down') }); // y ~= 0.3, not row-aligned
    run(game, 1, { p1: move('right') });
    expect(player(game, 'p1').y).toBeCloseTo(0.15, 10); // slid back toward row 0
    expect(player(game, 'p1').x).toBeCloseTo(0, 10); // no horizontal progress yet
    run(game, 1, { p1: move('right') });
    expect(player(game, 'p1').y).toBe(0); // snapped exactly into the lane
    run(game, 1, { p1: move('right') });
    expect(player(game, 'p1').x).toBeCloseTo(STEP, 10);
  });

  it('slides to the nearest lane and spends leftover budget on the new direction', () => {
    const game = twoPlayerGame();
    run(game, 5, { p1: move('down') }); // y ~= 0.75, nearest lane is row 1
    run(game, 1, { p1: move('right') });
    expect(player(game, 'p1').y).toBeCloseTo(0.9, 10); // slid down, not up
    run(game, 1, { p1: move('right') });
    expect(player(game, 'p1').y).toBe(1); // snapped to row 1
    expect(player(game, 'p1').x).toBeCloseTo(0.05, 6); // remainder spent moving right
  });

  it('clamps at the grid edge', () => {
    const game = twoPlayerGame();
    run(game, 5, { p1: move('left') });
    expect(player(game, 'p1').x).toBe(0);
    run(game, 5, { p1: move('up') });
    expect(player(game, 'p1').y).toBe(0);
  });

  it('ignores missing inputs (players idle) and accepts a Map of inputs', () => {
    const game = twoPlayerGame();
    const events = run(game, 3, {});
    expect(events).toEqual([]);
    expect(player(game, 'p1').x).toBe(0);
    expect(game.state.tick).toBe(3);
    game.tick(new Map([['p1', move('right')]]));
    expect(player(game, 'p1').x).toBeCloseTo(STEP, 10);
  });
});

describe('bombs', () => {
  it('places a bomb on the player tile with the player blast radius', () => {
    const game = twoPlayerGame();
    const events = run(game, 1, { p1: dropBomb() });
    const placed = ofType(events, 'bombPlaced');
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ ownerId: 'p1', col: 0, row: 0 });
    expect(game.state.bombs).toHaveLength(1);
    expect(game.state.bombs[0]).toMatchObject({
      col: 0,
      row: 0,
      ownerId: 'p1',
      blastRadius: BASE_BLAST_RADIUS,
    });
    expect(player(game, 'p1').activeBombs).toBe(1);
  });

  it('does not stack two bombs on one tile', () => {
    const game = twoPlayerGame();
    run(game, 1, { p1: dropBomb() });
    const events = run(game, 1, { p1: dropBomb() });
    expect(ofType(events, 'bombPlaced')).toHaveLength(0);
    expect(game.state.bombs).toHaveLength(1);
  });

  it('enforces bombCount, freeing a slot once the bomb explodes', () => {
    const game = twoPlayerGame();
    run(game, 1, { p1: dropBomb() }); // tick 1: bomb at (0,0)
    run(game, 14, { p1: move('down') }); // tick 15: p1 at (0,2), out of blast
    const rejected = run(game, 1, { p1: dropBomb() }); // tick 16: at bombCount limit
    expect(ofType(rejected, 'bombPlaced')).toHaveLength(0);
    expect(game.state.bombs).toHaveLength(1);
    run(game, 44); // tick 60: bomb explodes
    expect(game.state.bombs).toHaveLength(0);
    expect(player(game, 'p1').activeBombs).toBe(0);
    const events = run(game, 1, { p1: dropBomb() }); // tick 61: slot free again
    expect(ofType(events, 'bombPlaced')).toHaveLength(1);
    expect(game.state.bombs[0]).toMatchObject({ col: 0, row: 2 });
  });

  it('lets the owner walk off the bomb but not re-enter its tile', () => {
    const game = twoPlayerGame();
    run(game, 1, { p1: dropBomb() });
    run(game, 7, { p1: move('right') }); // walks off the bomb tile
    expect(Math.round(player(game, 'p1').x)).toBe(1);
    run(game, 7, { p1: move('left') }); // blocked at center of tile 1
    expect(player(game, 'p1').x).toBe(1);
  });

  it('explodes after BOMB_FUSE_TICKS ticks (placement tick included)', () => {
    const game = twoPlayerGame();
    run(game, 1, { p1: dropBomb() });
    const early = [
      ...run(game, 14, { p1: move('down') }),
      ...run(game, BOMB_FUSE_TICKS - 16),
    ]; // ticks 2..59
    expect(ofType(early, 'bombExploded')).toHaveLength(0);
    const events = run(game, 1); // tick 60
    expect(ofType(events, 'bombExploded')).toHaveLength(1);
  });
});

describe('explosions', () => {
  /** Places a bomb at (0,0) on tick 1, walks p1 to safety at (0,2), waits for the blast. */
  function explodeCornerBomb(game: Game): GameEvent[] {
    run(game, 1, { p1: dropBomb() });
    run(game, 14, { p1: move('down') });
    return run(game, 45); // last tick is tick 60, when the bomb explodes
  }

  it('covers a cross of radius 1, clipped at the grid edge, and expires after its duration', () => {
    const game = twoPlayerGame();
    const events = explodeCornerBomb(game);
    const exploded = ofType(events, 'bombExploded');
    expect(exploded).toHaveLength(1);
    expect(exploded[0].cells.map((c) => `${c.col},${c.row}`).sort()).toEqual([
      '0,0',
      '0,1',
      '1,0',
    ]);
    expect(explosionTiles(game)).toEqual(['0,0', '0,1', '1,0']);
    run(game, 9); // ticks 61..69: still burning
    expect(game.state.explosions).toHaveLength(3);
    run(game, 1); // tick 70: expired
    expect(game.state.explosions).toEqual([]);
  });

  it('stops rays at hard blocks without destroying them', () => {
    const grid = openGrid();
    grid[0][1] = TileType.HardBlock;
    const game = twoPlayerGame(grid);
    const events = explodeCornerBomb(game);
    expect(explosionTiles(game)).toEqual(['0,0', '0,1']);
    expect(game.state.grid[0][1]).toBe(TileType.HardBlock);
    expect(ofType(events, 'blockDestroyed')).toHaveLength(0);
  });

  it('destroys a soft block, includes its tile, and spawns a deterministic powerup', () => {
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock;
    const game = twoPlayerGame(grid, SEED_BIGGER_BLAST);
    const events = explodeCornerBomb(game);
    expect(explosionTiles(game)).toEqual(['0,0', '0,1', '1,0']);
    expect(game.state.grid[0][1]).toBe(TileType.Floor);
    expect(ofType(events, 'blockDestroyed')).toEqual([
      expect.objectContaining({ col: 1, row: 0 }),
    ]);
    expect(ofType(events, 'powerupSpawned')).toEqual([
      expect.objectContaining({ col: 1, row: 0, powerupType: PowerupType.BiggerBlast }),
    ]);
    // Spawned by the current explosion: survives it even while the tile burns.
    expect(game.state.powerups).toEqual([
      { col: 1, row: 0, type: PowerupType.BiggerBlast },
    ]);
  });

  it('destroys a soft block without a drop when the roll fails', () => {
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock;
    const game = twoPlayerGame(grid, SEED_NO_DROP);
    const events = explodeCornerBomb(game);
    expect(ofType(events, 'blockDestroyed')).toHaveLength(1);
    expect(ofType(events, 'powerupSpawned')).toHaveLength(0);
    expect(game.state.powerups).toEqual([]);
  });

  it('stops a longer ray at the first soft block it destroys', () => {
    // Seed 8 drops BiggerBlast from the first destroyed block; p1 collects it
    // so the second bomb has radius 2, with soft blocks at (2,0) and (3,0).
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock;
    grid[0][2] = TileType.SoftBlock;
    grid[0][3] = TileType.SoftBlock;
    const game = twoPlayerGame(grid, SEED_BIGGER_BLAST);
    explodeCornerBomb(game); // tick 60: destroys (1,0), drops BiggerBlast there
    run(game, 10); // tick 70: explosion cleared
    run(game, 15, { p1: move('up') }); // back to (0,0)
    const walk = run(game, 7, { p1: move('right') }); // collect at (1,0), stop at soft (2,0)
    expect(ofType(walk, 'powerupCollected')).toHaveLength(1);
    expect(player(game, 'p1').blastRadius).toBe(2);
    expect(player(game, 'p1').x).toBe(1);
    run(game, 1, { p1: dropBomb() }); // tick 93: radius-2 bomb at (1,0)
    expect(game.state.bombs[0]).toMatchObject({ col: 1, row: 0, blastRadius: 2 });
    run(game, 7, { p1: move('left') }); // back to (0,0)
    run(game, 14, { p1: move('down') }); // to (0,2), outside the blast
    const events = run(game, 38); // last tick is 152: bomb explodes
    expect(ofType(events, 'bombExploded')).toHaveLength(1);
    const tiles = explosionTiles(game);
    expect(tiles).toContain('2,0'); // destroyed soft block is included
    expect(tiles).not.toContain('3,0'); // ray stopped, block beyond untouched
    expect(game.state.grid[0][2]).toBe(TileType.Floor);
    expect(game.state.grid[0][3]).toBe(TileType.SoftBlock);
    expect(ofType(events, 'blockDestroyed')).toEqual([
      expect.objectContaining({ col: 2, row: 0 }),
    ]);
    expect(player(game, 'p1').alive).toBe(true);
  });

  it('chain reaction: a ray hitting another bomb detonates it the same tick', () => {
    // Seed 7 drops ExtraBomb from the first destroyed block -> bombCount 2.
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock;
    const game = twoPlayerGame(grid, SEED_EXTRA_BOMB);
    run(game, 1, { p1: dropBomb() });
    run(game, 14, { p1: move('down') });
    run(game, 45); // tick 60: explosion destroys (1,0), drops ExtraBomb
    run(game, 10); // tick 70: cleared
    run(game, 15, { p1: move('up') });
    run(game, 7, { p1: move('right') }); // collects ExtraBomb at (1,0)
    expect(player(game, 'p1').bombCount).toBe(2);
    run(game, 1, { p1: dropBomb() }); // tick 93: bomb A at (1,0), explodes tick 152
    run(game, 7, { p1: move('right') });
    run(game, 1, { p1: dropBomb() }); // tick 101: bomb B at (2,0), would explode tick 160
    expect(game.state.bombs).toHaveLength(2);
    expect(player(game, 'p1').activeBombs).toBe(2);
    run(game, 14, { p1: move('right') }); // retreat to (4,0)
    const quiet = run(game, 36); // ticks 116..151
    expect(ofType(quiet, 'bombExploded')).toHaveLength(0);
    const events = run(game, 1); // tick 152: A explodes, chain-detonates B
    expect(ofType(events, 'bombExploded')).toHaveLength(2);
    expect(game.state.bombs).toEqual([]);
    expect(player(game, 'p1').activeBombs).toBe(0);
    expect(explosionTiles(game)).toContain('3,0'); // B's own right ray fired
    expect(player(game, 'p1').alive).toBe(true);
  });

  it('burns a pre-existing powerup caught in a later blast', () => {
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock;
    const game = twoPlayerGame(grid, SEED_BIGGER_BLAST);
    explodeCornerBomb(game); // tick 60: BiggerBlast spawns at (1,0)
    run(game, 10); // tick 70: explosion cleared, powerup intact
    expect(game.state.powerups).toHaveLength(1);
    run(game, 15, { p1: move('up') }); // back to (0,0) without touching (1,0)
    run(game, 1, { p1: dropBomb() }); // tick 86: bomb whose blast covers (1,0)
    run(game, 14, { p1: move('down') }); // to safety at (0,2)
    const events = run(game, 45); // last tick is 145: bomb explodes
    expect(ofType(events, 'bombExploded')).toHaveLength(1);
    expect(ofType(events, 'powerupSpawned')).toHaveLength(0);
    expect(game.state.powerups).toEqual([]);
    expect(ofType(events, 'powerupCollected')).toHaveLength(0);
  });
});

describe('powerups', () => {
  function collect(type: PowerupType): { game: Game; events: GameEvent[] } {
    const game = twoPlayerGame();
    game.state.powerups.push({ col: 1, row: 0, type });
    const events = run(game, 7, { p1: move('right') });
    return { game, events };
  }

  it('ExtraBomb increments bombCount and emits powerupCollected', () => {
    const { game, events } = collect(PowerupType.ExtraBomb);
    expect(player(game, 'p1').bombCount).toBe(BASE_BOMB_COUNT + 1);
    expect(game.state.powerups).toEqual([]);
    expect(ofType(events, 'powerupCollected')).toEqual([
      expect.objectContaining({
        playerId: 'p1',
        col: 1,
        row: 0,
        powerupType: PowerupType.ExtraBomb,
      }),
    ]);
  });

  it('BiggerBlast increments blastRadius', () => {
    const { game } = collect(PowerupType.BiggerBlast);
    expect(player(game, 'p1').blastRadius).toBe(BASE_BLAST_RADIUS + 1);
  });

  it('Speed increases speed by the increment', () => {
    const { game } = collect(PowerupType.Speed);
    expect(player(game, 'p1').speed).toBe(BASE_SPEED + 0.5);
  });

  it('caps bombCount at MAX_BOMB_COUNT', () => {
    const game = twoPlayerGame();
    for (let col = 1; col <= 8; col++) {
      game.state.powerups.push({ col, row: 0, type: PowerupType.ExtraBomb });
    }
    run(game, 60, { p1: move('right') }); // walks across all 8 powerups
    expect(game.state.powerups).toEqual([]);
    expect(player(game, 'p1').bombCount).toBe(MAX_BOMB_COUNT); // 1 + 8 capped at 8
  });

  it('caps blastRadius at MAX_BLAST_RADIUS', () => {
    const game = twoPlayerGame();
    for (let col = 1; col <= 8; col++) {
      game.state.powerups.push({ col, row: 0, type: PowerupType.BiggerBlast });
    }
    run(game, 60, { p1: move('right') });
    expect(player(game, 'p1').blastRadius).toBe(MAX_BLAST_RADIUS); // 1 + 8 capped at 8
  });

  it('caps speed at MAX_SPEED', () => {
    const game = twoPlayerGame();
    for (let col = 1; col <= 7; col++) {
      game.state.powerups.push({ col, row: 0, type: PowerupType.Speed });
    }
    run(game, 80, { p1: move('right') });
    expect(game.state.powerups).toEqual([]);
    expect(player(game, 'p1').speed).toBe(MAX_SPEED); // 3 + 3.5 capped at 6
  });
});

describe('death and win', () => {
  it('kills a player standing in a blast and ends the game for the survivor', () => {
    const game = twoPlayerGame();
    run(game, 1, { p1: dropBomb() });
    const events = run(game, BOMB_FUSE_TICKS - 1); // p1 stays on the bomb
    expect(ofType(events, 'playerDied')).toEqual([
      expect.objectContaining({ playerId: 'p1', col: 0, row: 0 }),
    ]);
    expect(ofType(events, 'gameEnded')).toEqual([{ type: 'gameEnded', winnerId: 'p2' }]);
    expect(player(game, 'p1').alive).toBe(false);
    expect(game.state.status).toBe('finished');
    expect(game.state.winnerId).toBe('p2');
  });

  it('declares a draw when the last players die on the same tick', () => {
    const game = twoPlayerGame();
    run(game, 1, { p1: dropBomb(), p2: dropBomb() });
    const events = run(game, BOMB_FUSE_TICKS - 1);
    expect(ofType(events, 'playerDied')).toHaveLength(2);
    expect(ofType(events, 'gameEnded')).toEqual([{ type: 'gameEnded', winnerId: null }]);
    expect(game.state.status).toBe('finished');
    expect(game.state.winnerId).toBeNull();
  });

  it('is a no-op after the game finished', () => {
    const game = twoPlayerGame();
    run(game, 1, { p1: dropBomb() });
    run(game, BOMB_FUSE_TICKS - 1);
    expect(game.state.status).toBe('finished');
    const tickBefore = game.state.tick;
    const events = game.tick({ p2: move('right') });
    expect(events).toEqual([]);
    expect(game.state.tick).toBe(tickBefore);
    expect(player(game, 'p2').x).toBe(14);
  });

  it('keeps a dead player bomb ticking, ignores dead player input, and frees the slot', () => {
    const game = createGame({ seed: SEED_NO_DROP, playerIds: ['p1', 'p2', 'p3'], grid: openGrid() });
    // p3 walks up column 0 while p1 walks down, then p3 bombs p1's tile.
    run(game, 21, { p1: move('down'), p3: move('up') }); // p1 (0,3), p3 (0,9)
    run(game, 8, { p1: move('right'), p3: move('up') }); // p1 to (1,3)
    run(game, 22, { p3: move('up') }); // tick 51: p3 at (0,4)
    run(game, 1, { p3: dropBomb() }); // tick 52: p3 bomb at (0,4), explodes tick 111
    run(game, 14, { p3: move('down') }); // p3 retreats to (0,6)
    run(game, 1, { p1: dropBomb() }); // tick 67: p1 bomb at (1,3), explodes tick 126
    run(game, 7, { p1: move('left') }); // tick 74: p1 back on (0,3), inside p3's blast
    run(game, 36); // tick 110: nothing yet
    const deathTick = run(game, 1); // tick 111: p3's bomb kills p1
    expect(ofType(deathTick, 'playerDied')).toEqual([
      expect.objectContaining({ playerId: 'p1' }),
    ]);
    expect(game.state.status).toBe('running'); // p2 and p3 still alive
    expect(game.state.bombs).toHaveLength(1); // dead p1's bomb still ticking
    expect(player(game, 'p1').activeBombs).toBe(1);
    const posthumous = run(game, 15, { p1: { direction: 'right', placeBomb: true } }); // through tick 126
    expect(player(game, 'p1').x).toBe(0); // dead input ignored
    expect(ofType(posthumous, 'bombPlaced')).toHaveLength(0);
    const explode = ofType(posthumous, 'bombExploded'); // tick 126: p1's bomb goes off
    expect(explode).toHaveLength(1);
    expect(explode[0]).toMatchObject({ col: 1, row: 3 });
    expect(ofType(posthumous, 'playerDied')).toHaveLength(0); // corpse not re-killed
    expect(player(game, 'p1').activeBombs).toBe(0);
    expect(game.state.bombs).toEqual([]);
    expect(game.state.status).toBe('running');
  });
});

describe('determinism', () => {
  it('two games with the same seed and scripted inputs stay deep-equal over 200 ticks', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const dirs: (Direction | null)[] = ['up', 'down', 'left', 'right', null];
    const rng = createRng(42);
    const script: Record<string, PlayerInput>[] = [];
    for (let t = 0; t < 200; t++) {
      const inputs: Record<string, PlayerInput> = {};
      for (const id of ids) {
        inputs[id] = {
          direction: dirs[Math.floor(rng() * dirs.length)],
          placeBomb: rng() < 0.1,
        };
      }
      script.push(inputs);
    }
    const g1 = createGame({ seed: 12345, playerIds: ids });
    const g2 = createGame({ seed: 12345, playerIds: ids });
    const events1: GameEvent[] = [];
    const events2: GameEvent[] = [];
    for (const inputs of script) {
      events1.push(...g1.tick(inputs));
      events2.push(...g2.tick(inputs));
    }
    expect(g1.state).toEqual(g2.state);
    expect(events1).toEqual(events2);
  });
});
