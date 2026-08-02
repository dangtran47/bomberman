import type { Direction } from '@bomberman/shared';

/**
 * Xbox-layout gamepad input, mapped onto the two controls the keyboard already
 * exposes: a direction (D-pad or left stick) and the single trigger that Space
 * owns — A places bombs, fires the gun and swings the hammer, whichever the
 * player currently holds.
 *
 * Reads navigator.getGamepads() directly instead of Phaser's GamepadPlugin:
 * the plugin keeps its pads in an array indexed by the browser's pad index, and
 * a pad sitting at slot 1+ (reconnect, phantom device at 0) leaves a hole that
 * crashes the plugin's own shutdown (`gamepads[0].removeAllListeners`), wedging
 * every scene transition. The native API is poll-only and has no such state.
 *
 * Browsers only reveal a pad once it sends its first input, so an already
 * plugged-in controller stays invisible until a button is pressed. Everything
 * here degrades to "no pad": the keyboard path is untouched.
 */

/** Standard-layout button indices (Xbox: A, then the D-pad). */
const BUTTON_TRIGGER = 0;
const DPAD: Record<Direction, number> = { up: 12, down: 13, left: 14, right: 15 };

/**
 * Left stick thresholds. A direction engages past ENTER and only drops below
 * EXIT, so stick jitter around one threshold cannot re-stamp its press time and
 * hijack the last-pressed-wins ordering.
 */
const STICK_ENTER = 0.5;
const STICK_EXIT = 0.35;

const DIRECTIONS: Direction[] = ['up', 'down', 'left', 'right'];

export class GamepadInput {
  private readonly held: Record<Direction, boolean> = {
    up: false,
    down: false,
    left: false,
    right: false,
  };
  /**
   * When each held direction was engaged, on the same clock as
   * `Phaser.Input.Keyboard.Key.timeDown`, so both sources sort together.
   */
  private readonly pressedAt: Record<Direction, number> = { up: 0, down: 0, left: 0, right: 0 };
  /** Mirrors `Key.isDown` for the trigger button. */
  triggerHeld = false;
  /** Latched press edge, consumed like `Keyboard.JustDown`. */
  private triggerPressed = false;

  /** Reads the pad. Call exactly once per frame, before the getters below. */
  poll(now: number): void {
    // First connected pad, whatever slot it landed in: Chrome hands out the
    // browser's own index, and a real Xbox pad routinely shows up at 1+ (a
    // reconnect, or a phantom device holding slot 0), where slot 0 is null.
    const pad = navigator.getGamepads?.().find((p): p is Gamepad => p !== null && p.connected);
    if (!pad) {
      this.clear();
      return;
    }

    const x = pad.axes[0] ?? 0;
    const y = pad.axes[1] ?? 0;
    for (const dir of DIRECTIONS) {
      const down = pad.buttons[DPAD[dir]]?.pressed === true || this.stickHolds(dir, x, y);
      if (down && !this.held[dir]) this.pressedAt[dir] = now;
      this.held[dir] = down;
    }

    const trigger = pad.buttons[BUTTON_TRIGGER]?.pressed === true;
    if (trigger && !this.triggerHeld) this.triggerPressed = true;
    this.triggerHeld = trigger;
  }

  /** Held directions with their press times, for last-pressed-wins merging. */
  heldDirections(): [Direction, number][] {
    return DIRECTIONS.filter((dir) => this.held[dir]).map((dir) => [dir, this.pressedAt[dir]]);
  }

  /** Consumes this frame's trigger press edge. */
  consumeTriggerPress(): boolean {
    const pressed = this.triggerPressed;
    this.triggerPressed = false;
    return pressed;
  }

  /** Hysteresis: the exit threshold applies only while the direction is held. */
  private stickHolds(dir: Direction, x: number, y: number): boolean {
    const threshold = this.held[dir] ? STICK_EXIT : STICK_ENTER;
    switch (dir) {
      case 'up':
        return y <= -threshold;
      case 'down':
        return y >= threshold;
      case 'left':
        return x <= -threshold;
      case 'right':
        return x >= threshold;
    }
  }

  /** Drops every held input (pad unplugged, or not yet visible to the browser). */
  private clear(): void {
    for (const dir of DIRECTIONS) this.held[dir] = false;
    this.triggerHeld = false;
  }
}
