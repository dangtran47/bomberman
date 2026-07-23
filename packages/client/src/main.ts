import Phaser from 'phaser';
import { GRID_HEIGHT, GRID_WIDTH } from '@bomberman/shared';
import { audio } from './audio';
import { TILE_SIZE } from './textures';
import { BootScene } from './scenes/BootScene';
import { MenuScene } from './scenes/MenuScene';
import { LobbyScene } from './scenes/LobbyScene';
import { GameScene, HUD_HEIGHT } from './scenes/GameScene';

// Resume the (autoplay-suspended) AudioContext on the first user gesture.
audio.installUnlock();

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: GRID_WIDTH * TILE_SIZE, // 720
  height: GRID_HEIGHT * TILE_SIZE + HUD_HEIGHT, // 624 + 40 = 664
  backgroundColor: '#222222',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, MenuScene, LobbyScene, GameScene],
});
