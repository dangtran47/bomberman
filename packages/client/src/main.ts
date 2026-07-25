import Phaser from 'phaser';
import { GRID_HEIGHT, GRID_WIDTH } from '@bomberman/shared';
import { audio } from './audio';
import { TILE_SIZE } from './textures';
import { BootScene } from './scenes/BootScene';
import { MenuScene } from './scenes/MenuScene';
import { LobbyScene } from './scenes/LobbyScene';
import { GameScene, GRID_FRAME_WIDTH, GRID_TOP_MARGIN, HUD_HEIGHT } from './scenes/GameScene';

// Resume the (autoplay-suspended) AudioContext on the first user gesture.
audio.installUnlock();

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  // Left/right/bottom gain a frame band; the top band fits in GRID_TOP_MARGIN.
  width: GRID_WIDTH * TILE_SIZE + 2 * GRID_FRAME_WIDTH, // 720 + 36 = 756
  height: GRID_HEIGHT * TILE_SIZE + HUD_HEIGHT + GRID_TOP_MARGIN + GRID_FRAME_WIDTH, // 624 + 40 + 24 + 18 = 706
  backgroundColor: '#222222',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, MenuScene, LobbyScene, GameScene],
});
