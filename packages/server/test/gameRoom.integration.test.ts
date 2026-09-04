import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { matchMaker } from 'colyseus';
import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import { GRID_WIDTH, TileType, compileMap, generateMap, getMapDef } from '@bomberman/shared';
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

async function until(
  cond: () => boolean,
  timeoutMs = 3000,
  what = 'condition',
  probe?: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await probe?.();
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
    await probe?.();
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
    let code = '';
    try {
      await until(() => host.state?.code?.length === 4, 3000, 'room code in state');
      code = host.state.code;
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
        // Each seq'd input moves the player for exactly one tick and a dry
        // queue moves them not at all, so cover ground with a run of inputs:
        // 10 ticks at BASE_SPEED (3 tiles/s, 60Hz) is 0.5 tiles.
        for (let seq = 1; seq <= 10; seq++) {
          host.send('input', { seq, direction: 'right', placeBomb: false });
        }
        await until(() => guest.state.players.get('p0').x > 0.2, 3000, 'p0 moved right');

        // Room is locked after start: joining by id must fail.
        await expect(new Client(wsUrl).joinById(roomId, { nickname: 'Carol' })).rejects.toThrow();

        // Next queued input places a bomb; the bomb appears in state.
        host.send('input', { seq: 11, direction: null, placeBomb: true });
        await until(() => guest.state.bombs.size === 1, 3000, 'bomb visible');
        const bomb = [...guest.state.bombs.values()][0];
        expect(bomb.ownerId).toBe('p0');

        // The tick that consumed seq 11 acks it back to the clients.
        await until(() => guest.state.players.get('p0').lastInputSeq === 11, 3000, 'seq 11 acked');
        expect(guest.state.players.get('p0').lastInputSeq).toBe(11);
      } finally {
        await guest.leave();
      }
    } finally {
      await host.leave();
    }

    // Once everyone leaves, the room disposes and its code is released:
    // poll the real code until the lookup 404s.
    let status = 0;
    await until(
      () => status === 404,
      3000,
      `code ${code} released after dispose`,
      async () => {
        status = (await fetch(`${httpUrl}/room/${code}`)).status;
      },
    );
    expect(status).toBe(404);
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

  it('records placements + wins on finish, then host backToLobby resets to lobby and drops bots', async () => {
    const host: AnyRoom = await new Client(wsUrl).create('game', { nickname: 'Champ' });
    try {
      await until(() => host.state?.code?.length === 4, 3000, 'state ready');
      host.send('start'); // fillBots on: p0 human + 3 bots
      await until(() => host.state.phase === 'playing', 3000, 'phase playing');
      expect(host.state.players.size).toBe(4);

      // Get an ack on the board so the lobby reset has something to clear.
      host.send('input', { seq: 1, direction: 'right', placeBomb: false });
      await until(() => host.state.players.get('p0').lastInputSeq === 1, 3000, 'seq 1 acked');

      // Reach into the live room and end the match deterministically: kill every
      // bot (distinct deathTicks) while the host survives, so the next sim tick
      // fires gameEnded with the host as winner.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const room = matchMaker.getLocalRoomById(host.roomId) as any;
      let t = 30;
      for (const p of room.sim.state.players) {
        if (p.id !== 'p0') {
          p.alive = false;
          p.deathTick = t;
          t -= 10;
        }
      }

      await until(() => host.state.phase === 'finished', 3000, 'phase finished');
      expect(host.state.winnerId).toBe('p0');
      const winner = host.state.players.get('p0');
      expect(winner.wins).toBe(1);
      expect(winner.placement).toBe(1);
      const placements = [...host.state.players.values()]
        .map((p: { placement: number }) => p.placement)
        .sort();
      expect(placements).toEqual([1, 2, 3, 4]);
      const champChar = winner.character;

      // Host returns everyone to the lobby.
      host.send('backToLobby');
      await until(() => host.state.phase === 'lobby', 3000, 'back in lobby');
      expect(host.state.players.size).toBe(1); // bots dropped
      expect(host.state.bombs.size).toBe(0);
      expect(host.state.explosions.length).toBe(0);
      expect(host.state.powerups.length).toBe(0);
      expect(host.state.destroyedBlocks.length).toBe(0);
      expect(host.state.arenaShrunk.length).toBe(0);
      expect(host.state.winnerId).toBe('');
      expect(host.state.tick).toBe(0);

      // Survivor keeps identity + score; placement lingers as last result.
      const stillHere = host.state.players.get('p0');
      expect(stillHere.character).toBe(champChar);
      expect(stillHere.lastInputSeq).toBe(0); // acks restart with the next match
      expect(stillHere.wins).toBe(1);
      expect(stillHere.alive).toBe(true);

      // Room was unlocked: a fresh client can join again.
      const late: AnyRoom = await new Client(wsUrl).joinById(host.roomId, { nickname: 'Late' });
      await late.leave();
    } finally {
      await host.leave();
    }
  });

  it('lets only the host pick a map, validates the id, and keeps it across a rematch', async () => {
    const host: AnyRoom = await new Client(wsUrl).create('game', { nickname: 'A' });
    const guest: AnyRoom = await new Client(wsUrl).joinById(host.roomId, { nickname: 'B' });
    try {
      await until(() => host.state.players?.size === 2, 3000, 'both in');
      expect(host.state.mapId).toBe(''); // classic procedural by default

      // Non-host picks are ignored.
      guest.send('setMap', { mapId: 'winter' });
      await new Promise((r) => setTimeout(r, 150));
      expect(host.state.mapId).toBe('');

      host.send('setMap', { mapId: 'winter' });
      await until(() => guest.state.mapId === 'winter', 3000, 'map synced to guest');

      // Unknown ids and malformed payloads leave the current choice alone.
      host.send('setMap', { mapId: 'atlantis' });
      host.send('setMap', { mapId: 7 });
      host.send('setMap', {});
      await new Promise((r) => setTimeout(r, 150));
      expect(host.state.mapId).toBe('winter');

      // The started match runs on the picked map...
      host.send('toggleBots');
      await until(() => host.state.fillBots === false, 3000, 'bots off');
      host.send('start');
      await until(() => host.state.phase === 'playing', 3000, 'playing');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const room = matchMaker.getLocalRoomById(host.roomId) as any;
      const winterGrid = compileMap(getMapDef('winter')!, room.state.seed).grid;
      expect(room.sim.state.grid).toEqual(winterGrid);

      // ...and the host's choice survives backToLobby.
      for (const p of room.sim.state.players) {
        if (p.id !== 'p0') {
          p.alive = false;
          p.deathTick = 10;
        }
      }
      await until(() => host.state.phase === 'finished', 3000, 'finished');
      host.send('backToLobby');
      await until(() => host.state.phase === 'lobby', 3000, 'back in lobby');
      expect(host.state.mapId).toBe('winter');
    } finally {
      await guest.leave();
      await host.leave();
    }
  });

  it('resets gun/hammer skills and facing when returning to the lobby', async () => {
    const host: AnyRoom = await new Client(wsUrl).create('game', { nickname: 'A' });
    try {
      await until(() => host.state?.code?.length === 4, 3000, 'state ready');
      host.send('start'); // fillBots on
      await until(() => host.state.phase === 'playing', 3000, 'playing');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const room = matchMaker.getLocalRoomById(host.roomId) as any;
      const me = room.sim.state.players.find((p: { id: string }) => p.id === 'p0');
      me.gunAmmo = 2;
      me.hammerUses = 3;
      me.mineAmmo = 2;
      me.facing = 'left';
      await until(
        () => host.state.players.get('p0').gunAmmo === 2 && host.state.players.get('p0').facing === 'left',
        3000,
        'skills mirrored to schema',
      );
      expect(host.state.players.get('p0').hammerUses).toBe(3);
      expect(host.state.players.get('p0').mineAmmo).toBe(2);

      for (const p of room.sim.state.players) {
        if (p.id !== 'p0') {
          p.alive = false;
          p.deathTick = 10;
        }
      }
      await until(() => host.state.phase === 'finished', 3000, 'finished');
      host.send('backToLobby');
      await until(() => host.state.phase === 'lobby', 3000, 'back in lobby');

      const p0 = host.state.players.get('p0');
      expect(p0.gunAmmo).toBe(0);
      expect(p0.hammerUses).toBe(0);
      expect(p0.mineAmmo).toBe(0);
      expect(p0.facing).toBe('down');
    } finally {
      await host.leave();
    }
  });

  it('promotes a new host when the host disconnects on the results screen', async () => {
    const host: AnyRoom = await new Client(wsUrl).create('game', { nickname: 'A' });
    await until(() => host.state?.code?.length === 4, 3000, 'state ready');
    const guest: AnyRoom = await new Client(wsUrl).joinById(host.roomId, { nickname: 'B' });
    try {
      await until(() => host.state.players.size === 2, 3000, 'both in');
      host.send('toggleBots');
      await until(() => host.state.fillBots === false, 3000, 'bots off');
      host.send('start');
      await until(() => guest.state.phase === 'playing', 3000, 'playing');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const room = matchMaker.getLocalRoomById(host.roomId) as any;
      for (const p of room.sim.state.players) {
        if (p.id !== 'p0') {
          p.alive = false;
          p.deathTick = 10;
        }
      }
      await until(() => guest.state.phase === 'finished', 3000, 'finished');

      // Host quits on the results screen: the guest must be promoted so the
      // room is not deadlocked on a host that will never send backToLobby.
      await host.leave();
      await until(() => guest.state.hostId === 'p1', 3000, 'host promoted while finished');

      guest.send('backToLobby');
      await until(() => guest.state.phase === 'lobby', 3000, 'promoted host continued to lobby');
      expect(guest.state.players.size).toBe(1);
    } finally {
      await guest.leave();
    }
  });

  it('promotes a new host when the host disconnects mid-match', async () => {
    const host: AnyRoom = await new Client(wsUrl).create('game', { nickname: 'A' });
    await until(() => host.state?.code?.length === 4, 3000, 'state ready');
    const guest: AnyRoom = await new Client(wsUrl).joinById(host.roomId, { nickname: 'B' });
    try {
      await until(() => host.state.players.size === 2, 3000, 'both in');
      host.send('toggleBots');
      await until(() => host.state.fillBots === false, 3000, 'bots off');
      host.send('start');
      await until(() => guest.state.phase === 'playing', 3000, 'playing');

      // Host rage-quits mid-match; the guest becomes host right away.
      await host.leave();
      await until(() => guest.state.hostId === 'p1', 3000, 'host promoted while playing');

      // Their abandoned character dies; the guest wins and can continue.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const room = matchMaker.getLocalRoomById(guest.roomId) as any;
      for (const p of room.sim.state.players) {
        if (p.id !== 'p1') {
          p.alive = false;
          p.deathTick = 10;
        }
      }
      await until(() => guest.state.phase === 'finished', 3000, 'finished');

      guest.send('backToLobby');
      await until(() => guest.state.phase === 'lobby', 3000, 'promoted host continued to lobby');
    } finally {
      await guest.leave();
    }
  });

  it('syncs a mine placed through the input message', async () => {
    const host: AnyRoom = await new Client(wsUrl).create('game', { nickname: 'Sapper' });
    try {
      await until(() => host.state?.code?.length === 4, 3000, 'state ready');
      host.send('start'); // fillBots on
      await until(() => host.state.phase === 'playing', 3000, 'playing');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const room = matchMaker.getLocalRoomById(host.roomId) as any;
      room.sim.state.players.find((p: { id: string }) => p.id === 'p0').mineAmmo = 2;
      await until(() => host.state.players.get('p0').mineAmmo === 2, 3000, 'ammo mirrored');

      host.send('input', { seq: 1, direction: null, placeBomb: false, placeMine: true });
      await until(() => host.state.mines.size === 1, 3000, 'mine visible');
      const mine = [...host.state.mines.values()][0];
      expect(mine.ownerId).toBe('p0');
      expect(mine.phase).toBe(0); // inert for the first 3s
      expect(host.state.players.get('p0').mineAmmo).toBe(1);
    } finally {
      await host.leave();
    }
  });

  it('ignores backToLobby from a non-host', async () => {
    const host: AnyRoom = await new Client(wsUrl).create('game', { nickname: 'A' });
    await until(() => host.state?.code?.length === 4, 3000, 'state ready');
    const guest: AnyRoom = await new Client(wsUrl).joinById(host.roomId, { nickname: 'B' });
    try {
      await until(() => host.state.players.size === 2, 3000, 'both in');
      host.send('toggleBots');
      await until(() => host.state.fillBots === false, 3000, 'bots off');
      host.send('start');
      await until(() => host.state.phase === 'playing', 3000, 'playing');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const room = matchMaker.getLocalRoomById(host.roomId) as any;
      for (const p of room.sim.state.players) {
        if (p.id !== 'p0') {
          p.alive = false;
          p.deathTick = 10;
        }
      }
      await until(() => host.state.phase === 'finished', 3000, 'finished');

      // Non-host request must be ignored: phase stays finished.
      guest.send('backToLobby');
      await new Promise((r) => setTimeout(r, 200));
      expect(host.state.phase).toBe('finished');
    } finally {
      await guest.leave();
      await host.leave();
    }
  });

  it('echoes ping payloads back to the sender and ignores non-numbers', async () => {
    const host: AnyRoom = await new Client(wsUrl).create('game', { nickname: 'Pinger' });
    try {
      await until(() => host.state?.code?.length === 4, 3000, 'state ready');

      let pong: number | null = null;
      host.onMessage('pong', (t: number) => {
        pong = t;
      });
      host.send('ping', 123456);
      await until(() => pong === 123456, 3000, 'pong echoed');
      expect(pong).toBe(123456);

      // A non-number payload must not produce a reply.
      pong = null;
      host.send('ping', 'nope');
      await new Promise((r) => setTimeout(r, 150));
      expect(pong).toBeNull();
    } finally {
      await host.leave();
    }
  });
});
