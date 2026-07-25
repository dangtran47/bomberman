import { describe, expect, it } from 'vitest';
import { InputBuffer } from '../src/rooms/inputBuffer';

/** Shorthand for the full snapshot shape (all action flags default to false). */
function snap(over: Partial<Record<string, unknown>> = {}) {
  return { direction: null, placeBomb: false, fireGun: false, swingHammer: false, ...over };
}

describe('InputBuffer', () => {
  it('stores the latest direction per player', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'up', placeBomb: false });
    buf.set('p0', { direction: 'left', placeBomb: false });
    expect(buf.consume().get('p0')).toEqual(snap({ direction: 'left' }));
  });

  it('placeBomb is sticky: a press is not lost by a later message without it', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: null, placeBomb: true });
    buf.set('p0', { direction: 'right', placeBomb: false });
    expect(buf.consume().get('p0')).toEqual(snap({ direction: 'right', placeBomb: true }));
  });

  it('fireGun and swingHammer are sticky like placeBomb', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: null, placeBomb: false, fireGun: true });
    buf.set('p0', { direction: null, placeBomb: false, swingHammer: true });
    buf.set('p0', { direction: 'up', placeBomb: false });
    expect(buf.consume().get('p0')).toEqual(
      snap({ direction: 'up', fireGun: true, swingHammer: true }),
    );
  });

  it('consume clears the sticky skill flags but keeps the held direction', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'down', placeBomb: true, fireGun: true, swingHammer: true });
    expect(buf.consume().get('p0')).toEqual(
      snap({ direction: 'down', placeBomb: true, fireGun: true, swingHammer: true }),
    );
    expect(buf.consume().get('p0')).toEqual(snap({ direction: 'down' }));
  });

  it('defaults the skill flags to false when a client omits them', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'up', placeBomb: false });
    expect(buf.consume().get('p0')).toEqual(snap({ direction: 'up' }));
  });

  it('ignores non-boolean skill flags without dropping the message', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'up', placeBomb: false, fireGun: 'yes', swingHammer: 1 } as never);
    expect(buf.consume().get('p0')).toEqual(snap({ direction: 'up' }));
  });

  it('ignores malformed messages without dropping valid state', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'up', placeBomb: true, fireGun: true });
    buf.set('p0', { direction: 'sideways', placeBomb: 'yes' } as never);
    buf.set('p0', null as never);
    expect(buf.consume().get('p0')).toEqual(snap({ direction: 'up', placeBomb: true, fireGun: true }));
  });

  it('accepts null direction (stop moving)', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'up', placeBomb: false });
    buf.set('p0', { direction: null, placeBomb: false });
    expect(buf.consume().get('p0')).toEqual(snap());
  });

  it('carries a valid pingMs into the consumed snapshot', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'up', placeBomb: false, pingMs: 120 });
    expect(buf.consume().get('p0')?.pingMs).toBe(120);
  });

  it('ignores a non-numeric pingMs and keeps direction usable', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'left', placeBomb: false, pingMs: 'oops' } as never);
    const s = buf.consume().get('p0');
    expect(s?.direction).toBe('left');
    expect(s?.pingMs).toBeUndefined();
  });

  it('keeps the last valid pingMs when a later message omits it', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'up', placeBomb: false, pingMs: 80 });
    buf.set('p0', { direction: 'up', placeBomb: false });
    expect(buf.consume().get('p0')?.pingMs).toBe(80);
  });

  it('remove drops the player entirely', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'up', placeBomb: true });
    buf.remove('p0');
    expect(buf.consume().has('p0')).toBe(false);
  });

  it('clear empties the whole buffer', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'up', placeBomb: true });
    buf.set('p1', { direction: 'down', placeBomb: false });
    buf.clear();
    expect(buf.consume().size).toBe(0);
  });
});
