import type { Direction, PlayerInput } from '@bomberman/shared';

const DIRECTIONS: readonly string[] = ['up', 'down', 'left', 'right'];

interface Entry {
  direction: Direction | null;
  placeBomb: boolean;
  fireGun: boolean;
  swingHammer: boolean;
  pingMs: number | undefined;
}

/**
 * Latest-wins input storage with sticky action flags: a bomb/gun/hammer press
 * that arrives between ticks is OR-ed in and only cleared when a tick consumes
 * it, so a press can never be lost to a later "no action" message.
 */
export class InputBuffer {
  private readonly inputs = new Map<string, Entry>();

  /** Applies a raw (untrusted) client message; malformed messages are ignored. */
  set(playerId: string, message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const { direction, placeBomb, fireGun, swingHammer, pingMs } = message as {
      direction?: unknown;
      placeBomb?: unknown;
      fireGun?: unknown;
      swingHammer?: unknown;
      pingMs?: unknown;
    };
    const validDirection = direction === null || DIRECTIONS.includes(direction as string);
    if (!validDirection || typeof placeBomb !== 'boolean') return;
    // Skill flags are optional (older clients omit them); non-booleans are ignored.
    const gun = fireGun === true;
    const hammer = swingHammer === true;
    // Ping is optional and untrusted; a malformed value leaves the previous one.
    const ping =
      typeof pingMs === 'number' && Number.isFinite(pingMs) && pingMs >= 0 ? pingMs : undefined;

    const entry = this.inputs.get(playerId) ?? {
      direction: null,
      placeBomb: false,
      fireGun: false,
      swingHammer: false,
      pingMs: undefined,
    };
    entry.direction = direction as Direction | null;
    entry.placeBomb = entry.placeBomb || placeBomb;
    entry.fireGun = entry.fireGun || gun;
    entry.swingHammer = entry.swingHammer || hammer;
    if (ping !== undefined) entry.pingMs = ping;
    this.inputs.set(playerId, entry);
  }

  /** Snapshot for this tick; clears sticky action flags, keeps held directions. */
  consume(): Map<string, PlayerInput> {
    const snapshot = new Map<string, PlayerInput>();
    for (const [id, entry] of this.inputs) {
      snapshot.set(id, {
        direction: entry.direction,
        placeBomb: entry.placeBomb,
        fireGun: entry.fireGun,
        swingHammer: entry.swingHammer,
        pingMs: entry.pingMs,
      });
      entry.placeBomb = false;
      entry.fireGun = false;
      entry.swingHammer = false;
    }
    return snapshot;
  }

  remove(playerId: string): void {
    this.inputs.delete(playerId);
  }

  clear(): void {
    this.inputs.clear();
  }
}
