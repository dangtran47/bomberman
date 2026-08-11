# Bomb Ownership Blocking — Design

Date: 2026-08-11
Status: approved

## Problem

Two related defects in how bombs interact with players overlapping their tile:

1. **Own-bomb turn bug (reported):** place a bomb while moving past a junction,
   then press a perpendicular turn — the character slides a full extra tile in
   the old direction instead of turning. Root cause: `applyTurnGrace` calls
   `canEnter` on the junction tile, which (offset < 0.5, `GRACE_CAP = 0.45`) is
   always the player's *current* tile — the tile the just-placed bomb sits on.
   The snap is refused, `laneAhead` honours the stale lane commitment, and the
   player overshoots. Reproduced in sim: y=6.8 moving up, bomb at row 7, press
   right → y runs to 6.0 before turning (without the bomb: snaps to 7, turns
   immediately).
2. **Bombs don't wall partially-entered enemies (discovered during review):**
   a player whose center has crossed a tile boundary (e.g. x=5.6, rounded tile
   6) walks straight *through* a bomb on tile 6 — the aligned-advance path only
   checks the tile ahead (`cur + sign`), never the current rounded tile. A bomb
   placed in a chasing enemy's face does nothing.

Both trace to the same missing concept: the sim has no notion of *who* may
overlap a bomb tile. Decision: introduce bomb ownership into movement.

## Rule

> **A bomb tile is solid for everyone except its owner, and for the owner only
> while they have continuously remained on the tile since placement.**

Concretely, per bomb: `ownerId` (already exists) + new `ownerOnTile: boolean`.

| Who | Position relative to bomb tile | Allowed movement |
|---|---|---|
| Owner, `ownerOnTile` | anywhere on the tile | free — walk over/off in any direction, turn-grace snap allowed (fixes bug 1) |
| Owner, after leaving | adjacent | blocked like anyone else (no re-entry; `ownerOnTile` revoke is permanent) |
| Non-owner | adjacent tile | blocked (unchanged) |
| Non-owner | partially overlapping (crossed boundary, e.g. 5.6 vs center 6) | **retreat only** — any move that reduces distance to the tile center is refused; moves away are free (fixes bug 2) |
| Non-owner | exactly at the center when the bomb appears | every direction is "away" → can always leave; nobody is ever hard-stuck |

Why retreat-only instead of a grandfather set for non-owners: a per-overlap
grandfather list would readmit the just-entered enemy (their rounded tile *is*
the bomb tile), defeating the point. Retreat-only is safe because the entry
side was necessarily open at placement time; if a second bomb later closes it,
that is a legitimate pincer trap kill, not a stuck state.

Why the owner is exempt: the owner frequently places while running (bomb lands
on the tile they are 60% into); walling them mid-stride would stop them on
their own bomb. Classic behaviour: run through, and once off, the bomb is a
wall for them too.

## Shared sim (`packages/shared`)

- `types.ts` `Bomb`: add `ownerOnTile: boolean`.
- `movement.ts`:
  - `MovementPlayer` gains `id: string`; `MovementBomb` gains `ownerId: string`
    and `ownerOnTile: boolean`.
  - `canEnter(world, col, row, moverId?)`: a bomb no longer blocks when
    `bomb.ownerId === moverId && bomb.ownerOnTile`. Callers pass the moving
    player's id; pathing-style callers may omit it (bombs then always block).
  - `applyTurnGrace`: unchanged shape — passing the mover id through `canEnter`
    now permits the snap on the player's own fresh bomb and still refuses it
    for a non-owner overlapping someone else's bomb (consistent with
    retreat-only: the snap is center-ward motion on the perpendicular axis).
  - `movePlayer` aligned advance: new guard — if the mover's current rounded
    tile holds a bomb the mover is not exempt from, movement whose sign points
    toward that tile's center (`sign * (center - pos) > EPS`) is refused
    (blocked, no displacement). Movement away is untouched. This also kills the
    walk-through: crossing the center is center-ward until reached.
  - `laneAhead` "already inside that tile" branch (`lane === nearest`): now
    also refuses (`null`) when that tile holds a bomb the mover is not exempt
    from — settling onto the lane is center-ward motion on the perpendicular
    axis. The `lane !== nearest` branch keeps its existing `canEnter` check,
    now mover-aware.
