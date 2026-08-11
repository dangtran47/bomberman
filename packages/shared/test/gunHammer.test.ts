import { describe, expect, it } from 'vitest';
import {
  BASE_BOMB_COUNT,
  BASE_SPEED,
  BOMB_FUSE_TICKS,
  GRID_HEIGHT,
  GRID_WIDTH,
  GUN_AMMO_PER_PICKUP,
  HAMMER_USES_PER_PICKUP,
  KICK_DURATION_TICKS,
  SKILL_ACTION_COOLDOWN_TICKS,
  TICK_RATE,
} from '../src/constants';
import { createGame } from '../src/game';
import type { Game, GameEvent } from '../src/game';
import { PowerupType, TileType } from '../src/types';
import type { Direction, PlayerInput } from '../src/types';

// Same mined seeds as game.test.ts: the FIRST powerup roll of the run is known.
const SEED_EXTRA_BOMB = 7; // drops ExtraBomb
const SEED_NO_DROP = 1; // first roll fails POWERUP_DROP_CHANCE

/** Ticks to walk one tile at base speed (with one spare tick of margin where used). */
const WALK_TICKS = TICK_RATE / BASE_SPEED;

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

/** p1 aiming right from (0,0) with p2 parked out of the firing line. */
function shooterGame(grid: TileType[][] = openGrid(), seed = SEED_NO_DROP): Game {
  const game = twoPlayerGame(grid, seed);
  player(game, 'p1').facing = 'right';
  player(game, 'p2').y = 6;
  return game;
}

describe('pickups', () => {
  it('Gun grants a full magazine and re-pickup refills it', () => {
    const game = twoPlayerGame();
    game.state.powerups.push({ col: 1, row: 0, type: PowerupType.Gun });
    const events = run(game, WALK_TICKS + 1, { p1: move('right') });
    expect(player(game, 'p1').gunAmmo).toBe(GUN_AMMO_PER_PICKUP);
    expect(ofType(events, 'powerupCollected')).toEqual([
      expect.objectContaining({ playerId: 'p1', powerupType: PowerupType.Gun }),
    ]);

    player(game, 'p1').gunAmmo = 1;
    const col = Math.round(player(game, 'p1').x);
    game.state.powerups.push({ col, row: 0, type: PowerupType.Gun });
    run(game, 1);
    expect(player(game, 'p1').gunAmmo).toBe(GUN_AMMO_PER_PICKUP);
  });

  it('Hammer grants a full set of swings', () => {
    const game = twoPlayerGame();
    game.state.powerups.push({ col: 1, row: 0, type: PowerupType.Hammer });
    run(game, WALK_TICKS + 1, { p1: move('right') });
    expect(player(game, 'p1').hammerUses).toBe(HAMMER_USES_PER_PICKUP);
  });
});

