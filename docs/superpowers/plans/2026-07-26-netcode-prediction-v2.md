# Netcode Prediction v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministic, low-latency, smooth online movement: per-tick sequenced inputs, client-side prediction with rebase+replay, snapshot interpolation for remote players, and a walk bob.

**Architecture:** The shared sim's movement code is extracted into pure functions so the client predictor and server run byte-identical logic. The client runs its own player on a 20Hz fixed-step loop, sending one sequence-numbered input per step; the server queues inputs per player and consumes exactly one per tick (held duration in ticks is therefore preserved exactly — this is what fixes "same hold, different distance"). The server acks the last processed seq per player; the client rebases onto server state and replays unacked inputs. Remote players render via a time-delayed snapshot interpolation buffer instead of exponential lerp.

**Tech Stack:** TypeScript monorepo (npm workspaces), Phaser 3 client, Colyseus 0.15 server, Vitest.

**Background:** Root-cause analysis and an approved spec exist:
- Spec (from unmerged branch): `git show 374fe6e:docs/superpowers/specs/2026-07-24-netcode-prediction-design.md`
- Roadmap: `docs/superpowers/plans/2026-07-25-latency-reduction.md` (items #2, #3)
- Reference implementation (STALE — main has since gained ice/laneDir/turnGrace/kick movement): branch tip `71fd117` (`prediction.ts`, `inputBuffer.ts` rework, tests). Port ideas, not diffs.

## Global Constraints

- `TICK_RATE = 20`, `TICK_MS = 50` — unchanged.
- Existing shared tests must pass unchanged in Tasks 1–2 (behavior-preserving refactor).
- turnGrace becomes inert (no `pingMs` in the new input path → `player.turnGrace = 0`). Do NOT delete the turnGrace code in this series.
- The sim's `PlayerInput`/`Player` types in `packages/shared/src/types.ts` keep their shapes; the wire protocol adds `seq` outside the sim types.
- Old-client compat: an input message without a numeric `seq` uses a legacy latest-wins path. Old-server compat: a client seeing no `lastInputSeq` field on its own player renders without prediction.
- Run tests with `npm test --workspace=@bomberman/shared` (and `server`, `client`). Note (from memory): if exit codes matter in hooks, call `node_modules/.bin/vitest` directly.
- Commit messages: conventional commits, normal prose (no caveman).

---

### Task 1: Extract shared movement into pure functions

**Files:**
- Create: `packages/shared/src/movement.ts`
- Modify: `packages/shared/src/game.ts` (delete private movement methods, delegate)
- Modify: `packages/shared/src/index.ts` (export new module)
- Test: `packages/shared/test/movement.test.ts` (new); ALL existing shared tests must pass unchanged.

**Interfaces:**
- Produces (consumed by Tasks 3, 4):

```ts
export interface MovementPlayer {
  x: number; y: number; speed: number;
  kickTicks: number;
  momentumDir: Direction | null; momentumTicks: number; turnTicks: number;
  laneDir: Direction | null; turnGrace: number;
}
export interface MovementBomb {
  col: number; row: number;
  slideDC: number; slideDR: number; slideCooldown: number; slideInterval: number;
}
export interface MovementWorld { grid: TileType[][]; ice: boolean[][]; bombs: MovementBomb[]; }
export function canEnter(world: MovementWorld, col: number, row: number): boolean;
/** Full per-tick movement dispatcher (ice momentum, lane logic, kick side effects). */
export function stepPlayer(world: MovementWorld, player: MovementPlayer, direction: Direction | null): void;
```

- [ ] **Step 1: Write the parity test (failing — module doesn't exist)**

`packages/shared/test/movement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createGame, stepPlayer, TileType } from '../src';
import type { Direction, MovementPlayer, MovementWorld } from '../src';

const F = TileType.Floor;
const H = TileType.HardBlock;

/** 5x5 open box: hard border, floor inside. */
function boxGrid(): TileType[][] {
  return Array.from({ length: 13 }, (_, r) =>
    Array.from({ length: 15 }, (_, c) =>
      r === 0 || r === 12 || c === 0 || c === 14 ? H : F,
    ),
  );
}

function freshPlayer(x: number, y: number): MovementPlayer {
  return {
    x, y, speed: 3, kickTicks: 0,
    momentumDir: null, momentumTicks: 0, turnTicks: 0,
    laneDir: null, turnGrace: 0,
  };
}

function emptyIce(): boolean[][] {
  return Array.from({ length: 13 }, () => Array<boolean>(15).fill(false));
}

describe('stepPlayer (extracted movement)', () => {
  it('replaying the same input sequence twice gives identical trajectories', () => {
    const seq: (Direction | null)[] = [
      'right', 'right', 'right', 'down', 'down', null, 'left', 'left', 'up', 'right',
    ];
    const run = (): { x: number; y: number }[] => {
      const world: MovementWorld = { grid: boxGrid(), ice: emptyIce(), bombs: [] };
      const p = freshPlayer(1, 1);
      return seq.map((d) => {
        stepPlayer(world, p, d);
        return { x: p.x, y: p.y };
      });
    };
    expect(run()).toEqual(run());
  });

  it('matches GameImpl movement for a scripted input sequence', () => {
    const grid = boxGrid();
    const game = createGame({ seed: 1, playerIds: ['p0', 'p1'], grid });
    const sim = game.state.players[0];
    const world: MovementWorld = { grid: boxGrid(), ice: emptyIce(), bombs: [] };
    const local = freshPlayer(sim.x, sim.y);

    const seq: (Direction | null)[] = [
      'right', 'right', 'down', 'down', 'right', null, null, 'up', 'left', 'left',
      'down', 'right', 'right', 'right', 'up', 'up', null, 'down', 'left', null,
    ];
    for (const d of seq) {
      game.tick({ p0: { direction: d, placeBomb: false } });
      stepPlayer(world, local, d);
      expect(local.x).toBeCloseTo(sim.x, 12);
      expect(local.y).toBeCloseTo(sim.y, 12);
    }
  });

  it('is blocked by a bomb on the tile ahead', () => {
    const world: MovementWorld = {
      grid: boxGrid(),
      ice: emptyIce(),
      bombs: [{ col: 2, row: 1, slideDC: 0, slideDR: 0, slideCooldown: 0, slideInterval: 0 }],
    };
    const p = freshPlayer(1, 1);
    for (let i = 0; i < 20; i++) stepPlayer(world, p, 'right');
    expect(p.x).toBeLessThanOrEqual(1 + 1e-9);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace=@bomberman/shared -- movement`
Expected: FAIL — `stepPlayer` is not exported.

- [ ] **Step 3: Create `packages/shared/src/movement.ts`**

Move the following from `game.ts` VERBATIM (change only `this.state.X` → `world.X`, `this.method(...)` → free-function calls, and method signatures to take `(world, player, ...)`), preserving every comment:

- `EPS` constant (line 103)
- `stepPlayer` (game.ts:419–453) → `export function stepPlayer(world, player, direction)`
- `driveIce` (456–464) → private helper `driveIce(world, player, direction)`
- `clearMomentum` (466–469) → non-exported helper
- `isIce` (471–474) → non-exported helper reading `world.ice`
- `movePlayer` (484–570) → non-exported `movePlayer(world, player, direction, budgetMult = 1)`
- `laneAhead` (580–595) → non-exported `laneAhead(world, player, perp, horizontal)`
- `canEnter` (602–606) → `export function canEnter(world, col, row)` (checks `world.grid`, `world.bombs`)
- `bombAt` (608–610) → non-exported `bombAt(world, col, row)`

Kick side effect inside `movePlayer` (game.ts:544–563) mutates the blocking bomb's `slideDC/slideDR/slideInterval/slideCooldown` — keep it; `MovementBomb` carries those fields so both the sim's `Bomb` and predictor copies satisfy it. Imports needed: `GRID_WIDTH, GRID_HEIGHT, ICE_GLIDE_SPEED_MULT, ICE_GLIDE_TICKS, ICE_TURN_DELAY_TICKS, TICK_RATE, kickSlideInterval` from `./constants`, `TileType` from `./types`, plus the interface definitions from this task's Interfaces block.

- [ ] **Step 4: Delegate in `game.ts`**

Delete the moved private methods. In `GameImpl` add:

```ts
private get world(): MovementWorld {
  return { grid: this.state.grid, ice: this.state.ice, bombs: this.state.bombs };
}
```

Replace the call at game.ts:249 with `stepPlayer(this.world, player, input.direction ?? null);`. `killPlayer`'s `this.clearMomentum(player)` (game.ts:409) becomes inline `player.momentumDir = null; player.momentumTicks = 0;`. Import `stepPlayer` and `MovementWorld` from `./movement`. `canEnter` has no other callers inside `GameImpl` — verify with grep before deleting.

- [ ] **Step 5: Export from `packages/shared/src/index.ts`**

Add `export * from './movement';` alongside the existing exports.

- [ ] **Step 6: Run the full shared suite**

Run: `npm test --workspace=@bomberman/shared`
Expected: ALL pass — including `game.test.ts`, `iceDrift.test.ts`, `turnGrace.test.ts`, `kick.test.ts` unchanged, plus the new `movement.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/shared
git commit -m "refactor(shared): extract movement into pure stepPlayer/canEnter functions

Behavior-preserving: GameImpl delegates to the extracted functions so the
client predictor can run byte-identical movement code."
```

---

### Task 2: Server input queue + per-player ack

**Files:**
- Create: `packages/server/src/rooms/inputQueue.ts`
- Delete: `packages/server/src/rooms/inputBuffer.ts`
- Modify: `packages/server/src/rooms/GameRoom.ts` (swap buffer for queue, publish acks)
- Modify: `packages/server/src/rooms/schema.ts` (PlayerSchema.lastInputSeq)
- Test: rename `packages/server/test/inputBuffer.test.ts` → `inputQueue.test.ts` (rewrite); update `gameRoom.integration.test.ts`.

**Interfaces:**
- Consumes: nothing new.
- Produces (consumed by Task 4):
  - Wire message: `{ seq: number, direction: Direction | null, placeBomb: boolean, fireGun?: boolean, swingHammer?: boolean }`, one per client tick. `seq` starts at 1, strictly increasing.
  - `PlayerSchema.lastInputSeq: number` — seq of the last input applied to a tick; 0 before any.
  - `class InputQueue { push(playerId: string, message: unknown): void; consume(): Map<string, PlayerInput>; acked(playerId: string): number; remove(playerId: string): void; clear(): void }`

- [ ] **Step 1: Write failing tests**

`packages/server/test/inputQueue.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InputQueue } from '../src/rooms/inputQueue';

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

  it('holds the last direction with no actions when the queue runs dry, ack unchanged', () => {
    const q = new InputQueue();
    q.push('p0', msg(1, 'left', { placeBomb: true }));
    q.consume();
    const stalled = q.consume().get('p0');
    expect(stalled).toMatchObject({ direction: 'left', placeBomb: false });
    expect(q.acked('p0')).toBe(1);
  });

  it('rejects stale and duplicate seqs', () => {
    const q = new InputQueue();
    q.push('p0', msg(5));
    q.push('p0', msg(5, 'down'));
    q.push('p0', msg(3, 'up'));
    q.consume();
    expect(q.acked('p0')).toBe(5);
    // Both later pushes were dropped: next consume is a dry hold, not 'down'/'up'.
    expect(q.consume().get('p0')).toMatchObject({ direction: 'right' });
    expect(q.acked('p0')).toBe(5);
  });

  it('caps the backlog at 5, dropping the oldest; ack skips dropped seqs', () => {
    const q = new InputQueue();
    for (let s = 1; s <= 7; s++) q.push('p0', msg(s, s % 2 ? 'up' : 'down'));
    expect(q.consume().get('p0')).toMatchObject({ direction: 'up' }); // seq 3 (1, 2 dropped)
    expect(q.acked('p0')).toBe(3);
  });

  it('treats a message without seq as legacy latest-wins with sticky actions', () => {
    const q = new InputQueue();
    q.push('p0', { direction: 'right', placeBomb: true });
    q.push('p0', { direction: 'down', placeBomb: false });
    expect(q.consume().get('p0')).toMatchObject({ direction: 'down', placeBomb: true });
    expect(q.consume().get('p0')).toMatchObject({ direction: 'down', placeBomb: false });
    expect(q.acked('p0')).toBe(0);
  });

  it('ignores malformed messages', () => {
    const q = new InputQueue();
    q.push('p0', null);
    q.push('p0', { seq: 1, direction: 'diagonal', placeBomb: false });
    q.push('p0', { seq: 1, direction: 'up', placeBomb: 'yes' });
    expect(q.consume().size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test --workspace=@bomberman/server -- inputQueue`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `inputQueue.ts`**

```ts
import type { Direction, PlayerInput } from '@bomberman/shared';

const DIRECTIONS: readonly string[] = ['up', 'down', 'left', 'right'];
/** Max queued inputs per player (250ms at 20Hz); beyond this the oldest is dropped. */
const MAX_QUEUE = 5;

interface QueuedInput {
  seq: number;
  direction: Direction | null;
  placeBomb: boolean;
  fireGun: boolean;
  swingHammer: boolean;
}

interface LegacyEntry {
  direction: Direction | null;
  placeBomb: boolean;
  fireGun: boolean;
  swingHammer: boolean;
}

interface PlayerEntry {
  queue: QueuedInput[];
  /** Highest seq ever accepted; stale/duplicate pushes are rejected against it. */
  lastSeq: number;
  /** Seq of the last input actually applied to a tick (the published ack). */
  acked: number;
  /** Direction to keep applying when the queue runs dry (TCP stall). */
  heldDirection: Direction | null;
  /** Pre-seq clients: latest-wins direction with sticky one-shot action flags. */
  legacy: LegacyEntry | null;
}

/**
 * Per-player input queue: the client sends one sequence-numbered input per
 * 20Hz tick and the server applies exactly one per sim tick. Holding a key for
 * N client ticks therefore moves the player for exactly N server ticks — the
 * old latest-wins buffer quantized press/release against tick boundaries and
 * network jitter, which made the same hold cover different distances.
 */
export class InputQueue {
  private readonly players = new Map<string, PlayerEntry>();

  /** Applies a raw (untrusted) client message; malformed messages are ignored. */
  push(playerId: string, message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const { seq, direction, placeBomb, fireGun, swingHammer } = message as {
      seq?: unknown;
      direction?: unknown;
      placeBomb?: unknown;
      fireGun?: unknown;
      swingHammer?: unknown;
    };
    const validDirection = direction === null || DIRECTIONS.includes(direction as string);
    if (!validDirection || typeof placeBomb !== 'boolean') return;
    const dir = direction as Direction | null;
    const entry = this.entry(playerId);

    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) {
      // Legacy (pre-seq) client: latest-wins, action presses sticky until consumed.
      const legacy = entry.legacy ?? {
        direction: null,
        placeBomb: false,
        fireGun: false,
        swingHammer: false,
      };
      legacy.direction = dir;
      legacy.placeBomb = legacy.placeBomb || placeBomb;
      legacy.fireGun = legacy.fireGun || fireGun === true;
      legacy.swingHammer = legacy.swingHammer || swingHammer === true;
      entry.legacy = legacy;
      return;
    }

    if (seq <= entry.lastSeq) return; // stale or duplicate
    entry.lastSeq = seq;
    entry.queue.push({
      seq,
      direction: dir,
      placeBomb,
      fireGun: fireGun === true,
      swingHammer: swingHammer === true,
    });
    // Backlog cap: drop the oldest. The ack naturally skips dropped seqs when a
    // later input is consumed, so the client discards them from its pending list.
    if (entry.queue.length > MAX_QUEUE) entry.queue.shift();
  }

  /** One tick's inputs: pops the oldest queued input per player (or a dry hold). */
  consume(): Map<string, PlayerInput> {
    const snapshot = new Map<string, PlayerInput>();
    for (const [id, entry] of this.players) {
      const next = entry.queue.shift();
      if (next) {
        entry.acked = next.seq;
        entry.heldDirection = next.direction;
        snapshot.set(id, {
          direction: next.direction,
          placeBomb: next.placeBomb,
          fireGun: next.fireGun,
          swingHammer: next.swingHammer,
        });
      } else if (entry.legacy) {
        const l = entry.legacy;
        snapshot.set(id, {
          direction: l.direction,
          placeBomb: l.placeBomb,
          fireGun: l.fireGun,
          swingHammer: l.swingHammer,
        });
        l.placeBomb = false;
        l.fireGun = false;
        l.swingHammer = false;
      } else {
        // Queue dry (TCP stall): hold the last direction, no actions, ack frozen.
        snapshot.set(id, { direction: entry.heldDirection, placeBomb: false });
      }
    }
    return snapshot;
  }

  acked(playerId: string): number {
    return this.players.get(playerId)?.acked ?? 0;
  }

  remove(playerId: string): void {
    this.players.delete(playerId);
  }

  clear(): void {
    this.players.clear();
  }

  private entry(playerId: string): PlayerEntry {
    let entry = this.players.get(playerId);
    if (!entry) {
      entry = { queue: [], lastSeq: 0, acked: 0, heldDirection: null, legacy: null };
      this.players.set(playerId, entry);
    }
    return entry;
  }
}
```

Note: the dry-hold branch means `consume()` returns an entry for every player who EVER sent a message (same as the old buffer). `pingMs` is intentionally gone — turnGrace reads `input.pingMs` and now always sees `undefined`, so `player.turnGrace` is 0 (inert by design, see Global Constraints).

- [ ] **Step 4: Run inputQueue tests — expect PASS. Delete `inputBuffer.ts` and its old test file.**

Run: `npm test --workspace=@bomberman/server -- inputQueue`

- [ ] **Step 5: Schema ack field**

In `schema.ts` `PlayerSchema`, after `placement`:

```ts
/** Seq of this player's last input applied to a tick; clients reconcile against it. */
@type('number') lastInputSeq = 0;
```

- [ ] **Step 6: Wire `GameRoom`**

- Replace `private readonly inputBuffer = new InputBuffer();` with `private readonly inputQueue = new InputQueue();` (import swap).
- `onMessage('input')`: `this.inputQueue.set(...)` → `this.inputQueue.push(playerId, message)`.
- `onLeave`: `this.inputBuffer.remove(playerId)` → `this.inputQueue.remove(playerId)`.
- `returnToLobby`: `this.inputBuffer.clear()` → `this.inputQueue.clear()`.
- In `simTick()`, after `copySimToSchema(...)` add:

```ts
for (const playerId of this.slots.values()) {
  const ps = this.state.players.get(playerId);
  if (ps) ps.lastInputSeq = this.inputQueue.acked(playerId);
}
```

- [ ] **Step 7: Update `gameRoom.integration.test.ts`**

Wherever the test sends `room.send('input', {...})` / calls the message handler with `{direction, placeBomb}`, add increasing `seq` values (1, 2, 3…) per simulated client. Add one assertion after a tick: the moving player's `state.players.get(id).lastInputSeq` equals the last consumed seq.

- [ ] **Step 8: Run the full server suite**

Run: `npm test --workspace=@bomberman/server`
Expected: ALL pass.

- [ ] **Step 9: Commit**

```bash
git add packages/server
git commit -m "feat(server): per-player sequenced input queue with acks

One queued input consumed per sim tick preserves held-key duration
exactly (fixes distance varying between identical holds). PlayerSchema
publishes lastInputSeq for client reconciliation. Legacy no-seq
messages keep the old latest-wins semantics."
```

---

### Task 3: Client predictor module

**Files:**
- Create: `packages/client/src/prediction.ts`
- Create: `packages/client/vitest.config.ts`
- Modify: `packages/client/package.json` (add `"test": "vitest run"` script, `vitest` devDependency — reuse the root's version)
- Test: `packages/client/test/prediction.test.ts`

**Interfaces:**
- Consumes: `stepPlayer`, `canEnter`, `MovementPlayer`, `MovementBomb`, `MovementWorld` from `@bomberman/shared` (Task 1); `BOMB_FUSE_TICKS`, `TileType`.
- Produces (consumed by Task 4):

```ts
export interface PredictedPlayer extends MovementPlayer {
  alive: boolean;
  bombCount: number;
  activeBombs: number;
}
export interface PendingInput { seq: number; direction: Direction | null; placeBomb: boolean; }
export interface PredictedBomb { id: number; col: number; row: number; fuseTicks: number; } // id = -seq
export class Predictor {
  player: PredictedPlayer;
  pending: PendingInput[];
  bombs: PredictedBomb[];
  constructor(initial: PredictedPlayer);
  step(direction: Direction | null, bombHeld: boolean, grid: TileType[][], ice: boolean[][], serverBombs: { col: number; row: number }[]): PendingInput;
  reconcile(server: PredictedPlayer, acked: number, grid: TileType[][], ice: boolean[][], serverBombs: { col: number; row: number }[]): { dx: number; dy: number };
  ageBombs(): void;
}
```

- [ ] **Step 1: Vitest tooling**

`packages/client/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
```

Add to `packages/client/package.json` scripts: `"test": "vitest run"`. Check the root `package.json` for the vitest version other workspaces use and match it in `devDependencies`; run `npm install`.

- [ ] **Step 2: Write failing predictor tests**

`packages/client/test/prediction.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createGame, TileType } from '@bomberman/shared';
import type { Direction } from '@bomberman/shared';
import { Predictor } from '../src/prediction';
import type { PredictedPlayer } from '../src/prediction';

const F = TileType.Floor;
const H = TileType.HardBlock;

function boxGrid(): TileType[][] {
  return Array.from({ length: 13 }, (_, r) =>
    Array.from({ length: 15 }, (_, c) =>
      r === 0 || r === 12 || c === 0 || c === 14 ? H : F,
    ),
  );
}
function emptyIce(): boolean[][] {
  return Array.from({ length: 13 }, () => Array<boolean>(15).fill(false));
}
function spawn(): PredictedPlayer {
  return {
    x: 1, y: 1, speed: 3, kickTicks: 0,
    momentumDir: null, momentumTicks: 0, turnTicks: 0,
    laneDir: null, turnGrace: 0,
    alive: true, bombCount: 1, activeBombs: 0,
  };
}

/** Reference: the real sim fed the same inputs. */
function referenceRun(inputs: { direction: Direction | null; placeBomb: boolean }[]) {
  const game = createGame({ seed: 1, playerIds: ['p0', 'p1'], grid: boxGrid() });
  for (const input of inputs) game.tick({ p0: input });
  return game.state.players[0];
}

describe('Predictor', () => {
  it('prediction matches the sim exactly for movement inputs', () => {
    const inputs = (
      ['right', 'right', 'down', null, 'down', 'left', 'up', 'right', 'right', 'right'] as
      (Direction | null)[]
    ).map((direction) => ({ direction, placeBomb: false }));

    const p = new Predictor(spawn());
    for (const input of inputs) p.step(input.direction, false, boxGrid(), emptyIce(), []);
    const ref = referenceRun(inputs);
    expect(p.player.x).toBeCloseTo(ref.x, 12);
    expect(p.player.y).toBeCloseTo(ref.y, 12);
  });

  it('rebase + replay converges to the same position as pure prediction', () => {
    const dirs: (Direction | null)[] = ['right', 'right', 'right', 'down', 'down', 'down'];
    const pure = new Predictor(spawn());
    for (const d of dirs) pure.step(d, false, boxGrid(), emptyIce(), []);

    // Same inputs, but the server acks after tick 3 with the exact sim state.
    const acked = new Predictor(spawn());
    for (const d of dirs.slice(0, 3)) acked.step(d, false, boxGrid(), emptyIce(), []);
    const serverAt3 = referenceRun(dirs.slice(0, 3).map((direction) => ({ direction, placeBomb: false })));
    for (const d of dirs.slice(3)) acked.step(d, false, boxGrid(), emptyIce(), []);
    const err = acked.reconcile(
      { ...spawn(), ...pickPredicted(serverAt3) },
      3,
      boxGrid(),
      emptyIce(),
      [],
    );
    expect(err.dx).toBeCloseTo(0, 9);
    expect(err.dy).toBeCloseTo(0, 9);
    expect(acked.player.x).toBeCloseTo(pure.player.x, 9);
    expect(acked.player.y).toBeCloseTo(pure.player.y, 9);
    expect(acked.pending.length).toBe(3);
  });

  it('places an optimistic bomb that blocks its own tile after walking off', () => {
    const p = new Predictor(spawn());
    p.step(null, true, boxGrid(), emptyIce(), []);
    expect(p.bombs).toHaveLength(1);
    expect(p.bombs[0]).toMatchObject({ col: 1, row: 1 });
    expect(p.player.activeBombs).toBe(1);
    // Walk off, then try to walk back on: blocked by own predicted bomb.
    for (let i = 0; i < 10; i++) p.step('right', false, boxGrid(), emptyIce(), []);
    const off = p.player.x;
    expect(off).toBeGreaterThan(1.4);
    for (let i = 0; i < 10; i++) p.step('left', false, boxGrid(), emptyIce(), []);
    expect(p.player.x).toBeGreaterThanOrEqual(2 - 1e-9);
  });

  it('does not place beyond the bomb cap and refunds on reconcile', () => {
    const p = new Predictor(spawn());
    p.step(null, true, boxGrid(), emptyIce(), []);
    p.step(null, true, boxGrid(), emptyIce(), []); // cap = 1: second is refused
    expect(p.bombs).toHaveLength(1);
    expect(p.player.activeBombs).toBe(1);
    // Server acks both inputs but reports no bomb (rejected) and activeBombs 0.
    p.reconcile(spawn(), 2, boxGrid(), emptyIce(), []);
    expect(p.bombs).toHaveLength(0);
    expect(p.player.activeBombs).toBe(0);
  });

  it('stops predicting once dead', () => {
    const p = new Predictor(spawn());
    p.reconcile({ ...spawn(), alive: false }, 0, boxGrid(), emptyIce(), []);
    const before = p.player.x;
    p.step('right', false, boxGrid(), emptyIce(), []);
    expect(p.player.x).toBe(before);
  });
});

function pickPredicted(sim: { x: number; y: number; alive: boolean; speed: number; bombCount: number; activeBombs: number; kickTicks: number; momentumDir: Direction | null; momentumTicks: number; turnTicks: number; laneDir: Direction | null }): Partial<PredictedPlayer> {
  const { x, y, alive, speed, bombCount, activeBombs, kickTicks, momentumDir, momentumTicks, turnTicks, laneDir } = sim;
  return { x, y, alive, speed, bombCount, activeBombs, kickTicks, momentumDir, momentumTicks, turnTicks, laneDir };
}
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test --workspace=@bomberman/client`
Expected: FAIL — `../src/prediction` not found.

- [ ] **Step 4: Implement `prediction.ts`**

```ts
import { BOMB_FUSE_TICKS, TileType, stepPlayer } from '@bomberman/shared';
import type { Direction, MovementBomb, MovementPlayer, MovementWorld } from '@bomberman/shared';

export interface PredictedPlayer extends MovementPlayer {
  alive: boolean;
  bombCount: number;
  activeBombs: number;
}

export interface PendingInput {
  seq: number;
  direction: Direction | null;
  placeBomb: boolean;
}

export interface PredictedBomb {
  id: number; // negative: -seq of the placing input
  col: number;
  row: number;
  fuseTicks: number;
}

interface Obstacle {
  col: number;
  row: number;
}

/**
 * Predicts the local player only. Applies inputs instantly through the shared
 * movement code, then on each server ack rebases to authoritative state and
 * replays unacked inputs — identical code on both sides means replay normally
 * reproduces the prediction with zero visible correction.
 *
 * Known soft spot: a kicked bomb's slide is server-driven, so replaying past a
 * just-kicked bomb can disagree for a few ticks; the caller blends the error.
 */
export class Predictor {
  player: PredictedPlayer;
  pending: PendingInput[] = [];
  bombs: PredictedBomb[] = [];
  private nextSeq = 0;

  constructor(initial: PredictedPlayer) {
    this.player = { ...initial };
  }

  step(
    direction: Direction | null,
    bombHeld: boolean,
    grid: TileType[][],
    ice: boolean[][],
    serverBombs: Obstacle[],
  ): PendingInput {
    const input: PendingInput = { seq: ++this.nextSeq, direction, placeBomb: bombHeld };
    this.pending.push(input);
    this.apply(input, grid, ice, serverBombs);
    return input;
  }

  reconcile(
    server: PredictedPlayer,
    acked: number,
    grid: TileType[][],
    ice: boolean[][],
    serverBombs: Obstacle[],
  ): { dx: number; dy: number } {
    const prevX = this.player.x;
    const prevY = this.player.y;

    this.player = { ...server };
    this.pending = this.pending.filter((i) => i.seq > acked);
    this.bombs = []; // rebuilt by replaying unacked placements
    for (const input of this.pending) this.apply(input, grid, ice, serverBombs);

    return { dx: prevX - this.player.x, dy: prevY - this.player.y };
  }

  /** Predicted fuses only tick for rendering; the server owns detonation. */
  ageBombs(): void {
    for (const b of this.bombs) b.fuseTicks--;
    this.bombs = this.bombs.filter((b) => b.fuseTicks > 0);
  }

  /** Mirrors GameImpl.tick order: kick timer, bomb placement, then movement. */
  private apply(
    input: PendingInput,
    grid: TileType[][],
    ice: boolean[][],
    serverBombs: Obstacle[],
  ): void {
    if (!this.player.alive) return;
    if (this.player.kickTicks > 0) this.player.kickTicks--;
    if (input.placeBomb) this.tryPlaceBomb(input.seq, grid, serverBombs);
    const world: MovementWorld = {
      grid,
      ice,
      bombs: this.obstacles(serverBombs).map(asMovementBomb),
    };
    stepPlayer(world, this.player, input.direction);
  }

  private tryPlaceBomb(seq: number, grid: TileType[][], serverBombs: Obstacle[]): void {
    const col = Math.round(this.player.x);
    const row = Math.round(this.player.y);
    if (this.player.activeBombs >= this.player.bombCount) return;
    if (grid[row]?.[col] !== TileType.Floor) return;
    if (this.obstacles(serverBombs).some((o) => o.col === col && o.row === row)) return;
    this.bombs.push({ id: -seq, col, row, fuseTicks: BOMB_FUSE_TICKS });
    this.player.activeBombs++;
  }

  private obstacles(serverBombs: Obstacle[]): Obstacle[] {
    return [...serverBombs, ...this.bombs];
  }
}

function asMovementBomb(o: Obstacle): MovementBomb {
  return { col: o.col, row: o.row, slideDC: 0, slideDR: 0, slideCooldown: 0, slideInterval: 0 };
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npm test --workspace=@bomberman/client`

- [ ] **Step 6: Commit**

```bash
git add packages/client
git commit -m "feat(client): local-player predictor with rebase+replay

Runs the local player through the shared stepPlayer for instant input
feedback; on each server ack it rebases to authoritative state and
replays unacked inputs. Optimistic bombs get negative ids (-seq)."
```

---

### Task 4: Sync movement fields + wire prediction into GameScene

**Files:**
- Modify: `packages/server/src/rooms/schema.ts` (sync momentumDir/momentumTicks/turnTicks/laneDir)
- Modify: `packages/client/src/net.ts` (NetPlayer fields)
- Modify: `packages/client/src/scenes/GameScene.ts` (online fixed-step + prediction wiring, optimistic bomb sprite adoption)
- Test: `packages/server/test/schema.test.ts` (extend); manual smoke via `make start LAG=100`.

**Interfaces:**
- Consumes: `Predictor`, `PendingInput`, `PredictedPlayer` (Task 3); `PlayerSchema.lastInputSeq` + wire message (Task 2).
- Produces: `NetPlayer.lastInputSeq/momentumDir/momentumTicks/turnTicks/laneDir` for Task 5's rendering split.

- [ ] **Step 1: Sync the ice/lane movement fields**

The predictor rebases from server state, so replay needs the sim-only movement fields. In `schema.ts` `PlayerSchema` add:

```ts
/** Ice-drift heading carried across ticks ('' = none); predictor rebases from it. */
@type('string') momentumDir = '';
@type('number') momentumTicks = 0;
@type('number') turnTicks = 0;
/** Lane commitment for the corner slide ('' = none). */
@type('string') laneDir = '';
```

In `copySimToSchema`, replace the "stay sim-only" comment block with:

```ts
ps.momentumDir = player.momentumDir ?? '';
ps.momentumTicks = player.momentumTicks;
ps.turnTicks = player.turnTicks;
ps.laneDir = player.laneDir ?? '';
```

In `schema.test.ts`, extend the existing copySimToSchema round-trip test (read it first) to assert these four fields mirror the sim, with `null` mapping to `''`.

- [ ] **Step 2: Extend `NetPlayer` in `net.ts`**

```ts
  /** Seq of the last input the server applied for this player (reconciliation ack). */
  lastInputSeq: number;
  momentumDir: string;
  momentumTicks: number;
  turnTicks: number;
  laneDir: string;
```

- [ ] **Step 3: GameScene — state and create()**

Add fields near the other online fields (`GameScene.ts:312-325`):

```ts
  private predictor: Predictor | null = null;
  /** Rendered-minus-predicted offset, decayed toward 0 (~100ms) to hide corrections. */
  private predictionError = { x: 0, y: 0 };
  private lastAcked = 0;
  /** Slippery-tile mask for prediction; all false on non-winter maps. */
  private iceMask: boolean[][] = [];
```

Imports: `import { Predictor } from '../prediction';` and type `PredictedPlayer`.

In `create()` reset them (`predictor = null`, `predictionError = {x:0,y:0}`, `lastAcked = 0`). In `resolveMap`, after setting `this.compiled`, add:

```ts
this.iceMask =
  this.compiled?.ice ?? Array.from({ length: GRID_HEIGHT }, () => Array<boolean>(GRID_WIDTH).fill(false));
```

In the online branch of `create()`, after `this.grid = ...`, build the predictor from our own synced player (guard for an old server that lacks the ack field — render unpredicted then):

```ts
const own = data.connection.room.state.players.get(this.myId);
if (own && typeof own.lastInputSeq === 'number') {
  this.predictor = new Predictor(predictedFromNet(own));
}
```

Add a module-level helper next to `RenderState`:

```ts
/** Rebase snapshot of our own synced player, '' mapped back to null. */
function predictedFromNet(p: NetPlayer): PredictedPlayer {
  return {
    x: p.x,
    y: p.y,
    speed: p.speed,
    kickTicks: p.kickTicks,
    momentumDir: (p.momentumDir || null) as PredictedPlayer['momentumDir'],
    momentumTicks: p.momentumTicks,
    turnTicks: p.turnTicks,
    laneDir: (p.laneDir || null) as PredictedPlayer['laneDir'],
    turnGrace: 0,
    alive: p.alive,
    bombCount: p.bombCount,
    activeBombs: p.activeBombs,
  };
}
```

- [ ] **Step 4: GameScene — fixed-step input send in `updateOnline`**

Replace the send-on-change block (`GameScene.ts:643-673`, from `this.pollSkillKeys();` through the `this.keepaliveMs = 0; }` close) with a fixed-step loop. The trigger-routing logic above it is kept per-frame; sends move into the step:

```ts
    this.pollSkillKeys();
    const direction = this.currentDirection();
    const armed = this.myArmedSkill();
    if (armed === 'gun' && this.pendingTrigger) this.pendingGun = true;
    if (armed === 'hammer' && this.pendingTrigger) this.pendingHammer = true;
    this.pendingTrigger = false;
    if (!this.spaceKey.isDown) this.triggerServedSkill = false;
    else if (armed !== null) this.triggerServedSkill = true;
    const bombHeld = armed === null && this.spaceKey.isDown && !this.triggerServedSkill;

    // One sequenced input per 20Hz step: the server applies each for exactly one
    // tick, so held-key duration (and therefore distance) is reproduced exactly.
    this.accumulator += delta;
    let steps = 0;
    while (this.accumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= TICK_MS;
      this.stepOnline(direction, bombHeld);
      steps++;
    }
    if (this.accumulator >= TICK_MS) this.accumulator = 0;
```

New method (below `updateOnline`):

```ts
  /** One predicted client tick: advance the local player and send its input. */
  private stepOnline(direction: Direction | null, bombHeld: boolean): void {
    const room = this.connection!.room;
    const serverBombs: { col: number; row: number }[] = [];
    room.state.bombs.forEach((b) => serverBombs.push({ col: b.col, row: b.row }));

    let seq = 0;
    if (this.predictor) {
      const input = this.predictor.step(direction, bombHeld, this.grid!, this.iceMask, serverBombs);
      this.predictor.ageBombs();
      seq = input.seq;
    }
    if (!this.roomClosed) {
      room.send('input', {
        seq,
        direction,
        placeBomb: bombHeld,
        fireGun: this.pendingGun,
        swingHammer: this.pendingHammer,
        pingMs: this.pingMs ?? 0,
      });
      this.pendingGun = false;
      this.pendingHammer = false;
    }
  }
```

(`seq: 0` without a predictor lands in the server's legacy path on purpose.) Delete the now-unused fields `lastSentDirection`, `lastSentBomb`, `keepaliveMs`, the `KEEPALIVE_MS` const, and their resets in `create()`. Keep the ping block unchanged.

- [ ] **Step 5: GameScene — reconcile + render own player predicted**

Still in `updateOnline`, before `const state = this.renderStateFromRoom();` add:

```ts
    // Reconcile: rebase onto the server's last-applied input, replay the rest.
    const own = room.state.players.get(this.myId);
    if (this.predictor && own && own.lastInputSeq !== this.lastAcked) {
      const serverBombs: { col: number; row: number }[] = [];
      room.state.bombs.forEach((b) => serverBombs.push({ col: b.col, row: b.row }));
      const err = this.predictor.reconcile(
        predictedFromNet(own),
        own.lastInputSeq,
        this.grid!,
        this.iceMask,
        serverBombs,
      );
      this.predictionError.x += err.dx;
      this.predictionError.y += err.dy;
      this.lastAcked = own.lastInputSeq;
    }
    // Corrections slide out over ~100ms instead of snapping.
    const decay = Math.exp(-delta / PREDICTION_ERROR_SMOOTH_MS);
    this.predictionError.x *= decay;
    this.predictionError.y *= decay;
```

Const near `ONLINE_LERP`:

```ts
/** Time constant (ms) for bleeding off prediction corrections. */
const PREDICTION_ERROR_SMOOTH_MS = 100;
```

In `renderStateFromRoom()`, override our own entry and append predicted bombs. After the `players.sort(...)` line:

```ts
    if (this.predictor) {
      const own = players.find((p) => p.id === this.myId);
      if (own && own.alive) {
        own.x = this.predictor.player.x + this.predictionError.x;
        own.y = this.predictor.player.y + this.predictionError.y;
      }
    }
```

After the `s.bombs.forEach(...)` line:

```ts
    if (this.predictor) {
      for (const b of this.predictor.bombs) {
        // Skip predicted bombs the server has since confirmed on the same tile.
        if (!bombs.some((sb) => sb.col === b.col && sb.row === b.row)) {
          bombs.push({ id: b.id, col: b.col, row: b.row, slideInterval: 0 });
        }
      }
    }
```

In `updateOnline`, change `this.positionPlayers(state, ONLINE_LERP);` to pass per-player behavior: own sprite snaps (its smoothing is the error decay), remotes keep `ONLINE_LERP` until Task 5. Change `positionPlayers` signature to `(state, lerp, snapIds?: Set<string>)` and inside use `const k = snapIds?.has(player.id) ? 1 : lerp;` for the `setPosition` line. Call: `this.positionPlayers(state, ONLINE_LERP, new Set(this.predictor ? [this.myId] : []));`.

If the server reports us dead (`own.alive === false`), prediction must stop: `predictedFromNet` carries `alive`, and `Predictor.apply` early-returns — no extra wiring needed; the ghost renders from server coordinates because the override above checks `own.alive`.

- [ ] **Step 6: GameScene — adopt predicted bomb sprites without flicker**

In `reconcileBombs` (`GameScene.ts:1320`):

1. In the removal loop, don't mark explosion centers for predicted ids:

```ts
      if (!liveIds.has(id)) {
        // A vanished server bomb marks its cell as the explosion origin this
        // pass; predicted bombs (id < 0) vanish by adoption, not explosion.
        if (id > 0) this.explosionCenters.add(cellKey(entry.col, entry.row));
```

2. Before creating a sprite for a new server bomb, adopt a predicted sprite on the same tile:

```ts
      if (bomb.id > 0) {
        for (const [pid, pentry] of this.bombSprites) {
          if (pid < 0 && pentry.col === bomb.col && pentry.row === bomb.row) {
            this.bombSprites.delete(pid);
            this.bombSprites.set(bomb.id, pentry);
            break;
          }
        }
        if (this.bombSprites.has(bomb.id)) continue;
      }
```

Place this right after `const existing = this.bombSprites.get(bomb.id); if (existing) { ... continue; }`. The `audio.bombPlace()` line stays where it is — a predicted bomb plays it the frame it appears (instant feedback), and adoption `continue`s before the sound so it never double-plays.

- [ ] **Step 7: Typecheck + tests + manual smoke**

Run: `npm run build --workspace=@bomberman/client` (or the workspace's typecheck script — check `package.json`), plus `npm test --workspace=@bomberman/client` and `npm test --workspace=@bomberman/server`.

Manual: `make start LAG=100`, open two browser tabs at the printed Vite URL, create + join a room, start the match. Verify: own movement responds instantly with no rubber-banding on plain floor; taps produce the same short step every time; bombs appear under you instantly; ice map (winter) glide still behaves.

- [ ] **Step 8: Commit**

```bash
git add packages/client packages/server
git commit -m "feat(client): drive prediction + reconciliation in online mode

Own player steps locally per 20Hz fixed tick and sends one sequenced
input per step; on each server ack the predictor rebases and replays.
Ice/lane movement fields are now synced so replay is exact. Predicted
bombs render instantly and are adopted by their server twins."
```

---

### Task 5: Snapshot interpolation for remote players

**Files:**
- Create: `packages/client/src/interpolation.ts`
- Modify: `packages/client/src/scenes/GameScene.ts` (buffer feed + remote rendering; delete `ONLINE_LERP`)
- Test: `packages/client/test/interpolation.test.ts`

**Interfaces:**
- Consumes: `NetRoomState` players.
- Produces:

```ts
export const INTERP_DELAY_MS = 100;
export class SnapshotBuffer {
  push(t: number, players: Map<string, { x: number; y: number }>): void;
  /** Position at renderT (typically now - INTERP_DELAY_MS); null if id unseen. */
  sample(id: string, renderT: number): { x: number; y: number } | null;
}
```

- [ ] **Step 1: Write failing tests**

`packages/client/test/interpolation.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure, then implement `interpolation.ts`**

```ts
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
```

Run: `npm test --workspace=@bomberman/client` — expect PASS.

- [ ] **Step 3: Feed the buffer and render remotes from it**

GameScene:

- Field: `private snapshots = new SnapshotBuffer();` — reset in `create()` (`this.snapshots = new SnapshotBuffer();`). Import from `../interpolation`.
- In the online branch of `create()`, register (and clean up alongside the existing `onLeave` removal):

```ts
      const onPatch = (): void => {
        const positions = new Map<string, { x: number; y: number }>();
        data.connection.room.state.players.forEach((p, id) => {
          if (id !== this.myId) positions.set(id, { x: p.x, y: p.y });
        });
        this.snapshots.push(performance.now(), positions);
      };
      data.connection.room.onStateChange(onPatch);
      this.events.once('shutdown', () => {
        data.connection.room.onStateChange.remove(onPatch);
      });
```

- In `renderStateFromRoom()`, after the own-player prediction override, resample remotes:

```ts
    const renderT = performance.now() - INTERP_DELAY_MS;
    for (const p of players) {
      if (p.id === this.myId && this.predictor) continue;
      const s = this.snapshots.sample(p.id, renderT);
      if (s) {
        p.x = s.x;
        p.y = s.y;
      }
    }
```

- `updateOnline`: call `this.positionPlayers(state, 1);` — everything now snaps to already-smooth targets. Delete `ONLINE_LERP` and the `snapIds` parameter added in Task 4 (revert `positionPlayers` to `(state, lerp)`).
- The foot-shadow comment about lerp-smoothing (`GameScene.ts:1051-1055,163-166`) is now stale — trim both comments to say the shadow tracks the rendered sprite.

- [ ] **Step 4: Manual smoke**

`make start LAG=100`, two tabs: remote player motion is smooth and constant-speed (no 20Hz stutter, no rubber-band), ~100ms behind; own player unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/client
git commit -m "feat(client): time-based snapshot interpolation for remote players

Replaces the frame-rate-dependent exponential lerp with a 100ms-delayed
interpolation buffer: remote motion is smooth, constant-speed, and true
to the server trajectory."
```

---

### Task 6: Walk bob (motion polish)

**Files:**
- Modify: `packages/client/src/scenes/GameScene.ts` (`positionPlayers`)

**Interfaces:** none new.

- [ ] **Step 1: Implement**

Consts near `PLAYER_FOOT_OFFSET`:

```ts
/** Walking bob: vertical sine amplitude (px) and frequency (Hz). Visual only. */
const WALK_BOB_PX = 1.5;
const WALK_BOB_HZ = 8;
/** Position delta (tiles/frame) below which a player counts as standing still. */
const WALK_EPSILON = 0.002;
```

Field: `private walkAnim = new Map<string, { phase: number; lastX: number; lastY: number }>();` — cleared in `create()`.

`positionPlayers` gains a `delta: number` parameter (pass it through from `update`'s callers; offline call site `updateOffline` and online call site both have `delta` in scope; the one call in `create()` passes 0). Inside the loop, after computing `tx/ty` and before `setPosition`:

```ts
      let anim = this.walkAnim.get(player.id);
      if (!anim) {
        anim = { phase: 0, lastX: player.x, lastY: player.y };
        this.walkAnim.set(player.id, anim);
      }
      const moving =
        player.alive &&
        (Math.abs(player.x - anim.lastX) > WALK_EPSILON ||
          Math.abs(player.y - anim.lastY) > WALK_EPSILON);
      anim.lastX = player.x;
      anim.lastY = player.y;
      anim.phase = moving ? anim.phase + (delta / 1000) * WALK_BOB_HZ * Math.PI * 2 : 0;
      const bob = moving ? Math.abs(Math.sin(anim.phase)) * -WALK_BOB_PX : 0;
```

and apply `bob` to the sprite's y target (`ty + bob` in the `setPosition` line). The foot shadow keeps tracking the sprite, so it bobs along — acceptable (it reads as the character hopping with its shadow anchored via `footDrop`).

- [ ] **Step 2: Manual check**

Offline match: characters gently hop while moving, still when idle. Then `npm test --workspace=@bomberman/client` (no regressions).

- [ ] **Step 3: Commit**

```bash
git add packages/client
git commit -m "feat(client): walking bob on player sprites"
```

---

### Task 7: Docs, roadmap, memory

**Files:**
- Modify: `docs/superpowers/plans/2026-07-25-latency-reduction.md` (mark #2, #3 done)
- Modify: memory `client-prediction-followups.md` (the old note wrongly says prediction merged 2026-07-25 — it never was; this series supersedes it)

- [ ] **Step 1:** In the roadmap, flip items 2 and 3 to ✅ with one-line pointers to this plan. Note that turnGrace is now inert (no pingMs on the seq input path) and can be deleted in a future cleanup.
- [ ] **Step 2:** Rewrite the memory file: prediction v2 landed via this plan (list the commits); deploy order remains server BEFORE client (old server + new client falls back to unpredicted rendering via the `lastInputSeq` guard; new server + old client uses the legacy input path); browser smoke with real latency still owed before/at deploy.
- [ ] **Step 3: Commit**

```bash
git add docs packages
git commit -m "docs: netcode v2 rollout notes; mark roadmap items done"
```

---

## Self-Review Notes

- Spec coverage: shared extraction (Task 1), protocol+queue+ack (Task 2), predictor (Task 3), scene wiring + optimistic bombs (Task 4), interpolation (Task 5 — spec's out-of-scope item, pulled in from roadmap #3), fake-lag testing (server has `SIMULATE_LATENCY_MS` via `make start LAG=`, so the branch's `?lag` client harness is NOT ported).
- Type consistency: `stepPlayer(world, player, direction)` ordering used in Tasks 1/3; `InputQueue.push/consume/acked` in Tasks 2/4; `lastInputSeq` naming everywhere (matches the planned old-server guard).
- Known ship-as-is: replay past a just-kicked (sliding) bomb can mispredict briefly (error blend covers it); explosions/deaths remain server-authoritative with ~half-RTT delay; the dead-end bomb-block scenario is inherently latency-bound — prediction makes your own bomb drop instant and interpolation shows opponents truthfully, which shrinks (not eliminates) the "bot escaped anyway" window.
