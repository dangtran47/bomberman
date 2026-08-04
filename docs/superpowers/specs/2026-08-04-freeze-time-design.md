# Freeze-Time Powerup Design

Date: 2026-08-04
Status: Approved

## Summary

New powerup: **Freeze-Time**. Instant-on-pickup item that freezes every other alive player for 5 seconds, map-wide. Picker is unaffected. Frozen players cannot move, place bombs, place mines, or use gun/hammer skills, but remain killable by blasts — freeze sets up kills, it does not protect.

Asset already present: `packages/client/public/assets/freeze-time.png`.

## Decisions

- **Scope:** all other alive players, map-wide (classic Bomberman clock behavior).
- **Activation:** instant on pickup. Not a held skill; nothing shown in HUD inventory.
- **Effect:** fully frozen — no movement, no bomb/mine placement, no skill use. Blasts still kill frozen players. Bombs already placed by a frozen player keep ticking.
- **Stacking:** second pickup while enemies are frozen refreshes `frozenTicks` to full duration.
- **Enforcement location:** shared simulation (`packages/shared`), not server input filtering. Keeps client prediction and offline/local mode in parity — the same guards run on both sides.

## Shared (`packages/shared`)

- `PowerupType.FreezeTime` = index 8 in `types.ts` (appended after `Shield`).
- `POWERUP_TYPE_COUNT` 8 → 9 in `constants.ts`.
- `POWERUP_WEIGHTS`: append weight 1 after shield's, giving
  `[6, 6, 3, 3, 1, 1, 1, 1, 1]` (rare tier, same as gun/hammer/mine/shield).
- New constant `FREEZE_DURATION_TICKS = 100` (5 s at 20 ticks/s).
- `Player` gains `frozenTicks: number` (0 = not frozen).
- `applyPowerup()` case FreezeTime: for every other alive player, set `frozenTicks = FREEZE_DURATION_TICKS`. Does not clear held skills, does not touch the picker.
- Main tick loop decrements `frozenTicks` toward 0.
- Guards while `frozenTicks > 0`:
  - `stepPlayer()` in `movement.ts` — no-op (player cannot move).
  - `placeBomb()` — refuse.
  - `placeMine()` — refuse.
  - Gun / hammer skill use — refuse.

Note: the shield (`2026-08-04-shield-powerup-design.md`) shipped to `main` at index 7
first, so freeze-time takes index 8. The two buffs are orthogonal and need no
special-case code: shield grants kill immunity, freeze locks actions, so a
shielded player can still be frozen and a frozen player keeps its immunity.

## Server (`packages/server`)

- `PlayerSchema` gains replicated `frozenTicks` (uint8-scale is fine; max 100).
- `copySimToSchema` copies it each tick so clients can render the frozen state.

## Client (`packages/client`)

- `textures.ts`: register `freeze-time.png`, map `TEX.powerup[FreezeTime]`.
- Frozen player rendering: blue/ice tint on the player sprite while `frozenTicks > 0`; tint clears on unfreeze. Brief pickup flash on the picker for feedback.
- No HUD inventory entry (instant-use item).
- `skillsTable.ts` entry: "Freezes all enemies for 5s".
- Client prediction: the shared `stepPlayer` guard freezes the local player identically on client and server — no rubber-banding.

## Bots

No bot changes. Frozen bot inputs are discarded by the shared guards; bots already seek powerups generically.

## Testing (shared sim unit tests)

1. Pickup freezes all other alive players, not the picker.
2. Movement is blocked while frozen; resumes after.
3. `placeBomb` / `placeMine` / skill use refused while frozen.
4. `frozenTicks` reaches 0 after `FREEZE_DURATION_TICKS` ticks and player unfreezes.
5. Second pickup refreshes `frozenTicks` to full.
6. Frozen player still dies to a blast.