describe('gun firing', () => {
  it('consumes one shot, arms the cooldown, and refuses to fire until it expires', () => {
    const game = shooterGame();
    const p1 = player(game, 'p1');
    p1.gunAmmo = GUN_AMMO_PER_PICKUP;

    const fired = run(game, 1, { p1: act({ fireGun: true }) });
    expect(p1.gunAmmo).toBe(1);
    expect(p1.actionCooldown).toBe(SKILL_ACTION_COOLDOWN_TICKS);
    expect(ofType(fired, 'gunFired')).toEqual([
      expect.objectContaining({ playerId: 'p1', col: 0, row: 0, dir: 'right' }),
    ]);

    // Held trigger during the cooldown does nothing at all.
    const blocked = run(game, SKILL_ACTION_COOLDOWN_TICKS - 1, { p1: act({ fireGun: true }) });
    expect(ofType(blocked, 'gunFired')).toHaveLength(0);
    expect(p1.gunAmmo).toBe(1);

    const second = run(game, 1, { p1: act({ fireGun: true }) });
    expect(ofType(second, 'gunFired')).toHaveLength(1);
    expect(p1.gunAmmo).toBe(0);

    // Empty: no event, no cooldown re-arm.
    run(game, SKILL_ACTION_COOLDOWN_TICKS);
    const empty = run(game, 1, { p1: act({ fireGun: true }) });
    expect(ofType(empty, 'gunFired')).toHaveLength(0);
    expect(p1.actionCooldown).toBe(0);
  });

  it('stops at a hard block without destroying anything behind it', () => {
    const grid = openGrid();
    grid[0][3] = TileType.HardBlock;
    grid[0][5] = TileType.SoftBlock;
    const game = shooterGame(grid, SEED_EXTRA_BOMB);
    player(game, 'p1').gunAmmo = 1;

    const events = run(game, 1, { p1: act({ fireGun: true }) });
    expect(ofType(events, 'gunFired')).toEqual([
      expect.objectContaining({ hitCol: 3, hitRow: 0 }),
    ]);
    expect(ofType(events, 'blockDestroyed')).toHaveLength(0);
    expect(game.state.grid[0][3]).toBe(TileType.HardBlock);
    expect(game.state.grid[0][5]).toBe(TileType.SoftBlock);
  });

  it('destroys the first soft block and can drop a powerup on it', () => {
    const grid = openGrid();
    grid[0][2] = TileType.SoftBlock;
    grid[0][4] = TileType.SoftBlock;
    const game = shooterGame(grid, SEED_EXTRA_BOMB);
    player(game, 'p1').gunAmmo = 1;

    const events = run(game, 1, { p1: act({ fireGun: true }) });
    expect(ofType(events, 'gunFired')).toEqual([
      expect.objectContaining({ hitCol: 2, hitRow: 0 }),
    ]);
    expect(ofType(events, 'blockDestroyed')).toEqual([
      expect.objectContaining({ col: 2, row: 0 }),
    ]);
    expect(game.state.grid[0][2]).toBe(TileType.Floor);
    expect(game.state.grid[0][4]).toBe(TileType.SoftBlock); // ray stopped
    expect(ofType(events, 'powerupSpawned')).toEqual([
      expect.objectContaining({ col: 2, row: 0, powerupType: PowerupType.ExtraBomb }),
    ]);
    expect(game.state.powerups).toEqual([{ col: 2, row: 0, type: PowerupType.ExtraBomb }]);
  });

  it('destroys a soft block without a drop when the roll fails', () => {
    const grid = openGrid();
    grid[0][2] = TileType.SoftBlock;
    const game = shooterGame(grid, SEED_NO_DROP);
    player(game, 'p1').gunAmmo = 1;

    const events = run(game, 1, { p1: act({ fireGun: true }) });
    expect(ofType(events, 'blockDestroyed')).toHaveLength(1);
    expect(ofType(events, 'powerupSpawned')).toHaveLength(0);
    expect(game.state.powerups).toEqual([]);
  });

  it('ignores the bomb under the shooter and passes over powerups', () => {
    const grid = openGrid();
    grid[0][5] = TileType.SoftBlock;
    const game = shooterGame(grid, SEED_NO_DROP);
    game.state.powerups.push({ col: 3, row: 0, type: PowerupType.Speed });
    run(game, 1, { p1: act({ placeBomb: true }) }); // bomb at (0,0), full fuse
    player(game, 'p1').gunAmmo = 1; // armed only after bombing: space is the skill trigger

    const events = run(game, 1, { p1: act({ fireGun: true }) });
    expect(ofType(events, 'gunFired')).toEqual([
      expect.objectContaining({ hitCol: 5, hitRow: 0 }),
    ]);
    expect(game.state.grid[0][5]).toBe(TileType.Floor);
    expect(game.state.bombs).toHaveLength(1);
    expect(game.state.powerups).toContainEqual({ col: 3, row: 0, type: PowerupType.Speed });
  });

  it('reports a null hit when the ray leaves the grid', () => {
    const game = shooterGame();
    player(game, 'p1').gunAmmo = 1;
    const events = run(game, 1, { p1: act({ fireGun: true }) });
    expect(ofType(events, 'gunFired')).toEqual([
      expect.objectContaining({ hitCol: null, hitRow: null }),
    ]);
  });

  it('kills the first player in the line and ends the match', () => {
    const game = twoPlayerGame(); // p2 sits at (14, 0), straight down p1's line
    player(game, 'p1').gunAmmo = 1;
    const events = run(game, 1, { p1: act({ direction: 'right', fireGun: true }) });

    expect(ofType(events, 'gunFired')).toEqual([
      expect.objectContaining({ col: 0, row: 0, dir: 'right', hitCol: 14, hitRow: 0 }),
    ]);
    expect(ofType(events, 'playerDied')).toEqual([
      expect.objectContaining({ playerId: 'p2', col: 14, row: 0 }),
    ]);
    const p2 = player(game, 'p2');
    expect(p2.alive).toBe(false);
    expect(p2.deathTick).toBe(1);
    expect(ofType(events, 'gameEnded')).toEqual([expect.objectContaining({ winnerId: 'p1' })]);
    expect(game.state.status).toBe('finished');
  });

  it('never shoots the shooter and stops on the first victim', () => {
    const game = createGame({ seed: SEED_NO_DROP, playerIds: ['p1', 'p2', 'p3'], grid: openGrid() });
    const p1 = player(game, 'p1');
    p1.facing = 'right';
    p1.gunAmmo = 1;
    player(game, 'p2').x = 4; // (4,0), first in line
    player(game, 'p3').x = 8;
    player(game, 'p3').y = 0;

    const events = run(game, 1, { p1: act({ fireGun: true }) });
    expect(ofType(events, 'playerDied')).toEqual([
      expect.objectContaining({ playerId: 'p2', col: 4, row: 0 }),
    ]);
    expect(player(game, 'p1').alive).toBe(true);
    expect(player(game, 'p3').alive).toBe(true);
  });

  it('clears the victim skills so nothing leaks past death', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.facing = 'right';
    p1.gunAmmo = 1;
    const p2 = player(game, 'p2');
    p2.kickTicks = 100;
    p2.gunAmmo = 2;
    p2.hammerUses = 3;
    p2.actionCooldown = 4;

    run(game, 1, { p1: act({ fireGun: true }) });
    expect(p2.alive).toBe(false);
    expect([p2.kickTicks, p2.gunAmmo, p2.hammerUses, p2.actionCooldown]).toEqual([0, 0, 0, 0]);
  });
});

