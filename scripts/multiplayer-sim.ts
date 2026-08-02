/**
 * Multiplayer simulation test: spawns the dev server with simulated latency,
 * opens 4 real Chrome windows, and has each one play the game like a human —
 * real UI clicks to create/join the room, real keyboard input during the match.
 *
 * Each browser runs the full client (prediction + reconciliation against the
 * lagged server), so what you watch on screen is browser-local predicted state,
 * not the server echo. Bot decisions reuse the shared bot AI (@bomberman/shared
 * bot.ts), running *inside each page* at the sim tick rate (50ms): the driver
 * imports the shared package through vite's dev server, rebuilds a GameState
 * from the synced room state every tick, and presses/releases keys by
 * dispatching keyboard events — the same input path a human uses. Running
 * in-page (instead of polling from Node) keeps decisions fresh enough for the
 * bots to dodge bombs and survive into sudden death like they do offline.
 *
 * Usage:
 *   make simtest                # LAG=50 (round-trip ms) by default
 *   make simtest LAG=120
 *   HEADLESS=1 KEEP=0 node_modules/.bin/tsx scripts/multiplayer-sim.ts
 *
 * Env:
 *   LAG       simulated round-trip latency in ms (default 50)
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const VITE = path.join(ROOT, 'node_modules', '.bin', 'vite');

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : Number(raw);
}

const LAG = envNumber('LAG', 50);
const PLAYERS = Math.min(4, Math.max(2, envNumber('PLAYERS', 4)));
const HEADLESS = process.env.HEADLESS === '1';
const KEEP = process.env.KEEP !== '0';
const AGGRO = process.env.AGGRO === '1';

const SERVER_PORT = 2567;
const CLIENT_PORT = 5199; // fixed, away from the usual dev 5173
const BASE_URL = `http://localhost:${CLIENT_PORT}`;
/** Vite serves workspace files transformed; the in-page driver imports the shared package from here. */
const SHARED_URL = `/@fs${path.join(ROOT, 'packages/shared/src/index.ts')}`;

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
      env: { ...process.env, SIMULATE_LATENCY_MS: String(LAG), PORT: String(SERVER_PORT) },
      stdio: 'ignore',
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
 * Installs the in-page bot driver: imports the shared bot AI through vite,
 * then every 50ms rebuilds a GameState from the synced room state, asks the
 * bot for an input, and dispatches keyboard events (the client's normal input
 * path — held arrows, tapped Space/E/Q). Exposes window.__botStop().
 */
