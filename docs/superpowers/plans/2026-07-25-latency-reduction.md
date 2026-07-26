# Latency Reduction Roadmap

Investigation done 2026-07-25. Player in Vietnam (Viettel), server on Fly.io `sin` (Singapore).

## Problem statement

Raw ping is fine (~50ms VN→SG, 40-60ms Singapore-local), but the game *feels* ~3-4x
worse than the ping number. Cannot reach LoL-style 20ms to a Singapore server from
Vietnam — physics floor VN→SG is ~40ms. All meaningful wins are in the client/server
latency stack, not the network.

### Measured route (VN Viettel → Fly sin)

```
hop 1-5   Viettel local        5-7ms
hop 6     Viettel int'l gw     30ms   ← domestic→international jump
hop 7     NTT Hong Kong        30ms   ← routed via HONG KONG (detour)
hop 10    NTT Singapore        67ms
hop 11    Fly (sin)            53ms
ping RTT  50-51ms, low jitter
```

Path detours through Hong Kong (NTT GIN backbone), ~10ms above the ~40ms direct floor.
Fly's upstream transit is not under our control.

### Perceived input→see-it delay (own move, no prediction) ≈ 180ms

```
input sample (render frame)   ~16ms
uplink (ping/2)                25ms
server tick wait (0-50, avg)   25ms   ← 20Hz sim buffer
downlink (ping/2)              25ms
next patch wait                ~0ms   (patch rate = tick rate)
interp lerp 0.35 settle       ~100ms  ← exp smoothing, ~7 frames to converge
────────────────────────────────────
TOTAL PERCEIVED              ~180ms
```

## Current stack (as of investigation)

- Transport: Colyseus `@colyseus/ws-transport` (WebSocket over `ws`), `packages/server/src/app.ts`
- Sim tick: 20Hz / 50ms — `TICK_RATE`, `packages/shared/src/constants.ts:4-5`; loop `GameRoom.ts:208`
- Patch/broadcast: Colyseus default 20Hz (no `setPatchRate` override)
- Input send: event-driven + 100ms keepalive, throttled to render frame — `GameScene.ts:61,652-667`
- Remote interp: exp lerp `ONLINE_LERP=0.35` — `GameScene.ts:59`, applied `:680`. No client prediction (`GameScene.ts:291`) (as of investigation; superseded, see #2/#3 below)
- Lag comp: ping-scaled turn-grace snap-back — `shared/src/game.ts:232-233,491-514`; caps `GRACE_CAP=0.45`, `PING_CAP_MS=400`
- Host: `packages/server/fly.toml` — `primary_region='sin'`, `size='shared-cpu-1x'`, 256MB

## Fixes, ranked by ROI

### ✅ 1. Disable Nagle (TCP_NODELAY) — DONE
Node sockets default `noDelay=false` → Nagle can hold small 20Hz game packets up to
~40ms waiting for an ACK. Fixed in `packages/server/src/app.ts` via
`httpServer.on('connection', (socket) => socket.setNoDelay(true))` (covers all WS
upgrades). Mostly cuts jitter spikes, not baseline ping. Needs deploy to take effect.

### ✅ 2. Client-side prediction + reconciliation — biggest feel win — DONE
Built via `docs/superpowers/plans/2026-07-26-netcode-prediction-v2.md` (this branch).
Actual shape: a per-tick sequenced input queue (server applies exactly one input per
tick, which also fixes hold-duration→distance determinism), a client predictor that
rebases and replays unacked input on each server snapshot, and a `lastInputSeq` ack so
own-player movement renders locally with ~0ms feel regardless of ping.
Spec: `docs/superpowers/specs/2026-07-25-client-prediction-design.md`
Superseded plan: `docs/superpowers/plans/2026-07-25-client-prediction.md`

### ✅ 3. Snapshot interpolation for remote players — DONE
Built via `docs/superpowers/plans/2026-07-26-netcode-prediction-v2.md` (this branch).
Replaced the exp lerp (`ONLINE_LERP=0.35`, ~100ms convergence tail) with a time-based
100ms snapshot buffer, lerping remote players between two buffered snapshots by
timestamp. Bounds remote delay to ~1 tick and reads smoother than the old exp settle.

### 🟡 4. Raise tick + patch rate 20→30Hz — BLOCKED on dedicated CPU
30Hz halves the tick-wait window (25→17ms avg). BUT `shared-cpu-1x` can't sustain
higher rates reliably (CPU preemption → jitter, worse than low tick). Upgrade fly.toml
to dedicated/performance CPU first, then bump `TICK_RATE` and set Colyseus patch rate.
Do after #2 and #3.

### 🟢 5. Test alternate SG hosts (skip HK detour) — optional, ~10ms
Ping-test Vultr / DigitalOcean SG + AWS `ap-southeast-1` from a VN Viettel connection —
some sit on direct VN-SG cables (AAG/SMW) and skip the HK detour. Low priority vs the
stack fixes. Real sub-30ms only comes from a VN-hosted server (Fly has no VN region;
would need VNG Cloud / Viettel IDC / FPT, plus region-aware matchmaking so SG players
don't regress).

## Do-order

1. ✅ setNoDelay — done, deploy.
2. ✅ Client prediction (#2) — done, see above.
3. ✅ Snapshot interpolation (#3) — done, see above.
4. Dedicated CPU + 30Hz (#4).
5. Optional: alt-host routing test (#5).

Network baseline (~50ms) is near floor — do not chase it.

## turnGrace note

The ping-scaled turn-grace snap-back (`shared/src/game.ts:232-233,491-514`) is now
inert on the online path: the sequenced-input queue carries no `pingMs`, and
tick-exact input replay (per #2 above) supersedes what turn-grace was compensating
for. It's dead code online at this point and can be deleted in a future cleanup.
