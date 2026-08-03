/**
 * Opens an offline match in a real Chrome window and reports what the game reads
 * from the physical pad: raw browser view, what GamepadInput resolved, and the
 * human player's sim position/bombs.
 */
import { chromium } from 'playwright-core';

const URL = process.env.URL ?? 'http://localhost:5173';

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage({ viewport: { width: 900, height: 850 } });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForTimeout(2500);

  // Click "Play vs Bots" (logical 756x706 canvas, scaled to fit).
  const box = (await page.locator('canvas').boundingBox())!;
  const scale = Math.min(box.width / 756, box.height / 706);
  await page.mouse.click(
    box.x + box.width / 2 + (378 - 756 / 2) * scale,
    box.y + box.height / 2 + (280 - 706 / 2) * scale,
  );
  await page.waitForTimeout(1500);
  console.log('match started - drive with the controller now (40s)');

  let last = '';
  for (let i = 0; i < 80; i++) {
    const snap = await page.evaluate(() => {
      const raw = (Array.from(navigator.getGamepads?.() ?? []).filter(Boolean) as Gamepad[]).map(
        (p) => `${p.index}:${p.buttons.map((b, n) => (b.pressed ? n : -1)).filter((n) => n >= 0).join('+') || '-'}`,
      );
      const scene = (window as never as {
        __scene?: {
          pad: { triggerHeld: boolean; heldDirections: () => [string, number][] };
          sim?: { state: { players: { id: string; x: number; y: number }[]; bombs: { ownerId: string }[] } };
        };
      }).__scene;
      if (!scene) return { raw, game: 'no scene' };
      const me = scene.sim?.state.players[0];
      return {
        raw,
        padDirs: scene.pad.heldDirections().map(([d]) => d),
        padTrigger: scene.pad.triggerHeld,
        pos: me ? `${me.x.toFixed(2)},${me.y.toFixed(2)}` : '?',
        myBombs: me ? scene.sim!.state.bombs.filter((b) => b.ownerId === me.id).length : 0,
      };
    });
    const line = JSON.stringify(snap);
    if (line !== last) {
      console.log(new Date().toISOString().slice(11, 19), line);
      last = line;
    }
    await page.waitForTimeout(500);
  }
  console.log('done - window left open');
}

void main();
