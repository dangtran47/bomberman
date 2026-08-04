# Shield Powerup — Design

Date: 2026-08-04
Status: approved

## Summary

New powerup: Shield. On pickup the player becomes immune to all player-inflicted
damage for 7 seconds. Passive buff — does not occupy the exclusive skill slot,
so held gun/hammer/mine/kick are kept. Sudden death kills through it.

## Shared sim (`packages/shared`)

- `PowerupType.Shield` appended to the enum (index 7 — append-only wire protocol).
- `POWERUP_TYPE_COUNT = 9`; `POWERUP_WEIGHTS = [6, 6, 3, 3, 1, 1, 1, 1, 1]`
  (shield rare, same weight as weapons).
- `SHIELD_DURATION_TICKS = 140` (7 s at 20 tps).
- `Player.shieldTicks: number` — remaining immunity ticks, `0` = no shield.
  Decrements once per tick. Pickup sets it to `SHIELD_DURATION_TICKS`
  (re-pickup refreshes to full). `applyPowerup` does NOT call `clearSkills`.
- Kill-path guards — a player with `shieldTicks > 0` survives:
  - explosion cell overlap (bomb and mine blasts),
  - gun ray hit (ray still stops at the shielded player — shot absorbed),
  - hammer strike,
  - armed-mine step-on still detonates the mine; the blast kills no shielded
    player (wasted blast).
- Sudden death: unchanged — the closing wall kills regardless of shield
  (prevents end-game stalling).
- Bots: no behavior change. Bots may waste shots on shielded targets; accepted.

## Server (`packages/server`)

- Replicate `shieldTicks` in the colyseus player schema so clients can render
  shield state.

## Client (`packages/client`)

- Asset: extract the gold shield icon from `winter_map.png` (crop box near
  (550, 1500)–(730, 1650)) into the free `gameplay7.png` slot at (394, 68) via
  `scripts/extract_winter_assets.py`; frame name `winter_shield`.
- `textures.ts`: `TEX.powerup[PowerupType.Shield] = { key: G7, frame: 'winter_shield' }`.
- Player visual while shielded: gold sprite tint, blinking during the last 2 s
  (mirror of the kick warning pattern); the overhead shield badge marks the
  buff. (A pulsing ring was considered and dropped as redundant.)
- `skillsTable.ts`: add a Shield row.

## Tests (shared)

- Shield blocks each attack type: explosion, mine blast, gun, hammer.
- Shield expires: tick 141 onward the player is killable.
- Sudden death kills a shielded player.
- Re-pickup refreshes the timer.
- Pickup keeps held weapon ammo/uses.
