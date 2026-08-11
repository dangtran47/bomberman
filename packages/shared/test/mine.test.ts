import { describe, expect, it } from 'vitest';
import {
  BASE_SPEED,
  EXPLOSION_DURATION_TICKS,
  GRID_HEIGHT,
  GRID_WIDTH,
  GUN_AMMO_PER_PICKUP,
  HAMMER_USES_PER_PICKUP,
  KICK_DURATION_TICKS,
  MINE_AMMO_PER_PICKUP,
  MINE_ARM_TICKS,
  MINE_BURY_TICKS,
  minePhase,
  TICK_RATE,
} from '../src/constants';
import { createGame } from '../src/game';
import type { Game, GameEvent } from '../src/game';
import { PowerupType, TileType } from '../src/types';
import type { Direction, Mine, PlayerInput } from '../src/types';

const SEED_NO_DROP = 1; // first roll fails POWERUP_DROP_CHANCE

// Walking one tile takes TICK_RATE / BASE_SPEED ticks (20 at 60Hz).
const TICKS_PER_TILE = TICK_RATE / BASE_SPEED;

const move = (direction: Direction): PlayerInput => ({ direction, placeBomb: false });
const act = (extra: Partial<PlayerInput>): PlayerInput => ({
  direction: null,
  placeBomb: false,
  ...extra,
});

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

function ofType<T extends GameEvent['type']>(
  events: GameEvent[],
  type: T,
): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

function twoPlayerGame(grid: TileType[][] = openGrid(), seed = SEED_NO_DROP): Game {
  return createGame({ seed, playerIds: ['p1', 'p2'], grid });
}

/** A mine parked directly in the state, owned by p2 and aged into the wanted phase. */
function mine(col: number, row: number, ticks: number, ownerId = 'p2'): Mine {
  return { id: 99, col, row, ownerId, ticks };
}

describe('minePhase', () => {
  it('switches phase exactly on the arm and bury boundaries', () => {
    expect([MINE_ARM_TICKS, MINE_BURY_TICKS]).toEqual([120, 300]);
    expect(minePhase(0)).toBe(0);
    expect(minePhase(MINE_ARM_TICKS - 1)).toBe(0);
    expect(minePhase(MINE_ARM_TICKS)).toBe(1);
    expect(minePhase(MINE_BURY_TICKS - 1)).toBe(1);
    expect(minePhase(MINE_BURY_TICKS)).toBe(2);
    expect(minePhase(MINE_BURY_TICKS + 1000)).toBe(2); // mines never expire
  });
});

describe('mine placement', () => {
  it('drops a mine on the player tile and spends one charge', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.mineAmmo = MINE_AMMO_PER_PICKUP;

    const events = run(game, 1, { p1: act({ placeMine: true }) });

    expect(game.state.mines).toHaveLength(1);
    expect(game.state.mines[0]).toMatchObject({ col: 0, row: 0, ownerId: 'p1' });
    expect(p1.mineAmmo).toBe(MINE_AMMO_PER_PICKUP - 1);
    expect(ofType(events, 'minePlaced')).toEqual([
      expect.objectContaining({ ownerId: 'p1', col: 0, row: 0 }),
    ]);
  });

  it('places nothing without ammo', () => {
    const game = twoPlayerGame();
    const events = run(game, 1, { p1: act({ placeMine: true }) });
    expect(game.state.mines).toEqual([]);
    expect(ofType(events, 'minePlaced')).toHaveLength(0);
  });

  it('refuses a second mine on the same tile without spending a charge', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.mineAmmo = MINE_AMMO_PER_PICKUP;

    const events = run(game, 2, { p1: act({ placeMine: true }) });

    expect(game.state.mines).toHaveLength(1);
    expect(p1.mineAmmo).toBe(MINE_AMMO_PER_PICKUP - 1);
    expect(ofType(events, 'minePlaced')).toHaveLength(1);
  });

  it('refuses a mine on a tile that already holds a bomb', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    run(game, 1, { p1: act({ placeBomb: true }) }); // bomb at (0,0)
    p1.mineAmmo = 1;

    const events = run(game, 1, { p1: act({ placeMine: true }) });

    expect(game.state.mines).toEqual([]);
    expect(p1.mineAmmo).toBe(1);
    expect(ofType(events, 'minePlaced')).toHaveLength(0);
  });

  it('takes over the trigger like the other skills instead of placing a bomb', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.mineAmmo = MINE_AMMO_PER_PICKUP;

    const events = run(game, 1, { p1: act({ placeBomb: true }) });

    expect(ofType(events, 'minePlaced')).toHaveLength(1);
    expect(ofType(events, 'bombPlaced')).toHaveLength(0);
    expect(game.state.bombs).toEqual([]);
  });

  it('never blocks movement', () => {
    const game = twoPlayerGame();
    game.state.mines.push(mine(2, 0, 0));

    run(game, 3 * TICKS_PER_TILE + 1, { p1: move('right') });

    expect(Math.round(player(game, 'p1').x)).toBe(3); // walked straight over it
    expect(game.state.mines).toHaveLength(1);
  });
});

