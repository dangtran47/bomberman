import { describe, expect, it } from 'vitest';
import { createBot } from '../src/bot';
import type { Bot } from '../src/bot';
import { BOMB_FUSE_TICKS, GRID_HEIGHT, GRID_WIDTH } from '../src/constants';
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
      fuseTicks: BOMB_FUSE_TICKS,
      blastRadius: 2,
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
