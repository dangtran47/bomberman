# Skill Strategy Registry Refactor — Design

**Date:** 2026-07-25
**Status:** Approved (pending spec review)
**Scope:** Active skills only (Gun, Hammer). Passive modifiers (Kick, Ice) and core bomb mechanics are untouched except where exclusivity rules require coordination.

## Problem

Weapon logic is fragmented across ~12 files. Adding one new weapon today requires ~11 touch points: the `PowerupType` enum, per-weapon `Player` fields, the `applyPowerup` switch, per-weapon input flags, the input buffer, per-weapon dispatch in the tick loop, a private method on `GameImpl`, Colyseus schema fields plus sync code, client badge arrays, the skills table, texture mappings, and audio wiring.

Four new weapons are planned (grenade, trap, shield, bomb grab-and-throw). They need entity spawning and player status effects, so the refactor must provide behavior hooks, not just centralized config.

## Goals

- Adding a new active skill touches ~4 places: enum entry, one shared skill file plus a registry line, one client registry entry, one test file.
- No gameplay behavior change: gun, hammer, kick, ice, and bombs play exactly as before. Sole intentional input change: the E/Q direct-key aliases are removed — Space is the only skill trigger.
- Deterministic simulation is preserved; server and offline client stay in lockstep.

## Non-Goals

- No status-effect system yet (arrives with trap/shield later; the seam is `SkillContext`).
- No changes to kick or ice mechanics.
- No ECS rewrite.

## Design

### 1. Shared core — `packages/shared/src/skills/`

```
skills/
  types.ts     SkillDef + SkillContext interfaces
  registry.ts  SKILLS map, isSkillPowerup()
  gun.ts       gun logic (moved from GameImpl.fireGun)
  hammer.ts    hammer logic (moved from GameImpl.swingHammer)
```

```ts
interface SkillDef {
  type: PowerupType;
  chargesPerPickup: number;
  cooldownTicks: number;
  botAttackChance: number; // bot.ts reads this instead of BOT_GUN_ATTACK_CHANCE / BOT_HAMMER_ATTACK_CHANCE
  onActivate(player: Player, ctx: SkillContext): void;
}

interface SkillContext {
  state: GameState;
  emit(event: GameEvent): void;
  // Capability methods implemented by GameImpl; the set grows as weapons need them:
  // raycastHit(...), smashTile(...), hit-resolution helpers shared by gun/hammer.
}
```

`GameImpl` implements the capabilities; skills only compose them. Future weapons add capabilities (e.g. `spawnBomb`, `grabBomb`) without touching dispatch.

A charge is spent on every activation, hit or miss — identical to current behavior.

### 2. Player state and schema

`Player.gunAmmo` and `Player.hammerUses` are replaced by:

```ts
skill: PowerupType | null; // held active skill
skillCharges: number;      // uses remaining
```

`kickTicks` stays as-is (passive, out of scope), but mutual exclusivity is preserved: picking up any skill (active or kick) clears all others, exactly as `clearSkills` does today.

`applyPowerup` keeps its switch for stat upgrades (ExtraBomb, BiggerBlast, Speed) and collapses the per-skill cases into one generic branch:

```ts
if (isSkillPowerup(type)) {
  clearSkills(player);
  player.skill = type;
  player.skillCharges = SKILLS.get(type)!.chargesPerPickup;
}
```

Colyseus `PlayerSchema`: `gunAmmo` and `hammerUses` are replaced by `skillType: number` (-1 = none) and `skillCharges: number`. `copySimToSchema` mirrors the new fields.

### 3. Input and dispatch

`PlayerInput.fireGun` and `PlayerInput.swingHammer` are replaced by a single optional `useSkill?: boolean`.

Tick-loop dispatch becomes one generic path:

```ts
const armed = player.skill !== null && player.skillCharges > 0;
if ((input.useSkill || pressed) && armed && player.actionCooldown === 0) {
  const def = SKILLS.get(player.skill)!;
  def.onActivate(player, ctx);
  player.skillCharges--;
  player.actionCooldown = def.cooldownTicks;
}
```

- **Trigger semantics unchanged:** Space is one button — while a skill is held it triggers that skill and places no bombs; it fires on the press only; a press that started as a skill trigger stays one until release (`triggerHeld` / `skillTriggerHeld` logic is kept verbatim).
- Client keys: Space is the sole skill trigger. The existing E/Q direct-key aliases are removed. The held skill decides what fires.
- `inputBuffer` sticky-ORs `useSkill` the same way it did `fireGun`/`swingHammer`.
- Bot AI sets `useSkill: true` and reads `botAttackChance` from the held skill's def instead of branching on gun vs hammer.

### 4. Events and client registry

Per-skill event types stay in the `GameEvent` union (`gunFired`, `hammerSwung`) — typed payloads beat a generic blob. Client gains a mirror registry `packages/client/src/skills/registry.ts`:

```ts
{ [PowerupType]: {
    texFrame,            // powerup sprite frame (from textures.ts mapping)
    name, description,   // skills table copy (key label is always Space — not per-skill)
    renderEvent(scene, event), // tracer / tile flash
    sound(audio),        // gunShot / hammerHit
} }
```

Consumers:
- `skillsTable.ts` builds the reference panel from the registry.
- Badge UI: one generic badge per player showing held-skill icon + charge count, replacing the per-skill `SKILL_BADGES` array. Kick keeps its existing badge/tint rendering unchanged.
- `GameScene.handleEvent` dispatches skill events to the registry's `renderEvent`/`sound`.
- `textures.ts` powerup-frame mapping is sourced from the registry.

### 5. Extensibility proof — adding grenade later

1. `PowerupType.Grenade` enum entry.
2. `shared/src/skills/grenade.ts` + one registry line (plus a `spawnBomb` capability on `SkillContext`, added once).
3. Client registry entry + texture frame.
4. Test file.

No dispatch, schema, or input-protocol changes. Trap and shield will add a shared status-effect list on `Player` when they land; the seam exists (`SkillContext`), it is deliberately not built now.

### 6. Error handling

- Activation with no held skill or zero charges: impossible by construction (`armed` guard); no-op if reached.
- Unknown `skillType` from schema on client (version skew mid-deploy): render no badge; server and client deploy together so this is transient at worst.
- Registry lookup for a `PowerupType` that is not a skill: `isSkillPowerup` guards every entry point.

### 7. Testing and migration

- `gunHammer.test.ts`: re-pointed to `useSkill` input flag and `skillCharges` assertions. Same behavioral assertions (ray hits, tile smash, ammo consumption, cooldown, trigger-hold semantics).
- `kick.test.ts` and ice tests: untouched, must stay green.
- `inputBuffer.test.ts`: updated for `useSkill`.
- Server and client deploy together; no wire-protocol back-compat needed.
- Migration order, each step ending with a full green test run:
  1. Shared: skills module, Player fields, dispatch, input type.
  2. Server: schema fields, sync, input buffer.
  3. Client: registry, badges, skills table, key handling, textures, audio wiring.
