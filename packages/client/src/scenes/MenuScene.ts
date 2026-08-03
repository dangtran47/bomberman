import Phaser from 'phaser';
import { createRoom, joinRoom } from '../net';
import type { GameRoomConnection } from '../net';
import { mapName, nextMapId } from '../maps';
import { SPRITE_SIZE, TEX, TEXT_RES, addImage, addMenuBackdrop } from '../textures';
import type { GameSceneData } from './GameScene';
import type { LobbySceneData } from './LobbyScene';

export interface MenuSceneData {
  error?: string;
}

/** Generated rounded-rect button background (white, tinted per state). */
const BUTTON_TEX = 'ui-button';
const BUTTON_WIDTH = 280;
const BUTTON_HEIGHT = 54;
const BUTTON_RADIUS = 12;
/** Tints applied to the white button texture (tint can only darken). */
const BUTTON_TINT = 0x26263e;
const BUTTON_TINT_HOVER = 0x4a4a78;

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
  /** Arena for offline play; '' = classic procedural. Online picks it in the lobby. */
  private mapId = '';

  constructor() {
    super('Menu');
  }

  create(data?: MenuSceneData): void {
    this.busy = false;
    const cx = this.scale.width / 2;

    addMenuBackdrop(this);

    const title = addImage(this, cx, 120, TEX.title);
    title.setScale(SPRITE_SIZE.titleWidth / title.width);

    // Arena picker for offline play, cycling through the shared map registry.
    const mapText = this.add
      .text(cx, 228, '', {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: '#ffe040',
        resolution: TEXT_RES,
      })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    const refreshMapText = (): void => {
      mapText.setText(`Map: ${mapName(this.mapId)}  ⇄`);
    };
    refreshMapText();
    mapText.on('pointerover', () => mapText.setColor('#ffffff'));
    mapText.on('pointerout', () => mapText.setColor('#ffe040'));
    mapText.on('pointerdown', () => {
      this.mapId = nextMapId(this.mapId);
      refreshMapText();
    });

    this.addButton(cx, 280, 'Play vs Bots', () => {
      const gameData: GameSceneData = { mode: 'offline', seed: Date.now() >>> 0, mapId: this.mapId };
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
        resolution: TEXT_RES,
      })
      .setOrigin(0.5);

    this.add
      .text(cx, 560, 'Move: Arrows/WASD  Bomb/Gun/Hammer: Space', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: '#999999',
        resolution: TEXT_RES,
      })
      .setOrigin(0.5);

    this.events.once('shutdown', () => this.closeDialog());
  }

  /** Lazily generates the white rounded-rect texture the buttons tint. */
  private ensureButtonTexture(): void {
    if (this.textures.exists(BUTTON_TEX)) return;
    const g = this.add.graphics();
    g.fillStyle(0xffffff).fillRoundedRect(0, 0, BUTTON_WIDTH, BUTTON_HEIGHT, BUTTON_RADIUS);
    g.generateTexture(BUTTON_TEX, BUTTON_WIDTH, BUTTON_HEIGHT);
    g.destroy();
  }

  private addButton(x: number, y: number, label: string, onClick: () => void): void {
    this.ensureButtonTexture();
    const bg = this.add
      .image(x, y, BUTTON_TEX)
      .setTint(BUTTON_TINT)
      .setAlpha(0.92)
      .setInteractive({ useHandCursor: true });
    const text = this.add
      .text(x, y, label, {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: '#ffe040',
        resolution: TEXT_RES,
      })
      .setOrigin(0.5);
    bg.on('pointerover', () => {
      bg.setTint(BUTTON_TINT_HOVER);
      text.setColor('#ffffff');
    });
    bg.on('pointerout', () => {
      bg.setTint(BUTTON_TINT);
      text.setColor('#ffe040');
    });
    bg.on('pointerdown', onClick);
  }

  private async connect(open: () => Promise<GameRoomConnection>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.showLoading('Connecting...');
    try {
      const connection = await open();
      const lobbyData: LobbySceneData = { connection };
      this.scene.start('Lobby', lobbyData);
    } catch (error) {
      this.busy = false;
      this.closeDialog();
      const message = error instanceof Error ? error.message : 'Connection failed';
      this.statusText.setColor('#ff6060').setText(message);
    }
  }

  /** Full-screen modal spinner shown while a room create/join is in flight. */
  private showLoading(label: string): void {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:10;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:16px;background:rgba(0,0,0,0.6);' +
      'font-family:monospace;color:#ffe040;font-size:20px;';

    const spinner = document.createElement('div');
    spinner.style.cssText =
      'width:48px;height:48px;border:5px solid #ffe040;border-top-color:transparent;' +
      'border-radius:50%;animation:menu-spin 0.8s linear infinite;';

    const text = document.createElement('div');
    text.textContent = label;

    overlay.append(spinner, text);
    this.mountOverlay(overlay);
  }

  /**
   * Simple HTML form overlay centered over the canvas (Phaser text objects
   * cannot take typed input). Enter submits, Escape cancels.
   */
  private openDialog(fields: DialogField[], onSubmit: (values: string[]) => void): void {
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

    this.mountOverlay(dialog);
    inputs[0]?.focus();
  }

  /**
   * Attaches an HTML overlay and disables Phaser's input so clicks on the
   * overlay cannot bubble to the window listener and fire the menu buttons
   * sitting underneath the canvas.
   */
  private mountOverlay(overlay: HTMLDivElement): void {
    this.closeDialog();
    this.ensureSpinnerStyle();
    this.input.enabled = false;
    document.body.appendChild(overlay);
    this.dialog = overlay;
  }

  private ensureSpinnerStyle(): void {
    if (document.getElementById('menu-spin-style')) return;
    const style = document.createElement('style');
    style.id = 'menu-spin-style';
    style.textContent = '@keyframes menu-spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
  }

  private closeDialog(): void {
    this.dialog?.remove();
    this.dialog = null;
    this.input.enabled = true;
  }
}
