import Phaser from 'phaser';
import { PowerupType } from '@bomberman/shared';

/** Pixel size of one grid tile. */
export const TILE_SIZE = 48;

/**
 * Text render resolution. The canvas is upscaled by Phaser.Scale.FIT on
 * hi-DPI/large displays, so rendering text at 2-3x keeps it crisp instead of
 * blurry. Every `add.text` style should set `resolution: TEXT_RES`.
 */
export const TEXT_RES = Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1) + 1));

/** Atlas page texture keys; each page is loaded from `assets/<key>.png`. */
export const ATLAS_PAGES = [
  'gameplay',
  'gameplay2',
  'gameplay3',
  'gameplay4',
  'gameplay5',
  'gameplay6',
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
const G4 = 'gameplay4';
const G5 = 'gameplay5';
const G6 = 'gameplay6';

/** Tint applied to kick-related visuals (cyan). */
export const KICK_TINT = 0x40e0ff;

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
    { key: G3, frame: 'player_purple' },
    { key: G5, frame: 'player_green' },
  ],
  /** Color swatch tiles for the lobby character picker, same order as players. */
  characterTiles: [
    { key: G2, frame: 'tile_pink' },
    { key: G2, frame: 'tile_blue' },
    { key: G2, frame: 'tile_orange' },
    { key: G1, frame: 'tile_black' },
    { key: G2, frame: 'tile_purple' },
    { key: G2, frame: 'tile_green' },
  ],
  bomb: { key: G1, frame: 'bomb' },
  explosion: { key: G1, frame: 'pom_yellow' },
  /** Bomb-origin explosion cell gets the pink pom for a distinct core. */
  explosionCenter: { key: G1, frame: 'pom_pink' },
  powerup: {
    [PowerupType.ExtraBomb]: { key: G1, frame: 'bonus_bomb' },
    [PowerupType.BiggerBlast]: { key: G1, frame: 'bonus_hand' },
    [PowerupType.Speed]: { key: G1, frame: 'whistle' },
    // Rendered tinted cyan (KICK_TINT) to read as the kick skill.
    [PowerupType.Kick]: { key: G1, frame: 'bomb' },
  } as Record<PowerupType, TexRef>,
  /**
   * Winter theme extracted from the Bomb-It ice level. Blocks are 62x80:
   * a 62x62 opaque tile (snow floor baked in) plus an 18px transparent
   * overhang; draw anchored to the tile bottom (origin y = 1) and depth-sort
   * by row so overhangs overlap the cell above, on top of `winter.floor`.
   */
  winter: {
    floor: { key: G6, frame: 'winter_floor' },
    floorAlt: { key: G6, frame: 'winter_floor2' },
    hardBlock: { key: G6, frame: 'winter_wall' },
    softBlocks: [
      { key: G6, frame: 'winter_block_cans' },
      { key: G6, frame: 'winter_block_sled' },
      { key: G6, frame: 'winter_block_window' },
      { key: G6, frame: 'winter_block_ice' },
      { key: G6, frame: 'winter_block_snowball' },
    ],
    /** 3x3-tile centerpiece decoration (186x204, 18px top overhang). */
    lodge: { key: G6, frame: 'winter_lodge' },
  },
  background: { key: G2, frame: 'background' },
  leaderboard: { key: G4, frame: 'background_leaderboard' },
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
