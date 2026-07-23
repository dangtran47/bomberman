import Phaser from 'phaser';
import { generateTextures } from '../textures';

/** Generates all placeholder textures, then hands off to the menu. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    generateTextures(this);
    this.scene.start('Menu');
  }
}
