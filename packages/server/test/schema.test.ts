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
    expect(p0.kickTicks).toBe(simP0.kickTicks);
    expect(p0.gunAmmo).toBe(simP0.gunAmmo);
    expect(p0.hammerUses).toBe(simP0.hammerUses);
    expect(p0.facing).toBe(simP0.facing);
    expect(p0.facing).toBe('right'); // input direction aims the skills
  });

  it('mirrors the skill counters and facing in place', () => {
    const game = createGame({ seed: 42, playerIds: ['p0', 'p1'] });
    const state = makeRoomState(['p0', 'p1']);
    game.state.players[0].gunAmmo = 2;
    game.state.players[0].hammerUses = 3;
    game.state.players[0].facing = 'left';
    copySimToSchema(game.state, state);
    const p0 = state.players.get('p0')!;
    expect(p0.gunAmmo).toBe(2);
    expect(p0.hammerUses).toBe(3);
    expect(p0.facing).toBe('left');
  });

  it('defaults a fresh PlayerSchema to no skills facing down', () => {
    const p = new PlayerSchema();
    expect(p.gunAmmo).toBe(0);
    expect(p.hammerUses).toBe(0);
    expect(p.facing).toBe('down');
  });

  it('defaults RoomState.mapId to the classic procedural map', () => {
    expect(new RoomState().mapId).toBe('');
  });

  it('mirrors kickTicks in place', () => {
    const game = createGame({ seed: 42, playerIds: ['p0', 'p1'] });
    const state = makeRoomState(['p0', 'p1']);
    game.state.players[0].kickTicks = 7;
    copySimToSchema(game.state, state);
    expect(state.players.get('p0')!.kickTicks).toBe(7);
  });

  it('mirrors the ice/lane movement fields so clients can replay from them', () => {
    const game = createGame({ seed: 42, playerIds: ['p0', 'p1'] });
    const state = makeRoomState(['p0', 'p1']);
    game.state.players[0].momentumDir = 'right';
    game.state.players[0].momentumTicks = 5;
    game.state.players[0].turnTicks = 2;
    game.state.players[0].laneDir = 'up';
    copySimToSchema(game.state, state);
    const p0 = state.players.get('p0')!;
    expect(p0.momentumDir).toBe('right');
    expect(p0.momentumTicks).toBe(5);
    expect(p0.turnTicks).toBe(2);
    expect(p0.laneDir).toBe('up');
  });

  it('maps a null momentumDir/laneDir to the empty string', () => {
    const game = createGame({ seed: 42, playerIds: ['p0', 'p1'] });
    const state = makeRoomState(['p0', 'p1']);
    game.state.players[0].momentumDir = null;
    game.state.players[0].laneDir = null;
    copySimToSchema(game.state, state);
    const p0 = state.players.get('p0')!;
    expect(p0.momentumDir).toBe('');
    expect(p0.laneDir).toBe('');
  });

  it('defaults a fresh PlayerSchema to no momentum and no lane', () => {
    const p = new PlayerSchema();
    expect(p.momentumDir).toBe('');
    expect(p.momentumTicks).toBe(0);
    expect(p.turnTicks).toBe(0);
    expect(p.laneDir).toBe('');
  });

  it('updates bomb col/row when a sliding bomb moves', () => {
    const game = createGame({ seed: 42, playerIds: ['p0', 'p1'] });
    const state = makeRoomState(['p0', 'p1']);
    game.tick({ p0: { direction: null, placeBomb: true } });
    copySimToSchema(game.state, state);
    const simBomb = game.state.bombs[0];
    const key = String(simBomb.id);
    const before = { col: state.bombs.get(key)!.col, row: state.bombs.get(key)!.row };

    // Simulate a slide: move the sim bomb, re-mirror, expect the schema to follow.
    simBomb.col += 2;
    simBomb.row += 1;
    simBomb.slideInterval = 2;
    copySimToSchema(game.state, state);
    const bs = state.bombs.get(key)!;
    expect(bs.col).toBe(before.col + 2);
    expect(bs.row).toBe(before.row + 1);
    expect(bs.slideInterval).toBe(2);
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