- `game.ts`:
  - `placeBomb`: new bombs start `ownerOnTile: true` (placement tile is the
    owner's rounded tile by construction).
  - `tick()`: after movement and `moveSlidingBombs`, revoke `ownerOnTile` on
    any bomb whose owner is dead, gone, or whose rounded tile no longer equals
    the bomb tile (covers both the owner walking off and the bomb being kicked
    out from under the owner). Revoke is one-way; only `placeBomb` sets it.
- Kick interaction: unchanged. The kick fires from the *tile-ahead* blocked
  branch; the new current-tile guard never triggers a kick (you cannot kick a
  bomb you are overlapping).
- Bots (`bot.ts`): `isPassable` keeps treating every bomb tile as blocked
  (fine — flood fill already special-cases the start tile, which is how a bot
  escapes its own bomb). Known risk: a bot walled retreat-only on a rival's
  bomb tile relies on the driver's existing refusal/recenter escape
  (see lane-refusal fix); covered by keeping the full bot suite green.

## Server (`packages/server`)

- `BombSchema`: add `@type('boolean') ownerOnTile = true`.
- `copySimToSchema`: mirror the flag (write-guarded like `minePhase` — it
  changes at most once per bomb, so idle bombs cost no delta).

## Client (`packages/client`)

- `prediction.ts`:
  - `Obstacle` (server bombs passed into the predictor) gains
    `ownerId`/`ownerOnTile`; `asMovementBomb` forwards them.
  - `PredictedBomb` (locally placed, unacked) gains `ownerOnTile`, starts
    `true` with `ownerId` = local player. `apply()` mirrors the server revoke
    after `stepPlayer`: rounded player tile ≠ bomb tile → `ownerOnTile = false`.
    The revoke lives inside `apply` so reconcile replays reproduce it
    deterministically.
  - `PredictedPlayer` carries `id` (now required by `MovementPlayer`).
- `GameScene`: build `serverBombs` with the two new fields from `BombSchema`;
  seed the predictor's player id from the own `PlayerSchema.id`.

## Tests

Shared (`test/bombBlocking.test.ts` + a case in `turnGrace.test.ts`):
1. Regression (bug 1): moving up past a junction, place bomb + turn with ping →
   snaps to the junction and turns immediately; no extra tile of travel.
2. Non-owner at 5.6 vs bomb at 6: pressing toward center → no movement; with
   the far side open, cannot walk through either.
3. Same position, pressing away → retreats and escapes normally.
4. Same position, pressing a perpendicular turn → refused (no settling onto
   the bomb lane), pressing the turn after retreating works.
5. Owner places while running (bomb lands ahead of center) → runs through
   unimpeded; turn-grace snap on the own bomb tile works.
6. Owner leaves the tile → cannot re-enter (revoke permanent).
7. Non-owner exactly centered when the bomb appears under them → can leave in
   any direction.
8. Kicked bomb sliding off the owner's tile revokes `ownerOnTile`.

Server: `schema.test.ts` — `ownerOnTile` mirrored and write-guarded.
Client: `prediction.test.ts` — predicted bomb revoke on walk-off; replay after
reconcile converges (no correction) for the place-and-turn sequence.

## Out of scope

- The `inputQueue` `pingMs` drop (online `turnGrace` always 0) is a separate
  open regression; this change neither fixes nor depends on it. Bug 1's fix
  matters even at grace 0 because the client predictor does apply grace.
- No visual/UX changes; blocking reuses existing collision feel.