describe('hammer swinging', () => {
  it('destroys the adjacent soft block it faces and drops a powerup', () => {
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock;
    const game = shooterGame(grid, SEED_EXTRA_BOMB);
    const p1 = player(game, 'p1');
    p1.hammerUses = HAMMER_USES_PER_PICKUP;

    const events = run(game, 1, { p1: act({ swingHammer: true }) });
    expect(ofType(events, 'hammerSwung')).toEqual([
      expect.objectContaining({ playerId: 'p1', col: 1, row: 0 }),
    ]);
    expect(p1.hammerUses).toBe(HAMMER_USES_PER_PICKUP - 1);
    expect(p1.actionCooldown).toBe(SKILL_ACTION_COOLDOWN_TICKS);
    expect(game.state.grid[0][1]).toBe(TileType.Floor);
    expect(ofType(events, 'blockDestroyed')).toEqual([
      expect.objectContaining({ col: 1, row: 0 }),
    ]);
    expect(ofType(events, 'powerupSpawned')).toEqual([
      expect.objectContaining({ col: 1, row: 0, powerupType: PowerupType.ExtraBomb }),
    ]);
  });

  it('kills a player on the adjacent tile', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.facing = 'down';
    p1.hammerUses = 1;
    const p2 = player(game, 'p2');
    p2.x = 0;
    p2.y = 1;

    const events = run(game, 1, { p1: act({ swingHammer: true }) });
    expect(ofType(events, 'hammerSwung')).toEqual([
      expect.objectContaining({ col: 0, row: 1 }),
    ]);
    expect(ofType(events, 'playerDied')).toEqual([
      expect.objectContaining({ playerId: 'p2', col: 0, row: 1 }),
    ]);
    expect(ofType(events, 'gameEnded')).toEqual([expect.objectContaining({ winnerId: 'p1' })]);
  });

  it('reaches neither the tile beyond nor a hard block', () => {
    const grid = openGrid();
    grid[0][1] = TileType.HardBlock;
    grid[0][2] = TileType.SoftBlock;
    const game = shooterGame(grid, SEED_EXTRA_BOMB);
    const p1 = player(game, 'p1');
    p1.hammerUses = 2;

    const events = run(game, 1, { p1: act({ swingHammer: true }) });
    expect(ofType(events, 'hammerSwung')).toHaveLength(1); // the swing still happens
    expect(p1.hammerUses).toBe(1); // and still costs a use
    expect(ofType(events, 'blockDestroyed')).toHaveLength(0);
    expect(game.state.grid[0][1]).toBe(TileType.HardBlock);
    expect(game.state.grid[0][2]).toBe(TileType.SoftBlock);
  });

  it('is a free no-op when facing out of bounds', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1'); // at (0,0)
    p1.facing = 'up';
    p1.hammerUses = HAMMER_USES_PER_PICKUP;

    const events = run(game, 1, { p1: act({ swingHammer: true }) });
    expect(ofType(events, 'hammerSwung')).toHaveLength(0);
    expect(p1.hammerUses).toBe(HAMMER_USES_PER_PICKUP);
    expect(p1.actionCooldown).toBe(0);
  });

  it('shares the action cooldown with the gun', () => {
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock;
    const game = shooterGame(grid, SEED_NO_DROP);
    const p1 = player(game, 'p1');
    p1.gunAmmo = 1;
    p1.hammerUses = 1;

    const events = run(game, 1, { p1: act({ fireGun: true, swingHammer: true }) });
    expect(ofType(events, 'gunFired')).toHaveLength(1);
    expect(ofType(events, 'hammerSwung')).toHaveLength(0);
    expect(p1.hammerUses).toBe(1);
  });
});

