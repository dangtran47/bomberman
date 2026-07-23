import { Client } from 'colyseus.js';
import type { Room } from 'colyseus.js';
import type { PowerupType } from '@bomberman/shared';

/**
 * Thin Colyseus wrapper: create/join rooms and structural typings for the
 * server's synced schema state (decoded via reflection at runtime).
 */

// Minimal structural views over MapSchema / ArraySchema — only what we use.
export interface NetMap<T> {
  size: number;
  get(key: string): T | undefined;
  forEach(cb: (value: T, key: string) => void): void;
}
export interface NetArray<T> {
  length: number;
  forEach(cb: (value: T, index: number) => void): void;
}

export interface NetPlayer {
  id: string;
  sessionId: string;
  nickname: string;
  x: number;
  y: number;
  alive: boolean;
  bombCount: number;
  blastRadius: number;
  speed: number;
  activeBombs: number;
  isBot: boolean;
}

export interface NetBomb {
  id: number;
  col: number;
  row: number;
  ownerId: string;
  fuseTicks: number;
  blastRadius: number;
}

export interface NetExplosion {
  col: number;
  row: number;
  ticksLeft: number;
}

export interface NetPowerup {
  col: number;
  row: number;
  type: PowerupType;
}

export interface NetRoomState {
  phase: 'lobby' | 'playing' | 'finished';
  code: string;
  hostId: string;
  fillBots: boolean;
  tick: number;
  seed: number;
  /** row * GRID_WIDTH + col indices, append-only. */
  destroyedBlocks: NetArray<number>;
  players: NetMap<NetPlayer>;
  bombs: NetMap<NetBomb>;
  explosions: NetArray<NetExplosion>;
  powerups: NetArray<NetPowerup>;
  winnerId: string;
}

export interface GameRoomConnection {
  room: Room<NetRoomState>;
  /** Our slot id (p0-p3) in the room's players map. */
  playerId: string;
}

const WS_URL: string = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:2567';
const HTTP_URL = WS_URL.replace(/^ws/, 'http');

export async function createRoom(nickname: string): Promise<GameRoomConnection> {
  let room: Room<NetRoomState>;
  try {
    room = await new Client(WS_URL).create<NetRoomState>('game', { nickname });
  } catch (error) {
    throw new Error(friendlyError(error, 'Could not create room'));
  }
  return finishJoin(room);
}

export async function joinRoom(code: string, nickname: string): Promise<GameRoomConnection> {
  const trimmed = code.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(trimmed)) throw new Error('Room code must be 4 letters');

  let response: Response;
  try {
    response = await fetch(`${HTTP_URL}/room/${trimmed}`);
  } catch {
    throw new Error('Cannot reach server');
  }
  if (response.status === 404) throw new Error('Room not found');
  if (!response.ok) throw new Error('Room lookup failed');
  const { roomId } = (await response.json()) as { roomId: string };

  let room: Room<NetRoomState>;
  try {
    room = await new Client(WS_URL).joinById<NetRoomState>(roomId, { nickname });
  } catch (error) {
    throw new Error(friendlyError(error, 'Could not join room'));
  }
  return finishJoin(room);
}

/** Waits until the first synced state contains our own player, keyed by sessionId. */
function finishJoin(room: Room<NetRoomState>): Promise<GameRoomConnection> {
  return new Promise((resolve, reject) => {
    const findSelf = (): string | null => {
      let found: string | null = null;
      room.state?.players?.forEach((player, id) => {
        if (player.sessionId === room.sessionId) found = id;
      });
      return found;
    };
    const settle = (): void => {
      const playerId = findSelf();
      if (playerId !== null) {
        cleanup();
        resolve({ room, playerId });
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      void room.leave();
      reject(new Error('Timed out waiting for room state'));
    }, 5000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      room.onStateChange.remove(settle);
    };
    room.onStateChange(settle);
    settle();
  });
}

function friendlyError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/locked/i.test(message)) return 'Game already started';
  if (/full|maxClients|max clients/i.test(message)) return 'Room is full';
  if (/expired|not found/i.test(message)) return 'Room not found';
  return message !== '' ? `${fallback}: ${message}` : fallback;
}
