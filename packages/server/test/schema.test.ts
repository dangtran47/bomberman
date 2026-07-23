import { describe, expect, it } from 'vitest';
import { createGame } from '@bomberman/shared';
import { PlayerSchema, RoomState, copySimToSchema } from '../src/rooms/schema';

function makeRoomState(playerIds: string[]): RoomState {
  const state = new RoomState();
  for (const id of playerIds) {
    const p = new PlayerSchema();
    p.id = id;
    state.players.set(id, p);
  }
  return state;
}

describe('copySimToSchema', () => {
  it('copies tick and per-player fields', () => {
    const game = createGame({ seed: 42, playerIds: ['p0', 'p1'] });
    const state = makeRoomState(['p0', 'p1']);
    game.tick({ p0: { direction: 'right', placeBomb: false } });
    copySimToSchema(game.state, state);

    expect(state.tick).toBe(1);
    const simP0 = game.state.players[0];
    const p0 = state.players.get('p0')!;
    expect(p0.x).toBe(simP0.x);
    expect(p0.y).toBe(simP0.y);
    expect(p0.alive).toBe(true);
    expect(p0.bombCount).toBe(simP0.bombCount);
    expect(p0.blastRadius).toBe(simP0.blastRadius);
    expect(p0.speed).toBe(simP0.speed);
    expect(p0.activeBombs).toBe(simP0.activeBombs);
  });

  it('mirrors bombs by id and updates their fuse in place', () => {
    const game = createGame({ seed: 42, playerIds: ['p0', 'p1'] });
    const state = makeRoomState(['p0', 'p1']);
    game.tick({ p0: { direction: null, placeBomb: true } });
    copySimToSchema(game.state, state);

    expect(state.bombs.size).toBe(1);
    const simBomb = game.state.bombs[0];
    const bomb = state.bombs.get(String(simBomb.id))!;
    const before = bomb.fuseTicks;
    expect(bomb.col).toBe(simBomb.col);
    expect(bomb.row).toBe(simBomb.row);
    expect(bomb.ownerId).toBe('p0');
    expect(bomb.blastRadius).toBe(simBomb.blastRadius);

    const instance = bomb;
    game.tick({});
    copySimToSchema(game.state, state);
    expect(state.bombs.get(String(simBomb.id))).toBe(instance); // same schema object, delta-friendly
    expect(instance.fuseTicks).toBe(before - 1);
  });

  it('removes bombs that exploded and mirrors explosion cells', () => {
    const game = createGame({ seed: 42, playerIds: ['p0', 'p1'] });
    const state = makeRoomState(['p0', 'p1']);
    game.tick({ p0: { direction: null, placeBomb: true } });
    copySimToSchema(game.state, state);
    expect(state.bombs.size).toBe(1);

    // Run until the fuse burns down and the bomb explodes.
    while (game.state.bombs.length > 0) game.tick({});
    copySimToSchema(game.state, state);

    expect(state.bombs.size).toBe(0);
    expect(state.explosions.length).toBe(game.state.explosions.length);
    expect(state.explosions.length).toBeGreaterThan(0);
    expect(state.explosions[0].col).toBe(game.state.explosions[0].col);
    expect(state.explosions[0].row).toBe(game.state.explosions[0].row);
    expect(state.explosions[0].ticksLeft).toBe(game.state.explosions[0].ticksLeft);
  });

  it('mirrors powerups', () => {
    const game = createGame({ seed: 42, playerIds: ['p0', 'p1'] });
    const state = makeRoomState(['p0', 'p1']);
    // Fabricate a powerup directly on the sim state (drop chance is random).
    game.state.powerups.push({ col: 3, row: 4, type: 1 });
    copySimToSchema(game.state, state);
    expect(state.powerups.length).toBe(1);
    expect(state.powerups[0].col).toBe(3);
    expect(state.powerups[0].row).toBe(4);
    expect(state.powerups[0].type).toBe(1);
  });

  it('marks dead players', () => {
    const game = createGame({ seed: 42, playerIds: ['p0', 'p1'] });
    const state = makeRoomState(['p0', 'p1']);
    game.state.players[1].alive = false;
    copySimToSchema(game.state, state);
    expect(state.players.get('p1')!.alive).toBe(false);
  });
});
