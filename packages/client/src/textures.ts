import Phaser from 'phaser';
import { PowerupType } from '@bomberman/shared';

/** Pixel size of one grid tile. All textures are generated at this size. */
export const TILE_SIZE = 48;

/**
 * Central registry of texture keys. Later art-swap (real sprite pack) only
 * needs to load images under these same keys and delete generateTextures.
 */
export const TEX = {
  floor: 'floor',
  hardBlock: 'hardBlock',
  softBlock: 'softBlock',
  players: ['player0', 'player1', 'player2', 'player3'] as const,
  bomb: 'bomb',
  explosion: 'explosion',
  powerup: {
    [PowerupType.ExtraBomb]: 'powerup-extraBomb',
    [PowerupType.BiggerBlast]: 'powerup-biggerBlast',
    [PowerupType.Speed]: 'powerup-speed',
  } as Record<PowerupType, string>,
} as const;

const T = TILE_SIZE;

/** Generates every placeholder texture into the scene's texture manager. */
export function generateTextures(scene: Phaser.Scene): void {
  const g = scene.add.graphics();

  const fresh = (): Phaser.GameObjects.Graphics => {
    g.clear();
    return g;
  };

  // floor: dark green square with subtle border
  fresh().fillStyle(0x1e5c1e).fillRect(0, 0, T, T).lineStyle(1, 0x174a17).strokeRect(0.5, 0.5, T - 1, T - 1);
  g.generateTexture(TEX.floor, T, T);

  // hardBlock: dark gray with beveled look (lighter top-left edge)
  fresh().fillStyle(0x4a4a4a).fillRect(0, 0, T, T);
  g.fillStyle(0x6e6e6e).fillRect(0, 0, T, 4).fillRect(0, 0, 4, T);
  g.fillStyle(0x2e2e2e).fillRect(0, T - 4, T, 4).fillRect(T - 4, 0, 4, T);
  g.generateTexture(TEX.hardBlock, T, T);

  // softBlock: brown with brick lines
  fresh().fillStyle(0x9a5b2b).fillRect(0, 0, T, T).lineStyle(2, 0x6e3f1c);
  g.strokeRect(1, 1, T - 2, T - 2);
  g.lineBetween(0, T / 3, T, T / 3);
  g.lineBetween(0, (2 * T) / 3, T, (2 * T) / 3);
  g.lineBetween(T / 2, 0, T / 2, T / 3);
  g.lineBetween(T / 4, T / 3, T / 4, (2 * T) / 3);
  g.lineBetween((3 * T) / 4, T / 3, (3 * T) / 4, (2 * T) / 3);
  g.lineBetween(T / 2, (2 * T) / 3, T / 2, T);
  g.generateTexture(TEX.softBlock, T, T);

  // players: filled circles, distinct colors; black one gets a white outline
  const playerColors = [0xffffff, 0xe03030, 0x3060e0, 0x101010];
  const r = T / 2 - 6;
  playerColors.forEach((color, i) => {
    fresh().fillStyle(color).fillCircle(T / 2, T / 2, r);
    if (color === 0x101010) g.lineStyle(2, 0xffffff).strokeCircle(T / 2, T / 2, r);
    // simple face dots
    const eye = color === 0xffffff ? 0x000000 : 0xffffff;
    g.fillStyle(eye).fillCircle(T / 2 - 6, T / 2 - 4, 3).fillCircle(T / 2 + 6, T / 2 - 4, 3);
    g.generateTexture(TEX.players[i], T, T);
  });

  // bomb: black circle with short fuse line
  fresh().fillStyle(0x101010).fillCircle(T / 2, T / 2 + 3, T / 2 - 9);
  g.lineStyle(3, 0xc0a060).lineBetween(T / 2, 12, T / 2 + 8, 6);
  g.fillStyle(0xffa020).fillCircle(T / 2 + 8, 6, 3);
  g.generateTexture(TEX.bomb, T, T);

  // explosion: orange/yellow rounded square
  fresh().fillStyle(0xff8020).fillRoundedRect(2, 2, T - 4, T - 4, 10);
  g.fillStyle(0xffd040).fillRoundedRect(10, 10, T - 20, T - 20, 8);
  g.generateTexture(TEX.explosion, T, T);

  // powerups: icons on purple background
  const powerupBg = (): void => {
    fresh().fillStyle(0x7030a0).fillRoundedRect(2, 2, T - 4, T - 4, 8);
    g.lineStyle(2, 0xd0a0ff).strokeRoundedRect(3, 3, T - 6, T - 6, 8);
  };

  // extraBomb: small bomb icon
  powerupBg();
  g.fillStyle(0x101010).fillCircle(T / 2, T / 2 + 2, 10);
  g.lineStyle(2, 0xc0a060).lineBetween(T / 2, T / 2 - 8, T / 2 + 6, T / 2 - 14);
  g.generateTexture(TEX.powerup[PowerupType.ExtraBomb], T, T);

  // biggerBlast: orange burst (diamond + cross)
  powerupBg();
  g.fillStyle(0xff8020);
  g.fillTriangle(T / 2, 8, T / 2 - 8, T / 2, T / 2 + 8, T / 2);
  g.fillTriangle(T / 2, T - 8, T / 2 - 8, T / 2, T / 2 + 8, T / 2);
  g.fillTriangle(8, T / 2, T / 2, T / 2 - 8, T / 2, T / 2 + 8);
  g.fillTriangle(T - 8, T / 2, T / 2, T / 2 - 8, T / 2, T / 2 + 8);
  g.fillStyle(0xffd040).fillCircle(T / 2, T / 2, 6);
  g.generateTexture(TEX.powerup[PowerupType.BiggerBlast], T, T);

  // speed: yellow chevrons pointing right
  powerupBg();
  g.fillStyle(0xffe040);
  g.fillTriangle(12, 12, 12, T - 12, 24, T / 2);
  g.fillTriangle(24, 12, 24, T - 12, 36, T / 2);
  g.generateTexture(TEX.powerup[PowerupType.Speed], T, T);

  g.destroy();
}
