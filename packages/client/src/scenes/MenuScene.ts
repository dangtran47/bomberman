import Phaser from 'phaser';
import { createRoom, joinRoom } from '../net';
import type { GameRoomConnection } from '../net';
import type { GameSceneData } from './GameScene';
import type { LobbySceneData } from './LobbyScene';

export interface MenuSceneData {
  error?: string;
}

interface DialogField {
  label: string;
  maxLength: number;
  uppercase?: boolean;
}

/** Title screen: offline play plus online create/join flows. */
export class MenuScene extends Phaser.Scene {
  private statusText!: Phaser.GameObjects.Text;
  private dialog: HTMLDivElement | null = null;
  private busy = false;

  constructor() {
    super('Menu');
  }

  create(data?: MenuSceneData): void {
    this.busy = false;
    const cx = this.scale.width / 2;

    this.add
      .text(cx, 120, 'BOMBERMAN', {
        fontFamily: 'monospace',
        fontSize: '64px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);

    this.addButton(cx, 280, 'Play vs Bots', () => {
      const gameData: GameSceneData = { mode: 'offline', seed: Date.now() >>> 0 };
      this.scene.start('Game', gameData);
    });

    this.addButton(cx, 350, 'Create Room', () => {
      this.openDialog([{ label: 'Nickname', maxLength: 12 }], ([nickname]) => {
        void this.connect(() => createRoom(nickname));
      });
    });

    this.addButton(cx, 420, 'Join Room', () => {
      this.openDialog(
        [
          { label: 'Nickname', maxLength: 12 },
          { label: 'Room code', maxLength: 4, uppercase: true },
        ],
        ([nickname, code]) => {
          void this.connect(() => joinRoom(code, nickname));
        },
      );
    });

    this.statusText = this.add
      .text(cx, 480, data?.error ?? '', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: '#ff6060',
      })
      .setOrigin(0.5);

    this.add
      .text(cx, 560, 'Move: Arrows / WASD    Bomb: Space', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: '#999999',
      })
      .setOrigin(0.5);

    this.events.once('shutdown', () => this.closeDialog());
  }

  private addButton(x: number, y: number, label: string, onClick: () => void): void {
    const text = this.add
      .text(x, y, label, {
        fontFamily: 'monospace',
        fontSize: '32px',
        color: '#ffe040',
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    text.on('pointerover', () => text.setColor('#ffffff'));
    text.on('pointerout', () => text.setColor('#ffe040'));
    text.on('pointerdown', onClick);
  }

  private async connect(open: () => Promise<GameRoomConnection>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.statusText.setColor('#999999').setText('Connecting...');
    try {
      const connection = await open();
      const lobbyData: LobbySceneData = { connection };
      this.scene.start('Lobby', lobbyData);
    } catch (error) {
      this.busy = false;
      const message = error instanceof Error ? error.message : 'Connection failed';
      this.statusText.setColor('#ff6060').setText(message);
    }
  }

  /**
   * Simple HTML form overlay centered over the canvas (Phaser text objects
   * cannot take typed input). Enter submits, Escape cancels.
   */
  private openDialog(fields: DialogField[], onSubmit: (values: string[]) => void): void {
    this.closeDialog();

    const dialog = document.createElement('div');
    dialog.style.cssText =
      'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'background:#222;border:2px solid #ffe040;padding:24px;z-index:10;' +
      'display:flex;flex-direction:column;gap:12px;font-family:monospace;color:#fff;';

    const inputs: HTMLInputElement[] = [];
    for (const field of fields) {
      const label = document.createElement('label');
      label.textContent = field.label;
      label.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:14px;';
      const input = document.createElement('input');
      input.maxLength = field.maxLength;
      input.style.cssText =
        'font-family:monospace;font-size:18px;padding:6px;background:#111;' +
        'color:#fff;border:1px solid #666;outline:none;';
      if (field.uppercase) {
        input.style.textTransform = 'uppercase';
        input.addEventListener('input', () => {
          input.value = input.value.toUpperCase();
        });
      }
      label.appendChild(input);
      dialog.appendChild(label);
      inputs.push(input);
    }

    const submit = (): void => {
      const values = inputs.map((input) => input.value.trim());
      this.closeDialog();
      onSubmit(values);
    };

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:12px;justify-content:center;';
    const okButton = document.createElement('button');
    okButton.textContent = 'OK';
    const cancelButton = document.createElement('button');
    cancelButton.textContent = 'Cancel';
    for (const button of [okButton, cancelButton]) {
      button.style.cssText =
        'font-family:monospace;font-size:16px;padding:6px 18px;cursor:pointer;' +
        'background:#ffe040;border:none;color:#222;';
      row.appendChild(button);
    }
    cancelButton.style.background = '#666';
    cancelButton.style.color = '#fff';
    dialog.appendChild(row);

    okButton.addEventListener('click', submit);
    cancelButton.addEventListener('click', () => this.closeDialog());
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
      if (event.key === 'Escape') this.closeDialog();
      event.stopPropagation(); // keep keystrokes away from Phaser
    });

    document.body.appendChild(dialog);
    inputs[0]?.focus();
    this.dialog = dialog;
  }

  private closeDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
  }
}
