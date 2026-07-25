# Latency-Scaled Turn Grace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop players overshooting the tile they mean to turn on in online/room mode, by giving the authoritative sim a latency-scaled trailing-side grace when committing a turn.

**Architecture:** The overshoot is late-arriving perpendicular input snapping *forward* to the next tile in `laneAhead`. Add a per-player `turnGrace` (tiles) computed each tick from the player's reported ping and speed; on a turn onset, if the player passed the last junction by ≤ `turnGrace`, snap the perpendicular coordinate *back* onto that junction and commit the turn there. Ping is measured on the client and reported in the `input` message; offline play and bots report no ping, so grace is 0 and behavior is unchanged.

**Tech Stack:** TypeScript monorepo (pnpm workspaces), Vitest for the shared sim, Colyseus server, Phaser client.

## Global Constraints

- `TICK_RATE = 20` ticks/sec; per-tick move budget is `player.speed / TICK_RATE`.
- `BASE_SPEED = 3` tiles/sec.
- `EPS = 1e-9` (float-alignment tolerance in `game.ts`).
- `GRACE_CAP = 0.45` tile — grace must never reach the next junction center (0.5).
- `PING_CAP_MS = 400` — clamp reported ping before use.
- Determinism: grace derives only from the input payload + player state, so identical input streams replay identically. Do not read wall-clock time in the sim.
- Offline/bot parity: any code path where `pingMs` is absent MUST yield `turnGrace = 0` and behave byte-identically to today.

---

### Task 1: Types, constants, and player-field foundation

Adds the data the later tasks depend on. No behavior change yet; the sim ignores the new field until Task 2.

**Files:**
- Modify: `packages/shared/src/types.ts` (PlayerInput, Player)
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/game.ts:187-208` (player init)

**Interfaces:**
- Produces: `PlayerInput.pingMs?: number`; `Player.turnGrace: number`; `GRACE_CAP` and `PING_CAP_MS` constants exported from `constants.ts`.

- [ ] **Step 1: Add the ping field to `PlayerInput`**

In `packages/shared/src/types.ts`, extend the interface:

```typescript
export interface PlayerInput {
  direction: Direction | null;
  placeBomb: boolean;
  fireGun?: boolean; // optional: sources that never use the skills omit these
  swingHammer?: boolean;
  pingMs?: number; // round-trip time reported by the client; absent for bots/offline
}
```

- [ ] **Step 2: Add `turnGrace` to `Player`**

In `packages/shared/src/types.ts`, add after `laneDir`:

```typescript
  laneDir: Direction | null; // direction that pulled the player off-lane; the corner slide follows it
  turnGrace: number; // tiles of trailing-side latitude when committing a turn this tick; 0 offline
  deathTick: number | null; // null while alive/survivor
```

- [ ] **Step 3: Add the constants**

In `packages/shared/src/constants.ts`, after `BASE_SPEED`:

```typescript
export const GRACE_CAP = 0.45; // max turn grace (tiles); below 0.5 so it never crosses to the next junction
export const PING_CAP_MS = 400; // clamp reported ping before deriving turn grace
```

- [ ] **Step 4: Initialize `turnGrace` in `createGame`**

In `packages/shared/src/game.ts`, in the player literal (~line 206):

```typescript
        laneDir: null,
        turnGrace: 0,
        deathTick: null,
```

- [ ] **Step 5: Type-check and run the shared suite**

Run: `pnpm --filter @bomberman/shared test`
Expected: PASS (no behavior change; new field defaults ensure existing tests are unaffected). If other packages construct a `Player` literal, the compiler will flag the missing `turnGrace` — add `turnGrace: 0` at each site.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/constants.ts packages/shared/src/game.ts
git commit -m "feat(shared): turnGrace player field + PlayerInput.pingMs foundation"
```

---

### Task 2: Turn-grace snap-back in the sim (core fix)

Computes `turnGrace` each tick and uses it to snap a turn back onto the junction just crossed.

**Files:**
- Modify: `packages/shared/src/game.ts` — `tick()` loop (~226–242) and `movePlayer()` (~477–483)
- Test: `packages/shared/test/turnGrace.test.ts` (create)

