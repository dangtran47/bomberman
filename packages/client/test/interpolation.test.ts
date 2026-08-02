import { describe, expect, it } from 'vitest';
import { SnapshotBuffer } from '../src/interpolation';

const snap = (x: number, y: number) => new Map([['p1', { x, y }]]);

describe('SnapshotBuffer', () => {
  it('lerps between the two snapshots bracketing renderT', () => {
    const buf = new SnapshotBuffer();
    buf.push(1000, snap(2, 5));
    buf.push(1050, snap(3, 5));
    expect(buf.sample('p1', 1025)).toEqual({ x: 2.5, y: 5 });
  });

  it('clamps to the newest snapshot when renderT is ahead of the buffer', () => {
    const buf = new SnapshotBuffer();
    buf.push(1000, snap(2, 5));
    expect(buf.sample('p1', 1200)).toEqual({ x: 2, y: 5 });
  });

  it('clamps to the oldest snapshot when renderT is behind the buffer', () => {
    const buf = new SnapshotBuffer();
    buf.push(1000, snap(2, 5));
    buf.push(1050, snap(3, 5));
    expect(buf.sample('p1', 900)).toEqual({ x: 2, y: 5 });
  });

  it('returns null for a player with no samples', () => {
    const buf = new SnapshotBuffer();
    buf.push(1000, snap(2, 5));
    expect(buf.sample('nope', 1000)).toBeNull();
  });

  it('bridges a player missing from a middle snapshot (skips it)', () => {
    const buf = new SnapshotBuffer();
    buf.push(1000, snap(2, 5));
    buf.push(1050, new Map()); // patch without this player
    buf.push(1100, snap(4, 5));
    expect(buf.sample('p1', 1050)).toEqual({ x: 3, y: 5 });
  });
});