describe('mine detonation', () => {
  it('ignores the owner standing on it while inert, then kills them as it arms', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.mineAmmo = 1;
    run(game, 1, { p1: act({ placeMine: true }) });
    const placed = game.state.mines[0];

    while (minePhase(placed.ticks) === 0) {
      expect(p1.alive).toBe(true);
      run(game, 1);
    }

    expect(placed.ticks).toBe(MINE_ARM_TICKS);
    expect(p1.alive).toBe(false);
    expect(game.state.mines).toEqual([]);
  });

  it('kills a player who steps onto an armed mine', () => {
    const game = twoPlayerGame();
    game.state.mines.push(mine(2, 0, MINE_ARM_TICKS));

    const events = run(game, 2 * TICKS_PER_TILE, { p1: move('right') });

    expect(ofType(events, 'mineExploded')).toEqual([
      expect.objectContaining({ ownerId: 'p2', col: 2, row: 0 }),
    ]);
    expect(ofType(events, 'playerDied')).toEqual([
      expect.objectContaining({ playerId: 'p1', col: 2, row: 0 }),
    ]);
    expect(game.state.mines).toEqual([]);
  });

  it('kills a player who steps onto a buried mine', () => {
    const game = twoPlayerGame();
    game.state.mines.push(mine(2, 0, MINE_BURY_TICKS));

    const events = run(game, 2 * TICKS_PER_TILE, { p1: move('right') });

    expect(ofType(events, 'mineExploded')).toHaveLength(1);
    expect(player(game, 'p1').alive).toBe(false);
  });

  it('burns its own tile only', () => {
    const grid = openGrid();
    grid[0][3] = TileType.SoftBlock; // right of the mine tile
    const game = createGame({ seed: SEED_NO_DROP, playerIds: ['p1', 'p2', 'p3'], grid });
    const p2 = player(game, 'p2');
    p2.x = 2;
    p2.y = 1; // directly below the mine tile
    const p3 = player(game, 'p3');
    p3.x = 6;
    p3.y = 6;
    game.state.mines.push(mine(2, 0, MINE_ARM_TICKS, 'p3'));

    // Stops on the detonation tick so the explosion cell is still fresh.
    for (let i = 0; i < 2 * TICKS_PER_TILE && game.state.mines.length > 0; i++)
      run(game, 1, { p1: move('right') });

    expect(player(game, 'p1').alive).toBe(false);
    expect(p2.alive).toBe(true);
    expect(game.state.grid[0][3]).toBe(TileType.SoftBlock);
    expect(game.state.explosions).toEqual([
      { col: 2, row: 0, ticksLeft: EXPLOSION_DURATION_TICKS },
    ]);
  });

  it('goes off when a bomb blast covers its tile, whatever its phase', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.y = 6;
    player(game, 'p2').y = 10;
    game.state.mines.push(mine(2, 0, 0)); // still inert
    game.state.bombs.push({
      id: 999,
      col: 0,
      row: 0,
      ownerId: 'p2',
      ownerOnTile: false,
      fuseTicks: 1,
      blastRadius: 2,
      slideDC: 0,
      slideDR: 0,
      slideCooldown: 0,
      slideInterval: 0,
    });

    const events = run(game, 1);

    expect(ofType(events, 'bombExploded')).toHaveLength(1);
    expect(ofType(events, 'mineExploded')).toEqual([
      expect.objectContaining({ col: 2, row: 0 }),
    ]);
    expect(game.state.mines).toEqual([]);
  });
});

describe('mine pickups', () => {
  /** Walks p1 right from (0,0) onto a single powerup parked at (1,0). */
  function grab(game: Game, type: PowerupType): void {
    game.state.powerups.push({ col: 1, row: 0, type });
    run(game, TICKS_PER_TILE, { p1: move('right') });
  }

  it('grants a full set of mines and re-pickup refills it', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');

    grab(game, PowerupType.Mine);
    expect(p1.mineAmmo).toBe(MINE_AMMO_PER_PICKUP);

    p1.mineAmmo = 1;
    game.state.powerups.push({ col: Math.round(p1.x), row: 0, type: PowerupType.Mine });
    run(game, 1);
    expect(p1.mineAmmo).toBe(MINE_AMMO_PER_PICKUP);
  });

  it('a new mine pickup drops the kick, the gun and the hammer', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.kickTicks = KICK_DURATION_TICKS;
    p1.gunAmmo = GUN_AMMO_PER_PICKUP;
    p1.hammerUses = HAMMER_USES_PER_PICKUP;

    grab(game, PowerupType.Mine);

    expect(p1.mineAmmo).toBe(MINE_AMMO_PER_PICKUP);
    expect([p1.kickTicks, p1.gunAmmo, p1.hammerUses]).toEqual([0, 0, 0]);
  });

  it('a new gun, hammer or kick pickup drops the mines', () => {
    for (const type of [PowerupType.Gun, PowerupType.Hammer, PowerupType.Kick]) {
      const game = twoPlayerGame();
      const p1 = player(game, 'p1');
      p1.mineAmmo = MINE_AMMO_PER_PICKUP;

      grab(game, type);

      expect(p1.mineAmmo).toBe(0);
    }
  });

  it('death clears the mine charges', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.facing = 'right';
    p1.gunAmmo = 1;
    const p2 = player(game, 'p2');
    p2.mineAmmo = MINE_AMMO_PER_PICKUP;

    run(game, 1, { p1: act({ fireGun: true }) });

    expect(p2.alive).toBe(false);
    expect(p2.mineAmmo).toBe(0);
  });
});