**Interfaces:**
- Consumes: `PlayerInput.pingMs`, `Player.turnGrace`, `GRACE_CAP`, `PING_CAP_MS`, `TICK_RATE`, `EPS`, `canEnter`.
- Produces: turn-onset snap behavior; no new exported API.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/turnGrace.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/game';
import type { Game } from '../src/game';
import { GRID_HEIGHT, GRID_WIDTH } from '../src/constants';
import { TileType } from '../src/types';
import type { PlayerInput } from '../src/types';

function openGrid(): TileType[][] {
  return Array.from({ length: GRID_HEIGHT }, () =>
    Array<TileType>(GRID_WIDTH).fill(TileType.Floor),
  );
}

function game(): Game {
  return createGame({ seed: 1, playerIds: ['p1', 'p2'], grid: openGrid() });
}

function p1(g: Game) {
  const p = g.state.players.find((x) => x.id === 'p1');
  if (!p) throw new Error('no p1');
  return p;
}

// Player moving right, just past column 5 (x=5.3), on row 7. A turn 'up' arrives
// with 200ms ping -> grace = min(0.45, 3 * 0.1) = 0.3, which covers the 0.3
// overshoot, so x snaps back to 5 and the player moves up instead of overshooting.
const up = (pingMs: number): PlayerInput => ({ direction: 'up', placeBomb: false, pingMs });

