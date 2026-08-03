/**
 * Multiplayer simulation test: spawns the dev server with simulated latency,
 * opens 4 real Chrome windows, and has each one play the game like a human —
 * real UI clicks to create/join the room, real keyboard input during the match.
 *
 * Each browser runs the full client against the lagged server; the windows
 * render what a player would see. Bot decisions reuse the shared bot AI
 * (@bomberman/shared bot.ts), running in THIS process at the sim tick rate
 * (50ms) against the server's authoritative state (dev-only /debug/sim
 * endpoint, enabled via SIM_DEBUG_STATE=1) — perfect information, like the
 * offline bots. Each decision is then sent through that bot's own browser
 * client (room.send, legacy seq-0 latest-wins inputs), so the netcode path
 * under test stays fully exercised while the AI is never handicapped by
 * patch delay. GameScene suppresses its own input sends and pins its
 * predictor to the server state via the __botDirect dev flag (see
 * startBotPilots for the history of in-page sensing failures this replaced).
 *
 * Usage:
 *   make simtest                # LAG=50 (round-trip ms) by default
 *   make simtest LAG=120
 *   HEADLESS=1 KEEP=0 node_modules/.bin/tsx scripts/multiplayer-sim.ts
 *
 * Env:
 *   LAG       simulated round-trip latency in ms (default 50)
 *   GAMES     consecutive matches to play in the same room (default 5). After
 *             each match the host presses Enter on the results screen
 *             (Continue -> lobby) and Enter again in the lobby to start the
 *             next one — the same flow two humans use. The spawned server's
 *             stdout streams into this console, so its per-match `[perf]`
 *             lines (tick cost, heap, schema-encoder ref counts) interleave
 *             with the per-match client pings — the two trends the
 *             "lag climbs across consecutive matches" hypothesis predicts.
 *   PLAYERS   number of browser players, 2-4 (default 4)
 *   HEADLESS  1 = headless Chrome (default headed, 2x2 window grid)
 *   KEEP      0 = exit when the round ends (default: keep browsers open)
 *   AGGRO     1 = bots hunt each other from the start (short rounds — the
 *             shared brain kills fast even offline). Default is campaign
 *             mode: enemies are hidden from each bot's world view until
 *             sudden death (120s), so bots dig, collect powerups, and dodge
 *             for the whole match, then fight in the endgame.
 *   DEBUG     1 = print per-bot driver counters every second
 *
 * Requires Google Chrome installed (playwright-core channel:'chrome' — no
 * browser download).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { SUDDEN_DEATH_START_TICKS, createBot, createRng } from '../packages/shared/src';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const VITE = path.join(ROOT, 'node_modules', '.bin', 'vite');

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : Number(raw);
}

const LAG = envNumber('LAG', 50);
const GAMES = Math.max(1, envNumber('GAMES', 5));
const PLAYERS = Math.min(4, Math.max(2, envNumber('PLAYERS', 4)));
const HEADLESS = process.env.HEADLESS === '1';
const KEEP = process.env.KEEP !== '0';
const AGGRO = process.env.AGGRO === '1';

const SERVER_PORT = 2567;
const CLIENT_PORT = 5199; // fixed, away from the usual dev 5173
const BASE_URL = `http://localhost:${CLIENT_PORT}`;

// Canvas is 756x706 (main.ts); a matching viewport makes Scale.FIT render 1:1,
// so menu buttons sit at their designed coordinates.
const VIEW = { width: 756, height: 706 };
const MENU_CREATE = { x: 378, y: 350 };
const MENU_JOIN = { x: 378, y: 420 };

const NICKNAMES = ['Alice', 'Bob', 'Carol', 'Dave'];

const children: ChildProcess[] = [];
const browsers: Browser[] = [];
let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function shutdown(code: number): Promise<never> {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;
  await Promise.allSettled(browsers.map((b) => b.close()));
  for (const child of children) {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM'); // negative pid = whole group (vite/tsx spawn helpers)
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
  await sleep(300);
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

async function httpUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function startInfra(): Promise<void> {
  if (await httpUp(`http://localhost:${SERVER_PORT}/health`)) {
    console.log(`⚠ server already running on :${SERVER_PORT} — reusing it (its latency setting applies, not LAG=${LAG})`);
  } else {
    console.log(`starting server on :${SERVER_PORT} with SIMULATE_LATENCY_MS=${LAG}`);
    // cwd matters: tsx must pick up the server's tsconfig (decorators).
    const server = spawn(TSX, ['src/index.ts'], {
      cwd: path.join(ROOT, 'packages/server'),
      env: {
        ...process.env,
        SIMULATE_LATENCY_MS: String(LAG),
        PORT: String(SERVER_PORT),
        // Dev endpoint the bot pilots read the authoritative sim state from.
        SIM_DEBUG_STATE: '1',
      },
      // Server output streams into this console so the per-match [perf] lines
      // (GameRoom.logMatchPerf) land next to the client-side ping samples.
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    });
    children.push(server);
    await waitFor('game server', () => httpUp(`http://localhost:${SERVER_PORT}/health`), 15000);
  }

  if (await httpUp(BASE_URL)) {
    console.log(`⚠ client already running on :${CLIENT_PORT} — reusing it`);
  } else {
    console.log(`starting vite client on :${CLIENT_PORT}`);
    const vite = spawn(VITE, ['--port', String(CLIENT_PORT), '--strictPort'], {
      cwd: path.join(ROOT, 'packages/client'),
      env: { ...process.env },
      stdio: 'ignore',
      detached: true,
    });
    children.push(vite);
    await waitFor('vite dev server', () => httpUp(BASE_URL), 20000);
  }
}

async function launchPlayer(index: number): Promise<Page> {
  const col = index % 2;
  const row = Math.floor(index / 2);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: HEADLESS,
    args: [
      '--mute-audio',
      // Chrome throttles rAF and timers for unfocused/occluded windows, which
      // kills Phaser's update loop (and with it the input-send loop) in every
      // window but the focused one ~a minute into the match: the bot driver's
      // setInterval keeps deciding, the synced state keeps arriving over the
      // websocket, but no inputs go out — the server dry-holds the last
      // direction and the player freezes mid-map (decision rings show keyed
      // directions with a stale `facing`, i.e. nothing reaching the server).
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      `--window-position=${col * 770},${row * 790}`,
      `--window-size=770,790`,
    ],
  });
  browsers.push(browser);
  const context = await browser.newContext({ viewport: VIEW });
  const page = await context.newPage();
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 15000 });
  return page;
}

/** Clicks a Phaser menu button until its HTML dialog opens (scene load is async). */
async function openDialog(page: Page, at: { x: number; y: number }, inputCount: number): Promise<void> {
  await waitFor(
    'menu dialog',
    async () => {
      if ((await page.locator('input').count()) >= inputCount) return true;
      await page.mouse.click(at.x, at.y);
      await sleep(300);
      return (await page.locator('input').count()) >= inputCount;
    },
    15000,
  );
}

