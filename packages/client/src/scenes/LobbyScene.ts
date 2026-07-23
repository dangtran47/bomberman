import Phaser from 'phaser';
import type { GameRoomConnection, NetPlayer } from '../net';
import { addMenuBackdrop } from '../textures';
import type { GameSceneData } from './GameScene';

export interface LobbySceneData {
  connection: GameRoomConnection;
}

const SLOT_IDS = ['p0', 'p1', 'p2', 'p3'];

/** Waiting room: shows the join code, roster, and host controls. */
export class LobbyScene extends Phaser.Scene {
  private connection!: GameRoomConnection;
  private started = false;

  private codeText!: Phaser.GameObjects.Text;
  private playersText!: Phaser.GameObjects.Text;
  private fillBotsText!: Phaser.GameObjects.Text;
  private startText!: Phaser.GameObjects.Text;
  private waitingText!: Phaser.GameObjects.Text;
  private errorText!: Phaser.GameObjects.Text;

  private readonly onStateChange = (): void => this.refresh();
  private readonly onRoomLeave = (): void => {
    this.scene.start('Menu', { error: 'Disconnected from server' });
  };
  private offError: (() => void) | null = null;

  constructor() {
    super('Lobby');
  }

  create(data: LobbySceneData): void {
    this.connection = data.connection;
    this.started = false;
    const cx = this.scale.width / 2;
    const style = { fontFamily: 'monospace', color: '#ffffff' };

    addMenuBackdrop(this);

    this.add.text(cx, 80, 'ROOM CODE', { ...style, fontSize: '24px', color: '#999999' }).setOrigin(0.5);
    this.codeText = this.add
      .text(cx, 130, '----', { ...style, fontSize: '64px', fontStyle: 'bold', color: '#ffe040' })
      .setOrigin(0.5);
    this.add
      .text(cx, 180, 'share this code with your friends', { ...style, fontSize: '18px', color: '#999999' })
      .setOrigin(0.5);

    this.playersText = this.add
      .text(cx, 300, '', { ...style, fontSize: '24px', align: 'center', lineSpacing: 12 })
      .setOrigin(0.5, 0.5);

    this.fillBotsText = this.add
      .text(cx, 430, '', { ...style, fontSize: '24px', color: '#ffe040' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerover', () => this.fillBotsText.setColor('#ffffff'))
      .on('pointerout', () => this.fillBotsText.setColor('#ffe040'))
      .on('pointerdown', () => this.connection.room.send('toggleBots'));

    this.startText = this.add
      .text(cx, 480, 'Start game', { ...style, fontSize: '32px', color: '#ffe040' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerover', () => this.startText.setColor('#ffffff'))
      .on('pointerout', () => this.startText.setColor('#ffe040'))
      .on('pointerdown', () => this.connection.room.send('start'));

    this.waitingText = this.add
      .text(cx, 455, 'waiting for the host to start...', { ...style, fontSize: '20px', color: '#999999' })
      .setOrigin(0.5);

    this.errorText = this.add
      .text(cx, 530, '', { ...style, fontSize: '18px', color: '#ff6060' })
      .setOrigin(0.5);

    const leave = this.add
      .text(cx, 590, 'Leave room', { ...style, fontSize: '20px', color: '#999999' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    leave.on('pointerover', () => leave.setColor('#ffffff'));
    leave.on('pointerout', () => leave.setColor('#999999'));
    leave.on('pointerdown', () => {
      this.detach();
      void this.connection.room.leave();
      this.scene.start('Menu');
    });

    const room = this.connection.room;
    room.onStateChange(this.onStateChange);
    room.onLeave(this.onRoomLeave);
    this.offError = room.onMessage('error', (message: { message?: string }) => {
      this.errorText.setText(message?.message ?? 'Something went wrong');
    });
    this.events.once('shutdown', () => this.detach());

    this.refresh();
  }

  private refresh(): void {
    const state = this.connection.room.state;
    if (state.phase === 'playing' && !this.started) {
      this.started = true;
      const data: GameSceneData = { mode: 'online', connection: this.connection };
      this.scene.start('Game', data);
      return;
    }

    this.codeText.setText(state.code || '----');

    const lines = SLOT_IDS.map((id, i) => {
      const player: NetPlayer | undefined = state.players.get(id);
      if (player) {
        const tags = [
          id === state.hostId ? ' (host)' : '',
          id === this.connection.playerId ? ' (you)' : '',
        ].join('');
        return `${i + 1}. ${player.nickname}${tags}`;
      }
      return state.fillBots ? `${i + 1}. [bot]` : `${i + 1}. -`;
    });
    this.playersText.setText(lines.join('\n'));

    const isHost = state.hostId === this.connection.playerId;
    this.fillBotsText.setVisible(isHost).setText(`Fill with bots: ${state.fillBots ? 'ON' : 'OFF'}`);
    this.startText.setVisible(isHost);
    this.waitingText.setVisible(!isHost);
  }

  /** Removes room listeners; safe to call more than once. */
  private detach(): void {
    const room = this.connection.room;
    room.onStateChange.remove(this.onStateChange);
    room.onLeave.remove(this.onRoomLeave);
    this.offError?.();
    this.offError = null;
  }
}
