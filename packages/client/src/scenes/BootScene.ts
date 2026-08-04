import Phaser from 'phaser';
import { parseAtlas } from '../atlasParser';
import { ATLAS_PAGES, ATLAS_URL, FREEZE_PAGE, MINE_FRAMES, MINE_PAGE } from '../textures';

const ATLAS_TEXT_KEY = 'gameplay-atlas';

/**
 * Loads the Bomb-It atlas pages, registers every named region as a frame on
 * its page texture, then hands off to the menu.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    for (const page of ATLAS_PAGES) this.load.image(page, `assets/${page}.png`);
    this.load.image(MINE_PAGE, `assets/${MINE_PAGE}.png`);
    this.load.image(FREEZE_PAGE, `assets/${FREEZE_PAGE}.png`);
    this.load.text(ATLAS_TEXT_KEY, ATLAS_URL);
  }

  create(): void {
    const atlasText: string = this.cache.text.get(ATLAS_TEXT_KEY);
    for (const region of parseAtlas(atlasText)) {
      const pageKey = region.page.replace(/\.png$/, '');
      this.textures.get(pageKey).add(region.name, 0, region.x, region.y, region.w, region.h);
    }
    // The mine sheet ships no descriptor: its three frames are hand-measured.
    for (const [name, x, y, w, h] of MINE_FRAMES) {
      this.textures.get(MINE_PAGE).add(name, 0, x, y, w, h);
    }
    this.scene.start('Menu');
  }
}