async function startBotDriver(page: Page, seed: number): Promise<void> {
  await page.evaluate(
    async ({ sharedUrl, seed, aggro }) => {
      // tsx compiles with esbuild keepNames, which wraps inner functions in a
      // __name(...) helper that doesn't exist in the page after serialization.
      (globalThis as never as { __name?: unknown }).__name ??= (f: unknown) => f;
      const w = window as never as {
        __room?: { room: { state: any }; playerId: string };
        __botTimer?: number;
        __botStop?: () => void;
      };
      const hook = w.__room;
      if (!hook) throw new Error('no __room hook — did the page join a room?');
      const shared = await import(sharedUrl);
      const bot = shared.createBot(hook.playerId, shared.createRng(seed));
      const GRID_WIDTH: number = shared.GRID_WIDTH;
      const TileType = shared.TileType;

      // Base grid+ice compiled once per round (same path the sim uses).
      let base: { key: string; grid: number[][]; ice: boolean[][] } | null = null;
      const baseFor = (mapSeed: number, mapId: string) => {
        const key = `${mapSeed}:${mapId}`;
        if (base === null || base.key !== key) {
          const def = shared.getMapDef(mapId || undefined);
          const compiled = def ? shared.compileMap(def, mapSeed) : null;
          const grid = compiled ? compiled.grid : shared.generateMap(mapSeed);
          const ice = compiled ? compiled.ice : grid.map((row: number[]) => row.map(() => false));
          base = { key, grid, ice };
        }
        return base;
      };

      /** Rebuilds a shared GameState from the synced net state so bot.ts can run on it. */
      const toGameState = () => {
        const s = hook.room.state;
        const b = baseFor(s.seed, s.mapId);
        const grid = b.grid.map((row) => row.slice());
        s.destroyedBlocks.forEach((i: number) => {
          grid[Math.floor(i / GRID_WIDTH)][i % GRID_WIDTH] = TileType.Floor;
        });
        s.arenaShrunk.forEach((i: number) => {
          grid[Math.floor(i / GRID_WIDTH)][i % GRID_WIDTH] = TileType.HardBlock;
        });
        // Campaign mode: until sudden death, other players are presented as
        // dead so the bot never targets them — it digs, collects, and dodges
        // instead. Once the arena starts shrinking, everyone turns hostile.
        const passive = !aggro && s.tick < shared.SUDDEN_DEATH_START_TICKS;
        const players: unknown[] = [];
        s.players.forEach((p: any, id: string) =>
          players.push({
            id,
            x: p.x,
            y: p.y,
            alive: passive && id !== hook.playerId ? false : p.alive,
            speed: p.speed,
            bombCount: p.bombCount,
            blastRadius: p.blastRadius,
            activeBombs: p.activeBombs,
            kickTicks: p.kickTicks,
            gunAmmo: p.gunAmmo,
            hammerUses: p.hammerUses,
            // actionCooldown is not synced; 0 just makes the bot try a skill a
            // beat early — the server enforces the real cooldown.
            actionCooldown: 0,
            triggerHeld: false,
            skillTriggerHeld: false,
            facing: p.facing,
            momentumDir: p.momentumDir || null,
            momentumTicks: p.momentumTicks,
            turnTicks: p.turnTicks,
            laneDir: p.laneDir || null,
            turnGrace: 0,
            deathTick: null,
          }),
        );
        const bombs: unknown[] = [];
        s.bombs.forEach((bm: any) =>
          bombs.push({
            id: bm.id,
            col: bm.col,
            row: bm.row,
            ownerId: bm.ownerId,
            fuseTicks: bm.fuseTicks,
            blastRadius: bm.blastRadius,
            slideDC: 0,
            slideDR: 0,
            slideCooldown: 0,
            slideInterval: bm.slideInterval,
          }),
        );
        const explosions: unknown[] = [];
        s.explosions.forEach((e: any) => explosions.push({ col: e.col, row: e.row, ticksLeft: e.ticksLeft }));
        const powerups: unknown[] = [];
        s.powerups.forEach((p: any) => powerups.push({ col: p.col, row: p.row, type: p.type }));
        return {
          tick: s.tick,
          grid,
          ice: b.ice,
          players,
          bombs,
          explosions,
          powerups,
          status: s.phase === 'finished' ? 'finished' : 'running',
          winnerId: s.winnerId || null,
        };
      };

      // Phaser reads event.keyCode off window key events; synthetic events
      // need it patched on (KeyboardEventInit has no working keyCode).
      const KEYS: Record<string, [key: string, keyCode: number, code: string]> = {
        up: ['ArrowUp', 38, 'ArrowUp'],
        down: ['ArrowDown', 40, 'ArrowDown'],
        left: ['ArrowLeft', 37, 'ArrowLeft'],
        right: ['ArrowRight', 39, 'ArrowRight'],
        bomb: [' ', 32, 'Space'],
        gun: ['e', 69, 'KeyE'],
        hammer: ['q', 81, 'KeyQ'],
      };
      const fire = (type: string, [key, keyCode, code]: [string, number, string]) => {
        const event = new KeyboardEvent(type, { key, code, bubbles: true });
        Object.defineProperty(event, 'keyCode', { get: () => keyCode });
        window.dispatchEvent(event);
      };
      const tap = (k: [string, number, string]) => {
        fire('keydown', k);
        setTimeout(() => fire('keyup', k), 60);
      };
      let heldDir: string | null = null;
      const setDir = (dir: string | null) => {
        if (heldDir === dir) return;
        if (heldDir) fire('keyup', KEYS[heldDir]);
        if (dir) fire('keydown', KEYS[dir]);
        heldDir = dir;
      };

      /** Directions of the last few decisions; bombs are only placed after a
       * standstill so the (latency-delayed) bomb lands exactly where the
       * escape plan assumed. Moving drops are how bots kill themselves. */
      const recentDirs: (string | null)[] = [];
      const debug = { ticks: 0, errors: 0, lastError: '', lastInput: '' };
      (w as never as { __botDebug: unknown }).__botDebug = debug;
      w.__botStop = () => {
        clearInterval(w.__botTimer);
        setDir(null);
      };
      w.__botTimer = window.setInterval(() => {
        const s = hook.room.state;
        if (s.phase === 'finished') {
          w.__botStop!();
          return;
        }
        if (s.phase !== 'playing') return;
        const me = s.players.get(hook.playerId);
        if (!me || !me.alive) {
          setDir(null);
          return;
        }
        try {
          debug.ticks++;
          const input = bot.computeInput(toGameState());
          // Careful bombing: the shared brain happily builds multi-bomb fields
          // and dies in them (it does offline too). One bomb at a time, never
          // near another ticking bomb, and only from a standstill (with input
          // latency, a bomb dropped while moving lands a tile away from where
          // the escape plan assumed). Together these keep bots alive deep into
          // the round instead of dying in the first minute.
          if (input.placeBomb) {
            const col = Math.round(me.x);
            const row = Math.round(me.y);
            let crowded = false;
            s.bombs.forEach((b: any) => {
              if (Math.abs(b.col - col) + Math.abs(b.row - row) <= b.blastRadius + me.blastRadius + 1) crowded = true;
            });
            const moving = recentDirs.some((d) => d !== null);
            if (me.activeBombs > 0 || crowded || moving) input.placeBomb = false;
          }
          recentDirs.push(input.direction ?? null);
          if (recentDirs.length > 2) recentDirs.shift();
          debug.lastInput = JSON.stringify(input);
          setDir(input.direction);
          if (input.placeBomb) tap(KEYS.bomb);
          if (input.fireGun) tap(KEYS.gun);
          if (input.swingHammer) tap(KEYS.hammer);
        } catch (error) {
          debug.errors++;
          debug.lastError = error instanceof Error ? error.message : String(error);
        }
      }, 50);
    },
    { sharedUrl: SHARED_URL, seed, aggro: AGGRO },
  );
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

/** DEBUG=1: per-page driver counters + own position, printed every second. */
async function debugSample(pages: Page[]): Promise<void> {
  for (let i = 0; i < pages.length; i++) {
    const info = await pages[i]
      .evaluate(() => {
        const w = window as never as {
          __room?: { room: { state: any }; playerId: string };
          __botDebug?: { ticks: number; errors: number; lastError: string; lastInput: string };
        };
        if (!w.__room || !w.__botDebug) return null;
        const me = w.__room.room.state.players.get(w.__room.playerId);
        return {
          ...w.__botDebug,
          x: me ? Math.round(me.x * 10) / 10 : -1,
          y: me ? Math.round(me.y * 10) / 10 : -1,
          alive: me?.alive ?? false,
        };
      })
      .catch(() => null);
    if (info) {
      console.log(
        `  [${NICKNAMES[i]}] ticks=${info.ticks} errors=${info.errors} pos=(${info.x},${info.y}) alive=${info.alive}` +
          `${info.lastError ? ` lastError=${info.lastError}` : ''} lastInput=${info.lastInput}`,
      );
    }
  }
}

/** Watches the round from the host's page, logging deaths and sudden death. */
async function watchRound(host: Page, pages: Page[]): Promise<void> {
  const start = Date.now();
  const dead = new Set<string>();
  let suddenDeath = false;
  let lastDebug = 0;
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
      await debugSample(pages);
    }
    for (const p of view.players) {
      if (!p.alive && !dead.has(p.id)) {
        dead.add(p.id);
        console.log(`  ${p.nickname} died at ${secs}s`);
      }
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

  // Host starts the match (Enter in the lobby sends 'start' for the host).
  await waitFor(
    'all players in the lobby',
    async () => (await roomEval<number>(host, 'hook.room.state.players.size')) === PLAYERS,
    10000,
  );
  await host.keyboard.press('Enter');
  await Promise.all(
    pages.map((p, i) =>
      waitFor(`${NICKNAMES[i]} to reach the playing phase`, async () => (await roomEval<string>(p, 'hook.room.state.phase')) === 'playing', 10000),
    ),
  );

  await Promise.all(pages.map((p, i) => startBotDriver(p, 0xb0b + i)));
  console.log(`match started — LAG=${LAG}ms round-trip, in-page bots at 50ms tick`);

  await watchRound(host, pages);

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