async function submitDialog(page: Page, values: string[]): Promise<void> {
  const inputs = page.locator('input');
  for (let i = 0; i < values.length; i++) await inputs.nth(i).fill(values[i]);
  await page.getByText('OK', { exact: true }).click();
}

/** Reads a value out of the dev-only `window.__room` hook (null until joined). */
function roomEval<T>(page: Page, expr: string): Promise<T | null> {
  return page.evaluate(
    (e) =>
      // eslint-disable-next-line no-new-func
      new Function('hook', `return hook ? (${e}) : null`)((window as never as { __room?: unknown }).__room) as never,
    expr,
  );
}

async function waitForRoom(page: Page, name: string): Promise<void> {
  await waitFor(`${name} to join the room`, async () => (await roomEval<string>(page, 'hook.playerId')) !== null, 15000);
}

/**
 * Presses Enter on the host until the room reaches `phase`. Enter is the
 * host's advance key on both screens this drives (results -> Continue,
 * lobby -> start), and pressing it early or twice is harmless: the results
 * handler only fires while 'finished' and the lobby handler only while
 * 'lobby', so retrying just re-sends a message the server ignores.
 */
async function hostEnterUntilPhase(host: Page, phase: string, what: string): Promise<void> {
  await waitFor(
    what,
    async () => {
      if ((await roomEval<string>(host, 'hook.room.state.phase')) === phase) return true;
      await host.keyboard.press('Enter');
      await sleep(500);
      return (await roomEval<string>(host, 'hook.room.state.phase')) === phase;
    },
    20000,
  );
}

