# Shield Powerup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New Shield powerup: 7 seconds of immunity to all player-inflicted damage (explosions, mine blasts, gun, hammer); sudden death still kills.

**Architecture:** Authoritative sim lives in `packages/shared` (`game.ts` runs identically offline on the client and online on the server). A new `Player.shieldTicks` counter is set on pickup, decremented per tick, and checked at the kill sites. The server mirrors it into the Colyseus schema; the client renders a gold tint + last-2s blink and shows the powerup icon extracted from `winter_map.png` into atlas page `gameplay7`.

**Tech Stack:** TypeScript monorepo (npm workspaces), vitest (shared tests), Colyseus (server sync), Phaser 3 (client), Python 3 + PIL (asset extraction script).

## Global Constraints

- `PowerupType` enum is append-only — wire protocol sends numeric values. `Shield` MUST be appended after `Mine` (index 7). Never reorder.
- Spec: `docs/superpowers/specs/2026-08-04-shield-powerup-design.md`.
- `SHIELD_DURATION_TICKS = 140` (7 s at 20 tps), `SHIELD_WARNING_TICKS = 40` (last 2 s blink).
- Shield is passive: `applyPowerup` must NOT call `clearSkills` for it. Held weapons are kept.
- Sudden death (`applySuddenDeath`) kills through shield — do not guard it.
- Run tests with the binary directly (`node_modules/.bin/vitest`), NOT `npx` — the rtk shell hook corrupts npx exit codes.
- NEVER build files with shell `>` redirection (rtk hook corrupts it); the Python script writes all files itself.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Shared sim — shieldTicks, pickup, kill guards

**Files:**
- Modify: `packages/shared/src/types.ts` (enum + `Player`)
- Modify: `packages/shared/src/constants.ts` (durations, weights)
- Modify: `packages/shared/src/game.ts` (pickup, decrement, kill guards, init)
- Test: `packages/shared/test/shield.test.ts` (new)

**Interfaces:**
- Consumes: existing sim (`createGame`, `Game`, `Player`).
- Produces: `PowerupType.Shield` (= 7), `SHIELD_DURATION_TICKS = 140`, `SHIELD_WARNING_TICKS = 40`, `Player.shieldTicks: number` (0 = none). Later tasks rely on these exact names.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/shield.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  GUN_AMMO_PER_PICKUP,
  MINE_ARM_TICKS,
  POWERUP_TYPE_COUNT,
  POWERUP_WEIGHTS,
  SHIELD_DURATION_TICKS,
  SUDDEN_DEATH_START_TICKS,
} from '../src/constants';
import { createGame } from '../src/game';
import type { Game, GameEvent } from '../src/game';
import { SHRINK_ORDER } from '../src/suddenDeath';
import { PowerupType, TileType } from '../src/types';
import type { Bomb, PlayerInput } from '../src/types';

const SEED_NO_DROP = 1; // first roll fails POWERUP_DROP_CHANCE

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

function ofType<T extends GameEvent['type']>(
  events: GameEvent[],
  type: T,
): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
}

function twoPlayerGame(): Game {
  return createGame({ seed: SEED_NO_DROP, playerIds: ['p1', 'p2'], grid: openGrid() });
}

/** A due bomb parked directly in the state (fuse 1 => detonates next tick). */
function dueBomb(col: number, row: number, ownerId = 'p1'): Bomb {
  return {
    id: 99,
    col,
    row,
    ownerId,
    fuseTicks: 1,
    blastRadius: 1,
    slideDC: 0,
    slideDR: 0,
    slideCooldown: 0,
    slideInterval: 0,
  };
}

describe('shield constants', () => {
  it('shield is enum index 7 with drop weight 1', () => {
    expect(PowerupType.Shield).toBe(7);
    expect(POWERUP_TYPE_COUNT).toBe(8);
    expect(POWERUP_WEIGHTS).toEqual([6, 6, 3, 3, 1, 1, 1, 1]);
    expect(SHIELD_DURATION_TICKS).toBe(140);
  });
});

