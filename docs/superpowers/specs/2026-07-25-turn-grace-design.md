# Latency-Scaled Turn Grace — Design

**Date:** 2026-07-25
**Status:** Approved, pending implementation

## Problem

In online (room) mode the player often overshoots the tile where they intend
to turn. In offline (bot) mode turning is accurate. This is a network-latency
artifact, not a logic bug.

Root cause chain:

- Movement is grid-locked. A turn only commits when the player is aligned to a
  junction (`packages/shared/src/game.ts` `movePlayer`/`laneAhead`, ~477–568).
- Offline: direction is sampled from the local keyboard every sim tick with
  zero latency, so the turn commits exactly at the junction. Positions are
  snapped (`positionPlayers(state, 1)`).
- Online: there is **no client-side prediction** (confirmed by the comment at
  `GameScene.ts:292`). The client sends the direction to the authoritative
  server and waits a full RTT. During that RTT the server keeps applying the
  old direction (`InputBuffer` is latest-wins, non-sticky for direction), so
  the player rolls **past** the junction. When the turn finally arrives,
  `laneAhead` snaps the player *forward* to the next tile
  (`ceil`/`floor` on a perpendicular commit) → a full-tile overshoot.

Worse at higher ping (VN v4 ~50ms vs v6 route ~360ms).

## Chosen approach

**A — Cornering grace (latency-scaled snap-back tolerance).**

On a **turn onset** — an input that changes the movement axis (was moving
horizontally, now vertical, or vice versa) — if the player has passed the last
junction on the axis being left by no more than `grace`, snap **back** onto
that junction center and commit the turn there instead of snapping forward to
the next tile.

Early input (pressed before the junction) already works today; this adds
tolerance on the **trailing** side, which is exactly the case latency
produces.

Rejected alternatives:

- **B — Timed input buffer (hold N ticks, apply at next alignment ahead).**
  Only helps input that arrives *early*. Late input still snaps forward →
  overshoot not fixed.
- **C — Lag compensation / rewind.** Server timestamps inputs and rewinds the
  player to input-time position. Needs client timestamps + server-side
  position history. Overkill for a party game.

## Grace formula (ping-scaled, per player)

```
grace = min(GRACE_CAP, player.speed * oneWaySec)   // tiles
oneWaySec = clamp(pingMs, 0, PING_CAP) / 2 / 1000
```

Constants:

- `GRACE_CAP = 0.45` tile. Never reaches the next junction center (0.5), so
  there is never ambiguity about which junction the turn belongs to.
- `PING_CAP ≈ 400` ms. Bounds spikes and abusive/spoofed ping values.
- `player.speed` is in tiles/sec (per-tick budget is `player.speed / TICK_RATE`).

Offline and bots supply no ping → `grace = 0` → behavior is byte-identical to
today. **Bot mode is unaffected.**

## Plumbing (client ping → shared sim)

The sim is authoritative and shared; it needs a per-player latency figure.

1. **Client** already tracks RTT as `this.pingMs` (set in the `pong` handler,
   `GameScene.ts:454`). Add `pingMs` to the `input` message payload sent at
   `GameScene.ts:661`.
2. **`InputBuffer`** (`packages/server/src/rooms/inputBuffer.ts`): accept and
   store an optional `pingMs` on the entry (latest-wins, validated/clamped to a
   number; malformed ignored). `consume()` includes it in the snapshot.
   `PlayerInput` (shared type) gains an optional `latencyMs` / `pingMs` field.
3. **`game.ts tick()`**: for each player, before `stepPlayer`, set
   `player.turnGrace` from the input's ping and the player's current speed using
   the formula above. When no ping is present, set `0`.
4. **`movePlayer` / `laneAhead`**: consume `player.turnGrace` to allow the
   trailing-side snap on a turn onset.

New field: `Player.turnGrace: number` (default `0`).

## Turn-onset detection

A turn onset is when the requested `direction` is perpendicular to the axis the
player is currently committed to (`player.laneDir`). At that moment, check the
alignment offset on the axis being left:

- offset within `[0, grace]` **past** the nearest junction → snap back to that
  junction (`round`), then move in the new direction;
- otherwise unchanged (early-input path and the existing forward-slide stay as
  they are).

`grace = 0` collapses this to "snap back only when already exactly aligned",
i.e. current behavior.

## Scope

- `packages/shared` — `game.ts` (tick + movePlayer/laneAhead), `Player` type
  (`turnGrace`), `PlayerInput` type (ping field).
- `packages/server` — `inputBuffer.ts` (carry ping), `PlayerInput` consumption.
- `packages/client` — one line: add `pingMs` to the input message.

~4 files.

## Testing

Shared-sim unit tests (deterministic, no network):

- **Offline parity:** `grace = 0`, turn requested exactly at a junction →
  turns; turn requested past the junction → snaps forward (unchanged today).
- **Trailing grace:** player at `x = C + 0.3`, `grace = 0.4`, turn up requested
  → snaps back to `x = C`, moves up.
- **Beyond grace:** player at `x = C + 0.5`, `grace = 0.4` → no snap-back,
  overshoot to next junction (expected — bounded by `GRACE_CAP`).
- **Determinism:** grace is derived from the input payload, so replay of the
  same input stream is reproducible.

## Risk

A small server-side snap-back produces a minor client rubber-band, smoothed by
`ONLINE_LERP = 0.35`. Acceptable for the accuracy gain.
