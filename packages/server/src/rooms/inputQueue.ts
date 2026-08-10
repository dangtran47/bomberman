import { PING_CAP_MS, TICK_RATE } from '@bomberman/shared';
import type { Direction, PlayerInput } from '@bomberman/shared';

const DIRECTIONS: readonly string[] = ['up', 'down', 'left', 'right'];
/** Max queued inputs per player (250ms worth); beyond this the oldest is dropped. */
const MAX_QUEUE = Math.round(0.25 * TICK_RATE);

interface QueuedInput {
  seq: number;
  direction: Direction | null;
  placeBomb: boolean;
  fireGun: boolean;
  swingHammer: boolean;
  placeMine: boolean;
  /** Client-reported RTT, already clamped; drives the sim's turnGrace. */
  pingMs: number | undefined;
}

interface LegacyEntry {
  direction: Direction | null;
  placeBomb: boolean;
  fireGun: boolean;
  swingHammer: boolean;
  placeMine: boolean;
}

interface PlayerEntry {
  queue: QueuedInput[];
  /** Highest seq ever accepted; stale/duplicate pushes are rejected against it. */
  lastSeq: number;
  /** Seq of the last input actually applied to a tick (the published ack). */
  acked: number;
  /** Direction to keep applying when the queue runs dry (TCP stall). */
  heldDirection: Direction | null;
  /** Last consumed pingMs, repeated on dry-hold ticks so grace stays stable. */
  heldPing: number | undefined;
  /** Pre-seq clients: latest-wins direction with sticky one-shot action flags. */
  legacy: LegacyEntry | null;
}

/**
 * Per-player input queue: the client sends one sequence-numbered input per
 * 20Hz tick and the server applies exactly one per sim tick. Holding a key for
 * N client ticks therefore moves the player for exactly N server ticks — the
 * old latest-wins buffer quantized press/release against tick boundaries and
 * network jitter, which made the same hold cover different distances.
 *
 * The reproduction is exact modulo queue starvation: when a TCP stall empties the
 * queue, the dry-hold keeps repeating the last direction for ticks the client never
 * sent, so those ticks are the server's invention rather than a replay. Stalled
 * inputs still apply once they arrive within the backlog cap; a longer stall drops
 * the oldest queued inputs per MAX_QUEUE. Either way a stall stretches a hold
 * rather than pausing it.
 */
export class InputQueue {
  private readonly players = new Map<string, PlayerEntry>();

  /** Applies a raw (untrusted) client message; malformed messages are ignored. */
  push(playerId: string, message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const { seq, direction, placeBomb, fireGun, swingHammer, placeMine, pingMs } = message as {
      seq?: unknown;
      direction?: unknown;
      placeBomb?: unknown;
      fireGun?: unknown;
      swingHammer?: unknown;
      placeMine?: unknown;
      pingMs?: unknown;
    };
    const validDirection = direction === null || DIRECTIONS.includes(direction as string);
    if (!validDirection || typeof placeBomb !== 'boolean') return;
    const dir = direction as Direction | null;
    // Untrusted latency claim: clamp here so a lying client caps out at the
    // same turn grace an honest 400ms connection gets.
    const ping =
      typeof pingMs === 'number' && Number.isFinite(pingMs) && pingMs >= 0
        ? Math.min(pingMs, PING_CAP_MS)
        : undefined;
    const entry = this.entry(playerId);

    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) {
      // Legacy (pre-seq) client: latest-wins, action presses sticky until consumed.
      const legacy = entry.legacy ?? {
        direction: null,
        placeBomb: false,
        fireGun: false,
        swingHammer: false,
        placeMine: false,
      };
      legacy.direction = dir;
      legacy.placeBomb = legacy.placeBomb || placeBomb;
      legacy.fireGun = legacy.fireGun || fireGun === true;
      legacy.swingHammer = legacy.swingHammer || swingHammer === true;
      legacy.placeMine = legacy.placeMine || placeMine === true;
      entry.legacy = legacy;
      return;
    }

    if (seq <= entry.lastSeq) return; // stale or duplicate
    entry.lastSeq = seq;
    entry.queue.push({
      seq,
      direction: dir,
      placeBomb,
      fireGun: fireGun === true,
      swingHammer: swingHammer === true,
      placeMine: placeMine === true,
      pingMs: ping,
    });
    // Backlog cap: drop the oldest. The ack naturally skips dropped seqs when a
    // later input is consumed, so the client discards them from its pending list.
    if (entry.queue.length > MAX_QUEUE) entry.queue.shift();
  }

  /** One tick's inputs: pops the oldest queued input per player (or a dry hold). */
  consume(): Map<string, PlayerInput> {
    const snapshot = new Map<string, PlayerInput>();
    for (const [id, entry] of this.players) {
      const next = entry.queue.shift();
      if (next) {
        entry.acked = next.seq;
        entry.heldDirection = next.direction;
        entry.heldPing = next.pingMs;
        snapshot.set(id, {
          direction: next.direction,
          placeBomb: next.placeBomb,
          fireGun: next.fireGun,
          swingHammer: next.swingHammer,
          placeMine: next.placeMine,
          pingMs: next.pingMs,
        });
      } else if (entry.legacy) {
        const l = entry.legacy;
        snapshot.set(id, {
          direction: l.direction,
          placeBomb: l.placeBomb,
          fireGun: l.fireGun,
          swingHammer: l.swingHammer,
          placeMine: l.placeMine,
        });
        l.placeBomb = false;
        l.fireGun = false;
        l.swingHammer = false;
        l.placeMine = false;
      } else {
        // Queue dry (TCP stall): hold the last direction, no actions, ack frozen.
        snapshot.set(id, { direction: entry.heldDirection, placeBomb: false, pingMs: entry.heldPing });
      }
    }
    return snapshot;
  }

  acked(playerId: string): number {
    return this.players.get(playerId)?.acked ?? 0;
  }

  remove(playerId: string): void {
    this.players.delete(playerId);
  }

  clear(): void {
    this.players.clear();
  }

  private entry(playerId: string): PlayerEntry {
    let entry = this.players.get(playerId);
    if (!entry) {
      entry = { queue: [], lastSeq: 0, acked: 0, heldDirection: null, heldPing: undefined, legacy: null };
      this.players.set(playerId, entry);
    }
    return entry;
  }
}
