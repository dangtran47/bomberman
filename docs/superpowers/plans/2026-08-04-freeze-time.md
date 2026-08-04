# Freeze-Time Powerup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New instant-on-pickup powerup that freezes every other alive player for 5 seconds (no move, no bomb/mine, no gun/hammer; still killable).

**Architecture:** Enforcement lives in the shared simulation (`packages/shared`) so offline play, server, and client prediction all run the same guards. `Player.frozenTicks` counts down; `stepPlayer` no-ops while frozen; the game tick skips action handling while frozen. Server replicates `frozenTicks` via `PlayerSchema`; client tints frozen sprites ice-blue.

**Tech Stack:** TypeScript monorepo, vitest, Phaser 3 client, Colyseus server.

**Spec:** `docs/superpowers/specs/2026-08-04-freeze-time-design.md`

## Global Constraints

- `PowerupType` is append-only (wire protocol sends enum values) — `FreezeTime` goes AFTER `Mine`.
- Freeze duration: `FREEZE_DURATION_TICKS = 100` (5 s at `TICK_RATE = 20`).
- Drop weight: 1 (rare tier, same as Gun/Hammer/Mine).
- Frozen players remain killable; bombs they already placed keep ticking.
- The freeze/decrement convention everywhere: **guards check `frozenTicks > 0` first, decrement happens at the END of that player's per-tick handling** (after `stepPlayer`). Freeze then lasts exactly 100 ticks. Prediction must mirror this order.
- Run tests from repo root with workspace filter, e.g. `npx vitest run test/freeze.test.ts` inside `packages/shared` — but per memory, call `node_modules/.bin/vitest` directly when the exit code matters (rtk npx wrapper mangles exit codes).

---

### Task 1: Shared sim — freeze mechanics (TDD)

**Files:**
- Modify: `packages/shared/src/types.ts` (PowerupType enum ~line 7-15, Player interface ~line 29)
- Modify: `packages/shared/src/constants.ts` (POWERUP_TYPE_COUNT line 24, POWERUP_WEIGHTS line 31, new constant)
- Modify: `packages/shared/src/movement.ts` (MovementPlayer line 13, stepPlayer line 33)
- Modify: `packages/shared/src/game.ts` (applyPowerup line 138, player init ~line 196, tick loop ~line 235-260, collectPowerups line 663)
- Test: `packages/shared/test/freeze.test.ts` (new)

**Interfaces:**
- Consumes: existing `createGame`, `PlayerInput`, test helpers pattern from `packages/shared/test/mine.test.ts`.
- Produces: `PowerupType.FreezeTime` (enum value 7), `FREEZE_DURATION_TICKS = 100`, `Player.frozenTicks: number`, `MovementPlayer.frozenTicks: number`, `stepPlayer` that no-ops while `frozenTicks > 0`. Later tasks rely on these exact names.

