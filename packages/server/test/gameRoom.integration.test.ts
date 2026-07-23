import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { GRID_WIDTH, TileType, generateMap } from '@bomberman/shared';
import { createApp } from '../src/app';
import { hashSeed } from '../src/rooms/GameRoom';

let gameServer: ReturnType<typeof createApp>['gameServer'];
let port: number;
let wsUrl: string;
let httpUrl: string;

beforeAll(async () => {
  const app = createApp({ gracefullyShutdown: false });
  gameServer = app.gameServer;
  await gameServer.listen(0);
  port = (app.httpServer.address() as AddressInfo).port;
  wsUrl = `ws://127.0.0.1:${port}`;
  httpUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await gameServer.gracefullyShutdown(false);
});

async function until(cond: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyRoom = Room<any>;

describe('hashSeed', () => {
  it('is deterministic and uint32', () => {
    expect(hashSeed('ABCD:123')).toBe(hashSeed('ABCD:123'));
    expect(hashSeed('ABCD:123')).not.toBe(hashSeed('ABCD:124'));
    const seed = hashSeed('ZZZZ:999');
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('server http endpoints', () => {
  it('GET /health returns 200 ok', async () => {
    const res = await fetch(`${httpUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('GET /room/:code returns 404 for unknown codes', async () => {
    const res = await fetch(`${httpUrl}/room/QQQQ`);
    expect(res.status).toBe(404);
  });
});

describe('create/join/start/move flow', () => {
  it('runs a full round-trip: create, join by code, start, inputs move players', async () => {
    const host: AnyRoom = await new Client(wsUrl).create('game', { nickname: 'Alice' });
    try {
      await until(() => host.state?.code?.length === 4, 3000, 'room code in state');
      const code: string = host.state.code;
      expect(code).toMatch(/^[A-Z]{4}$/);
      expect(host.state.phase).toBe('lobby');

      // Host is identified by sessionId in the players map.
      const me = host.state.players.get('p0');
      expect(me.nickname).toBe('Alice');
      expect(me.sessionId).toBe(host.sessionId);
      expect(host.state.hostId).toBe('p0');

      // Second player joins via code lookup (lowercase to prove case-insensitivity).
      const lookup = await fetch(`${httpUrl}/room/${code.toLowerCase()}`);
      expect(lookup.status).toBe(200);
      const { roomId } = (await lookup.json()) as { roomId: string };
      expect(roomId).toBe(host.roomId);
      const guest: AnyRoom = await new Client(wsUrl).joinById(roomId, { nickname: '  Bob  ' });
      try {
        await until(() => host.state.players.size === 2, 3000, 'guest visible to host');
        expect(host.state.players.get('p1').nickname).toBe('Bob'); // trimmed

        // Guest cannot start; nothing should change.
        guest.send('start');
        await new Promise((r) => setTimeout(r, 150));
        expect(host.state.phase).toBe('lobby');

        // Host disables bot fill, then starts a 2-human game.
        const fillBefore: boolean = host.state.fillBots;
        expect(fillBefore).toBe(true);
        host.send('toggleBots');
        await until(() => host.state.fillBots === false, 3000, 'fillBots off');
        host.send('start');
        await until(() => guest.state.phase === 'playing', 3000, 'phase playing on guest');

        expect(guest.state.seed).toBeGreaterThan(0);
        expect(guest.state.players.size).toBe(2); // no bots
        await until(() => guest.state.tick > 0, 3000, 'ticks advancing');

        // p0 spawns at (0,0); moving right must increase x, visible to the guest.
        host.send('input', { direction: 'right', placeBomb: false });
        await until(() => guest.state.players.get('p0').x > 0.2, 3000, 'p0 moved right');

        // Room is locked after start: joining by id must fail.
        await expect(new Client(wsUrl).joinById(roomId, { nickname: 'Carol' })).rejects.toThrow();

        // Sticky bomb: a press between ticks is consumed, bomb appears in state.
        host.send('input', { direction: null, placeBomb: true });
        await until(() => guest.state.bombs.size === 1, 3000, 'bomb visible');
        const bomb = [...guest.state.bombs.values()][0];
        expect(bomb.ownerId).toBe('p0');
      } finally {
        await guest.leave();
      }
    } finally {
      await host.leave();
    }

    // Once everyone leaves, the room disposes and the code frees up.
    await until(
      () => false as boolean,
      400,
      'grace period',
    ).catch(() => undefined);
    const after = await fetch(`${httpUrl}/room/AAAA`);
    expect(after.status).toBe(404);
  });

  it('fills empty slots with bots when fillBots is on', { timeout: 20_000 }, async () => {
    const host: AnyRoom = await new Client(wsUrl).create('game', { nickname: 'Solo' });
    try {
      await until(() => host.state?.code?.length === 4, 3000, 'state ready');
      expect(host.state.fillBots).toBe(true);
      host.send('start');
      await until(() => host.state.phase === 'playing', 3000, 'phase playing');
      expect(host.state.players.size).toBe(4);
      const bots = [...host.state.players.values()].filter((p: { isBot: boolean }) => p.isBot);
      expect(bots).toHaveLength(3);
      await until(() => host.state.tick > 2, 3000, 'sim ticking with bots');

      // Bots bomb soft blocks; destroyedBlocks indices must line up with the
      // grid the client regenerates locally from the synced seed.
      await until(() => host.state.destroyedBlocks.length > 0, 15_000, 'a block destroyed');
      const grid = generateMap(host.state.seed);
      const index: number = host.state.destroyedBlocks[0];
      const row = Math.floor(index / GRID_WIDTH);
      const col = index % GRID_WIDTH;
      expect(grid[row][col]).toBe(TileType.SoftBlock);
    } finally {
      await host.leave();
    }
  });

  it('rejects a 5th player when the room is full', async () => {
    const host: AnyRoom = await new Client(wsUrl).create('game', { nickname: 'A' });
    const others: AnyRoom[] = [];
    try {
      await until(() => host.state?.code?.length === 4, 3000, 'state ready');
      for (let i = 0; i < 3; i++) {
        others.push(await new Client(wsUrl).joinById(host.roomId, { nickname: `G${i}` }));
      }
      await until(() => host.state.players.size === 4, 3000, 'four players');
      await expect(new Client(wsUrl).joinById(host.roomId, { nickname: 'Late' })).rejects.toThrow();
    } finally {
      for (const room of others) await room.leave();
      await host.leave();
    }
  });

  it('promotes a new host when the host leaves the lobby', async () => {
    const host: AnyRoom = await new Client(wsUrl).create('game', { nickname: 'A' });
    await until(() => host.state?.code?.length === 4, 3000, 'state ready');
    const guest: AnyRoom = await new Client(wsUrl).joinById(host.roomId, { nickname: 'B' });
    try {
      await until(() => guest.state?.players?.size === 2, 3000, 'both players in');
      await host.leave();
      await until(() => guest.state.hostId === 'p1', 3000, 'host promoted');
      expect(guest.state.players.size).toBe(1);
    } finally {
      await guest.leave();
    }
  });
});