describe('turn grace', () => {
  it('snaps the turn back onto the junction when within ping-scaled grace', () => {
    const g = game();
    const p = p1(g);
    p.x = 5.3;
    p.y = 7;
    p.laneDir = 'right';
    g.tick({ p1: up(200) });
    expect(p.x).toBeCloseTo(5, 6); // snapped back to the junction column
    expect(p.y).toBeLessThan(7); // moved up this tick
  });

  it('does not snap when the overshoot exceeds grace (bounded by GRACE_CAP)', () => {
    const g = game();
    const p = p1(g);
    p.x = 5.4; // 0.4 past the junction
    p.y = 7;
    p.laneDir = 'right';
    g.tick({ p1: up(200) }); // grace 0.3 < 0.4
    expect(p.x).toBeGreaterThan(5.4); // slides forward toward column 6 (overshoot path intact)
    expect(p.y).toBeCloseTo(7, 6); // has not turned up yet
  });

  it('is inert offline (no pingMs -> grace 0 -> forward slide unchanged)', () => {
    const g = game();
    const p = p1(g);
    p.x = 5.3;
    p.y = 7;
    p.laneDir = 'right';
    g.tick({ p1: { direction: 'up', placeBomb: false } }); // no pingMs
    expect(p.x).toBeGreaterThan(5.3); // slides forward toward column 6
    expect(p.y).toBeCloseTo(7, 6);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bomberman/shared test turnGrace`
Expected: FAIL — the first test's `p.x` is ~5.45 (forward slide), not 5.

- [ ] **Step 3: Compute `turnGrace` in the tick loop**

In `packages/shared/src/game.ts`, add the import (extend the existing `constants` import block near the top):

```typescript
import {
  // ...existing named imports...
  GRACE_CAP,
  PING_CAP_MS,
} from './constants';
```

Then inside `tick()`, in the per-player loop, set `turnGrace` before `stepPlayer` (right after `const input = readInput(inputs, player.id);` at ~line 226):

```typescript
      const input = readInput(inputs, player.id);
      // Latency-scaled turn latitude: how far the player expects to have drifted
      // past a junction while their turn was in flight. 0 offline (no ping).
      const oneWaySec = Math.min(input.pingMs ?? 0, PING_CAP_MS) / 2 / 1000;
      player.turnGrace = Math.min(GRACE_CAP, player.speed * oneWaySec);
```

- [ ] **Step 4: Add the snap-back guard in `movePlayer`**

In `packages/shared/src/game.ts`, inside `movePlayer`, right after `const perp = horizontal ? player.y : player.x;` (~line 481, before `const lane = this.laneAhead(...)`):

```typescript
    const perp = horizontal ? player.y : player.x;
    // Turn onset: the new direction is perpendicular to the lane we were
    // committed to. If a latency budget says we only just overran the junction,
    // snap the perpendicular coordinate back onto it and turn there instead of
    // sliding forward to the next tile (the overshoot players feel online).
    if (player.turnGrace > EPS && player.laneDir !== null && player.laneDir !== direction) {
      const leavingHorizontally = player.laneDir === 'left' || player.laneDir === 'right';
      if (leavingHorizontally !== horizontal) {
        const junction = Math.round(perp);
        const offset = Math.abs(junction - perp);
        if (offset > EPS && offset <= player.turnGrace + EPS) {
          const col = horizontal ? Math.round(player.x) : junction;
          const row = horizontal ? junction : Math.round(player.y);
          if (this.canEnter(col, row)) {
            if (horizontal) player.y = junction;
            else player.x = junction;
          }
        }
      }
    }
    const lane = this.laneAhead(player, horizontal ? player.y : player.x, horizontal);
```

Note: `lane` is recomputed from the (possibly snapped) coordinate, so the rest of `movePlayer` sees an aligned player and moves straight in `direction`. `perp` is still used below for the `dist` check — after a snap, `perp` and the coordinate agree at the junction, so `dist ≈ 0`.

Correction for the existing line: the original `const lane = this.laneAhead(player, perp, horizontal);` must be replaced by the recomputed form above (reading the coordinate fresh) OR reassign `perp` after the snap. Reassign is cleaner — change the block to set a mutable `perp`:

```typescript
    let perp = horizontal ? player.y : player.x;
    if (player.turnGrace > EPS && player.laneDir !== null && player.laneDir !== direction) {
      const leavingHorizontally = player.laneDir === 'left' || player.laneDir === 'right';
      if (leavingHorizontally !== horizontal) {
        const junction = Math.round(perp);
        const offset = Math.abs(junction - perp);
        if (offset > EPS && offset <= player.turnGrace + EPS) {
          const col = horizontal ? Math.round(player.x) : junction;
          const row = horizontal ? junction : Math.round(player.y);
          if (this.canEnter(col, row)) {
            if (horizontal) player.y = junction;
            else player.x = junction;
            perp = junction;
          }
        }
      }
    }
    const lane = this.laneAhead(player, perp, horizontal);
```

Use this second form. Change `const perp` on the original line to `let perp` and insert the guard before the `laneAhead` call.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @bomberman/shared test turnGrace`
Expected: PASS (all three).

- [ ] **Step 6: Run the full shared suite for regressions**

Run: `pnpm --filter @bomberman/shared test`
Expected: PASS — existing movement/kick/ice tests unaffected (they pass no `pingMs`, so `turnGrace` stays 0 and the guard never fires).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/game.ts packages/shared/test/turnGrace.test.ts
git commit -m "feat(shared): latency-scaled turn-grace snap-back on turn onset"
```

---

### Task 3: Server carries ping through the input buffer

The buffer must accept and forward the client's reported ping so the sim sees it.

**Files:**
- Modify: `packages/server/src/rooms/inputBuffer.ts`
- Test: `packages/server/test/inputBuffer.test.ts` (create; if the server package has no test runner wired, fold this verification into Task 2's sim tests instead and skip Steps 1–2 here — see Step 0)

**Interfaces:**
- Consumes: `PlayerInput.pingMs` (Task 1).
- Produces: `InputBuffer.consume()` snapshots include `pingMs` when a valid one was last set.

- [ ] **Step 0: Confirm the server test setup**

Run: `pnpm --filter @bomberman/server test -- --run 2>&1 | head -20`
If Vitest runs, proceed with Steps 1–2. If the server has no test script, skip Steps 1–2, implement Steps 3–4, and rely on the manual check in Task 4 Step 4 plus the passing sim tests.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/inputBuffer.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { InputBuffer } from '../src/rooms/inputBuffer';

describe('InputBuffer ping', () => {
  it('carries a valid pingMs into the consumed snapshot', () => {
    const buf = new InputBuffer();
    buf.set('p1', { direction: 'up', placeBomb: false, pingMs: 120 });
    const snap = buf.consume();
    expect(snap.get('p1')?.pingMs).toBe(120);
  });

  it('ignores a non-numeric pingMs and keeps direction usable', () => {
    const buf = new InputBuffer();
    buf.set('p1', { direction: 'left', placeBomb: false, pingMs: 'oops' });
    const snap = buf.consume();
    expect(snap.get('p1')?.direction).toBe('left');
    expect(snap.get('p1')?.pingMs).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @bomberman/server test inputBuffer`
Expected: FAIL — `pingMs` is `undefined` (not yet stored).

- [ ] **Step 3: Store `pingMs` on the entry**

In `packages/server/src/rooms/inputBuffer.ts`:

Extend `Entry`:

```typescript
interface Entry {
  direction: Direction | null;
  placeBomb: boolean;
  fireGun: boolean;
  swingHammer: boolean;
  pingMs: number | undefined;
}
```

In `set()`, destructure and validate `pingMs`, then store it (latest-wins; malformed leaves the previous value). Replace the destructure and the entry-build:

```typescript
    const { direction, placeBomb, fireGun, swingHammer, pingMs } = message as {
      direction?: unknown;
      placeBomb?: unknown;
      fireGun?: unknown;
      swingHammer?: unknown;
      pingMs?: unknown;
    };
    const validDirection = direction === null || DIRECTIONS.includes(direction as string);
    if (!validDirection || typeof placeBomb !== 'boolean') return;
    const gun = fireGun === true;
    const hammer = swingHammer === true;
    const ping = typeof pingMs === 'number' && Number.isFinite(pingMs) && pingMs >= 0 ? pingMs : undefined;

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
```

In `consume()`, include `pingMs` in the snapshot object:

```typescript
      snapshot.set(id, {
        direction: entry.direction,
        placeBomb: entry.placeBomb,
        fireGun: entry.fireGun,
        swingHammer: entry.swingHammer,
        pingMs: entry.pingMs,
      });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @bomberman/server test inputBuffer`
Expected: PASS. (If Step 0 skipped tests, run `pnpm --filter @bomberman/server build` / `tsc --noEmit` to confirm it type-checks.)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/rooms/inputBuffer.ts packages/server/test/inputBuffer.test.ts
git commit -m "feat(server): forward client pingMs through the input buffer"
```

---

### Task 4: Client reports its ping in the input message

The last wire: the client already measures RTT as `this.pingMs`; send it.

**Files:**
- Modify: `packages/client/src/scenes/GameScene.ts:661-666` (the `room.send('input', ...)` payload)

**Interfaces:**
- Consumes: `this.pingMs` (already set in the `pong` handler).
- Produces: `input` messages carry `pingMs`, consumed by Task 3.

- [ ] **Step 1: Add `pingMs` to the input payload**

In `packages/client/src/scenes/GameScene.ts`, in `updateOnline`'s `room.send('input', {...})`:

```typescript
      room.send('input', {
        direction,
        placeBomb: bombHeld,
        fireGun: this.pendingGun,
        swingHammer: this.pendingHammer,
        pingMs: this.pingMs ?? 0,
      });
```

- [ ] **Step 2: Type-check the client**

Run: `pnpm --filter @bomberman/client build`
Expected: PASS (or `tsc --noEmit` if that's the project's check).

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/scenes/GameScene.ts
git commit -m "feat(client): report measured ping in the input message"
```

- [ ] **Step 4: Manual end-to-end check**

Run the app (`/run` or the project's dev command), create a room, and drive a player through a corridor turn. With simulated latency (browser devtools network throttling, or a high real ping), the turn should land on the intended tile instead of overshooting to the next junction. In bot/offline mode, movement should feel identical to before this change.

---

## Notes for the implementer

- The whole feature is inert unless a `pingMs` reaches the sim. Bots (`bot.ts computeInput`) and the offline client build inputs without it, so `turnGrace` stays 0 and every existing code path is unchanged — this is the offline-parity guarantee, verified by Task 2 Step 3's third test.
- `turnGrace` is transient (recomputed every tick before use); it is not synced to clients and needs no `copySimToSchema` handling.
- Do not widen `GRACE_CAP` to ≥ 0.5 — at 0.5 a snap could target the wrong junction, and the "which junction did they mean" invariant breaks.
