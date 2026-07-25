import type { Direction, PlayerInput } from '@bomberman/shared';

const DIRECTIONS: readonly string[] = ['up', 'down', 'left', 'right'];

/**
 * Latest-wins input storage with a sticky placeBomb flag: a bomb press that
 * arrives between ticks is OR-ed in and only cleared when a tick consumes it,
 * so a press can never be lost to a later "no bomb" message.
 */
export class InputBuffer {
  private readonly inputs = new Map<string, { direction: Direction | null; placeBomb: boolean }>();

  /** Applies a raw (untrusted) client message; malformed messages are ignored. */
  set(playerId: string, message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const { direction, placeBomb } = message as { direction?: unknown; placeBomb?: unknown };
    const validDirection = direction === null || DIRECTIONS.includes(direction as string);
    if (!validDirection || typeof placeBomb !== 'boolean') return;

    const entry = this.inputs.get(playerId) ?? { direction: null, placeBomb: false };
    entry.direction = direction as Direction | null;
    entry.placeBomb = entry.placeBomb || placeBomb;
    this.inputs.set(playerId, entry);
  }

  /** Snapshot for this tick; clears sticky bomb flags, keeps held directions. */
  consume(): Map<string, PlayerInput> {
    const snapshot = new Map<string, PlayerInput>();
    for (const [id, entry] of this.inputs) {
      snapshot.set(id, { direction: entry.direction, placeBomb: entry.placeBomb });
      entry.placeBomb = false;
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
