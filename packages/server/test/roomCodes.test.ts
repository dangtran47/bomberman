import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearRoomCodes,
  generateCode,
  lookupRoomId,
  registerRoomCode,
  releaseRoomCode,
} from '../src/roomCodes';

describe('generateCode', () => {
  it('produces 4 uppercase A-Z characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCode()).toMatch(/^[A-Z]{4}$/);
    }
  });

  it('maps the random source deterministically onto the alphabet', () => {
    expect(generateCode(() => 0)).toBe('AAAA');
    expect(generateCode(() => 0.999999)).toBe('ZZZZ');
  });
});

describe('room code registry', () => {
  beforeEach(() => clearRoomCodes());

  it('registers a code and resolves it to the roomId', () => {
    const code = registerRoomCode('room-1');
    expect(lookupRoomId(code)).toBe('room-1');
  });

  it('lookup is case-insensitive', () => {
    const code = registerRoomCode('room-1');
    expect(lookupRoomId(code.toLowerCase())).toBe('room-1');
  });

  it('returns undefined for unknown codes', () => {
    expect(lookupRoomId('XXXX')).toBeUndefined();
  });

  it('retries on collision until an unused code is found', () => {
    // Random source yields the same code twice, then a different one.
    const rolls = [0, 0, 0, 0, /* second attempt collides again */ 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5];
    let i = 0;
    const random = () => rolls[Math.min(i++, rolls.length - 1)];
    const first = registerRoomCode('room-1', random);
    expect(first).toBe('AAAA');
    const second = registerRoomCode('room-2', random);
    expect(second).not.toBe('AAAA');
    expect(lookupRoomId(first)).toBe('room-1');
    expect(lookupRoomId(second)).toBe('room-2');
  });

  it('release frees the code for reuse', () => {
    const code = registerRoomCode('room-1', () => 0);
    releaseRoomCode(code);
    expect(lookupRoomId(code)).toBeUndefined();
    expect(registerRoomCode('room-2', () => 0)).toBe(code);
  });
});
