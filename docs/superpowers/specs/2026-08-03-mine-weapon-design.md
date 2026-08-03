# Mine Weapon — Design Spec

Date: 2026-08-03
Status: Approved by user (trigger/timeline/acquisition/blast choices confirmed)

## Summary

A new placeable weapon: the proximity mine. A player with the Mine skill places a mine on
their tile. The mine arms after 2 seconds, then buries itself 3 seconds after arming,
becoming fully invisible. Any player (including the owner) who steps on an armed or
buried mine detonates it, burning that single tile.

## User-approved decisions

- **Trigger**: step-on, anyone including the owner.
- **Timeline**: measured from placement — 0–2s inert, 2–5s armed (flashing), 5s+ buried.
- **Acquisition**: new Mine powerup skill (like Gun/Hammer), grants 2 mines.
- **Blast**: single tile only (no cross rays).

## Simulation (packages/shared)

- New `Mine` entity: `{ id, col, row, ownerId, ticks }`. Stored in its own collection —
  mines never slide, never block movement (they must be walkable), and have no fuse.
- Constants (20 ticks/sec): `MINE_ARM_TICKS = 40` (2s), `MINE_BURY_TICKS = 100`
  (arm + 3s). Mines never expire; they persist until triggered or match end.
- Phases derived from `ticks`: inert (< 60), armed (60–199), buried (>= 200).
- Placement: `placeMine` when the input requests it, the player holds the Mine skill with
  ammo remaining, and the tile has no existing mine or bomb. Decrements `mineAmmo`.
- Trigger: each tick, if a mine is armed or buried and any alive player occupies its tile,
  it detonates. Standing on the tile at the moment arming completes also triggers it.
- A bomb blast that covers a mine's tile detonates the mine (consistent with bomb
  chain-detonation). A mine detonation adds one explosion cell at its own tile, reusing
  the existing explosion/burning/death pipeline. Because the blast covers only the mine's
  own tile and placement forbids sharing a tile with a bomb, a mine can never
  chain-detonate a bomb; no new chain code is needed in that direction.
- New `PowerupType.Mine`; `applyPowerup` sets `mineAmmo = 2` (matching Gun's grant style).
  Picking it up again refreshes to 2. Holding Mine replaces Gun/Hammer the same way those
  replace each other.

## Networking (packages/server)

- `MineSchema { id, col, row, ownerId, phase }` in a new `mines: MapSchema`.
- Server maps sim ticks to `phase` (0 inert / 1 armed / 2 buried). Phase changes twice per
  mine lifetime, so sync churn is minimal. All blinking is client-local.
- No client prediction for mines — server-authoritative, same as gun/hammer.

## Client (packages/client)

- `mine.png` (916×1554) holds 3 vertically stacked frames: dull mine, lit mine (red
  button + lights), red button alone. Loaded once in BootScene; three frames added at
  precise pixel rects (measured from alpha bounding boxes at implementation time) via
  `texture.add`. Scaled to tile size like the bomb sprite.
- Rendering by phase, in a `reconcileMines()` mirroring `reconcileBombs()`:
  - Phase 0 (inert): static dull frame.
  - Phase 1 (armed): alternate dull ↔ lit every ~250 ms (timer-driven texture swap).
  - Phase 2 (buried): renders nothing at all. (Amended from blinking red dot: bomb
    blasts destroy mines, so full invisibility has counter-play and is fair.)
  - Removal: existing explosion sprite + sound handle the detonation feedback.
- Input: skill key already routes to the held skill (gun fires, hammer swings); with the
  Mine skill held it sends a `placeMine` input flag. Skills table gains a Mine row (icon =
  dull mine frame, 2 uses).

## Bot AI (packages/shared/src/bot.ts)

- All mine tiles (inert included) join the `danger` set in `buildContext`, so pathfinding
  and flee logic avoid them. Mines never block movement. (Amended from "inert ignored":
  sim runs showed bots placing a mine and standing on it until it armed — 33/54 self-kills;
  including inert tiles in danger dropped this to 9/92.) `computeDangerTimes` ranks a mine
  tile by ticks-until-armed.

## Out of scope (YAGNI)

Kicking/pushing mines, disarming, multiple mines per tile, mine expiry, client prediction
for mine placement.

## Testing

TDD in packages/shared: placement gating (ammo, occupied tile), phase transitions at exact
tick boundaries, step-on detonation per phase (inert safe, armed/buried lethal, owner
included), bomb-blast chain trigger, single-tile blast (adjacent tiles unharmed), powerup
grant/refresh, bot avoidance of armed mine tiles. Server schema sync covered by existing
room test patterns if present.
