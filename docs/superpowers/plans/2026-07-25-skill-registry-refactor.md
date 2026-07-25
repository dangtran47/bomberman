# Skill Strategy Registry Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize gun/hammer weapon logic into a strategy-pattern skill registry so a new active skill lands as ~1 shared file + 1 client registry entry instead of ~11 scattered touch points.

**Architecture:** A shared `SkillDef` registry (strategy pattern) owns per-skill behavior; `GameImpl` exposes capability methods through a `SkillContext` and dispatches one generic `useSkill` path. Player state generalizes to `skill: PowerupType | null` + `skillCharges`. The client gets a mirror view registry (name, texture, FX renderers). Spec: `docs/superpowers/specs/2026-07-25-skill-registry-refactor-design.md`.

**Tech Stack:** TypeScript (npm workspaces), Vitest, Colyseus (server sync), Phaser (client).

## Global Constraints

- No gameplay behavior change: gun, hammer, kick, ice, bombs play exactly as before. Charge accounting preserved: gun spends a shot even when the ray leaves the grid; a hammer swing aimed off-grid is a no-op costing nothing.
- Sole intentional input change: E/Q direct-key aliases removed — Space is the only skill trigger.
- Kick (`kickTicks`) and ice are untouched, except the skill-exclusivity rule (picking up any of kick/gun/hammer clears the others) must keep working.
- Determinism: the sim must not gain any new RNG or iteration-order dependence. Never call `Math.random`.
- Space trigger semantics preserved verbatim: fires the held skill on the press only; a press that started as a skill trigger never turns into a bomb until released (`triggerHeld` / `skillTriggerHeld`).
- Server and client deploy together — no wire-protocol back-compat shims.
- Run tests with the vitest binary directly when an exit code matters: `node_modules/.bin/vitest run` from the package directory (do not pipe through wrappers).

## File Structure

```
packages/shared/src/skills/types.ts      (new) SkillDef + SkillContext interfaces
packages/shared/src/skills/gun.ts        (new) gun strategy (logic moved from GameImpl.fireGun)
packages/shared/src/skills/hammer.ts     (new) hammer strategy (moved from GameImpl.swingHammer)
packages/shared/src/skills/registry.ts   (new) SKILLS map + isSkillPowerup()
packages/shared/src/types.ts             Player: skill/skillCharges; PlayerInput: useSkill
packages/shared/src/constants.ts         export DIRECTION_STEPS (moved from game.ts)
packages/shared/src/game.ts              generic dispatch; delete fireGun/swingHammer
packages/shared/src/bot.ts               registry-driven weapon selection
packages/shared/src/index.ts             export skills module
packages/server/src/rooms/inputBuffer.ts useSkill flag
packages/server/src/rooms/schema.ts      skillType/skillCharges
packages/server/src/rooms/GameRoom.ts    rematch reset of new fields
packages/client/src/skills/registry.ts   (new) per-skill view: name, effect, FX renderers
packages/client/src/skillsTable.ts       skill rows sourced from view registry
packages/client/src/controls.ts          drop GUN_KEY/HAMMER_KEY
packages/client/src/net.ts               NetPlayer: skillType/skillCharges
packages/client/src/scenes/GameScene.ts  generic badge/FX/trigger paths
```

---

### Task 1: Shared skills module (types, gun, hammer, registry)

**Files:**
- Create: `packages/shared/src/skills/types.ts`
- Create: `packages/shared/src/skills/gun.ts`
- Create: `packages/shared/src/skills/hammer.ts`
- Create: `packages/shared/src/skills/registry.ts`
- Modify: `packages/shared/src/constants.ts` (add `DIRECTION_STEPS`)
- Modify: `packages/shared/src/index.ts` (export registry + types)
- Test: `packages/shared/test/skillRegistry.test.ts`

**Interfaces:**
- Consumes: existing `Player`, `PowerupType`, `TileType`, `Bomb` from `../types`; `GameEvent`, `GameState` (type-only) from `../game`; constants.
- Produces: `SkillDef`, `SkillContext` (from `skills/types`), `SKILLS: ReadonlyMap<PowerupType, SkillDef>`, `isSkillPowerup(type: PowerupType): boolean`, `gunSkill`, `hammerSkill`, and `DIRECTION_STEPS: Record<Direction, [dc: number, dr: number]>` exported from `constants.ts`. Task 2 wires `GameImpl` to these; Task 3 uses `botAim`/`botAttackChance`.

Note: this task adds new files that nothing consumes yet — the existing suite must stay green and the new registry test must pass. `import type` from `../game` is safe (type-only, erased at runtime; no runtime cycle).

- [ ] **Step 1: Write the failing test**

`packages/shared/test/skillRegistry.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  GUN_AMMO_PER_PICKUP,
  HAMMER_USES_PER_PICKUP,
  SKILL_ACTION_COOLDOWN_TICKS,
  BOT_GUN_ATTACK_CHANCE,
  BOT_HAMMER_ATTACK_CHANCE,
} from '../src/constants';
import { SKILLS, isSkillPowerup } from '../src/skills/registry';
import { PowerupType } from '../src/types';

describe('skill registry', () => {
  it('contains gun and hammer with their pickup/cooldown/bot config', () => {
    const gun = SKILLS.get(PowerupType.Gun);
    expect(gun).toBeDefined();
    expect(gun!.chargesPerPickup).toBe(GUN_AMMO_PER_PICKUP);
    expect(gun!.cooldownTicks).toBe(SKILL_ACTION_COOLDOWN_TICKS);
    expect(gun!.botAim).toBe('ray');
    expect(gun!.botAttackChance).toBe(BOT_GUN_ATTACK_CHANCE);

    const hammer = SKILLS.get(PowerupType.Hammer);
    expect(hammer).toBeDefined();
    expect(hammer!.chargesPerPickup).toBe(HAMMER_USES_PER_PICKUP);
    expect(hammer!.cooldownTicks).toBe(SKILL_ACTION_COOLDOWN_TICKS);
    expect(hammer!.botAim).toBe('melee');
    expect(hammer!.botAttackChance).toBe(BOT_HAMMER_ATTACK_CHANCE);
  });

  it('isSkillPowerup is true only for registered active skills', () => {
    expect(isSkillPowerup(PowerupType.Gun)).toBe(true);
    expect(isSkillPowerup(PowerupType.Hammer)).toBe(true);
    // Kick is exclusive with the active skills but passive - not in the registry.
    expect(isSkillPowerup(PowerupType.Kick)).toBe(false);
    expect(isSkillPowerup(PowerupType.ExtraBomb)).toBe(false);
    expect(isSkillPowerup(PowerupType.BiggerBlast)).toBe(false);
    expect(isSkillPowerup(PowerupType.Speed)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/shared`): `node_modules/.bin/vitest run test/skillRegistry.test.ts`