- [ ] **Step 1: Write the failing test** — create `packages/shared/test/freeze.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  FREEZE_DURATION_TICKS,
  GRID_HEIGHT,
  GRID_WIDTH,
  GUN_AMMO_PER_PICKUP,
  MINE_AMMO_PER_PICKUP,
} from '../src/constants';
import { createGame } from '../src/game';
import type { Game, GameEvent } from '../src/game';
import { PowerupType, TileType } from '../src/types';
import type { Direction, PlayerInput } from '../src/types';

const SEED_NO_DROP = 1;

const move = (direction: Direction): PlayerInput => ({ direction, placeBomb: false });
const act = (extra: Partial<PlayerInput>): PlayerInput => ({
  direction: null,
  placeBomb: false,
  ...extra,
});

function openGrid(): TileType[][] {
  return Array.from({ length: GRID_HEIGHT }, () =>
    Array<TileType>(GRID_WIDTH).fill(TileType.Floor),
  );
}

function run(game: Game, ticks: number, inputs: Record<string, PlayerInput> = {}): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < ticks; i++) events.push(...game.tick(inputs));
  return events;
}

function player(game: Game, id: string) {
  const found = game.state.players.find((p) => p.id === id);
  if (!found) throw new Error(`no player ${id}`);
  return found;
}

function twoPlayerGame(): Game {
  return createGame({ seed: SEED_NO_DROP, playerIds: ['p1', 'p2'], grid: openGrid() });
}

/** p1 stands on a FreezeTime powerup so the next tick collects it. */
function gameWithPickup(): Game {
  const game = twoPlayerGame();
  const p1 = player(game, 'p1');
  game.state.powerups.push({
    col: Math.round(p1.x),
    row: Math.round(p1.y),
    type: PowerupType.FreezeTime,
  });
  return game;
}

describe('freeze-time pickup', () => {
  it('freezes every other alive player, not the picker', () => {
    const game = gameWithPickup();
    run(game, 1);
    expect(player(game, 'p1').frozenTicks).toBe(0);
    expect(player(game, 'p2').frozenTicks).toBe(FREEZE_DURATION_TICKS);
  });

  it('skips dead players', () => {
    const game = gameWithPickup();
    const p2 = player(game, 'p2');
    p2.alive = false;
    run(game, 1);
    expect(p2.frozenTicks).toBe(0);
  });

  it('second pickup refreshes the timer to full', () => {
    const game = gameWithPickup();
    run(game, 1);
    run(game, 30); // burn some of the freeze
    const p1 = player(game, 'p1');
    game.state.powerups.push({
      col: Math.round(p1.x),
      row: Math.round(p1.y),
      type: PowerupType.FreezeTime,
    });
    run(game, 1);
    expect(player(game, 'p2').frozenTicks).toBe(FREEZE_DURATION_TICKS);
  });
});

describe('frozen player restrictions', () => {
  it('cannot move while frozen, moves again after exactly FREEZE_DURATION_TICKS', () => {
    const game = twoPlayerGame();
    const p2 = player(game, 'p2');
    p2.frozenTicks = FREEZE_DURATION_TICKS;
    const startX = p2.x;

    run(game, FREEZE_DURATION_TICKS, { p2: move('left') });
    expect(p2.x).toBe(startX); // all 100 ticks blocked

    run(game, 1, { p2: move('left') });
    expect(p2.x).toBeLessThan(startX); // first tick after freeze moves
  });

  it('cannot place a bomb while frozen', () => {
    const game = twoPlayerGame();
    player(game, 'p2').frozenTicks = 10;
    run(game, 1, { p2: act({ placeBomb: true }) });
    expect(game.state.bombs).toEqual([]);
  });

  it('cannot place a mine while frozen', () => {
    const game = twoPlayerGame();
    const p2 = player(game, 'p2');
    p2.frozenTicks = 10;
    p2.mineAmmo = MINE_AMMO_PER_PICKUP;
    run(game, 1, { p2: act({ placeMine: true }) });
    expect(game.state.mines).toEqual([]);
    expect(p2.mineAmmo).toBe(MINE_AMMO_PER_PICKUP);
  });

  it('cannot fire the gun while frozen', () => {
    const game = twoPlayerGame();
    const p2 = player(game, 'p2');
    p2.frozenTicks = 10;
    p2.gunAmmo = GUN_AMMO_PER_PICKUP;
    run(game, 1, { p2: act({ fireGun: true }) });
    expect(p2.gunAmmo).toBe(GUN_AMMO_PER_PICKUP);
  });

  it('still dies to a blast while frozen', () => {
    const game = twoPlayerGame();
    const p2 = player(game, 'p2');
    p2.frozenTicks = FREEZE_DURATION_TICKS;
    game.state.explosions.push({
      col: Math.round(p2.x),
      row: Math.round(p2.y),
      ticksLeft: 3,
    });
    run(game, 1);
    expect(p2.alive).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/shared`): `node_modules/.bin/vitest run test/freeze.test.ts` (or `../../node_modules/.bin/vitest` if hoisted — check where the binary lives)
Expected: FAIL — `FREEZE_DURATION_TICKS` not exported, `frozenTicks` missing.

- [ ] **Step 3: Implement**

`packages/shared/src/types.ts` — append enum member and Player field:

```typescript
export enum PowerupType {
  ExtraBomb,
  BiggerBlast,
  Speed,
  Kick,
  Gun,
  Hammer,
  Mine, // append only: the wire protocol sends these values
  FreezeTime,
}
```