describe('exclusive skills', () => {
  /** Walks p1 right from (0,0) onto a single powerup parked at (1,0). */
  function grab(game: Game, type: PowerupType): void {
    game.state.powerups.push({ col: 1, row: 0, type });
    run(game, WALK_TICKS + 1, { p1: move('right') });
  }

  it('a new gun pickup drops the kick and the hammer', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.kickTicks = KICK_DURATION_TICKS;
    p1.hammerUses = HAMMER_USES_PER_PICKUP;

    grab(game, PowerupType.Gun);

    expect(p1.gunAmmo).toBe(GUN_AMMO_PER_PICKUP);
    expect(p1.kickTicks).toBe(0);
    expect(p1.hammerUses).toBe(0);
  });

  it('a new hammer pickup drops the kick and the gun', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.kickTicks = KICK_DURATION_TICKS;
    p1.gunAmmo = GUN_AMMO_PER_PICKUP;

    grab(game, PowerupType.Hammer);

    expect(p1.hammerUses).toBe(HAMMER_USES_PER_PICKUP);
    expect(p1.kickTicks).toBe(0);
    expect(p1.gunAmmo).toBe(0);
  });

  it('a new kick pickup drops the gun and the hammer', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.gunAmmo = GUN_AMMO_PER_PICKUP;
    p1.hammerUses = HAMMER_USES_PER_PICKUP;

    grab(game, PowerupType.Kick);

    // Granted mid-walk, so a few ticks have already ticked off the timer.
    expect(p1.kickTicks).toBeGreaterThan(0);
    expect(p1.gunAmmo).toBe(0);
    expect(p1.hammerUses).toBe(0);
  });

  it('re-picking the same skill refills it without zeroing itself', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.gunAmmo = 1;

    grab(game, PowerupType.Gun);

    expect(p1.gunAmmo).toBe(GUN_AMMO_PER_PICKUP);
  });

  it('stat upgrades leave the held skill alone', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.gunAmmo = GUN_AMMO_PER_PICKUP;

    grab(game, PowerupType.ExtraBomb);

    expect(p1.bombCount).toBe(BASE_BOMB_COUNT + 1);
    expect(p1.gunAmmo).toBe(GUN_AMMO_PER_PICKUP);
  });
});

