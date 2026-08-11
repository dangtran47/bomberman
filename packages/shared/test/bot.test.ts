import { describe, expect, it } from 'vitest';
import { createBot } from '../src/bot';
import type { Bot } from '../src/bot';
import {
  BOMB_FUSE_TICKS,
  GRID_HEIGHT,
  GRID_WIDTH,
  GUN_AMMO_PER_PICKUP,
  HAMMER_USES_PER_PICKUP,
  MINE_ARM_TICKS,
} from '../src/constants';
import { createGame } from '../src/game';
import type { Game, GameEvent } from '../src/game';
import { createRng } from '../src/rng';
import { PowerupType, TileType } from '../src/types';
import type { PlayerInput } from '../src/types';

function openGrid(): TileType[][] {
  return Array.from({ length: GRID_HEIGHT }, () =>
    Array<TileType>(GRID_WIDTH).fill(TileType.Floor),
  );
}

function ofType<T extends GameEvent['type']>(
  events: GameEvent[],
  type: T,
): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

function player(game: Game, id: string) {
  const found = game.state.players.find((p) => p.id === id);
  if (!found) throw new Error(`no player ${id}`);
  return found;
}

/** Advances the game with bot-supplied inputs (missing players idle); stops early once finished. */
function runBots(game: Game, bots: Record<string, Bot>, ticks: number): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks && game.state.status === 'running'; i++) {
    const inputs: Record<string, PlayerInput> = {};
    for (const [id, bot] of Object.entries(bots)) inputs[id] = bot.computeInput(game.state);
    events.push(...game.tick(inputs));
  }
  return events;
}

