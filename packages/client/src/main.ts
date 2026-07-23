import Phaser from 'phaser';
import { GRID_HEIGHT, GRID_WIDTH } from '@bomberman/shared';
import { TILE_SIZE } from './textures';
import { BootScene } from './scenes/BootScene';
import { MenuScene } from './scenes/MenuScene';
import { GameScene, HUD_HEIGHT } from './scenes/GameScene';

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
  scene: [BootScene, MenuScene, GameScene],
});
