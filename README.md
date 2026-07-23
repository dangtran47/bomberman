# Bomberman

A classic-style web Bomberman: 15x13 grid, bombs, chain reactions, powerups,
and a shrinking sudden-death arena. Play offline against three bots or online
with up to four players via room codes.

- **Deterministic simulation** — the same seed and inputs always produce the
  same game, so the browser (offline mode) and the server (online mode) run
  the identical shared code.
- **No assets** — all sprites are generated procedurally at boot and all
  sound effects are synthesized with WebAudio. The repo ships zero images and
  zero audio files.

## Monorepo layout

| Package | What it is |
| --- | --- |
| `packages/shared` | Deterministic fixed-tick simulation (20 tps), map generator, bot AI. Pure TypeScript, no runtime deps. |
| `packages/client` | Phaser 3 + Vite browser client. Offline vs bots, online via Colyseus. |
| `packages/server` | Colyseus 0.16 authoritative game server with 4-letter room codes. |

## Run locally

Requires Node 22+.

```sh
npm install
```

**Offline mode** (no server needed):

```sh
npm run dev --workspace @bomberman/client
```

Open the printed URL (default `http://localhost:5173`), pick "Play vs Bots".
Move with arrows/WASD, drop bombs with Space.

**Online mode** (two terminals):

```sh
# terminal 1 — game server on :2567
npm run dev --workspace @bomberman/server

# terminal 2 — client
npm run dev --workspace @bomberman/client
```

Pick "Create Room", share the 4-letter code, friends join via "Join Room"
(open a second browser tab to try it alone — the host can also fill empty
slots with bots). The client connects to `ws://localhost:2567` by default;
override with `VITE_SERVER_URL` (see `packages/client/.env.example`).

## Test and typecheck

```sh
npm test                                     # all workspaces (shared + server)
npx tsc --noEmit -p packages/shared          # typecheck a single package
npm run build --workspace @bomberman/client  # typecheck + production build
```

## Gameplay notes

- Matches start with a 75%-density soft-block field; blasts destroy soft
  blocks and have a 30% chance to drop a powerup (extra bomb, bigger blast,
  speed).
- **Sudden death**: after 2 minutes the border spirals inward clockwise, one
  tile every 0.5s becoming an indestructible block. It crushes bombs and
  powerups and kills anyone standing there, stopping after four rings so a
  center region stays playable. The HUD counts it down.
- Last player standing wins; simultaneous final deaths are a draw.

## Deploy

The server runs on [Fly.io](https://fly.io), the static client on
[Cloudflare Pages](https://pages.cloudflare.com). Nothing here auto-deploys —
these are the manual steps.

### 1. Server on Fly

```sh
fly launch --no-deploy -c packages/server/fly.toml   # once: create the app; pick your own name/region
fly deploy -c packages/server/fly.toml               # from the REPO ROOT (build context needs the workspace)
```

Notes:

- `fly launch --no-deploy` registers the app without deploying; edit the
  `app`/`primary_region` values in `packages/server/fly.toml` to match what
  you chose.
- Run `fly deploy` from the repo root: the Dockerfile copies the root
  lockfile plus `packages/shared` and `packages/server`.
- The server reads `PORT` (Fly sets/expects 8080, matching `internal_port`)
  and serves `GET /health` for the configured health check.
- Colyseus WebSockets work through Fly's standard `http_service` proxy — no
  extra config.

### 2. Client on Cloudflare Pages

Build the client pointing at your Fly app (note `wss://`):

```sh
VITE_SERVER_URL=wss://<your-app>.fly.dev npm run build --workspace @bomberman/client
```

Then deploy the static output in `packages/client/dist`:

```sh
npx wrangler pages deploy packages/client/dist
```

(or drag-and-drop the `dist` folder in the Cloudflare dashboard). No wrangler
config lives in the repo.

### Cost

The fly.toml uses a single `shared-cpu-1x` / 256MB machine with
`auto_stop_machines = "stop"` and `min_machines_running = 0`: the machine
stops whenever nobody is connected and auto-starts on the next request, so an
idle deployment costs approximately nothing. Cloudflare Pages static hosting
is free.