/**
 * Per-match bot pilots. The brains (shared bot.ts) run HERE in the harness
 * process against the server's authoritative sim state, fetched from the
 * dev-only /debug/sim endpoint every 50ms — zero sensing latency, the same
 * perfect information the offline bots enjoy. Each decision then travels
 * through that bot's real browser client (room.send on its page), so the
 * input path under test — websocket, simulated latency, server input queue —
 * stays fully exercised. The pages themselves only render; window.__botDirect
 * suppresses GameScene's own input sends and pins its predictor to the
 * server state so every window draws players where the server has them.
 *
 * Earlier versions ran the brains inside each page against the SYNCED state:
 * sensing lagged 100-450ms behind the server (patch delay, rAF throttling,
 * input-queue backlog), and no amount of steering machinery made a per-tick
 * re-planning brain converge on 200ms-stale information. Reading server truth
 * is a cheat the game itself never gets, but the sim's job is to exercise the
 * netcode, not to handicap the AI.
 */
interface BotPilots {
  rings: Map<string, unknown[]>;
  counters: { ticks: number; errors: number; lastError: string; lastInput: string }[];
  stop(): Promise<void>;
}

async function startBotPilots(
  code: string,
  pages: Page[],
  playerIds: string[],
  seed: number,
): Promise<BotPilots> {
  // Relay mode: scene stops sending its own (empty) inputs and mirrors the
  // server position for the own sprite.
  await Promise.all(
    pages.map((p) =>
      p.evaluate(() => {
        (window as never as { __botDirect: boolean }).__botDirect = true;
      }),
    ),
  );

  const bots = playerIds.map((id, i) => ({ id, bot: createBot(id, createRng(seed + i)) }));
  const rings = new Map<string, unknown[]>(playerIds.map((id, i) => [NICKNAMES[i], []]));
  const counters = playerIds.map(() => ({ ticks: 0, errors: 0, lastError: '', lastInput: '' }));
  /** Last two decision directions per bot; placements only fire from rest. */
  const recentDirs: (string | null)[][] = playerIds.map(() => []);
  let stopped = false;
  let inFlight = false;

  const sendInput = (page: Page, msg: unknown) =>
    page
      .evaluate((m) => {
        const w = window as never as {
          __room?: { room: { send: (type: string, message: unknown) => void } };
        };
        w.__room?.room.send('input', m);
      }, msg)
      .catch(() => undefined);

  const idle = { seq: 0, direction: null, placeBomb: false, pingMs: 0 };

  const timer = setInterval(() => {
    if (stopped || inFlight) return; // skip a beat rather than pile up fetches
    inFlight = true;
    void (async () => {
      let snap: { phase: string; state: any } | null = null;
      try {
        const res = await fetch(`http://localhost:${SERVER_PORT}/debug/sim/${code}`, {
          signal: AbortSignal.timeout(300),
        });
        if (res.ok) snap = (await res.json()) as { phase: string; state: any };
      } catch {
        /* transient — server busy or between matches */
      }
      inFlight = false;
      if (stopped || snap === null) return;
      if (snap.phase !== 'playing' || snap.state.status === 'finished') return;

      const state = snap.state;
      // Campaign mode: enemies are hidden from each bot until sudden death so
      // matches show digging and dodging before the endgame fight.
      const passive = !AGGRO && state.tick < SUDDEN_DEATH_START_TICKS;
      for (let i = 0; i < bots.length; i++) {
        const { id, bot } = bots[i];
        const view = passive
          ? { ...state, players: state.players.map((p: any) => (p.id === id ? p : { ...p, alive: false })) }
          : state;
        let input;
        try {
          input = bot.computeInput(view);
        } catch (error) {
          counters[i].errors++;
          counters[i].lastError = error instanceof Error ? error.message : String(error);
          continue;
        }
        counters[i].ticks++;
        // Placement gate: the input still arrives 1-2 server ticks late, so a
        // bomb or mine sent while the player is coasting can land a tile away
        // from the plan. Only place from a standstill (this decision and the
        // previous two all wanted no movement).
        const rest =
          input.direction === null &&
          recentDirs[i].length === 2 &&
          recentDirs[i].every((d) => d === null);
        if ((input.placeBomb === true || input.placeMine === true) && !rest) {
          input.placeBomb = false;
          input.placeMine = false;
        }
        recentDirs[i].push(input.direction ?? null);
        if (recentDirs[i].length > 2) recentDirs[i].shift();
        counters[i].lastInput = JSON.stringify(input);

        const me = state.players.find((p: any) => p.id === id);
        const ring = rings.get(NICKNAMES[i])!;
        ring.push({
          t: state.tick,
          x: me?.x,
          y: me?.y,
          d: input.direction,
          pb: input.placeBomb,
          pm: input.placeMine ?? false,
          r: bot.lastRule,
        });
        if (ring.length > 40) ring.shift();

        void sendInput(pages[i], {
          seq: 0,
          direction: input.direction ?? null,
          placeBomb: input.placeBomb === true,
          fireGun: input.fireGun === true,
          swingHammer: input.swingHammer === true,
          placeMine: input.placeMine === true,
          pingMs: 0,
        });
      }
    })();
  }, 50);

  return {
    rings,
    counters,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.all(pages.map((p) => sendInput(p, idle)));
    },
  };
}