describe('createBot', () => {
  it('moves off the blast line of a ticking bomb and survives the explosion', () => {
    const game = createGame({ seed: 1, playerIds: ['bot', 'p2'], grid: openGrid() });
    // Enemy bomb whose radius-2 cross covers the bot spawn at (0,0).
    game.state.bombs.push({
      id: 99,
      col: 0,
      row: 1,
      ownerId: 'p2',
      ownerOnTile: false,
      fuseTicks: BOMB_FUSE_TICKS,
      blastRadius: 2,
      slideDC: 0,
      slideDR: 0,
      slideCooldown: 0,
      slideInterval: 0,
    });
    player(game, 'p2').activeBombs = 1;
    const bot = createBot('bot', createRng(7));
    const blastTiles = new Set(['0,0', '0,1', '0,2', '0,3', '1,1', '2,1']);

    const early = runBots(game, { bot }, 30);
    expect(ofType(early, 'bombExploded')).toHaveLength(0);
    const me = player(game, 'bot');
    expect(blastTiles.has(`${Math.round(me.x)},${Math.round(me.y)}`)).toBe(false);

    const later = runBots(game, { bot }, BOMB_FUSE_TICKS);
    expect(ofType(later, 'bombExploded')).toHaveLength(1);
    expect(me.alive).toBe(true);
  });

  it('does not place a bomb when boxed in with no escape route', () => {
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock; // (1,0)
    grid[1][0] = TileType.SoftBlock; // (0,1) -> bot at (0,0) is boxed in next to soft blocks
    const game = createGame({ seed: 1, playerIds: ['bot', 'p2'], grid });
    const bot = createBot('bot', createRng(2));
    const events: GameEvent[] = [];
    for (let i = 0; i < 120; i++) {
      const input = bot.computeInput(game.state);
      expect(input).toEqual({ direction: null, placeBomb: false });
      events.push(...game.tick({ bot: input }));
    }
    expect(ofType(events, 'bombPlaced')).toHaveLength(0);
    expect(player(game, 'bot').alive).toBe(true);
  });

  it('destroys at least one soft block over time and stays alive', () => {
    const grid = openGrid();
    grid[0][2] = TileType.SoftBlock; // (2,0)
    grid[2][0] = TileType.SoftBlock; // (0,2)
    const game = createGame({ seed: 1, playerIds: ['bot', 'p2'], grid });
    const bot = createBot('bot', createRng(4));
    const events = runBots(game, { bot }, 600);
    expect(ofType(events, 'blockDestroyed').length).toBeGreaterThanOrEqual(1);
    expect(player(game, 'bot').alive).toBe(true);
  });

  it('walks to and collects a powerup 3 tiles away', () => {
    const game = createGame({ seed: 1, playerIds: ['bot', 'p2'], grid: openGrid() });
    game.state.powerups.push({ col: 3, row: 0, type: PowerupType.ExtraBomb });
    const bot = createBot('bot', createRng(6));
    const events = runBots(game, { bot }, 60);
    expect(ofType(events, 'powerupCollected')).toEqual([
      expect.objectContaining({ playerId: 'bot', col: 3, row: 0 }),
    ]);
    expect(player(game, 'bot').bombCount).toBe(2);
  });

  it('swings a held hammer to break a nearby soft block instead of freezing', () => {
    const grid = openGrid();
    grid[0][2] = TileType.SoftBlock; // (2,0)
    const game = createGame({ seed: 1, playerIds: ['bot', 'p2'], grid });
    player(game, 'bot').hammerUses = HAMMER_USES_PER_PICKUP;
    const bot = createBot('bot', createRng(4));

    const events = runBots(game, { bot }, 120);
    expect(ofType(events, 'hammerSwung').length).toBeGreaterThanOrEqual(1);
    expect(ofType(events, 'blockDestroyed')).toEqual([
      expect.objectContaining({ col: 2, row: 0 }),
    ]);
    expect(ofType(events, 'bombPlaced')).toHaveLength(0); // armed: space never drops bombs
    expect(player(game, 'bot').alive).toBe(true);
  });

  it('does not stall holding the trigger when a soft block is already adjacent', () => {
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock; // (1,0) right next to the bot spawn
    const game = createGame({ seed: 1, playerIds: ['bot', 'p2'], grid });
    player(game, 'bot').hammerUses = HAMMER_USES_PER_PICKUP;
    const bot = createBot('bot', createRng(3));

    const events = runBots(game, { bot }, 120);
    expect(ofType(events, 'blockDestroyed')).toEqual([
      expect.objectContaining({ col: 1, row: 0 }),
    ]);
    expect(player(game, 'bot').hammerUses).toBeLessThan(HAMMER_USES_PER_PICKUP);
  });

  it('hammers an adjacent enemy to death', () => {
    const game = createGame({ seed: 1, playerIds: ['bot', 'p2'], grid: openGrid() });
    player(game, 'bot').hammerUses = HAMMER_USES_PER_PICKUP;
    const victim = player(game, 'p2');
    victim.x = 2;
    victim.y = 0; // two tiles right of the bot spawn, reachable and hammerable
    const bot = createBot('bot', createRng(5));

    const events = runBots(game, { bot }, 120);
    expect(ofType(events, 'hammerSwung').length).toBeGreaterThanOrEqual(1);
    expect(victim.alive).toBe(false);
  });

  it('fires a held gun at a soft block in its line instead of freezing', () => {
    const grid = openGrid();
    grid[0][3] = TileType.SoftBlock; // (3,0), straight down the bot's row
    const game = createGame({ seed: 1, playerIds: ['bot', 'p2'], grid });
    player(game, 'bot').gunAmmo = GUN_AMMO_PER_PICKUP;
    player(game, 'p2').y = 6; // out of the firing line
    const bot = createBot('bot', createRng(4));

    const events = runBots(game, { bot }, 120);
    expect(ofType(events, 'gunFired').length).toBeGreaterThanOrEqual(1);
    expect(ofType(events, 'blockDestroyed')).toEqual([
      expect.objectContaining({ col: 3, row: 0 }),
    ]);
    expect(ofType(events, 'bombPlaced')).toHaveLength(0);
    expect(player(game, 'bot').alive).toBe(true);
  });

  it('spends the hammer on several blocks, then goes back to bombs', () => {
    const grid = openGrid();
    grid[0][2] = TileType.SoftBlock;
    grid[2][0] = TileType.SoftBlock;
    grid[2][2] = TileType.SoftBlock;
    grid[4][0] = TileType.SoftBlock;
    const game = createGame({ seed: 1, playerIds: ['bot', 'p2'], grid });
    player(game, 'bot').hammerUses = HAMMER_USES_PER_PICKUP;
    const bot = createBot('bot', createRng(9));

    const events = runBots(game, { bot }, 600);
    // Not necessarily the full magazine: a block can drop another skill pickup,
    // and skills are exclusive, so collecting one replaces the hammer.
    expect(ofType(events, 'hammerSwung').length).toBeGreaterThanOrEqual(2);
    expect(player(game, 'bot').hammerUses).toBe(0);
    expect(ofType(events, 'bombPlaced').length).toBeGreaterThanOrEqual(1);
    expect(player(game, 'bot').alive).toBe(true);
  });

  it('refuses to walk onto an armed mine, even to reach a powerup behind it', () => {
    // One-tile corridor: (0,0)..(4,0), armed mine at (2,0), powerup at (4,0).
    const grid = Array.from({ length: GRID_HEIGHT }, () =>
      Array<TileType>(GRID_WIDTH).fill(TileType.HardBlock),
    );
    for (let col = 0; col <= 4; col++) grid[0][col] = TileType.Floor;
    const game = createGame({ seed: 1, playerIds: ['bot', 'p2'], grid });
    game.state.mines.push({ id: 1, col: 2, row: 0, ownerId: 'p2', ticks: MINE_ARM_TICKS });
    game.state.powerups.push({ col: 4, row: 0, type: PowerupType.ExtraBomb });
    const bot = createBot('bot', createRng(8));

    const me = player(game, 'bot');
    for (let i = 0; i < 200; i++) {
      game.tick({ bot: bot.computeInput(game.state) });
      expect(Math.round(me.x)).toBeLessThan(2);
    }
    expect(me.alive).toBe(true);
    expect(game.state.mines).toHaveLength(1); // never stepped on it
  });

  it('steps off the mine it just dropped instead of waiting for it to arm', () => {
    const grid = openGrid();
    grid[0][1] = TileType.SoftBlock; // gives the bot a reason to use its charge here
    const game = createGame({ seed: 1, playerIds: ['bot', 'p2'], grid });
    player(game, 'bot').mineAmmo = 1;
    const bot = createBot('bot', createRng(4));

    const events = runBots(game, { bot }, 200);

    expect(ofType(events, 'minePlaced')).toHaveLength(1);
    expect(ofType(events, 'mineExploded')).toHaveLength(0);
    expect(game.state.mines).toHaveLength(1);
    expect(player(game, 'bot').alive).toBe(true);
  });

  it('returns idle input for a dead or absent player', () => {
    const game = createGame({ seed: 1, playerIds: ['bot', 'p2'], grid: openGrid() });
    player(game, 'bot').alive = false;
    expect(createBot('bot', createRng(1)).computeInput(game.state)).toEqual({
      direction: null,
      placeBomb: false,
    });
    expect(createBot('ghost', createRng(1)).computeInput(game.state)).toEqual({
      direction: null,
      placeBomb: false,
    });
  });

  it('is deterministic: same seeds and state sequence produce identical inputs', () => {
    const simulate = () => {
      const ids = ['a', 'b', 'c', 'd'];
      const game = createGame({ seed: 123, playerIds: ids });
      const bots = Object.fromEntries(ids.map((id, i) => [id, createBot(id, createRng(50 + i))]));
      const record: PlayerInput[][] = [];
      for (let t = 0; t < 600 && game.state.status === 'running'; t++) {
        const inputs: Record<string, PlayerInput> = {};
        for (const id of ids) inputs[id] = bots[id].computeInput(game.state);
        record.push(ids.map((id) => inputs[id]));
        game.tick(inputs);
      }
      return { record, state: game.state };
    };
    const first = simulate();
    const second = simulate();
    expect(second.record).toEqual(first.record);
    expect(second.state).toEqual(first.state);
  });

  it(
    'integration smoke: 4 bots on a generated map run to completion or 3000 ticks without crashing',
    () => {
      const ids = ['a', 'b', 'c', 'd'];
      const game = createGame({ seed: 2024, playerIds: ids });
      const bots = Object.fromEntries(
        ids.map((id, i) => [id, createBot(id, createRng(1000 + i))]),
      );
      const events = runBots(game, bots, 3000);
      expect(ofType(events, 'blockDestroyed').length).toBeGreaterThan(0);
      expect(game.state.tick).toBeGreaterThan(0);
    },
    15000,
  );
});