describe('space is the skill trigger while armed', () => {
  it('fires the gun instead of placing a bomb', () => {
    const game = shooterGame();
    const p1 = player(game, 'p1');
    p1.gunAmmo = 1;

    const events = run(game, 1, { p1: act({ placeBomb: true }) });

    expect(ofType(events, 'gunFired')).toHaveLength(1);
    expect(ofType(events, 'bombPlaced')).toHaveLength(0);
    expect(game.state.bombs).toHaveLength(0);
    expect(p1.gunAmmo).toBe(0);
  });

  it('swings the hammer instead of placing a bomb', () => {
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock;
    const game = shooterGame(grid, SEED_NO_DROP);
    const p1 = player(game, 'p1');
    p1.hammerUses = 1;

    const events = run(game, 1, { p1: act({ placeBomb: true }) });

    expect(ofType(events, 'hammerSwung')).toHaveLength(1);
    expect(ofType(events, 'bombPlaced')).toHaveLength(0);
    expect(game.state.bombs).toHaveLength(0);
  });

  it('fires once per press, not once per cooldown, while space is held', () => {
    const game = shooterGame();
    const p1 = player(game, 'p1');
    p1.gunAmmo = GUN_AMMO_PER_PICKUP;

    run(game, SKILL_ACTION_COOLDOWN_TICKS + 5, { p1: act({ placeBomb: true }) });

    expect(p1.gunAmmo).toBe(GUN_AMMO_PER_PICKUP - 1);
  });

  it('fires again after the trigger is released and pressed once more', () => {
    const game = shooterGame();
    const p1 = player(game, 'p1');
    p1.gunAmmo = GUN_AMMO_PER_PICKUP;

    run(game, 1, { p1: act({ placeBomb: true }) });
    run(game, SKILL_ACTION_COOLDOWN_TICKS, { p1: act({ placeBomb: false }) });
    run(game, 1, { p1: act({ placeBomb: true }) });

    expect(p1.gunAmmo).toBe(0);
  });

  it('goes back to placing bombs once the skill runs out and the trigger is pressed again', () => {
    const game = shooterGame();
    const p1 = player(game, 'p1');
    p1.gunAmmo = 1;

    run(game, 1, { p1: act({ placeBomb: true }) }); // last shot
    expect(p1.gunAmmo).toBe(0);

    run(game, 1, { p1: act({ placeBomb: false }) }); // release
    const events = run(game, 1, { p1: act({ placeBomb: true }) }); // fresh press
    expect(ofType(events, 'bombPlaced')).toHaveLength(1);
  });

  it('does not drop a bomb when the trigger stays held past the last shot', () => {
    const game = shooterGame();
    const p1 = player(game, 'p1');
    p1.gunAmmo = 1;

    // One long hold: the shot empties the gun, the key never comes back up.
    const events = run(game, SKILL_ACTION_COOLDOWN_TICKS + 4, { p1: act({ placeBomb: true }) });

    expect(ofType(events, 'gunFired')).toHaveLength(1);
    expect(ofType(events, 'bombPlaced')).toHaveLength(0);
    expect(game.state.bombs).toHaveLength(0);
  });

  it('does not drop a bomb when the trigger stays held past the last swing', () => {
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock;
    const game = shooterGame(grid, SEED_NO_DROP);
    const p1 = player(game, 'p1');
    p1.hammerUses = 1;

    const events = run(game, SKILL_ACTION_COOLDOWN_TICKS + 4, { p1: act({ placeBomb: true }) });

    expect(ofType(events, 'hammerSwung')).toHaveLength(1);
    expect(ofType(events, 'bombPlaced')).toHaveLength(0);
    expect(game.state.bombs).toHaveLength(0);
  });

  it('places bombs normally with no skill held', () => {
    const game = shooterGame();
    const events = run(game, 1, { p1: act({ placeBomb: true }) });
    expect(ofType(events, 'bombPlaced')).toHaveLength(1);
  });
});