interface RoundView {
  phase: string;
  tick: number;
  winnerId: string;
  players: { id: string; nickname: string; alive: boolean; placement: number }[];
}

function roundView(page: Page): Promise<RoundView | null> {
  return page.evaluate(() => {
    (globalThis as never as { __name?: unknown }).__name ??= (f: unknown) => f;
    const hook = (window as never as { __room?: { room: { state: any } } }).__room;
    if (!hook) return null;
    const s = hook.room.state;
    const players: unknown[] = [];
    s.players.forEach((p: any, id: string) =>
      players.push({ id, nickname: p.nickname, alive: p.alive, placement: p.placement }),
    );
    return { phase: s.phase, tick: s.tick, winnerId: s.winnerId, players } as never;
  });
}

/**
 * Each page's measured round-trip time (GameScene's ping/pong HUD value), read
 * off the dev-only `window.__scene` hook. This is the number the players watch
 * climb, so its per-match trend is the client half of the hypothesis check.
 */
async function pingLine(pages: Page[]): Promise<string> {
  const pings = await Promise.all(
    pages.map((p) =>
      p
        .evaluate(() => {
          const scene = (window as never as { __scene?: { pingMs?: number | null } }).__scene;
          return scene && typeof scene.pingMs === 'number' ? scene.pingMs : null;
        })
        .catch(() => null),
    ),
  );
  return pings.map((ms, i) => `${NICKNAMES[i]}=${ms === null ? '--' : `${ms}ms`}`).join(' ');
}

