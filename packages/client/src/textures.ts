import Phaser from 'phaser';
import { PowerupType } from '@bomberman/shared';

/** Pixel size of one grid tile. */
export const TILE_SIZE = 48;

/** Atlas page texture keys; each page is loaded from `assets/<key>.png`. */
export const ATLAS_PAGES = [
  'gameplay',
  'gameplay2',
  'gameplay3',
  'gameplay4',
  'gameplay5',
] as const;

/** URL of the libGDX atlas descriptor (served from public/assets). */
export const ATLAS_URL = 'assets/gameplay.atlas';

/** A texture reference: atlas page key + named frame registered on it. */
export interface TexRef {
  key: string;
  frame: string;
}

const G1 = 'gameplay';
const G2 = 'gameplay2';
const G3 = 'gameplay3';

/**
 * Central registry of sprite references into the Bomb-It atlas. All scenes
 * render via `TEX.*` so an art swap only touches this file.
 */
export const TEX = {
  floor: { key: G1, frame: 'floor' },
  hardBlock: { key: G1, frame: 'cone_red' },
  softBlock: { key: G1, frame: 'middle' },
  players: [
    { key: G3, frame: 'player_pink' },
    { key: G3, frame: 'player_blue' },
    { key: G3, frame: 'player_orange' },
    { key: G3, frame: 'player_black' },
  ],
  bomb: { key: G1, frame: 'bomb' },
  explosion: { key: G1, frame: 'pom_yellow' },
  /** Bomb-origin explosion cell gets the pink pom for a distinct core. */
  explosionCenter: { key: G1, frame: 'pom_pink' },
  powerup: {
    [PowerupType.ExtraBomb]: { key: G1, frame: 'bonus_bomb' },
    [PowerupType.BiggerBlast]: { key: G1, frame: 'bonus_hand' },
    [PowerupType.Speed]: { key: G1, frame: 'whistle' },
  } as Record<PowerupType, TexRef>,
  background: { key: G2, frame: 'background' },
  title: { key: G1, frame: 'title' },
  youWin: { key: G2, frame: 'you_win' },
  youLose: { key: G1, frame: 'you_lose' },
} as const;

/**
 * Target on-screen sizes (px) for atlas sprites. Sprites scale uniformly
 * (aspect preserved) unless the consumer stretches to a full tile.
 */
export const SPRITE_SIZE = {
  /** Cones (hard blocks) scale by height, centered on the tile. */
  hardBlockHeight: 44,
  /** Players scale by height, anchored bottom-center at the tile bottom. */
  playerHeight: 44,
  bombHeight: 40,
  powerupHeight: 36,
  /** Menu title logo, scaled by width. */
  titleWidth: 540,
  /** Win/lose banner on the game-over overlay, scaled by width. */
  bannerWidth: 420,
} as const;

/** Alpha of the dark overlay laid over menu/lobby backgrounds for contrast. */
const MENU_OVERLAY_ALPHA = 0.3;

/** Adds a TexRef image; scenes use this instead of spelling key+frame. */
export function addImage(
  scene: Phaser.Scene,
  x: number,
  y: number,
  ref: TexRef,
): Phaser.GameObjects.Image {
  return scene.add.image(x, y, ref.key, ref.frame);
}

/**
 * Full-screen backdrop for menu-style scenes: the desert background scaled
 * to cover the canvas, plus a dark overlay so text stays readable.
 */
export function addMenuBackdrop(scene: Phaser.Scene): void {
  const { width, height } = scene.scale;
  const bg = addImage(scene, width / 2, height / 2, TEX.background);
  bg.setScale(Math.max(width / bg.width, height / bg.height));
  scene.add.rectangle(0, 0, width, height, 0x000000, MENU_OVERLAY_ALPHA).setOrigin(0, 0);
}