describe('shield pickup', () => {
  it('sets shieldTicks and keeps held weapons', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.gunAmmo = GUN_AMMO_PER_PICKUP;
    game.state.powerups.push({
      col: Math.round(p1.x),
      row: Math.round(p1.y),
      type: PowerupType.Shield,
    });

    const events = run(game, 1);

    expect(ofType(events, 'powerupCollected')).toHaveLength(1);
    // Collection happens after the per-player decrement, so the first full
    // tick of immunity is counted on the next tick.
    expect(p1.shieldTicks).toBe(SHIELD_DURATION_TICKS);
    expect(p1.gunAmmo).toBe(GUN_AMMO_PER_PICKUP); // passive: weapons kept
  });

  it('re-pickup refreshes the timer to full', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.shieldTicks = 10;
    game.state.powerups.push({
      col: Math.round(p1.x),
      row: Math.round(p1.y),
      type: PowerupType.Shield,
    });

    run(game, 1);

    expect(p1.shieldTicks).toBe(SHIELD_DURATION_TICKS);
  });

  it('counts down one per tick and expires', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    p1.shieldTicks = 5;

    run(game, 5);
    expect(p1.shieldTicks).toBe(0);
    run(game, 1);
    expect(p1.shieldTicks).toBe(0); // never negative
  });
});