/** DEBUG=1: pilot counters + each page's synced vs predicted own position. */
async function debugSample(pages: Page[], pilots: BotPilots): Promise<void> {
  for (let i = 0; i < pages.length; i++) {
    const info = await pages[i]
      .evaluate(() => {
        const w = window as never as {
          __room?: { room: { state: any }; playerId: string };
          __scene?: { predictor?: { player?: { x: number; y: number } } };
        };
        if (!w.__room) return null;
        const me = w.__room.room.state.players.get(w.__room.playerId);
        // Predicted own position: the own window renders the sprite from this,
        // so it diverging from the synced position means the player watches
        // themselves in the wrong place (the __botDirect freeze bug).
        const pp = w.__scene?.predictor?.player;
        return {
          x: me ? Math.round(me.x * 10) / 10 : -1,
          y: me ? Math.round(me.y * 10) / 10 : -1,
          px: pp ? Math.round(pp.x * 10) / 10 : null,
          py: pp ? Math.round(pp.y * 10) / 10 : null,
          alive: me?.alive ?? false,
        };
      })
      .catch(() => null);
    const c = pilots.counters[i];
    if (info && c) {
      console.log(
        `  [${NICKNAMES[i]}] ticks=${c.ticks} errors=${c.errors} pos=(${info.x},${info.y})` +
          ` predicted=(${info.px},${info.py}) alive=${info.alive}` +
          `${c.lastError ? ` lastError=${c.lastError}` : ''} lastInput=${c.lastInput}`,
      );
    }
  }
}

/**
 * Stall forensics: dumps a bot's recent decisions (tick, synced position, keyed
 * direction, bomb flag). The signature to look for is the keyed direction
 * disagreeing with how the position actually moves — that is how both the
 * skill-key bug and the lane-commitment oscillation were found.
 */
function dumpRing(pilots: BotPilots, name: string): void {
  const ring = pilots.rings.get(name);
  console.log(`  RING ${name}: ${JSON.stringify(ring ? ring.slice(-16) : null)}`);
}

