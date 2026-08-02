import { afterEach, describe, expect, it, vi } from 'vitest';
import { GamepadInput } from '../src/gamepad';

/** Minimal native Gamepad stand-in: only what GamepadInput reads. */
function fakePad(overrides: {
  index?: number;
  connected?: boolean;
  buttons?: Partial<Record<number, boolean>>;
  axes?: number[];
}): Gamepad {
  const buttons: { pressed: boolean }[] = [];
  for (let i = 0; i <= 15; i++) buttons[i] = { pressed: overrides.buttons?.[i] === true };
  return {
    index: overrides.index ?? 0,
    connected: overrides.connected ?? true,
    buttons,
    axes: overrides.axes ?? [0, 0],
  } as unknown as Gamepad;
}

function stubPads(pads: (Gamepad | null)[]): void {
  vi.stubGlobal('navigator', { getGamepads: () => pads });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GamepadInput', () => {
  it('reads a pad sitting at slot 1 behind a phantom null slot 0', () => {
    // Chrome routinely reports [null, pad] after a reconnect; slot holes must
    // never break polling (they crash Phaser's own GamepadPlugin on shutdown,
    // which is why this class reads the native API instead).
    stubPads([null, fakePad({ index: 1, buttons: { 15: true } })]);
    const input = new GamepadInput();
    input.poll(100);
    expect(input.heldDirections()).toEqual([['right', 100]]);
  });

  it('ignores disconnected pads', () => {
    stubPads([fakePad({ connected: false, buttons: { 12: true } })]);
    const input = new GamepadInput();
    input.poll(100);
    expect(input.heldDirections()).toEqual([]);
    expect(input.triggerHeld).toBe(false);
  });

  it('latches the trigger press edge until consumed, and tracks held state', () => {
    const pad = fakePad({ buttons: { 0: true } });
    stubPads([pad]);
    const input = new GamepadInput();
    input.poll(100);
    expect(input.triggerHeld).toBe(true);
    expect(input.consumeTriggerPress()).toBe(true);
    // Still held next frame: no new edge.
    input.poll(116);
    expect(input.consumeTriggerPress()).toBe(false);
    expect(input.triggerHeld).toBe(true);
  });

  it('clears held inputs when the pad disappears', () => {
    stubPads([fakePad({ buttons: { 13: true } })]);
    const input = new GamepadInput();
    input.poll(100);
    expect(input.heldDirections()).toEqual([['down', 100]]);
    stubPads([null]);
    input.poll(116);
    expect(input.heldDirections()).toEqual([]);
  });

  it('applies stick hysteresis: engages past 0.5, releases only below 0.35', () => {
    const input = new GamepadInput();
    stubPads([fakePad({ axes: [0.4, 0] })]);
    input.poll(100);
    expect(input.heldDirections()).toEqual([]); // below enter threshold
    stubPads([fakePad({ axes: [0.6, 0] })]);
    input.poll(116);
    expect(input.heldDirections()).toEqual([['right', 116]]);
    stubPads([fakePad({ axes: [0.4, 0] })]);
    input.poll(132);
    expect(input.heldDirections()).toEqual([['right', 116]]); // above exit: still held
    stubPads([fakePad({ axes: [0.3, 0] })]);
    input.poll(148);
    expect(input.heldDirections()).toEqual([]);
  });

  it('stamps a fresh press time when a direction re-engages', () => {
    const input = new GamepadInput();
    stubPads([fakePad({ buttons: { 14: true } })]);
    input.poll(100);
    stubPads([fakePad({})]);
    input.poll(116);
    stubPads([fakePad({ buttons: { 14: true } })]);
    input.poll(132);
    expect(input.heldDirections()).toEqual([['left', 132]]);
  });

  it('survives environments without getGamepads', () => {
    vi.stubGlobal('navigator', {});
    const input = new GamepadInput();
    input.poll(100);
    expect(input.heldDirections()).toEqual([]);
  });
});