Expected: FAIL — cannot resolve `../src/skills/registry`.

- [ ] **Step 3: Add `DIRECTION_STEPS` to constants.ts**

Append to `packages/shared/src/constants.ts` (it needs the `Direction` type — add the import at the top of the file):

```typescript
import type { Direction } from './types';
```

```typescript
/** Grid delta per facing direction, shared by the sim and the skills. */
export const DIRECTION_STEPS: Record<Direction, [dc: number, dr: number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};
```

(`types.ts` does not import `constants.ts`, so this creates no cycle. Leave the identical local `DIRECTION_STEPS` in `game.ts` alone for now — Task 2 deletes it.)

- [ ] **Step 4: Create `packages/shared/src/skills/types.ts`**

```typescript
import type { GameEvent, GameState } from '../game';
import type { Player, PowerupType } from '../types';

/**
 * Capabilities the simulation hands a skill for one activation. Implemented by
 * GameImpl with the tick's event list captured, so skills never see the list.
 * The set grows as future skills need more (spawnBomb, status effects, ...).
 */
export interface SkillContext {
  readonly state: GameState;
  emit(event: GameEvent): void;
  /** Living rival on the tile (excluding `except`), if any. */
  alivePlayerAt(col: number, row: number, except: Player): Player | undefined;
  /** Destroys a soft block: same event + powerup drop roll as an explosion ray. */
  destroySoftBlock(col: number, row: number): void;
  killPlayer(victim: Player): void;
}

/**
 * One active skill (strategy pattern). Registered in skills/registry.ts;
 * the sim dispatches to `onActivate` and owns charge/cooldown accounting.
 */
export interface SkillDef {
  readonly type: PowerupType;
  readonly chargesPerPickup: number;
  readonly cooldownTicks: number;
  /** Bot aiming model: 'ray' scans the facing line, 'melee' checks the adjacent tile. */
  readonly botAim: 'ray' | 'melee';
  /** Fraction of ready ticks the bot attacks a lined-up enemy (dodge-window nerf). */
  readonly botAttackChance: number;
  /** Performs the skill. Returns false when nothing happened - no charge or cooldown is spent. */
  onActivate(player: Player, ctx: SkillContext): boolean;
}
```

- [ ] **Step 5: Create `packages/shared/src/skills/gun.ts`**

The body is `GameImpl.fireGun` (`game.ts:281-341`) with `this.` helpers swapped for `ctx.` and the charge/cooldown guard removed (the dispatcher owns it now). Preserve the ray-walk order exactly — hard block, soft block, bomb, victim — it fixes RNG consumption order:

```typescript
import {
  BOT_GUN_ATTACK_CHANCE,
  DIRECTION_STEPS,
  GRID_HEIGHT,
  GRID_WIDTH,
  GUN_AMMO_PER_PICKUP,
  SKILL_ACTION_COOLDOWN_TICKS,
} from '../constants';
import { PowerupType, TileType } from '../types';
import type { Bomb, Player } from '../types';
import type { SkillDef } from './types';

/**
 * Fires one shot along `facing` from the shooter's tile. The ray stops on the
 * first hard block, soft block (destroyed, with a blast's drop roll) or rival
 * player (killed); a bomb takes the shot and goes off with it. A shot is spent
 * even when the ray leaves the grid.
 */
export const gunSkill: SkillDef = {
  type: PowerupType.Gun,
  chargesPerPickup: GUN_AMMO_PER_PICKUP,
  cooldownTicks: SKILL_ACTION_COOLDOWN_TICKS,
  botAim: 'ray',
  botAttackChance: BOT_GUN_ATTACK_CHANCE,
  onActivate(player, ctx) {
    const s = ctx.state;
    const col = Math.round(player.x);
    const row = Math.round(player.y);
    const [dc, dr] = DIRECTION_STEPS[player.facing];
    let hitCol: number | null = null;
    let hitRow: number | null = null;
    let softHit = false;
    let victim: Player | undefined;
    let shotBomb: Bomb | undefined;

    for (let step = 1; ; step++) {
      const c = col + dc * step;
      const r = row + dr * step;
      if (c < 0 || c >= GRID_WIDTH || r < 0 || r >= GRID_HEIGHT) break;
      const tile = s.grid[r][c];
      if (tile === TileType.HardBlock) {
        hitCol = c;
        hitRow = r;
        break;
      }
      if (tile === TileType.SoftBlock) {
        hitCol = c;
        hitRow = r;
        softHit = true;
        break;
      }
      // A bomb takes the shot and goes off with it; the ray stops there.
      const bomb = s.bombs.find((b) => b.col === c && b.row === r);
      if (bomb) {
        hitCol = c;
        hitRow = r;
        shotBomb = bomb;
        break;
      }
      victim = ctx.alivePlayerAt(c, r, player);
      if (victim) {
        hitCol = c;
        hitRow = r;
        break;
      }
    }

    ctx.emit({
      type: 'gunFired',
      playerId: player.id,
      col,
      row,
      dir: player.facing,
      hitCol,
      hitRow,
    });
    if (softHit && hitCol !== null && hitRow !== null) ctx.destroySoftBlock(hitCol, hitRow);
    // Same as the hammer: detonateDueBombs runs later this tick and takes it to 0.
    else if (shotBomb) shotBomb.fuseTicks = 1;
    else if (victim) ctx.killPlayer(victim);
    return true;
  },
};
```

