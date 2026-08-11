import { describe, expect, it } from 'vitest';
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  GUN_AMMO_PER_PICKUP,
  MINE_ARM_TICKS,
  POWERUP_TYPE_COUNT,
  POWERUP_WEIGHTS,
  SHIELD_DURATION_TICKS,
  SUDDEN_DEATH_START_TICKS,
} from '../src/constants';
import { createGame } from '../src/game';
import type { Game, GameEvent } from '../src/game';
import { SHRINK_ORDER } from '../src/suddenDeath';
import { PowerupType, TileType } from '../src/types';
import type { Bomb, PlayerInput } from '../src/types';

const SEED_NO_DROP = 1; // first roll fails POWERUP_DROP_CHANCE

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

function twoPlayerGame(): Game {
  return createGame({ seed: SEED_NO_DROP, playerIds: ['p1', 'p2'], grid: openGrid() });
}

/** A due bomb parked directly in the state (fuse 1 => detonates next tick). */
function dueBomb(col: number, row: number, ownerId = 'p1'): Bomb {
  return {
    id: 99,
    col,
    row,
    ownerId,
    ownerOnTile: false,
    fuseTicks: 1,
    blastRadius: 1,
    slideDC: 0,
    slideDR: 0,
    slideCooldown: 0,
    slideInterval: 0,
  };
}

describe('shield constants', () => {
  it('shield is enum index 7 with drop weight 3', () => {
    expect(PowerupType.Shield).toBe(7);
    expect(POWERUP_TYPE_COUNT).toBe(9); // FreezeTime appended after Shield
    expect(POWERUP_WEIGHTS).toEqual([12, 12, 6, 6, 2, 2, 2, 3, 1]);
    expect(POWERUP_WEIGHTS[PowerupType.Shield]).toBe(3);
    expect(SHIELD_DURATION_TICKS).toBe(420); // 7s at 60tps
  });
});

describe('shield pickup', () => {
  it('sets shieldTicks and keeps held weapons', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.gunAmmo = GUN_AMMO_PER_PICKUP;
    game.state.powerups.push({
      col: Math.round(p1.x),
      row: Math.round(p1.y),
      type: PowerupType.Shield,
    });

    const events = run(game, 1);

    expect(ofType(events, 'powerupCollected')).toHaveLength(1);
    // Collection happens after the per-player decrement, so the first full
    // tick of immunity is counted on the next tick.
    expect(p1.shieldTicks).toBe(SHIELD_DURATION_TICKS);
    expect(p1.gunAmmo).toBe(GUN_AMMO_PER_PICKUP); // passive: weapons kept
  });

  it('re-pickup refreshes the timer to full', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.shieldTicks = 10;
    game.state.powerups.push({
      col: Math.round(p1.x),
      row: Math.round(p1.y),
      type: PowerupType.Shield,
    });

    run(game, 1);

    expect(p1.shieldTicks).toBe(SHIELD_DURATION_TICKS);
  });

  it('counts down one per tick and expires', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.shieldTicks = 5;

    run(game, 5);
    expect(p1.shieldTicks).toBe(0);
    run(game, 1);
    expect(p1.shieldTicks).toBe(0); // never negative
  });
});

describe('shield vs attacks', () => {
  it('survives a bomb blast; the same blast without shield kills', () => {
    for (const shielded of [true, false]) {
      const game = twoPlayerGame();
      const p2 = player(game, 'p2');
      p2.x = 5;
      p2.y = 5;
      if (shielded) p2.shieldTicks = SHIELD_DURATION_TICKS;
      game.state.bombs.push(dueBomb(5, 5));

      const events = run(game, 1);

      expect(ofType(events, 'bombExploded')).toHaveLength(1);
      expect(p2.alive).toBe(shielded);
    }
  });

  it('survives standing in a lingering explosion for the whole shield', () => {
    const game = twoPlayerGame();
    const p2 = player(game, 'p2');
    p2.x = 5;
    p2.y = 5;
    p2.shieldTicks = SHIELD_DURATION_TICKS;
    game.state.bombs.push(dueBomb(5, 5));

    run(game, 3); // explosion cells persist EXPLOSION_DURATION_TICKS

    expect(p2.alive).toBe(true);
  });

  it('triggers an armed mine but survives its blast', () => {
    const game = twoPlayerGame();
    const p2 = player(game, 'p2');
    p2.x = 5;
    p2.y = 5;
    p2.shieldTicks = SHIELD_DURATION_TICKS;
    game.state.mines.push({ id: 99, col: 5, row: 5, ownerId: 'p1', ticks: MINE_ARM_TICKS });

    const events = run(game, 1);

    expect(ofType(events, 'mineExploded')).toHaveLength(1); // mine is spent
    expect(p2.alive).toBe(true);
  });

  it('absorbs a gun shot: ray stops on the shielded player, no kill', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    const p2 = player(game, 'p2');
    p1.x = 1;
    p1.y = 1;
    p1.facing = 'right';
    p1.gunAmmo = 1;
    p2.x = 4;
    p2.y = 1;
    p2.shieldTicks = SHIELD_DURATION_TICKS;

    const events = run(game, 1, { p1: act({ fireGun: true }) });

    const [shot] = ofType(events, 'gunFired');
    expect([shot.hitCol, shot.hitRow]).toEqual([4, 1]); // absorbed, not passed through
    expect(p2.alive).toBe(true);
    expect(ofType(events, 'playerDied')).toHaveLength(0);
  });

  it('shrugs off a hammer strike', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    const p2 = player(game, 'p2');
    p1.x = 1;
    p1.y = 1;
    p1.facing = 'right';
    p1.hammerUses = 1;
    p2.x = 2;
    p2.y = 1;
    p2.shieldTicks = SHIELD_DURATION_TICKS;

    const events = run(game, 1, { p1: act({ swingHammer: true }) });

    expect(ofType(events, 'hammerSwung')).toHaveLength(1); // swing is spent
    expect(p2.alive).toBe(true);
  });

  it('sudden death kills through the shield', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    const p2 = player(game, 'p2');
    // park p1 safely in the center, p2 on the first shrink tile
    p1.x = 7;
    p1.y = 6;
    p2.x = SHRINK_ORDER[0].col;
    p2.y = SHRINK_ORDER[0].row;
    p2.shieldTicks = SHIELD_DURATION_TICKS;
    game.state.tick = SUDDEN_DEATH_START_TICKS - 1; // next tick is the first shrink

    const events = run(game, 1);

    expect(ofType(events, 'arenaShrink')).toHaveLength(1);
    expect(p2.alive).toBe(false);
  });
});