/** Watches the round from the host's page, logging deaths and sudden death. */
async function watchRound(host: Page, pages: Page[], pilots: BotPilots): Promise<void> {
  const start = Date.now();
  const dead = new Set<string>();
  let suddenDeath = false;
  let lastDebug = 0;
  let lastPing = 0;
  let lastDigCount = -1;
  let lastDigAt = Date.now();
  let analyzed = false;
  while (!shuttingDown) {
    let view: RoundView | null;
    try {
      view = await roundView(host);
    } catch {
      return; // page closed
    }
    if (view === null) return;
    const secs = Math.round((Date.now() - start) / 1000);
    if (process.env.DEBUG === '1' && Date.now() - lastDebug > 1000) {
      lastDebug = Date.now();
      await debugSample(pages, pilots);
    }
    if (Date.now() - lastPing > 15_000) {
      lastPing = Date.now();
      console.log(`  pings at ${secs}s: ${await pingLine(pages)}`);
    }
    for (const p of view.players) {
      if (!p.alive && !dead.has(p.id)) {
        dead.add(p.id);
        console.log(`  ${p.nickname} died at ${secs}s`);
      }
    }
    // Stall probe: no block destroyed for 25s pre-sudden-death -> dump analysis.
    const digCount = (await roomEval<number>(host, 'hook.room.state.destroyedBlocks.length')) ?? -1;
    if (digCount !== lastDigCount) {
      lastDigCount = digCount;
      lastDigAt = Date.now();
    } else if (!analyzed && view.tick < 2400 && Date.now() - lastDigAt > 25_000) {
      analyzed = true;
      console.log(`  STALL: no digging for 25s at tick ${view.tick} (destroyed=${digCount})`);
      for (const name of NICKNAMES.slice(0, pages.length)) dumpRing(pilots, name);
      // A picture of the stalled board beats any amount of ring archaeology.
      const shot = `/tmp/bomberman-stall-${Date.now()}.png`;
      await pages[0].screenshot({ path: shot }).catch(() => undefined);
      console.log(`  STALL screenshot: ${shot}`);
    }
    if (!suddenDeath && view.tick >= 2400) {
      suddenDeath = true;
      console.log(`  sudden death started (${secs}s)`);
    }
    if (view.phase === 'finished') {
      const winner = view.players.find((p) => p.id === view.winnerId);
      console.log(`round finished in ${secs}s — winner: ${winner ? `${winner.nickname} (${winner.id})` : 'draw'}`);
      for (const p of [...view.players].sort((a, b) => a.placement - b.placement)) {
        console.log(`  #${p.placement || '-'} ${p.nickname}`);
      }
      console.log(`  pings at end: ${await pingLine(pages)}`);
      return;
    }
    if (Date.now() - start > 6 * 60_000) {
      console.log('round watchdog: 6 minutes elapsed, giving up');
      return;
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  await startInfra();

  console.log(`launching ${PLAYERS} Chrome windows...`);
  const pages: Page[] = [];
  for (let i = 0; i < PLAYERS; i++) pages.push(await launchPlayer(i));
  const [host, ...guests] = pages;

  // Host creates the room through the real menu UI.
  await openDialog(host, MENU_CREATE, 1);
  await submitDialog(host, [NICKNAMES[0]]);
  await waitForRoom(host, NICKNAMES[0]);
  await waitFor('room code', async () => /^[A-Z]{4}$/.test((await roomEval<string>(host, 'hook.room.state.code')) ?? ''), 10000);
  const code = (await roomEval<string>(host, 'hook.room.state.code'))!;
  console.log(`room code: ${code}`);

  // Guests join by code.
  for (let i = 0; i < guests.length; i++) {
    await openDialog(guests[i], MENU_JOIN, 2);
    await submitDialog(guests[i], [NICKNAMES[i + 1], code]);
    await waitForRoom(guests[i], NICKNAMES[i + 1]);
    console.log(`${NICKNAMES[i + 1]} joined`);
  }

  await waitFor(
    'all players in the lobby',
    async () => (await roomEval<number>(host, 'hook.room.state.players.size')) === PLAYERS,
    10000,
  );

  // Consecutive matches in the same room, driven exactly like two humans
  // would: host Enter on the results screen (Continue -> lobby), host Enter in
  // the lobby (start). Repeating Enter until the phase flips absorbs scene
  // transitions and the simulated latency.
  for (let game = 1; game <= GAMES; game++) {
    if (game > 1) {
      await sleep(1500); // results overlay mounts its Enter handler on the next patch + frame
      await hostEnterUntilPhase(host, 'lobby', `host to continue after match ${game - 1}`);
      await sleep(800); // every page swaps back to the lobby scene
    }
    await hostEnterUntilPhase(host, 'playing', `match ${game} to start`);
    await Promise.all(
      pages.map((p, i) =>
        waitFor(`${NICKNAMES[i]} to reach the playing phase`, async () => (await roomEval<string>(p, 'hook.room.state.phase')) === 'playing', 10000),
      ),
    );

    // Fresh pilots per match; a per-game seed keeps bot behavior from
    // repeating verbatim.
    const playerIds = await Promise.all(
      pages.map(async (p, i) => {
        const id = await roomEval<string>(p, 'hook.playerId');
        if (id === null) throw new Error(`${NICKNAMES[i]} has no playerId`);
        return id;
      }),
    );
    const pilots = await startBotPilots(code, pages, playerIds, 0xb0b + game * 100);
    console.log(
      `match ${game}/${GAMES} started — LAG=${LAG}ms round-trip, server-truth bots at 50ms tick`,
    );

    await watchRound(host, pages, pilots);
    await pilots.stop();
  }

  if (KEEP && !HEADLESS) {
    console.log('browsers stay open for inspection — Ctrl-C to exit');
  } else {
    await shutdown(0);
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await shutdown(1);
});
