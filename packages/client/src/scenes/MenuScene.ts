import Phaser from 'phaser';
import type { GameSceneData } from './GameScene';

/** Title screen: offline play plus disabled online placeholders. */
export class MenuScene extends Phaser.Scene {
  constructor() {
    super('Menu');
  }

  create(): void {
    const cx = this.scale.width / 2;

    this.add
      .text(cx, 140, 'BOMBERMAN', {
        fontFamily: 'monospace',
        fontSize: '64px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    const play = this.add
      .text(cx, 300, 'Play vs Bots', {
        fontFamily: 'monospace',
        fontSize: '32px',
        color: '#ffe040',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    play.on('pointerover', () => play.setColor('#ffffff'));
    play.on('pointerout', () => play.setColor('#ffe040'));
    play.on('pointerdown', () => {
      const data: GameSceneData = { mode: 'offline', seed: Date.now() >>> 0 };
      this.scene.start('Game', data);
    });

    // Online placeholders — no logic until the multiplayer task.
    for (const [i, label] of ['Create Room', 'Join Room'].entries()) {
      this.add
        .text(cx, 370 + i * 50, `${label} (online coming soon)`, {
          fontFamily: 'monospace',
          fontSize: '24px',
          color: '#666666',
        })
        .setOrigin(0.5);
    }

    this.add
      .text(cx, 520, 'Move: Arrows / WASD    Bomb: Space', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: '#999999',
      })
      .setOrigin(0.5);
  }
}
