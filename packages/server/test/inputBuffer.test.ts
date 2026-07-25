import { describe, expect, it } from 'vitest';
import { InputBuffer } from '../src/rooms/inputBuffer';

describe('InputBuffer', () => {
  it('stores the latest direction per player', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'up', placeBomb: false });
    buf.set('p0', { direction: 'left', placeBomb: false });
    expect(buf.consume().get('p0')).toEqual({ direction: 'left', placeBomb: false });
  });

  it('placeBomb is sticky: a press is not lost by a later message without it', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: null, placeBomb: true });
    buf.set('p0', { direction: 'right', placeBomb: false });
    expect(buf.consume().get('p0')).toEqual({ direction: 'right', placeBomb: true });
  });

  it('consume clears placeBomb but keeps the held direction', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'down', placeBomb: true });
    buf.consume();
    expect(buf.consume().get('p0')).toEqual({ direction: 'down', placeBomb: false });
  });

  it('ignores malformed messages without dropping valid state', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'up', placeBomb: true });
    buf.set('p0', { direction: 'sideways', placeBomb: 'yes' } as never);
    buf.set('p0', null as never);
    expect(buf.consume().get('p0')).toEqual({ direction: 'up', placeBomb: true });
  });

  it('accepts null direction (stop moving)', () => {
    const buf = new InputBuffer();
    buf.set('p0', { direction: 'up', placeBomb: false });
    buf.set('p0', { direction: null, placeBomb: false });
    expect(buf.consume().get('p0')).toEqual({ direction: null, placeBomb: false });
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