describe('shield vs attacks', () => {
  it('survives a bomb blast; the same blast without shield kills', () => {
    for (const shielded of [true, false]) {
      const game = twoPlayerGame();
      const p2 = player(game, 'p2');
      p2.x = 5;
      p2.y = 5;
      if (shielded) p2.shieldTicks = SHIELD_DURATION_TICKS;
      game.state.bombs.push(dueBomb(5, 5));

      const events = run(game, 1);

      expect(ofType(events, 'bombExploded')).toHaveLength(1);
      expect(p2.alive).toBe(shielded);
    }
  });

  it('survives standing in a lingering explosion for the whole shield', () => {
    const game = twoPlayerGame();
    const p2 = player(game, 'p2');
    p2.x = 5;
    p2.y = 5;
    p2.shieldTicks = SHIELD_DURATION_TICKS;
    game.state.bombs.push(dueBomb(5, 5));

    run(game, 3); // explosion cells persist EXPLOSION_DURATION_TICKS

    expect(p2.alive).toBe(true);
  });

  it('triggers an armed mine but survives its blast', () => {
    const game = twoPlayerGame();
    const p2 = player(game, 'p2');
    p2.x = 5;
    p2.y = 5;
    p2.shieldTicks = SHIELD_DURATION_TICKS;
    game.state.mines.push({ id: 99, col: 5, row: 5, ownerId: 'p1', ticks: MINE_ARM_TICKS });

    const events = run(game, 1);

    expect(ofType(events, 'mineExploded')).toHaveLength(1); // mine is spent
    expect(p2.alive).toBe(true);
  });

  it('absorbs a gun shot: ray stops on the shielded player, no kill', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    const p2 = player(game, 'p2');
    p1.x = 1;
    p1.y = 1;
    p1.facing = 'right';
    p1.gunAmmo = 1;
    p2.x = 4;
    p2.y = 1;
    p2.shieldTicks = SHIELD_DURATION_TICKS;

    const events = run(game, 1, { p1: act({ fireGun: true }) });

    const [shot] = ofType(events, 'gunFired');
    expect([shot.hitCol, shot.hitRow]).toEqual([4, 1]); // absorbed, not passed through
    expect(p2.alive).toBe(true);
    expect(ofType(events, 'playerDied')).toHaveLength(0);
  });

  it('shrugs off a hammer strike', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    const p2 = player(game, 'p2');
    p1.x = 1;
    p1.y = 1;
    p1.facing = 'right';
    p1.hammerUses = 1;
    p2.x = 2;
    p2.y = 1;
    p2.shieldTicks = SHIELD_DURATION_TICKS;

    const events = run(game, 1, { p1: act({ swingHammer: true }) });

    expect(ofType(events, 'hammerSwung')).toHaveLength(1); // swing is spent
    expect(p2.alive).toBe(true);
  });

  it('sudden death kills through the shield', () => {
    const game = twoPlayerGame();
    const p1 = player(game, 'p1');
    const p2 = player(game, 'p2');
    // park p1 safely in the center, p2 on the first shrink tile
    p1.x = 7;
    p1.y = 6;
    p2.x = SHRINK_ORDER[0].col;
    p2.y = SHRINK_ORDER[0].row;
    p2.shieldTicks = SHIELD_DURATION_TICKS;
    game.state.tick = SUDDEN_DEATH_START_TICKS - 1; // next tick is the first shrink

    const events = run(game, 1);

    expect(ofType(events, 'arenaShrink')).toHaveLength(1);
    expect(p2.alive).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && ../../node_modules/.bin/vitest run test/shield.test.ts`
Expected: FAIL — `PowerupType.Shield` undefined / `SHIELD_DURATION_TICKS` not exported / `shieldTicks` missing.

- [ ] **Step 3: Implement**

`packages/shared/src/types.ts`:

1. Append to the enum (after `Mine`):

```ts
export enum PowerupType {
  ExtraBomb,
  BiggerBlast,
  Speed,
  Kick,
  Gun,
  Hammer,
  Mine, // append only: the wire protocol sends these values
  Shield,
}
```

2. Add to `Player` (after `mineAmmo: number;`):

```ts
  shieldTicks: number; // remaining immunity ticks, 0 = no shield
```

`packages/shared/src/constants.ts`:

1. `POWERUP_TYPE_COUNT` becomes 8; update the weights comment and array:

```ts
export const POWERUP_TYPE_COUNT = 8;

/**
 * Relative drop weights per PowerupType, in enum order
 * (ExtraBomb, BiggerBlast, Speed, Kick, Gun, Hammer, Mine, Shield).
 * Bomb count and blast radius are the common drops; the weapons and the
 * shield are rare.
 */
export const POWERUP_WEIGHTS = [6, 6, 3, 3, 1, 1, 1, 1] as const;
```

2. Next to the other skill constants (after `MINE_AMMO_PER_PICKUP`):

```ts
/** Shield immunity window (7s at 20tps); blocks every attack except sudden death. */
export const SHIELD_DURATION_TICKS = 140;
export const SHIELD_WARNING_TICKS = 40; // last 2s: the client blinks the tint
```

`packages/shared/src/game.ts`:

1. Import `SHIELD_DURATION_TICKS` from `./constants`.
2. In `applyPowerup`, add a case (NOT calling `clearSkills` — passive buff, sits outside the exclusive skill slot):

```ts
    case PowerupType.Shield:
      player.shieldTicks = SHIELD_DURATION_TICKS;
      break;
```

3. In `tick()`, next to the kick decrement (`if (player.kickTicks > 0) player.kickTicks--;`):

```ts
      if (player.shieldTicks > 0) player.shieldTicks--;
```

4. In the constructor's player initializer, after `mineAmmo: 0,`:

```ts
        shieldTicks: 0,
```

5. Kill guards. In `fireGun`, the ray must still STOP on a shielded player (shot absorbed) — only the kill is skipped. Change the final line:

```ts
    else if (victim && victim.shieldTicks <= 0) this.killPlayer(victim, events);
```

In `swingHammer`, change the final two lines:

```ts
    const victim = this.alivePlayerAt(col, row, player);
    if (victim && victim.shieldTicks <= 0) this.killPlayer(victim, events);
```

In `applyDeaths` (covers bomb AND mine blasts — mines detonate through the shared explosion-cell path), guard the burn check:

```ts
    for (const player of s.players) {
      if (!player.alive || player.shieldTicks > 0) continue;
      const col = Math.round(player.x);
      const row = Math.round(player.y);
      if (burning.has(tileKey(col, row))) this.killPlayer(player, events);
    }
```

Do NOT touch `applySuddenDeath` (kills through shield) or `tickMines` (a shielded player still triggers an armed mine; the blast then hits nobody).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && ../../node_modules/.bin/vitest run test/shield.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Run the whole shared suite (regressions: weights array length feeds `powerupTypeForRoll`)**

Run: `cd packages/shared && ../../node_modules/.bin/vitest run`
Expected: PASS. If `game.test.ts` asserts on `POWERUP_TYPE_COUNT`/weights, update those assertions to the new values.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/constants.ts packages/shared/src/game.ts packages/shared/test/shield.test.ts
git commit -m "feat(shared): shield powerup — 7s immunity, sudden death exempt"
```

---

### Task 2: Server + net sync of shieldTicks

**Files:**
- Modify: `packages/server/src/rooms/schema.ts` (schema field + mirror)
- Modify: `packages/server/src/rooms/GameRoom.ts` (lobby reset block, ~line 355)
- Modify: `packages/client/src/net.ts` (NetPlayer typing)

**Interfaces:**
- Consumes: `Player.shieldTicks` from Task 1.
- Produces: `PlayerSchema.shieldTicks` / `NetPlayer.shieldTicks` (number), synced every tick. Task 4's render adapter reads `NetPlayer.shieldTicks`.

- [ ] **Step 1: Add the schema field**

In `packages/server/src/rooms/schema.ts`, `PlayerSchema`, after `@type('number') mineAmmo = 0;`:

```ts
  @type('number') shieldTicks = 0;
```

In `copySimToSchema`, after `ps.mineAmmo = player.mineAmmo;`:

```ts
    ps.shieldTicks = player.shieldTicks;
```

- [ ] **Step 2: Reset it between matches**

In `packages/server/src/rooms/GameRoom.ts`, the lobby-reset loop that zeroes `ps.kickTicks/gunAmmo/hammerUses/mineAmmo` (~line 355), add after `ps.mineAmmo = 0;`:

```ts
      ps.shieldTicks = 0;
```

- [ ] **Step 3: Type it on the client**

In `packages/client/src/net.ts`, `NetPlayer`, after `mineAmmo: number;`:

```ts
  shieldTicks: number;
```

- [ ] **Step 4: Verify server package builds**

Run: `cd packages/server && ../../node_modules/.bin/tsc --noEmit`
Expected: clean. (Client typecheck happens in Task 4 — `net.ts` alone introduces no errors.)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/rooms/schema.ts packages/server/src/rooms/GameRoom.ts packages/client/src/net.ts
git commit -m "feat(server): sync shieldTicks through the player schema"
```

---

### Task 3: Extract winter_shield atlas frame

**Files:**
- Modify: `scripts/extract_winter_assets.py`
- Regenerates: `packages/client/public/assets/gameplay7.png`, `packages/client/public/assets/gameplay.atlas` (gameplay7 section replaced in place — script is idempotent)

**Interfaces:**
- Consumes: `winter_map.png` (shield art alpha bbox: left 572, top 1497, right 751, bottom 1712 — verified by connected-component analysis).
- Produces: atlas frame `winter_shield` (64x64, xy 394,68 on page gameplay7). Task 4 references `{ key: 'gameplay7', frame: 'winter_shield' }`.

- [ ] **Step 1: Add the crop box**

In `scripts/extract_winter_assets.py`, after `BOX_SNOWBLOCK`:

```python
BOX_SHIELD = (572, 1497, 751, 1712)  # gold shield with the cross-star emblem
```

- [ ] **Step 2: Add the frame + placement**

In `build_page()`, add to the `frames` dict:

```python
        "winter_shield": fit_center(trim(sheet.crop(BOX_SHIELD))),
```

Add to `placement` (the free 64x64 slot on the second row):

```python
        ("winter_shield", 394, 68),
```

- [ ] **Step 3: Run the script**

Run: `python3 scripts/extract_winter_assets.py`
Expected output includes: `winter_shield  xy: 394,  68  size:  64,  64` and `updated .../gameplay.atlas`.

- [ ] **Step 4: Verify the atlas entry**

Run: `grep -A2 winter_shield packages/client/public/assets/gameplay.atlas`
Expected: `winter_shield` with `xy: 394, 68`.

- [ ] **Step 5: Commit**

```bash
git add scripts/extract_winter_assets.py packages/client/public/assets/gameplay7.png packages/client/public/assets/gameplay.atlas
git commit -m "feat(client): extract winter_shield frame onto gameplay7"
```

---

### Task 4: Client rendering — icon, tint, badge, skills table

**Files:**
- Modify: `packages/client/src/textures.ts`
- Modify: `packages/client/src/scenes/GameScene.ts`
- Modify: `packages/client/src/skillsTable.ts`

**Interfaces:**
- Consumes: `PowerupType.Shield`, `SHIELD_WARNING_TICKS` (Task 1), `NetPlayer.shieldTicks` (Task 2), frame `winter_shield` (Task 3).
- Produces: user-visible shield rendering; no downstream consumers.

- [ ] **Step 1: Powerup icon**

`packages/client/src/textures.ts`, in `TEX.powerup`:

```ts
    [PowerupType.Shield]: { key: G7, frame: 'winter_shield' },
```

Below `KICK_TINT`, add:

```ts
/** Tint applied to shielded players (gold). */
export const SHIELD_TINT = 0xffd54a;
```

- [ ] **Step 2: RenderPlayer + adapter**

`packages/client/src/scenes/GameScene.ts`:

1. `RenderPlayer` interface, after `mineAmmo: number;`:

```ts
  shieldTicks: number;
```

(Offline mode passes the sim's `Player` structurally — it already has the field after Task 1.)

2. In `renderStateFromRoom()`, in the `players.push({ ... })` literal after `mineAmmo: p.mineAmmo,`:

```ts
        shieldTicks: p.shieldTicks,
```

- [ ] **Step 3: Tint + blink**

In the player-positioning loop (the existing kick-tint block), import `SHIELD_WARNING_TICKS` from `@bomberman/shared` and `SHIELD_TINT` from `../textures`, then replace the kick block with a priority chain — shield outranks kick (survival beats a movement perk):

```ts
      // Shield outranks kick: solid gold tint, blinking over the last 2s.
      // Kick keeps its cyan/red scheme when no shield is up.
      const shieldWarning = player.shieldTicks > 0 && player.shieldTicks <= SHIELD_WARNING_TICKS;
      const shieldBlinkOn = Math.floor(player.shieldTicks / 5) % 2 === 0;
      const warning = player.kickTicks > 0 && player.kickTicks <= KICK_WARNING_TICKS;
      const blinkOn = Math.floor(player.kickTicks / 5) % 2 === 0;
      if (player.shieldTicks > SHIELD_WARNING_TICKS) sprite.setTint(SHIELD_TINT);
      else if (shieldWarning) {
        if (shieldBlinkOn) sprite.setTint(SHIELD_TINT);
        else sprite.clearTint();
      } else if (player.kickTicks > KICK_WARNING_TICKS) sprite.setTint(KICK_TINT);
      else if (warning) {
        if (blinkOn) sprite.setTint(KICK_WARNING_TINT);
        else sprite.clearTint();
      } else sprite.clearTint();
```

(`warning`/`blinkOn` stay defined — `updateSkillBadges(player, sprite, warning, blinkOn)` on the next line consumes them unchanged.)

- [ ] **Step 4: Overhead badge**

In `SKILL_BADGES` (top of GameScene.ts), append:

```ts
  { key: 'shield', type: PowerupType.Shield, value: (p) => p.shieldTicks, showCount: false },
```

- [ ] **Step 5: Skills table row**

`packages/client/src/skillsTable.ts`, append to `SKILLS`:

```ts
  {
    type: PowerupType.Shield,
    name: 'Shield',
    effect: 'no damage for 7s — bombs, mines, gun & hammer bounce off',
  },
```

- [ ] **Step 6: Typecheck + build client**

Run: `cd packages/client && ../../node_modules/.bin/tsc --noEmit && ../../node_modules/.bin/vite build`
Expected: clean typecheck, successful build.

- [ ] **Step 7: Smoke test offline**

Run the dev client (`make dev` or `npm run dev -w @bomberman/client`), start an offline match, and use the browser console/debug to confirm the shield icon renders when a Shield powerup drops (weight 1 — may take a few block breaks). Verify gold tint on pickup and blink near expiry.

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/textures.ts packages/client/src/scenes/GameScene.ts packages/client/src/skillsTable.ts
git commit -m "feat(client): render shield powerup — icon, gold tint, badge, table row"
```
