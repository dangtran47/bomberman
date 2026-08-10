# Netcode Feel v3: 60 Hz, turnGrace revival, momentum removal

Date: 2026-08-10
Status: approved

## Problem

Controls feel less responsive than they should:

1. **turnGrace is dead code.** The client reports `pingMs` in every input, but
   `InputQueue` (which replaced `inputBuffer` in dc5358e) drops it, so
   `game.ts` always computes `turnGrace = 0`. Online cornering overshoots
   junctions with no latency compensation.
2. **20 Hz tick is the dominant input-latency floor.** Input waits up to 50 ms
   for the next step, and the sub-tick render blend trails up to another 50 ms.
3. **Ice momentum reads as heavy, laggy movement.** Glide, turn-delay, and
   momentum bookkeeping fight the player instead of feeling fast.

## Decisions (user-approved)

- Tick rate: **60 Hz** sim + input send rate. Colyseus patch rate stays at its
  20 Hz default, so downstream bandwidth is unchanged.
- Ice: momentum/glide/turn-delay logic is **removed**; standing on an ice tile
  now applies a flat **1.5× speed multiplier** (`ICE_SPEED_MULT`), stacking
  with the Speed powerup.
- turnGrace: revived by forwarding `pingMs` through `InputQueue`, clamped
  server-side to `PING_CAP_MS`; the client `Predictor` applies the same grace
  formula so rebase+replay converges.

## Design

### A. pingMs → turnGrace

- `InputQueue.push` validates `pingMs` (finite number ≥ 0, clamped to
  `PING_CAP_MS` — never trust the client) and stores it per queued input.
- `consume()` emits it in `PlayerInput`; the dry-hold path (TCP stall) repeats
  the last seen `pingMs` alongside `heldDirection`.
- Bots and legacy clients send none → grace 0, unchanged.
- Client `Predictor.step` takes the current `pingMs`, stores it on the pending
  input, and `apply()` sets `player.turnGrace` with the exact `game.ts`
  formula before `stepPlayer` — replayed inputs use the pingMs they were sent
  with, mirroring what the server will compute.

### B. 60 Hz tick

- `TICK_RATE = 60`, `TICK_MS = 1000 / 60`. Every duration constant is declared
  in seconds via a `secs()` helper so real-time behavior is unchanged.
- Server: `setSimulationInterval` with a raw callback drifts (setInterval
  jitter), so `GameRoom` pumps an accumulator from the callback's `deltaTime`
  (clamped to 250 ms catch-up) and steps `simTick` in whole-tick multiples.
- `InputQueue` backlog cap is time-derived: 250 ms of ticks (15 at 60 Hz).
- Client: `MAX_STEPS_PER_FRAME` 5 → 10 (5 steps is only 83 ms of catch-up at
  60 Hz). `INTERP_DELAY_MS` and error smoothing are ms-based, unchanged.
- Bots: per-tick attack chances rescaled (÷3) to keep real-time attack
  cadence; `SHRINK_LOOKAHEAD_TICKS` derived from seconds.

### C. Momentum removal, ice speed boost

- `stepPlayer`: frozen → no move; no direction → stop dead (no glide);
  direction → `movePlayer` with budget multiplier `ICE_SPEED_MULT` when the
  player's tile is ice.
- Removed everywhere: `momentumDir`, `momentumTicks`, `turnTicks` (types,
  game init, killPlayer, PlayerSchema, copySimToSchema, NetPlayer,
  predictedFromNet). `laneDir` + corner slide + `turnGrace` stay — they are
  the good part of the feel.
- Removed constants: `ICE_GLIDE_TICKS`, `ICE_GLIDE_SPEED_MULT`,
  `ICE_TURN_DELAY_TICKS`. Added: `ICE_SPEED_MULT = 1.5`.
- The `ice` mask and Winter map remain; ice tiles are now speed lanes.

## Compatibility

Server and client must deploy together: schema fields changed and every
tick-denominated quantity moved. (The repo already requires paired deploys for
shared-sim changes — the grid is seed-derived on both sides.)

## Testing

- `inputQueue.test.ts`: pingMs forwarding, clamping, dry-hold retention;
  backlog cap re-derived.
- Ice drift tests replaced by ice speed-boost tests.
- `turnGrace.test.ts` unchanged (formula untouched) but now guards a live path.
- `prediction.test.ts`: rebase+replay converges with turnGrace active.
- Manual playtest by the user; deploy deferred.