- [ ] **Step 6: Create `packages/shared/src/skills/hammer.ts`**

Body from `GameImpl.swingHammer` (`game.ts:347-371`), same transformation. The off-grid early return becomes `return false` (no charge, no cooldown — current behavior):

```typescript
import {
  BOT_HAMMER_ATTACK_CHANCE,
  DIRECTION_STEPS,
  GRID_HEIGHT,
  GRID_WIDTH,
  HAMMER_USES_PER_PICKUP,
  SKILL_ACTION_COOLDOWN_TICKS,
} from '../constants';
import { PowerupType, TileType } from '../types';
import type { SkillDef } from './types';

/**
 * Hits the tile directly ahead: destroys a soft block or kills whoever stands
 * there. Swinging at the grid edge is a no-op and costs nothing.
 */
export const hammerSkill: SkillDef = {
  type: PowerupType.Hammer,
  chargesPerPickup: HAMMER_USES_PER_PICKUP,
  cooldownTicks: SKILL_ACTION_COOLDOWN_TICKS,
  botAim: 'melee',
  botAttackChance: BOT_HAMMER_ATTACK_CHANCE,
  onActivate(player, ctx) {
    const [dc, dr] = DIRECTION_STEPS[player.facing];
    const col = Math.round(player.x) + dc;
    const row = Math.round(player.y) + dr;
    if (col < 0 || col >= GRID_WIDTH || row < 0 || row >= GRID_HEIGHT) return false;

    ctx.emit({ type: 'hammerSwung', playerId: player.id, col, row });

    if (ctx.state.grid[row][col] === TileType.SoftBlock) {
      ctx.destroySoftBlock(col, row);
      return true;
    }
    // Smacking a bomb sets it off: detonateDueBombs runs later this same tick
    // and takes the fuse to 0 (same trick as a kicked bomb hitting a wall).
    const bomb = ctx.state.bombs.find((b) => b.col === col && b.row === row);
    if (bomb) {
      bomb.fuseTicks = 1;
      return true;
    }
    const victim = ctx.alivePlayerAt(col, row, player);
    if (victim) ctx.killPlayer(victim);
    return true;
  },
};
```

- [ ] **Step 7: Create `packages/shared/src/skills/registry.ts`**

```typescript
import { PowerupType } from '../types';
import { gunSkill } from './gun';
import { hammerSkill } from './hammer';
import type { SkillDef } from './types';

/** Every active (button-triggered) skill. Passive pickups (kick, stats) live elsewhere. */
export const SKILLS: ReadonlyMap<PowerupType, SkillDef> = new Map([
  [PowerupType.Gun, gunSkill],
  [PowerupType.Hammer, hammerSkill],
]);

/** True for powerups that grant an active skill (occupy the skill slot + Space trigger). */
export function isSkillPowerup(type: PowerupType): boolean {
  return SKILLS.has(type);
}
```

- [ ] **Step 8: Export from `packages/shared/src/index.ts`**

Add after the existing exports:

```typescript
export * from './skills/registry';
export type { SkillContext, SkillDef } from './skills/types';
```

- [ ] **Step 9: Run tests**

Run (from `packages/shared`): `node_modules/.bin/vitest run`
Expected: skillRegistry tests PASS; the entire existing suite still PASSES (nothing consumes the new module yet).

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src/skills packages/shared/src/constants.ts packages/shared/src/index.ts packages/shared/test/skillRegistry.test.ts
git commit -m "feat(shared): add skill strategy registry with gun and hammer defs"
```

---

### Task 2: Generic dispatch in the sim (types.ts + game.ts + gun/hammer tests)

**Files:**
- Modify: `packages/shared/src/types.ts:18-46`
- Modify: `packages/shared/src/game.ts` (imports, `applyPowerup`, `clearSkills`, constructor init, `tick`, delete `fireGun`/`swingHammer`, add `useSkill` + ctx)
- Test: `packages/shared/test/gunHammer.test.ts` (updated in place)

**Interfaces:**
- Consumes: `SKILLS`, `isSkillPowerup` from `./skills/registry`; `SkillContext` from `./skills/types`; `DIRECTION_STEPS` from `./constants` (Task 1).
- Produces: `Player.skill: PowerupType | null`, `Player.skillCharges: number` (replacing `gunAmmo`/`hammerUses`), `PlayerInput.useSkill?: boolean` (replacing `fireGun`/`swingHammer`). Tasks 3-6 build on these exact names.

Warning: after this task `bot.ts` (and therefore `bot.test.ts` / `game.test.ts` if they touch removed fields — game.test.ts does not) will not type-check/run against the removed fields. That is expected; run only the filtered test files listed in Step 6. Task 3 restores the full suite.

- [ ] **Step 1: Update `packages/shared/src/types.ts`**

Replace the `fireGun`/`swingHammer` lines of `PlayerInput` (types.ts:21-22) with:

```typescript
  useSkill?: boolean; // optional: sources that never use the skills omit it
```

Replace the `gunAmmo`/`hammerUses` lines of `Player` (types.ts:36-37) with:

```typescript
  skill: PowerupType | null; // held active skill (gun/hammer); at most one
  skillCharges: number; // uses left for the held skill, 0 = spent
```

Update the `actionCooldown` comment on the next line to: `// ticks until the next skill use is allowed`.

- [ ] **Step 2: Update `packages/shared/src/game.ts` — imports and helpers**

- In the `./constants` import block: remove `GUN_AMMO_PER_PICKUP`, `HAMMER_USES_PER_PICKUP`, `SKILL_ACTION_COOLDOWN_TICKS`; add `DIRECTION_STEPS`.
- Delete the local `DIRECTION_STEPS` table (`game.ts:111-116`).
- Add imports:

```typescript
import { SKILLS, isSkillPowerup } from './skills/registry';
import type { SkillContext } from './skills/types';
```

- Replace `applyPowerup` (`game.ts:135-161`) with:

```typescript
function applyPowerup(player: Player, type: PowerupType): void {
  switch (type) {
    case PowerupType.ExtraBomb:
      player.bombCount = Math.min(MAX_BOMB_COUNT, player.bombCount + 1);
      return;
    case PowerupType.BiggerBlast:
      player.blastRadius = Math.min(MAX_BLAST_RADIUS, player.blastRadius + 1);
      return;
    case PowerupType.Speed:
      player.speed = Math.min(MAX_SPEED, player.speed + SPEED_INCREMENT);
      return;
    // The skills are exclusive: a pickup always replaces whatever is held, so a
    // player carries at most one (re-pickup of the same one refills).
    case PowerupType.Kick:
      clearSkills(player);
      player.kickTicks = KICK_DURATION_TICKS;
      return;
  }
  if (isSkillPowerup(type)) {
    clearSkills(player);
    player.skill = type;
    player.skillCharges = SKILLS.get(type)!.chargesPerPickup;
  }
}
```

- Replace `clearSkills` (`game.ts:164-168`) with:

```typescript
/** Drops every held skill. Stat upgrades (bombs, blast, speed) are untouched. */
function clearSkills(player: Player): void {
  player.kickTicks = 0;
  player.skill = null;
  player.skillCharges = 0;
}
```

- [ ] **Step 3: Update constructor init and tick dispatch**

In the constructor's player literal (`game.ts:196-198`), replace

```typescript
        kickTicks: 0,
        gunAmmo: 0,
        hammerUses: 0,
```

with

```typescript
        kickTicks: 0,
        skill: null,
        skillCharges: 0,
```

In `tick()` (`game.ts:232-240`), replace

```typescript
      const armed = player.gunAmmo > 0 || player.hammerUses > 0;
```

with

```typescript
      const armed = player.skill !== null && player.skillCharges > 0;
```

and replace the two dispatch lines

```typescript
      if (input.fireGun || (pressed && player.gunAmmo > 0)) this.fireGun(player, events);
      if (input.swingHammer || (pressed && player.hammerUses > 0)) this.swingHammer(player, events);
```

with

```typescript
      if ((input.useSkill || pressed) && armed) this.useSkill(player, events);
```

(The `armed` guard replaces the per-weapon `> 0` checks; `useSkill` re-checks charges/cooldown itself so a sticky flag arriving after the magazine empties stays a no-op, as before.)

- [ ] **Step 4: Replace `fireGun`/`swingHammer` with the generic dispatcher**

Delete `fireGun` (`game.ts:276-341`) and `swingHammer` (`game.ts:343-371`) including their doc comments. In their place add:

```typescript
  /**
   * Activates the held skill via its registry strategy. Charge and cooldown
   * accounting lives here so every skill behaves consistently; a strategy
   * returning false (e.g. hammer aimed off-grid) costs nothing.
   */
  private useSkill(player: Player, events: GameEvent[]): void {
    if (player.skill === null || player.skillCharges <= 0 || player.actionCooldown > 0) return;
    const def = SKILLS.get(player.skill)!;
    const ctx: SkillContext = {
      state: this.state,
      emit: (event) => events.push(event),
      alivePlayerAt: (col, row, except) => this.alivePlayerAt(col, row, except),
      destroySoftBlock: (col, row) => this.destroySoftBlock(col, row, events),
      killPlayer: (victim) => this.killPlayer(victim, events),
    };
    if (def.onActivate(player, ctx)) {
      player.skillCharges--;
      player.actionCooldown = def.cooldownTicks;
    }
  }
```

(`alivePlayerAt`, `destroySoftBlock`, `killPlayer` already exist on `GameImpl` — signatures unchanged.)

- [ ] **Step 5: Update `packages/shared/test/gunHammer.test.ts` mechanically**

