import http from 'node:http';
import { Server, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { GameRoom } from './rooms/GameRoom';
import { lookupRoomId } from './roomCodes';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
} as const;

const ROOM_CODE_ROUTE = /^\/room\/([A-Za-z]{4})$/;
/** Dev-only (SIM_DEBUG_STATE=1): raw authoritative sim state for the local
 * multiplayer sim harness — its bot brains read server truth while their
 * inputs still travel through the real browser clients. */
const DEBUG_SIM_ROUTE = /^\/debug\/sim\/([A-Za-z]{4})$/;

/** Plain-http routes: health check for deploys + room-code -> roomId lookup.
 * Colyseus wraps this listener and handles its own /matchmake routes first. */
export function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? '';
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (process.env.SIM_DEBUG_STATE === '1' && req.method === 'GET') {
    const dm = DEBUG_SIM_ROUTE.exec(url);
    if (dm) {
      const roomId = lookupRoomId(dm[1].toUpperCase());
      const room = roomId !== undefined ? matchMaker.getLocalRoomById(roomId) : undefined;
      const snap = room instanceof GameRoom ? room.debugSimState() : null;
      if (snap) {
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snap));
      } else {
        res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no running sim for that room' }));
      }
      return;
    }
  }
  const match = req.method === 'GET' ? ROOM_CODE_ROUTE.exec(url) : null;
  if (match) {
    const roomId = lookupRoomId(match[1]);
    if (roomId !== undefined) {
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ roomId }));
    } else {
      res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'room not found' }));
    }
    return;
  }
  res.writeHead(404, CORS_HEADERS);
  res.end();
}

export interface AppOptions {
  /** Disable process signal hooks (for tests). */
  gracefullyShutdown?: boolean;
}

export function createApp(options: AppOptions = {}): { gameServer: Server; httpServer: http.Server } {
  const httpServer = http.createServer(handleHttpRequest);
  // Disable Nagle's algorithm on every TCP socket (WS upgrades reuse these).
  // Node defaults noDelay=false, which lets Nagle hold small game packets up to
  // ~40ms waiting for an ACK — real added latency at our 20Hz packet cadence.
  httpServer.on('connection', (socket) => socket.setNoDelay(true));
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    gracefullyShutdown: options.gracefullyShutdown ?? true,
    greet: false,
  });
  gameServer.define('game', GameRoom);
  return { gameServer, httpServer };
}
