import { describe, expect, it } from 'vitest';
import {
  FREEZE_DURATION_TICKS,
  GRID_HEIGHT,
  GRID_WIDTH,
  GUN_AMMO_PER_PICKUP,
  MINE_AMMO_PER_PICKUP,
  POWERUP_TYPE_COUNT,
  POWERUP_WEIGHTS,
} from '../src/constants';
import { createGame } from '../src/game';
import type { Game, GameEvent } from '../src/game';
import { PowerupType, TileType } from '../src/types';
import type { Direction, PlayerInput } from '../src/types';

const SEED_NO_DROP = 1;

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

function twoPlayerGame(): Game {
  return createGame({ seed: SEED_NO_DROP, playerIds: ['p1', 'p2'], grid: openGrid() });
}

/** p1 stands on a FreezeTime powerup so the next tick collects it. */
function gameWithPickup(): Game {
  const game = twoPlayerGame();
  const p1 = player(game, 'p1');
  game.state.powerups.push({
    col: Math.round(p1.x),
    row: Math.round(p1.y),
    type: PowerupType.FreezeTime,
  });
  return game;
}

describe('freeze-time constants', () => {
  // PowerupType is an append-only wire protocol: Shield shipped at 7 first, so
  // FreezeTime is pinned at 8. Never reorder.
  it('freeze-time is enum index 8 with drop weight 1', () => {
    expect(PowerupType.FreezeTime).toBe(8);
    expect(POWERUP_TYPE_COUNT).toBe(9);
    expect(POWERUP_WEIGHTS).toEqual([6, 6, 3, 3, 1, 1, 1, 1, 1]);
    expect(POWERUP_WEIGHTS[PowerupType.FreezeTime]).toBe(1);
    expect(FREEZE_DURATION_TICKS).toBe(100);
  });
});

describe('freeze-time pickup', () => {
  it('freezes every other alive player, not the picker', () => {
    const game = gameWithPickup();
    run(game, 1);
    expect(player(game, 'p1').frozenTicks).toBe(0);
    expect(player(game, 'p2').frozenTicks).toBe(FREEZE_DURATION_TICKS);
  });

  it('skips dead players', () => {
    const game = gameWithPickup();
    const p2 = player(game, 'p2');
    p2.alive = false;
    run(game, 1);
    expect(p2.frozenTicks).toBe(0);
  });

  it('second pickup refreshes the timer to full', () => {
    const game = gameWithPickup();
    run(game, 1);
    run(game, 30); // burn some of the freeze
    const p1 = player(game, 'p1');
    game.state.powerups.push({
      col: Math.round(p1.x),
      row: Math.round(p1.y),
      type: PowerupType.FreezeTime,
    });
    run(game, 1);
    expect(player(game, 'p2').frozenTicks).toBe(FREEZE_DURATION_TICKS);
  });
});

describe('frozen player restrictions', () => {
  it('cannot move while frozen, moves again after exactly FREEZE_DURATION_TICKS', () => {
    const game = twoPlayerGame();
    const p2 = player(game, 'p2');
    p2.frozenTicks = FREEZE_DURATION_TICKS;
    const startX = p2.x;

    run(game, FREEZE_DURATION_TICKS, { p2: move('left') });
    expect(p2.x).toBe(startX); // all 100 ticks blocked

    run(game, 1, { p2: move('left') });
    expect(p2.x).toBeLessThan(startX); // first tick after freeze moves
  });

  it('cannot place a bomb while frozen', () => {
    const game = twoPlayerGame();
    player(game, 'p2').frozenTicks = 10;
    run(game, 1, { p2: act({ placeBomb: true }) });
    expect(game.state.bombs).toEqual([]);
  });

  it('cannot place a mine while frozen', () => {
    const game = twoPlayerGame();
    const p2 = player(game, 'p2');
    p2.frozenTicks = 10;
    p2.mineAmmo = MINE_AMMO_PER_PICKUP;
    run(game, 1, { p2: act({ placeMine: true }) });
    expect(game.state.mines).toEqual([]);
    expect(p2.mineAmmo).toBe(MINE_AMMO_PER_PICKUP);
  });

  it('cannot fire the gun while frozen', () => {
    const game = twoPlayerGame();
    const p2 = player(game, 'p2');
    p2.frozenTicks = 10;
    p2.gunAmmo = GUN_AMMO_PER_PICKUP;
    run(game, 1, { p2: act({ fireGun: true }) });
    expect(p2.gunAmmo).toBe(GUN_AMMO_PER_PICKUP);
  });

  it('still dies to a blast while frozen', () => {
    const game = twoPlayerGame();
    const p2 = player(game, 'p2');
    p2.frozenTicks = FREEZE_DURATION_TICKS;
    game.state.explosions.push({
      col: Math.round(p2.x),
      row: Math.round(p2.y),
      ticksLeft: 3,
    });
    run(game, 1);
    expect(p2.alive).toBe(false);
  });
});