In-place substitutions across the file (it covers ray behavior, cooldowns, trigger semantics — assertions keep their meanings):
- Input flags: `fireGun: true` → `useSkill: true`; `swingHammer: true` → `useSkill: true`.
- State writes granting a gun: `player(game, 'p1').gunAmmo = N` → `player(game, 'p1').skill = PowerupType.Gun; player(game, 'p1').skillCharges = N;` (same for other ids).
- State writes granting a hammer: `...hammerUses = N` → `...skill = PowerupType.Hammer; ...skillCharges = N;`.
- Reads: `.gunAmmo` / `.hammerUses` in `expect(...)` → `.skillCharges` (where a test asserts the *other* weapon's count is 0 after an exclusive pickup, assert `.skill` equals the expected type instead — exclusivity now lives in one field).
- Pickup tests asserting `gunAmmo === GUN_AMMO_PER_PICKUP` after collecting a Gun powerup → assert `skill === PowerupType.Gun && skillCharges === GUN_AMMO_PER_PICKUP` (same pattern for Hammer).

Also verify the hammer edge-of-grid test still asserts no charge is consumed (now `skillCharges` unchanged) — the `onActivate → false` path covers it.

- [ ] **Step 6: Run the affected shared tests**

Run (from `packages/shared`): `node_modules/.bin/vitest run test/gunHammer.test.ts test/kick.test.ts test/game.test.ts test/skillRegistry.test.ts test/iceDrift.test.ts test/suddenDeath.test.ts`
Expected: ALL PASS. (`bot.test.ts` is intentionally excluded until Task 3.)

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/game.ts packages/shared/test/gunHammer.test.ts
git commit -m "refactor(shared): dispatch skills through the registry; generalize player skill state"
```

---

### Task 3: Bot AI reads the registry

**Files:**
- Modify: `packages/shared/src/bot.ts` (weapon selection ~line 354, `useSkill` helper ~lines 282-315, `skillAim`, constants imports)
- Test: `packages/shared/test/bot.test.ts` (updated in place)

**Interfaces:**
- Consumes: `Player.skill`/`Player.skillCharges`, `PlayerInput.useSkill` (Task 2); `SKILLS` and `SkillDef` with `botAim: 'ray' | 'melee'`, `botAttackChance` (Task 1).
- Produces: nothing new — bot emits `{ direction, placeBomb, useSkill? }` inputs.

- [ ] **Step 1: Update weapon selection in `createBot.computeInput`**

Replace (bot.ts:354):

```typescript
      const weapon = me.hammerUses > 0 ? 'hammer' : me.gunAmmo > 0 ? 'gun' : null;
      if (weapon) {
        const action = useSkill(
          ctx,
          weapon,
          col,
          row,
          me.actionCooldown,
          enemyTiles,
          blockUnsafe,
          rng,
        );
```

with:

```typescript
      const def = me.skill !== null && me.skillCharges > 0 ? SKILLS.get(me.skill) : undefined;
      if (def) {
        const action = useSkillInput(
          ctx,
          def,
          col,
          row,
          me.actionCooldown,
          enemyTiles,
          blockUnsafe,
          rng,
        );
```

Add `import { SKILLS } from './skills/registry';` and `import type { SkillDef } from './skills/types';` to bot.ts imports; drop the now-unused `BOT_GUN_ATTACK_CHANCE` / `BOT_HAMMER_ATTACK_CHANCE` constants imports.

- [ ] **Step 2: Rework the bot's skill helper**

Rename the module-private `useSkill` helper to `useSkillInput` (avoids shadowing confusion with the sim's dispatcher) and change its signature/body: parameter `weapon: 'gun' | 'hammer'` becomes `def: SkillDef`; the attack-chance line becomes `const chance = def.botAttackChance;`; both return branches collapse to one:

```typescript
    return { direction: aim.dir, placeBomb: false, useSkill: true };
```

`skillAim` (and any helper that branched on `weapon === 'gun'` vs `'hammer'`) now branches on `def.botAim === 'ray'` vs `'melee'` — pass `def` (or just `def.botAim`) through instead of the weapon string. Ray aiming logic (gun) maps to `'ray'`, adjacent-tile aiming (hammer) to `'melee'`; the aiming code itself is unchanged.

- [ ] **Step 3: Update `packages/shared/test/bot.test.ts`**

Mechanical substitutions:
- `player(game, 'bot').hammerUses = HAMMER_USES_PER_PICKUP` → `player(game, 'bot').skill = PowerupType.Hammer; player(game, 'bot').skillCharges = HAMMER_USES_PER_PICKUP;`
- `player(game, 'bot').gunAmmo = GUN_AMMO_PER_PICKUP` → `player(game, 'bot').skill = PowerupType.Gun; player(game, 'bot').skillCharges = GUN_AMMO_PER_PICKUP;`
- Assertions `expect(player(game, 'bot').hammerUses).toBeLessThan(...)` → `expect(player(game, 'bot').skillCharges).toBeLessThan(...)`; `...toBe(0)` likewise on `skillCharges`.
- Add `PowerupType` to the test's imports from `../src/types` if missing.

- [ ] **Step 4: Run the full shared suite**

Run (from `packages/shared`): `node_modules/.bin/vitest run`
Expected: ALL PASS (bot suite included — full suite green again).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/bot.ts packages/shared/test/bot.test.ts
git commit -m "refactor(shared): bot weapon use driven by skill registry"
```

---

### Task 4: Server — input buffer, schema, rematch reset

**Files:**
- Modify: `packages/server/src/rooms/inputBuffer.ts`
- Modify: `packages/server/src/rooms/schema.ts:20-22` and `:90-92`
- Modify: `packages/server/src/rooms/GameRoom.ts:277-278`
- Test: `packages/server/test/inputBuffer.test.ts`, `packages/server/test/schema.test.ts`, `packages/server/test/gameRoom.integration.test.ts` (updated in place)

**Interfaces:**
- Consumes: `PlayerInput.useSkill`, `Player.skill`/`skillCharges` (Task 2).
- Produces: `PlayerSchema.skillType: number` (-1 = none) and `PlayerSchema.skillCharges: number` — the client (Task 6) reads these exact names off the synced state.

- [ ] **Step 1: Update failing tests first**

`inputBuffer.test.ts`: replace the `fireGun`/`swingHammer` fields with `useSkill` throughout — the `snap` helper default becomes `{ direction: null, placeBomb: false, useSkill: false }`; the sticky test sends `{ direction: null, placeBomb: false, useSkill: true }` and expects `useSkill: true` on first consume, `false` after; the malformed-value test sends `useSkill: 'yes'` and expects it ignored (`false`).

`schema.test.ts`: `gunAmmo`/`hammerUses` mirror assertions become `skillType`/`skillCharges`. The write-side setup `game.state.players[0].gunAmmo = 2; ...hammerUses = 3;` becomes `game.state.players[0].skill = PowerupType.Gun; game.state.players[0].skillCharges = 2;` with assertions `expect(p0.skillType).toBe(PowerupType.Gun); expect(p0.skillCharges).toBe(2);` and the defaults test expects `skillType === -1 && skillCharges === 0`. Import `PowerupType` from `@bomberman/shared`.

`gameRoom.integration.test.ts`: `me.gunAmmo = 2; me.hammerUses = 3;` becomes `me.skill = PowerupType.Gun; me.skillCharges = 2;`; the wait condition and assertions read `skillType`/`skillCharges`; the rematch-reset assertions become `expect(p0.skillType).toBe(-1); expect(p0.skillCharges).toBe(0);`.

- [ ] **Step 2: Run server tests to verify they fail**

Run (from `packages/server`): `node_modules/.bin/vitest run`
Expected: FAIL — schema lacks `skillType`, buffer lacks `useSkill`.

- [ ] **Step 3: Update `inputBuffer.ts`**

`Entry` becomes `{ direction, placeBomb, useSkill: boolean }`. In `set()`: destructure `useSkill` instead of `fireGun`/`swingHammer`; `const skill = useSkill === true;`; sticky-OR `entry.useSkill = entry.useSkill || skill;`. In `consume()`: snapshot `useSkill: entry.useSkill` and clear `entry.useSkill = false` alongside `placeBomb`. Update the class doc comment ("a bomb/skill press...").

- [ ] **Step 4: Update `schema.ts` and `GameRoom.ts`**

`PlayerSchema` (schema.ts:21-22): replace

```typescript
  @type('number') gunAmmo = 0;
  @type('number') hammerUses = 0;
```

with

```typescript
  /** Held active skill as a PowerupType value; -1 = none. */
  @type('number') skillType = -1;
  @type('number') skillCharges = 0;
```

`copySimToSchema` (schema.ts:91-92): replace the two mirror lines with

```typescript
    ps.skillType = player.skill ?? -1;
    ps.skillCharges = player.skillCharges;
```

`GameRoom.ts:277-278` (rematch reset): replace `ps.gunAmmo = 0; ps.hammerUses = 0;` with `ps.skillType = -1; ps.skillCharges = 0;`.

- [ ] **Step 5: Run server tests**

Run (from `packages/server`): `node_modules/.bin/vitest run`
Expected: ALL PASS. Also run `npm run build` in `packages/server` (tsc --noEmit) — expect clean.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/rooms packages/server/test
git commit -m "refactor(server): sync generic skill state; single useSkill input flag"
```

---

### Task 5: Client skill view registry + skills table

**Files:**
- Create: `packages/client/src/skills/registry.ts`
- Modify: `packages/client/src/skillsTable.ts`
- Modify: `packages/client/src/controls.ts`

**Interfaces:**
- Consumes: `PowerupType`, `Direction`, `RenderState`-shaped data; `TEX`, `audio`.
- Produces: `SKILL_VIEWS: ReadonlyMap<PowerupType, SkillView>` with the exact shape below — Task 6 calls `renderEvent` (offline events) and `renderUse` (online count-drop FX).

Note: the client has no test runner; verification is `tsc --noEmit`, which stays broken until Task 6 finishes (GameScene/net still reference removed shared fields). Do not run the build in this task; Task 6 Step 6 is the verification gate for both tasks.

- [ ] **Step 1: Create `packages/client/src/skills/registry.ts`**

```typescript
import type { Direction, GameEvent, PowerupType as PT } from '@bomberman/shared';
import { PowerupType } from '@bomberman/shared';
import { audio } from '../audio';

/**
 * The FX surface GameScene hands a skill view: just enough to draw shot
 * tracers and tile flashes without the view knowing scene internals.
 */
export interface SkillFx {
  showTracer(
    col: number,
    row: number,
    dir: Direction,
    hitCol: number | null,
    hitRow: number | null,
  ): void;
  flashTile(col: number, row: number, color: number): void;
  /** First blocking cell along `dir` from (col,row); [null,null] if it leaves the grid. */
  scanRay(col: number, row: number, dir: Direction, shooterId: string): [number | null, number | null];
  /** Tracer/flash accent color (TRACER_COLOR). */
  readonly accentColor: number;
}

/** Minimal player view the FX path needs (matches GameScene's RenderPlayer). */
export interface SkillFxPlayer {
  id: string;
  x: number;
  y: number;
  facing: Direction;
}

/** Grid delta per facing direction (mirrors the sim's step table). */
const DIR_STEP: Record<Direction, [dc: number, dr: number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/**
 * Client-side view of one active skill: table copy plus FX hooks. Mirrors the
 * shared skills/registry.ts - a new weapon adds one entry here and one there.
 */
export interface SkillView {
  readonly type: PT;
  readonly name: string;
  /** One-line effect for the skills reference table. */
  readonly effect: string;
  /** Offline: sim events drive the FX. */
  renderEvent(fx: SkillFx, event: GameEvent): void;
  /** Online: a drop in the synced charge count drives the FX (events are not streamed). */
  renderUse(fx: SkillFx, player: SkillFxPlayer): void;
}

const gunView: SkillView = {
  type: PowerupType.Gun,
  name: 'Gun',
  effect: '2 shots — breaks a block, downs a player, sets off a bomb',
  renderEvent(fx, event) {
    if (event.type !== 'gunFired') return;
    audio.gunShot();
    fx.showTracer(event.col, event.row, event.dir, event.hitCol, event.hitRow);
  },
  renderUse(fx, player) {
    audio.gunShot();
    const col = Math.round(player.x);
    const row = Math.round(player.y);
    // The shot itself is not synced: re-scan locally for the tracer end. A shot
    // that broke a block draws one tile long - close enough for a 180ms flash.
    const [hitCol, hitRow] = fx.scanRay(col, row, player.facing, player.id);
    fx.showTracer(col, row, player.facing, hitCol, hitRow);
  },
};

const hammerView: SkillView = {
  type: PowerupType.Hammer,
  name: 'Hammer',
  effect: '3 swings — smashes the tile ahead, sets off a bomb',
  renderEvent(fx, event) {
    if (event.type !== 'hammerSwung') return;
    audio.hammerHit();
    fx.flashTile(event.col, event.row, fx.accentColor);
  },
  renderUse(fx, player) {
    audio.hammerHit();
    const [dc, dr] = DIR_STEP[player.facing];
    fx.flashTile(Math.round(player.x) + dc, Math.round(player.y) + dr, fx.accentColor);
  },
};

export const SKILL_VIEWS: ReadonlyMap<PT, SkillView> = new Map([
  [PowerupType.Gun, gunView],
  [PowerupType.Hammer, hammerView],
]);
```

- [ ] **Step 2: Source skill rows from the registry in `skillsTable.ts`**

Replace the Gun and Hammer entries of the `SKILLS` array (skillsTable.ts:16-27) with rows derived from the view registry. The array becomes the stat/passive rows only, then append the active skills:

```typescript
import { SKILL_VIEWS } from './skills/registry';
```

```typescript
const SKILLS: { type: PowerupType; name: string; effect: string; key?: string }[] = [
  { type: PowerupType.ExtraBomb, name: 'Extra Bomb', effect: '+1 bomb at once' },
  { type: PowerupType.BiggerBlast, name: 'Bigger Blast', effect: '+1 blast range' },
  { type: PowerupType.Speed, name: 'Speed', effect: 'move faster' },
  {
    type: PowerupType.Kick,
    name: 'Kick',
    effect: 'walk into a bomb to kick it; slides & blows up on impact (15s)',
  },
  ...[...SKILL_VIEWS.values()].map((view) => ({
    type: view.type,
    name: view.name,
    effect: view.effect,
    key: SKILL_KEY_LABEL,
  })),
];
```

(`buildSkillsTable` itself is unchanged.)

- [ ] **Step 3: Drop the alias keys from `controls.ts`**

Replace the whole file body with:

```typescript
/**
 * Skill controls, shared by the input handler and every place that shows the
 * player which key to press (HUD counters, skills panel).
 *
 * Space is the only trigger: the sim fires the held skill on the press and
 * refuses to place bombs until the magazine runs out.
 */
export const SKILL_KEY_LABEL = 'Space';
```

(`GUN_KEY` / `HAMMER_KEY` deleted; their GameScene consumers go away in Task 6.)

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/skills/registry.ts packages/client/src/skillsTable.ts packages/client/src/controls.ts
git commit -m "feat(client): skill view registry; table rows sourced from it; drop E/Q aliases"
```

(No build here — `tsc` still fails on GameScene/net until Task 6; that task's build is the gate.)

---

### Task 6: Client — GameScene, net types, generic badges and FX

**Files:**
- Modify: `packages/client/src/net.ts:34-36`
- Modify: `packages/client/src/scenes/GameScene.ts` (badge config ~121-131, RenderPlayer ~162-175, state fields ~242-271, resets ~308-314, stepSim ~466-488, handleEvent ~490-519, updateOnline ~523-572, renderStateFromRoom ~592-608, trackOnlineSkillUse ~659-680, pollSkillKeys/setupInput/myArmedSkill ~705-734, updateHammerTarget ~927-939, updateSkillBadges ~968-1033)

**Interfaces:**
- Consumes: `PlayerSchema.skillType`/`skillCharges` (Task 4); `SKILL_VIEWS`, `SkillFx` (Task 5); shared `Player.skill`/`skillCharges`, `PlayerInput.useSkill` (Task 2).
- Produces: nothing downstream — this is the leaf.

- [ ] **Step 1: `net.ts` — sync shape**

Replace `NetPlayer.kickTicks/gunAmmo/hammerUses` block (net.ts:34-36) with:

```typescript
  kickTicks: number;
  /** Held active skill as a PowerupType value; -1 = none. */
  skillType: number;
  skillCharges: number;
```

- [ ] **Step 2: GameScene — state, input plumbing**

- `RenderPlayer`: replace `gunAmmo: number; hammerUses: number;` with `skillType: number; skillCharges: number;` (keep `kickTicks`).
- `renderStateFromRoom`: map `skillType: p.skillType, skillCharges: p.skillCharges` instead of the two old fields.
- Delete fields `gunKey`, `hammerKey`, `pendingGun`, `pendingHammer`; add `private pendingSkill = false;` (online-only latch, replaces both). Keep `pendingTrigger`, `triggerServedSkill`.
- Replace `prevGunAmmo`/`prevHammerUses` maps (~270-271) with:

```typescript
  /** Online: last-seen held skill + charges per player, to derive use FX from count drops. */
  private prevSkill = new Map<string, { type: number; charges: number }>();
```

  and update the resets at ~308-314 accordingly (`this.prevSkill.clear();`).
- `setupInput`: delete the `gunKey`/`hammerKey` lines and the `GUN_KEY, HAMMER_KEY` import from `./controls` (keep `SKILL_KEY_LABEL` if referenced elsewhere, e.g. HUD copy).
- `pollSkillKeys`: only the Space edge remains:

```typescript
  /**
   * Latches this frame's Space press. JustDown consumes the edge, so it must be
   * polled exactly once per frame regardless of how many sim steps follow.
   */
  private pollSkillKeys(): void {
    if (Phaser.Input.Keyboard.JustDown(this.spaceKey)) this.pendingTrigger = true;
  }
```

- `stepSim` (offline): the human input drops the skill flags entirely — the sim edges Space itself:

```typescript
      [HUMAN_ID]: {
        direction: this.currentDirection(),
        placeBomb: this.spaceKey.isDown,
      },
```

  and delete the `this.pendingGun = false; this.pendingHammer = false;` lines. Offline, `pendingTrigger` is unused; it stays latched but harmless — clear it in `updateOffline` right after `pollSkillKeys()` (`this.pendingTrigger = false;`) to keep the latch single-purpose.
- `myArmedSkill` becomes a boolean check against the synced schema:

```typescript
  /** True when Space triggers the held skill (online); false while it still places bombs. */
  private myArmedSkill(): boolean {
    const me = this.connection?.room.state.players.get(this.myId);
    return me !== undefined && me.skillType >= 0 && me.skillCharges > 0;
  }
```

- `updateOnline` input block: replace the armed/pending routing (~545-551) with:

```typescript
    const armed = this.myArmedSkill();
    if (armed && this.pendingTrigger) this.pendingSkill = true;
    this.pendingTrigger = false;
    if (!this.spaceKey.isDown) this.triggerServedSkill = false;
    else if (armed) this.triggerServedSkill = true;
    const bombHeld = !armed && this.spaceKey.isDown && !this.triggerServedSkill;
```

  and the send condition/payload: `this.pendingGun || this.pendingHammer` → `this.pendingSkill`; the message becomes

```typescript
      room.send('input', {
        direction,
        placeBomb: bombHeld,
        useSkill: this.pendingSkill,
      });
      this.pendingSkill = false;
```

- [ ] **Step 3: GameScene — FX via the view registry**

- Add imports: `import { SKILL_VIEWS } from '../skills/registry'; import type { SkillFx } from '../skills/registry';`
- Add one lazily-built FX adapter on the scene:

```typescript
  /** FX surface handed to skill views; bound once, closes over the scene. */
  private skillFx: SkillFx = {
    showTracer: (col, row, dir, hitCol, hitRow) => this.showTracer(col, row, dir, hitCol, hitRow),
    flashTile: (col, row, color) => this.flashTile(col, row, color),
    scanRay: (col, row, dir, shooterId) =>
      this.scanRay(this.latestRenderState(), col, row, dir, shooterId),
    accentColor: TRACER_COLOR,
  };
```

  `scanRay` needs a `RenderState`; online it is only called from `trackOnlineSkillUse`, which has one — the simplest correct wiring is to store the state: add `private lastRenderState: RenderState | null = null;`, set it at the top of `trackOnlineSkillUse` (`this.lastRenderState = state;` before the loop), and implement `latestRenderState()` as `return this.lastRenderState!;` (only reachable from `renderUse`, which only runs inside `trackOnlineSkillUse`).
- `handleEvent` (offline): replace the `gunFired`/`hammerSwung` cases with one delegation:

```typescript
      case 'gunFired':
      case 'hammerSwung': {
        for (const view of SKILL_VIEWS.values()) view.renderEvent(this.skillFx, event);
        break;
      }
```

  (Each view ignores events that are not its own — the type guard is inside `renderEvent`.)
- `trackOnlineSkillUse` becomes generic:

```typescript
  /**
   * Online: skill FX derive from a drop in the synced charge count while the
   * held skill stays the same (events are not streamed).
   */
  private trackOnlineSkillUse(state: RenderState): void {
    this.lastRenderState = state;
    for (const player of state.players) {
      const prev = this.prevSkill.get(player.id);
      if (prev && prev.type === player.skillType && player.skillCharges < prev.charges) {
        SKILL_VIEWS.get(player.skillType)?.renderUse(this.skillFx, player);
      }
      this.prevSkill.set(player.id, { type: player.skillType, charges: player.skillCharges });
    }
  }
```

  Change the private `scanRay` signature to take the state first if it does not already (it does: `scanRay(state, col, row, dir, shooterId)` — keep as is; the adapter above passes `latestRenderState()`).

- [ ] **Step 4: GameScene — badges and hammer crosshair**

- Replace the `SKILL_BADGES` module constant (121-131) with:

```typescript
/** Overhead badges, in draw order; `value` reads the synced count off a player. */
const SKILL_BADGES: {
  key: string;
  texType: (p: RenderPlayer) => PowerupType | null;
  value: (p: RenderPlayer) => number;
  /** Timers (kick) show no number; consumable counts do. */
  showCount: boolean;
}[] = [
  { key: 'kick', texType: () => PowerupType.Kick, value: (p) => p.kickTicks, showCount: false },
  {
    key: 'skill',
    texType: (p) => (p.skillType >= 0 ? (p.skillType as PowerupType) : null),
    value: (p) => (p.skillType >= 0 ? p.skillCharges : 0),
    showCount: true,
  },
];
```

- In `updateSkillBadges`, the only structural change is the icon texture lookup: where a badge is created (`TEX.powerup[skill.type]`, ~line 1001) use `TEX.powerup[skill.texType(player)!]` (the `value(player) > 0` filter guarantees `texType` is non-null there). One subtlety: when a player swaps gun→hammer, the 'skill' badge key survives but the icon must change — handle it by destroying a stale badge when its texture type changed. Track it: extend the per-badge record `SkillBadge` with `texType: PowerupType`, and in the reconcile loop before reuse:

```typescript
      let badge = badges.get(skill.key);
      const tex = skill.texType(player)!;
      if (badge && badge.texType !== tex) {
        badge.icon.destroy();
        badge.count?.destroy();
        badges.delete(skill.key);
        badge = undefined;
      }
```

  and store `texType: tex` when creating the badge. The pickup-pop tween condition (`prev.get(skill.key) ?? 0) === 0`) still works: a swap goes through destroy-and-recreate with prev>0 — to make the pop also fire on swaps, reset the prev to 0 when destroying a stale badge (`prev.set(skill.key, 0);` inside the branch above).
- `updateHammerTarget` armed condition (line 928) becomes:

```typescript
    const armed = me.alive && me.skillType === PowerupType.Hammer && me.skillCharges > 0;
```

  (Import of `PowerupType` already exists in GameScene.)

- [ ] **Step 5: HUD check**

Grep GameScene for any remaining `gunAmmo`/`hammerUses`/`pendingGun`/`pendingHammer`/`GUN_KEY`/`HAMMER_KEY` references (e.g. `updateHud`) and convert them to the `skillType`/`skillCharges` equivalents:

Run: `grep -n "gunAmmo\|hammerUses\|pendingGun\|pendingHammer\|GUN_KEY\|HAMMER_KEY" packages/client/src -r`
Expected after fixes: no matches.

- [ ] **Step 6: Typecheck the client (verification gate for Tasks 5+6)**

Run (from `packages/client`): `node_modules/.bin/tsc --noEmit`
Expected: clean. Also re-run the full workspace suite from the repo root: `npm test` — shared + server all green.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src
git commit -m "refactor(client): generic skill badges, FX and input via skill view registry"
```

---

### Task 7: Full verification + smoke test

**Files:**
- No new files; fixes only if verification finds breakage.

- [ ] **Step 1: Full test run**

Run from the repo root: `npm test`
Expected: every workspace suite PASSES.

- [ ] **Step 2: Builds**

Run: `npm run build --workspace packages/server && npm run build --workspace packages/client`
Expected: both clean (client build includes `tsc --noEmit && vite build`).

- [ ] **Step 3: Offline smoke test**

Start the client (`npm run dev` in `packages/client`), play an offline match, and verify: picking up a gun shows the badge with a count and Space fires a tracer (no bomb); picking up a hammer swaps the badge icon, shows the red X crosshair on the facing tile, and Space smashes; E and Q do nothing; emptying the magazine returns Space to bomb placement after release; kick still tints/blinks and slides bombs; the skills table lists Gun/Hammer rows with [Space].

- [ ] **Step 4: Online smoke test (if a local server runs easily)**

`npm run dev` in `packages/server` + two client tabs: confirm badges, tracer/flash FX derived from synced counts, and gun→hammer badge swap mid-match.

- [ ] **Step 5: Final commit (only if fixes were needed)**

```bash
git add -A && git commit -m "fix: post-refactor verification fixes"
```