describe('hammering a bomb', () => {
  it('detonates it on the spot', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');

    run(game, 1, { p1: act({ placeBomb: true }) }); // bomb at (0,0)
    run(game, WALK_TICKS + 1, { p1: move('right') }); // step off it, onto (1,0)
    expect(Math.round(p1.x)).toBe(1);
    expect(game.state.bombs).toHaveLength(1);

    p1.facing = 'left';
    p1.hammerUses = 1;
    const events = run(game, 1, { p1: act({ swingHammer: true }) });

    expect(ofType(events, 'hammerSwung')).toHaveLength(1);
    expect(ofType(events, 'bombExploded')).toHaveLength(1);
    expect(game.state.bombs).toHaveLength(0);
    expect(p1.hammerUses).toBe(0);
  });
});

describe('shooting a bomb', () => {
  it('stops the ray on it and sets it off', () => {
    const grid = openGrid();
    grid[0][5] = TileType.SoftBlock;
    const game = shooterGame(grid, SEED_NO_DROP);
    run(game, 1, { p1: act({ placeBomb: true }) }); // bomb at (0,0)
    run(game, 2 * WALK_TICKS + 1, { p1: move('right') }); // walk to (2,0), leaving it behind
    const p1 = player(game, 'p1');
    expect(Math.round(p1.x)).toBe(2);
    p1.facing = 'left';
    p1.gunAmmo = 1;

    const events = run(game, 1, { p1: act({ fireGun: true }) });

    expect(ofType(events, 'gunFired')).toEqual([
      expect.objectContaining({ hitCol: 0, hitRow: 0 }),
    ]);
    expect(ofType(events, 'bombExploded')).toHaveLength(1);
    expect(game.state.bombs).toHaveLength(0);
  });

  it('stops at the near bomb without reaching a block behind it', () => {
    const grid = openGrid();
    grid[0][5] = TileType.SoftBlock;
    const game = shooterGame(grid, SEED_NO_DROP);
    const p1 = player(game, 'p1');
    p1.y = 6; // out of the blast so the match does not end mid-test
    player(game, 'p2').y = 10;
    game.state.bombs.push({
      id: 999,
      col: 3,
      row: 6,
      ownerId: 'p2',
      ownerOnTile: false,
      fuseTicks: BOMB_FUSE_TICKS,
      blastRadius: 1,
      slideDC: 0,
      slideDR: 0,
      slideCooldown: 0,
      slideInterval: 0,
    });
    game.state.grid[6][5] = TileType.SoftBlock; // the sim copies the grid it is given
    p1.gunAmmo = 1;

    const events = run(game, 1, { p1: act({ fireGun: true }) });

    expect(ofType(events, 'gunFired')).toEqual([
      expect.objectContaining({ hitCol: 3, hitRow: 6 }),
    ]);
    expect(ofType(events, 'bombExploded')).toHaveLength(1);
    expect(game.state.grid[6][5]).toBe(TileType.SoftBlock); // ray never got there
  });

  it('still passes over powerups', () => {
    const grid = openGrid();
    grid[0][5] = TileType.SoftBlock;
    const game = shooterGame(grid, SEED_NO_DROP);
    game.state.powerups.push({ col: 3, row: 0, type: PowerupType.Speed });
    player(game, 'p1').gunAmmo = 1;

    const events = run(game, 1, { p1: act({ fireGun: true }) });

    expect(ofType(events, 'gunFired')).toEqual([
      expect.objectContaining({ hitCol: 5, hitRow: 0 }),
    ]);
    expect(game.state.powerups).toContainEqual({ col: 3, row: 0, type: PowerupType.Speed });
  });
});
