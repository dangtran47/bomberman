import { describe, expect, it } from 'vitest';
import { PING_CAP_MS, TICK_RATE } from '@bomberman/shared';
import { InputQueue } from '../src/rooms/inputQueue';

/** Mirrors the queue's internal cap: 250ms worth of ticks. */
const MAX_QUEUE = Math.round(0.25 * TICK_RATE);

const msg = (seq: number, direction: string | null = 'right', extra = {}) => ({
  seq,
  direction,
  placeBomb: false,
  ...extra,
});

describe('InputQueue', () => {
  it('consumes exactly one queued input per tick, in order, and acks its seq', () => {
    const q = new InputQueue();
    q.push('p0', msg(1, 'right'));
    q.push('p0', msg(2, 'down'));
    expect(q.consume().get('p0')).toMatchObject({ direction: 'right' });
    expect(q.acked('p0')).toBe(1);
    expect(q.consume().get('p0')).toMatchObject({ direction: 'down' });
    expect(q.acked('p0')).toBe(2);
  });

  it('gives the player no input on a dry tick (stall pauses the hold), ack unchanged', () => {
    const q = new InputQueue();
    q.push('p0', msg(1, 'left', { placeBomb: true }));
    q.consume();
    // Nothing arrived for this tick: the sim must not move the player, because
    // the client never predicted a tick here. Repeating the last direction
    // would invent movement the client has to be rebased over once the stalled
    // inputs land.
    expect(q.consume().has('p0')).toBe(false);
    expect(q.acked('p0')).toBe(1);
  });

  it('applies exactly the sent inputs across a stall: hold length is reproduced, not stretched', () => {
    const q = new InputQueue();
    q.push('p0', msg(1, 'right'));
    q.consume();
    // TCP stall: six ticks pass with nothing queued.
    for (let i = 0; i < 6; i++) expect(q.consume().has('p0')).toBe(false);
    // The burst lands; each queued input is applied once, in order.
    for (let s = 2; s <= 6; s++) q.push('p0', msg(s, 'right'));
    let moved = 0;
    for (let s = 2; s <= 6; s++) {
      expect(q.consume().get('p0')).toMatchObject({ direction: 'right' });
      expect(q.acked('p0')).toBe(s);
      moved++;
    }
    expect(moved).toBe(5);
    expect(q.consume().has('p0')).toBe(false);
  });

  it('rejects stale and duplicate seqs', () => {
    const q = new InputQueue();
    q.push('p0', msg(5));
    q.push('p0', msg(5, 'down'));
    q.push('p0', msg(3, 'up'));
    q.consume();
    expect(q.acked('p0')).toBe(5);
    // Both later pushes were dropped: next consume is a dry tick, not 'down'/'up'.
    expect(q.consume().has('p0')).toBe(false);
    expect(q.acked('p0')).toBe(5);
  });

  it('caps the backlog at 250ms of ticks, dropping the oldest; ack skips dropped seqs', () => {
    const q = new InputQueue();
    for (let s = 1; s <= MAX_QUEUE + 2; s++) q.push('p0', msg(s, s % 2 ? 'up' : 'down'));
    expect(q.consume().get('p0')).toMatchObject({ direction: 'up' }); // seq 3 (1, 2 dropped)
    expect(q.acked('p0')).toBe(3);
  });

  it('forwards pingMs with the consumed input, clamped to PING_CAP_MS', () => {
    const q = new InputQueue();
    q.push('p0', msg(1, 'right', { pingMs: 120 }));
    q.push('p0', msg(2, 'right', { pingMs: 99999 })); // lying client
    expect(q.consume().get('p0')).toMatchObject({ pingMs: 120 });
    expect(q.consume().get('p0')).toMatchObject({ pingMs: PING_CAP_MS });
  });

  it('drops an invalid pingMs but keeps the input', () => {
    const q = new InputQueue();
    q.push('p0', msg(1, 'up', { pingMs: 'fast' }));
    q.push('p0', msg(2, 'up', { pingMs: -50 }));
    q.push('p0', msg(3, 'up', { pingMs: Number.NaN }));
    for (let i = 0; i < 3; i++) {
      const input = q.consume().get('p0')!;
      expect(input.direction).toBe('up');
      expect(input.pingMs).toBeUndefined();
    }
  });

  it('treats a message without seq as legacy latest-wins with sticky actions', () => {
    const q = new InputQueue();
    q.push('p0', { direction: 'right', placeBomb: true });
    q.push('p0', { direction: 'down', placeBomb: false });
    expect(q.consume().get('p0')).toMatchObject({ direction: 'down', placeBomb: true });
    expect(q.consume().get('p0')).toMatchObject({ direction: 'down', placeBomb: false });
    expect(q.acked('p0')).toBe(0);
  });

  it('carries placeMine through the queue alongside the other skill flags', () => {
    const q = new InputQueue();
    q.push('p0', msg(1, 'up', { fireGun: true, swingHammer: true, placeMine: true }));
    q.push('p0', msg(2, 'up'));
    expect(q.consume().get('p0')).toMatchObject({
      fireGun: true,
      swingHammer: true,
      placeMine: true,
    });
    expect(q.consume().get('p0')).toMatchObject({ placeMine: false });
  });

  it('keeps a legacy placeMine press sticky until a tick consumes it', () => {
    const q = new InputQueue();
    q.push('p0', { direction: 'right', placeBomb: false, placeMine: true });
    q.push('p0', { direction: 'down', placeBomb: false });
    expect(q.consume().get('p0')).toMatchObject({ direction: 'down', placeMine: true });
    expect(q.consume().get('p0')).toMatchObject({ direction: 'down', placeMine: false });
  });

  it('ignores non-boolean placeMine without dropping the message', () => {
    const q = new InputQueue();
    q.push('p0', msg(1, 'up', { placeMine: 'yes' }));
    expect(q.consume().get('p0')).toMatchObject({ direction: 'up', placeMine: false });
  });

  it('ignores malformed messages', () => {
    const q = new InputQueue();
    q.push('p0', null);
    q.push('p0', { seq: 1, direction: 'diagonal', placeBomb: false });
    q.push('p0', { seq: 1, direction: 'up', placeBomb: 'yes' });
    expect(q.consume().size).toBe(0);
  });

  it('remove drops the player entirely', () => {
    const q = new InputQueue();
    q.push('p0', msg(1));
    q.remove('p0');
    expect(q.consume().has('p0')).toBe(false);
    expect(q.acked('p0')).toBe(0);
  });

  it('clear empties the whole queue', () => {
    const q = new InputQueue();
    q.push('p0', msg(1));
    q.push('p1', msg(1, 'down'));
    q.clear();
    expect(q.consume().size).toBe(0);
  });
});