In `Player` (after `mineAmmo`):

```typescript
  frozenTicks: number; // >0 = frozen solid: no movement, bombs, or skills
```

`packages/shared/src/constants.ts`:

```typescript
export const POWERUP_TYPE_COUNT = 8;
```

Update the weights comment to end `(…, Gun, Hammer, Mine, FreezeTime)` and:

```typescript
export const POWERUP_WEIGHTS = [6, 6, 3, 3, 1, 1, 1, 1] as const;
```

Near the mine constants:

```typescript
/** Freeze-time pickup: every other alive player is frozen this long. */
export const FREEZE_DURATION_TICKS = 100; // 5s at 20tps
```

`packages/shared/src/movement.ts` — add to `MovementPlayer`:

```typescript
export interface MovementPlayer {
  x: number; y: number; speed: number;
  kickTicks: number;
  frozenTicks: number;
  momentumDir: Direction | null; momentumTicks: number; turnTicks: number;
  laneDir: Direction | null; turnGrace: number;
}
```

First line of `stepPlayer` body:

```typescript
  if (player.frozenTicks > 0) return; // frozen solid: no movement at all
```

`packages/shared/src/game.ts`:

1. Import `FREEZE_DURATION_TICKS` from `./constants`.
2. Player init in the constructor: add `frozenTicks: 0,` after `mineAmmo: 0,`.
3. `applyPowerup` — new signature and case (update the existing function; `players` is the full roster):

```typescript
function applyPowerup(player: Player, type: PowerupType, players: Player[]): void {
  switch (type) {
    // ... existing cases unchanged ...
    // Freeze-time is instant: it holds no slot and clears nothing on the picker.
    case PowerupType.FreezeTime:
      for (const other of players) {
        if (other === player || !other.alive) continue;
        other.frozenTicks = FREEZE_DURATION_TICKS;
      }
      break;
  }
}
```

4. `collectPowerups` call site becomes `applyPowerup(player, powerup.type, s.players);`
5. Tick loop (~lines 235-260): compute `frozen` after reading input, gate facing/bomb/skills, decrement at the very end (after `stepPlayer`). The block becomes:

```typescript
    for (const player of s.players) {
      if (!player.alive) continue;
      if (player.kickTicks > 0) player.kickTicks--;
      const input = readInput(inputs, player.id);
      // Latency-scaled turn latitude: how far the player expects to have drifted
      // past a junction while their turn was in flight. 0 offline (no ping).
      const oneWaySec = Math.min(input.pingMs ?? 0, PING_CAP_MS) / 2 / 1000;
      player.turnGrace = Math.min(GRACE_CAP, player.speed * oneWaySec);
      // Frozen solid: inputs still maintain trigger bookkeeping (so nothing
      // fires spuriously on unfreeze) but no action or movement happens.
      const frozen = player.frozenTicks > 0;
      if (input.direction && !frozen) player.facing = input.direction; // aims the skills too
      // Space is one button: while a skill is held it triggers that skill and
      // places no bombs, and it fires on the press (a held trigger would burn
      // the whole magazine at the cooldown's rate).
      // A press that started as a skill trigger stays one until the key comes
      // back up: emptying the magazine mid-hold must not turn into a bomb.
      const armed = player.gunAmmo > 0 || player.hammerUses > 0 || player.mineAmmo > 0;
      const pressed = input.placeBomb && !player.triggerHeld;
      player.triggerHeld = input.placeBomb;
      if (!input.placeBomb) player.skillTriggerHeld = false;
      else if (armed) player.skillTriggerHeld = true;
      if (input.placeBomb && !armed && !player.skillTriggerHeld && !frozen) {
        this.placeBomb(player, events);
      }
      if (player.actionCooldown > 0) player.actionCooldown--;
      if (!frozen) {
        if (input.fireGun || (pressed && player.gunAmmo > 0)) this.fireGun(player, events);
        if (input.swingHammer || (pressed && player.hammerUses > 0)) this.swingHammer(player, events);
        if (input.placeMine || (pressed && player.mineAmmo > 0)) this.placeMine(player, events);
      }
      stepPlayer(this.world, player, input.direction ?? null);
      if (player.frozenTicks > 0) player.frozenTicks--;
    }
```

