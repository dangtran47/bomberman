import { describe, expect, it } from 'vitest';
import { createGame } from '../src/game';
import type { Game } from '../src/game';
import { BOMB_FUSE_TICKS, GRID_HEIGHT, GRID_WIDTH } from '../src/constants';
import { TileType } from '../src/types';
import type { Bomb, PlayerInput } from '../src/types';

function openGrid(): TileType[][] {
  return Array.from({ length: GRID_HEIGHT }, () =>
    Array<TileType>(GRID_WIDTH).fill(TileType.Floor),
  );
}

function game(): Game {
  return createGame({ seed: 1, playerIds: ['p1', 'p2'], grid: openGrid() });
}

function player(g: Game, id: string) {
  const p = g.state.players.find((x) => x.id === id);
  if (!p) throw new Error(`no ${id}`);
  return p;
}

/** A rival's bomb the owner has long since walked off: solid for everyone. */
function enemyBomb(g: Game, col: number, row: number): Bomb {
  const bomb: Bomb = {
    id: 99,
    col,
    row,
    ownerId: 'p1',
    fuseTicks: BOMB_FUSE_TICKS,
    blastRadius: 1,
    slideDC: 0,
    slideDR: 0,
    slideCooldown: 0,
    slideInterval: 0,
    ownerOnTile: false,
  };
  g.state.bombs.push(bomb);
  return bomb;
}

const go = (direction: PlayerInput['direction']): PlayerInput => ({ direction, placeBomb: false });

function hold(g: Game, id: string, direction: PlayerInput['direction'], ticks: number): void {
  for (let i = 0; i < ticks; i++) g.tick({ [id]: go(direction) });
}

describe('bomb ownership blocking', () => {
  it('marks a freshly placed bomb as owned-on-tile', () => {
    const g = game();
    const p = player(g, 'p1');
    p.x = 5;
    p.y = 7;
    g.tick({ p1: { direction: null, placeBomb: true } });
    expect(g.state.bombs[0]).toMatchObject({ col: 5, row: 7, ownerOnTile: true });
  });

  it('refuses a non-owner moving toward the center of a bomb tile it overlaps', () => {
    const g = game();
    const p = player(g, 'p2');
    p.x = 5.6; // rounded tile 6: already overlapping the bomb tile
    p.y = 7;
    enemyBomb(g, 6, 7);
    hold(g, 'p2', 'right', 30);
    expect(p.x).toBeCloseTo(5.6, 9); // no walking through, not even to the center
  });

  it('lets a non-owner overlapping a bomb tile retreat off it', () => {
    const g = game();
    const p = player(g, 'p2');
    p.x = 5.6;
    p.y = 7;
    enemyBomb(g, 6, 7);
    hold(g, 'p2', 'left', 20); // 20 ticks at 0.05 tiles/tick
    expect(p.x).toBeCloseTo(4.6, 9);
  });

  it('refuses a non-owner settling onto the lane of a bomb tile it overlaps', () => {
    const g = game();
    const p = player(g, 'p2');
    p.x = 5.6;
    p.y = 7;
    p.laneDir = 'right'; // the move that carried it onto the tile
    enemyBomb(g, 6, 7);
    hold(g, 'p2', 'up', 10);
    expect(p.y).toBeCloseTo(7, 9); // the turn never settles onto column 6
    expect(p.x).toBeCloseTo(5.6, 9);

    // Backing out of the tile first frees the turn.
    hold(g, 'p2', 'left', 4); // x = 5.4, rounded tile 5
    hold(g, 'p2', 'up', 12);
    expect(p.y).toBeLessThan(7);
  });

  it('lets the owner run straight through a bomb dropped under its stride', () => {
    const g = game();
    const p = player(g, 'p1');
    p.x = 5.6; // rounded tile 6, so the bomb lands ahead of the center
    p.y = 7;
    g.tick({ p1: { direction: 'right', placeBomb: true } });
    expect(g.state.bombs[0]).toMatchObject({ col: 6, row: 7, ownerOnTile: true });
    hold(g, 'p1', 'right', 10);
    expect(p.x).toBeGreaterThan(6.1); // walked over its own bomb
  });

  it('revokes the exemption once the owner leaves and refuses re-entry', () => {
    const g = game();
    const p = player(g, 'p1');
    p.x = 5;
    p.y = 7;
    g.tick({ p1: { direction: null, placeBomb: true } });
    const bomb = g.state.bombs[0];
    hold(g, 'p1', 'right', 20); // x = 6.0: off the bomb tile
    expect(bomb.ownerOnTile).toBe(false);
    hold(g, 'p1', 'left', 30);
    expect(p.x).toBeGreaterThanOrEqual(6 - 1e-9); // clamped at the bomb's neighbour
  });

  it('revokes the exemption when the owner dies', () => {
    const g = game();
    const p = player(g, 'p1');
    p.x = 5;
    p.y = 7;
    g.tick({ p1: { direction: null, placeBomb: true } });
    const bomb = g.state.bombs[0];
    p.alive = false;
    g.tick({});
    expect(bomb.ownerOnTile).toBe(false);
  });

  it('revokes the exemption when a kick slides the bomb out from under the owner', () => {
    const g = game();
    const p = player(g, 'p1');
    p.x = 5;
    p.y = 7;
    g.tick({ p1: { direction: null, placeBomb: true } });
    const bomb = g.state.bombs[0];
    expect(bomb.ownerOnTile).toBe(true);
    bomb.slideDC = 1;
    bomb.slideInterval = 1;
    bomb.slideCooldown = 1;
    g.tick({});
    expect(bomb.col).toBe(6);
    expect(bomb.ownerOnTile).toBe(false);
  });

  it('lets a centered non-owner leave a bomb tile in any direction', () => {
    for (const direction of ['up', 'down', 'left', 'right'] as const) {
      const g = game();
      const p = player(g, 'p2');
      p.x = 5;
      p.y = 7;
      enemyBomb(g, 5, 7); // dropped right under it
      hold(g, 'p2', direction, 5);
      const moved = Math.abs(p.x - 5) + Math.abs(p.y - 7);
      expect(moved).toBeCloseTo(0.25, 9);
    }
  });
});
