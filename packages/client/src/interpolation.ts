/** Remote players render this far in the past, so two 20Hz snapshots bracket the render time. */
export const INTERP_DELAY_MS = 100;
/** Drop snapshots older than this; generous slack over the render delay. */
const MAX_AGE_MS = 1000;

interface Sample {
  t: number;
  x: number;
  y: number;
}

/**
 * Per-player time-stamped position history. Remote sprites sample it at
 * (now - INTERP_DELAY_MS), lerping between the two bracketing samples —
 * smooth, frame-rate independent, and true to the server's trajectory,
 * unlike the exponential lerp this replaces (which never settled and lagged
 * by a frame-rate-dependent amount).
 */
export class SnapshotBuffer {
  private readonly samples = new Map<string, Sample[]>();

  push(t: number, players: Map<string, { x: number; y: number }>): void {
    for (const [id, pos] of players) {
      let list = this.samples.get(id);
      if (!list) {
        list = [];
        this.samples.set(id, list);
      }
      list.push({ t, x: pos.x, y: pos.y });
      const cutoff = t - MAX_AGE_MS;
      while (list.length > 2 && list[0].t < cutoff) list.shift();
    }
  }

  /** Position at renderT (typically now - INTERP_DELAY_MS); null if id unseen. */
  sample(id: string, renderT: number): { x: number; y: number } | null {
    const list = this.samples.get(id);
    if (!list || list.length === 0) return null;
    if (renderT <= list[0].t) return { x: list[0].x, y: list[0].y };
    const last = list[list.length - 1];
    if (renderT >= last.t) return { x: last.x, y: last.y };
    for (let i = 1; i < list.length; i++) {
      if (list[i].t >= renderT) {
        const a = list[i - 1];
        const b = list[i];
        const f = (renderT - a.t) / (b.t - a.t);
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }
    return { x: last.x, y: last.y };
  }
}