(`stepPlayer` also guards internally — both are kept so prediction, which calls `stepPlayer` directly, matches.)

- [ ] **Step 4: Run the freeze tests — expect PASS.** Then run the whole shared suite (`node_modules/.bin/vitest run` in `packages/shared`) — expect PASS; existing tests must not break (creation adds one field; weights change only adds an eighth entry, `powerupTypeForRoll` unchanged for old rolls below the old total... NOTE: total weight went 21 → 22, so rolls map slightly differently. If a seeded test asserts a specific drop type and now fails, inspect — the fix is updating the seed/expectation in that test, not reverting the weight).

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): freeze-time powerup — freezes all other players 5s"
```

---

### Task 2: Server — replicate frozenTicks

**Files:**
- Modify: `packages/server/src/rooms/schema.ts` (PlayerSchema ~line 24, copySimToSchema ~line 113)

**Interfaces:**
- Consumes: `Player.frozenTicks` from Task 1.
- Produces: `PlayerSchema.frozenTicks` replicated field (clients read it as `NetPlayer.frozenTicks` in Task 3).

- [ ] **Step 1: Add the field** — in `PlayerSchema` after `mineAmmo`:

```typescript
  /** >0 = frozen by a freeze-time pickup; clients tint the sprite from it. */
  @type('number') frozenTicks = 0;
```

- [ ] **Step 2: Copy it** — in `copySimToSchema` player loop after `ps.mineAmmo = player.mineAmmo;`:

```typescript
    ps.frozenTicks = player.frozenTicks;
```

- [ ] **Step 3: Run server tests + typecheck**

Run in `packages/server`: `node_modules/.bin/vitest run` and `node_modules/.bin/tsc --noEmit` (use the project's build/typecheck script if one exists — check `packages/server/package.json`).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server
git commit -m "feat(server): replicate frozenTicks to clients"
```

---

### Task 3: Client — asset, prediction, tint, skills table

**Files:**
- Modify: `packages/client/src/net.ts` (NetPlayer ~line 37)
- Modify: `packages/client/src/prediction.ts` (apply ~line 85)
- Modify: `packages/client/src/textures.ts` (page consts ~line 29, TEX.powerup ~line 100, tint consts ~line 56)
- Modify: `packages/client/src/scenes/BootScene.ts` (preload ~line 18)
- Modify: `packages/client/src/scenes/GameScene.ts` (RenderPlayer ~line 286, predictedFromNet ~line 309, renderStateFromRoom ~line 957, tint block ~line 1363)
- Modify: `packages/client/src/skillsTable.ts` (SKILLS ~line 29)

**Interfaces:**
- Consumes: `PowerupType.FreezeTime`, `FREEZE_DURATION_TICKS`, `MovementPlayer.frozenTicks` (Task 1), `NetPlayer.frozenTicks` wire field (Task 2). Asset file `packages/client/public/assets/freeze-time.png` (already present).
- Produces: nothing consumed later; final task.

- [ ] **Step 1: net.ts** — add to `NetPlayer` after `mineAmmo`:

```typescript
  /** >0 = frozen by a freeze-time pickup. */
  frozenTicks: number;
```

- [ ] **Step 2: prediction.ts** — mirror the sim's ordering in `apply` (guard inside `stepPlayer` blocks movement; decrement after it; bomb placement gated):

```typescript
  private apply(
    input: PendingInput,
    grid: TileType[][],
    ice: boolean[][],
    serverBombs: Obstacle[],
  ): void {
    if (!this.player.alive) return;
    if (this.player.kickTicks > 0) this.player.kickTicks--;
    if (input.placeBomb && this.player.frozenTicks <= 0) {
      this.tryPlaceBomb(input.seq, grid, serverBombs);
    }
    const world: MovementWorld = {
      grid,
      ice,
      bombs: this.obstacles(serverBombs).map(asMovementBomb),
    };
    stepPlayer(world, this.player, input.direction);
    if (this.player.frozenTicks > 0) this.player.frozenTicks--;
  }
```

Update the doc comment on `apply` ("Mirrors GameImpl.tick order: kick timer, bomb placement, movement, freeze countdown.").

- [ ] **Step 3: textures.ts** —

After `MINE_FRAMES`:

```typescript
/** Standalone page (not in the atlas): the freeze-time powerup art. */
export const FREEZE_PAGE = 'freeze-time';
```

Near `KICK_TINT`:

```typescript
/** Tint applied to frozen players (ice blue). */
export const FREEZE_TINT = 0x7fd4ff;
```

In `TEX.powerup`:

```typescript
    [PowerupType.FreezeTime]: { key: FREEZE_PAGE, frame: '__BASE' },
```

(`'__BASE'` is Phaser's implicit whole-image frame for `load.image` textures; `addImage(scene, x, y, ref)` passes it straight through and it renders the full png.)

- [ ] **Step 4: BootScene.ts** — import `FREEZE_PAGE` alongside `MINE_PAGE` and add next to the mine load:

```typescript
    this.load.image(FREEZE_PAGE, `assets/${FREEZE_PAGE}.png`);
```

- [ ] **Step 5: GameScene.ts** —

`RenderPlayer` gains (after `mineAmmo`):

```typescript
  frozenTicks: number;
```

`predictedFromNet` gains (after `kickTicks: p.kickTicks,`):

```typescript
    frozenTicks: p.frozenTicks,
```

`renderStateFromRoom` player mapping gains (after `kickTicks: p.kickTicks,`):

```typescript
        frozenTicks: p.frozenTicks,
```

Tint block (~line 1363) — frozen wins over kick:

```typescript
      // Frozen: solid ice tint beats every kick tint for the duration.
      const warning = player.kickTicks > 0 && player.kickTicks <= KICK_WARNING_TICKS;
      const blinkOn = Math.floor(player.kickTicks / 5) % 2 === 0;
      if (player.frozenTicks > 0) sprite.setTint(FREEZE_TINT);
      else if (player.kickTicks > KICK_WARNING_TICKS) sprite.setTint(KICK_TINT);
      else if (warning) {
        if (blinkOn) sprite.setTint(KICK_WARNING_TINT);
        else sprite.clearTint();
      } else sprite.clearTint();
```

Import `FREEZE_TINT` in the existing textures import.

- [ ] **Step 6: skillsTable.ts** — append after the Mine row:

```typescript
  {
    type: PowerupType.FreezeTime,
    name: 'Freeze Time',
    effect: 'freezes all enemies for 5s the moment you grab it',
  },
```

(No `key`: it is instant on pickup, not a held skill.)

- [ ] **Step 7: Run client tests + typecheck**

Run in `packages/client`: `node_modules/.bin/vitest run` and the package's typecheck/build script (check `packages/client/package.json`; likely `tsc` and/or `vite build`).
Expected: PASS. Missing `frozenTicks` in any object literal implementing `MovementPlayer`/`PredictedPlayer`/`RenderPlayer` will surface here — fix by adding the field with 0.

- [ ] **Step 8: Commit**

```bash
git add packages/client
git commit -m "feat(client): freeze-time pickup art, prediction, and frozen tint"
```

---

### Task 4: Full verification

- [ ] **Step 1:** From repo root: `npm test` (all workspaces) — expect PASS.
- [ ] **Step 2:** Repo-wide typecheck/build (`npm run build` if present at root; otherwise per-package).
- [ ] **Step 3:** Grep for stragglers: `rg -n "frozenTicks" packages | grep -v test` — every structural implementer of Player/MovementPlayer/NetPlayer/RenderPlayer should carry the field (check `packages/shared/src/bot.ts` and the server's `/debug/sim` payload if it lists player fields explicitly).
- [ ] **Step 4:** Commit anything outstanding.

---

## Self-review notes

- Spec coverage: pickup semantics (Task 1), replication (Task 2), art + tint + prediction + skills table (Task 3). Spec's "brief pickup flash on the picker" is intentionally dropped: the map-wide tint IS the feedback; noted as a deviation to raise at review.
- Weight-total change (21→22) can shift seeded drop expectations in existing tests — Task 1 Step 4 covers it.
- Bots need no change (guards drop their inputs), matching the spec.
