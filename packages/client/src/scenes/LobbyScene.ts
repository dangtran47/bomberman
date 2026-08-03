import Phaser from 'phaser';
import { CHARACTER_COUNT } from '@bomberman/shared';
import type { GameRoomConnection, NetPlayer } from '../net';
import { mapName, nextMapId } from '../maps';
import { TEX, TEXT_RES, addImage, addMenuBackdrop } from '../textures';
import { buildSkillsTable } from '../skillsTable';
import type { GameSceneData } from './GameScene';

export interface LobbySceneData {
  connection: GameRoomConnection;
}

const SLOT_IDS = ['p0', 'p1', 'p2', 'p3'];
/** Character picker cell size (px) and gap between cells. */
const CELL = 60;
const CELL_GAP = 14;
/** Vertical center of the character-picker strip. */
const PICKER_Y = 212;
/** Roster: y-center of the first row and spacing between rows. */
const ROSTER_FIRST_Y = 278;
const ROSTER_ROW_H = 34;

/** Waiting room: shows the join code, roster, and host controls. */
export class LobbyScene extends Phaser.Scene {
  private connection!: GameRoomConnection;
  private started = false;

  private codeText!: Phaser.GameObjects.Text;
  /** Roster rows (character sprite + name), rebuilt each refresh. */
  private rosterObjects: Phaser.GameObjects.GameObject[] = [];
  private fillBotsText!: Phaser.GameObjects.Text;
  private mapText!: Phaser.GameObjects.Text;
  private startText!: Phaser.GameObjects.Text;
  private waitingText!: Phaser.GameObjects.Text;
  private errorText!: Phaser.GameObjects.Text;
  /** Character-picker decorations, rebuilt each refresh. */
  private pickerObjects: Phaser.GameObjects.GameObject[] = [];
  /** Keyboard-focused picker tile; highlight hidden until arrows are used. */
  private focusIndex = 0;
  private focusVisible = false;

  /** Skills reference popover: objects + visibility flag (built lazily). */
  private skillsPanel: Phaser.GameObjects.GameObject[] = [];
  private skillsShown = false;

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
    this.skillsPanel = [];
    this.skillsShown = false;
    const cx = this.scale.width / 2;
    const style = { fontFamily: 'monospace', color: '#ffffff', resolution: TEXT_RES };

    addMenuBackdrop(this);

    this.add.text(cx, 46, 'ROOM CODE', { ...style, fontSize: '20px', color: '#999999' }).setOrigin(0.5);
    this.codeText = this.add
      .text(cx, 94, '----', { ...style, fontSize: '56px', fontStyle: 'bold', color: '#ffe040' })
      .setOrigin(0.5);
    this.add
      .text(cx, 130, 'share this code with your friends', { ...style, fontSize: '16px', color: '#999999' })
      .setOrigin(0.5);

    this.add
      .text(cx, 170, 'PICK YOUR CHARACTER', { ...style, fontSize: '18px', color: '#999999' })
      .setOrigin(0.5);
    // Character picker strip is rebuilt in refresh() (state-driven).
    // Keyboard navigation for the picker (arrows move, Enter/Space confirms).
    const kb = this.input.keyboard;
    if (kb) {
      kb.on('keydown-LEFT', () => this.moveFocus(-1));
      kb.on('keydown-RIGHT', () => this.moveFocus(1));
      kb.on('keydown-ENTER', () => this.confirmAndStart());
      kb.on('keydown-SPACE', () => this.confirmFocus());
    }

    // Roster rows are rebuilt in refresh() (state-driven).

    // Arena picker: host-only control, but everyone sees the current choice.
    this.mapText = this.add
      .text(cx, 400, '', { ...style, fontSize: '22px', color: '#ffe040' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerover', () => {
        if (this.isHost()) this.mapText.setColor('#ffffff');
      })
      .on('pointerout', () => {
        if (this.isHost()) this.mapText.setColor('#ffe040');
      })
      .on('pointerdown', () => {
        if (!this.isHost()) return;
        const state = this.connection.room.state;
        this.connection.room.send('setMap', { mapId: nextMapId(state.mapId) });
      });

    this.fillBotsText = this.add
      .text(cx, 430, '', { ...style, fontSize: '22px', color: '#ffe040' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerover', () => this.fillBotsText.setColor('#ffffff'))
      .on('pointerout', () => this.fillBotsText.setColor('#ffe040'))
      .on('pointerdown', () => this.connection.room.send('toggleBots'));

    this.startText = this.add
      .text(cx, 476, 'Start game', { ...style, fontSize: '30px', color: '#ffe040' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerover', () => this.startText.setColor('#ffffff'))
      .on('pointerout', () => this.startText.setColor('#ffe040'))
      .on('pointerdown', () => this.connection.room.send('start'));

    this.waitingText = this.add
      .text(cx, 476, 'waiting for the host to start...', { ...style, fontSize: '20px', color: '#999999' })
      .setOrigin(0.5);

    this.errorText = this.add
      .text(cx, 514, '', { ...style, fontSize: '16px', color: '#ff6060' })
      .setOrigin(0.5);

    // Skills reference: click-to-toggle modal popover (bottom-left, out of the center stack).
    const skillsButton = this.add
      .text(16, 634, 'Skills', { ...style, fontSize: '20px', color: '#ffe040' })
      .setOrigin(0, 0.5)
      .setInteractive({ useHandCursor: true });
    skillsButton.on('pointerover', () => skillsButton.setColor('#ffffff'));
    skillsButton.on('pointerout', () => skillsButton.setColor('#ffe040'));
    skillsButton.on('pointerdown', () => this.toggleSkillsPanel());
    this.events.once('shutdown', () => this.destroySkillsPanel());

    const leave = this.add
      .text(this.scale.width - 16, 634, 'Leave room', { ...style, fontSize: '20px', color: '#999999' })
      .setOrigin(1, 0.5)
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

    this.rebuildRoster(state);
    this.rebuildPicker(state);

    const isHost = this.isHost();
    this.mapText
      .setText(`Map: ${mapName(state.mapId)}${isHost ? '  ⇄' : ''}`)
      .setColor(isHost ? '#ffe040' : '#999999');
    this.fillBotsText.setVisible(isHost).setText(`Fill with bots: ${state.fillBots ? 'ON' : 'OFF'}`);
    this.startText.setVisible(isHost);
    this.waitingText.setVisible(!isHost);
  }

  private isHost(): boolean {
    return this.connection.room.state.hostId === this.connection.playerId;
  }

  /** Rebuilds the roster rows: each player's picked character sprite + name. */
  private rebuildRoster(state: GameRoomConnection['room']['state']): void {
    for (const o of this.rosterObjects) o.destroy();
    this.rosterObjects = [];

    // Fixed left-aligned block so rows line up: portrait then text.
    const portraitX = 250;
    const textX = 270;
    const style = { fontFamily: 'monospace', color: '#ffffff', resolution: TEXT_RES };

    SLOT_IDS.forEach((id, i) => {
      const y = ROSTER_FIRST_Y + i * ROSTER_ROW_H;
      const player: NetPlayer | undefined = state.players.get(id);

      if (player) {
        const tags = [
          id === state.hostId ? ' (host)' : '',
          id === this.connection.playerId ? ' (you)' : '',
        ].join('');
        const wins = player.wins > 0 ? ` — ${player.wins} win(s)` : '';
        const label = `P${i + 1}  ${player.nickname}${tags}${wins}`;

        // Small portrait immediately left of the name text.
        if (TEX.players[player.character]) {
          const portrait = addImage(this, portraitX, y, TEX.players[player.character]).setOrigin(0.5, 0.5);
          portrait.setScale(24 / portrait.height);
          this.rosterObjects.push(portrait);
        }
        this.rosterObjects.push(
          this.add.text(textX, y, label, { ...style, fontSize: '18px' }).setOrigin(0, 0.5),
        );
      } else {
        const label = state.fillBots ? `P${i + 1}  [bot]` : `P${i + 1}  -`;
        this.rosterObjects.push(
          this.add.text(textX, y, label, { ...style, fontSize: '18px', color: '#999999' }).setOrigin(0, 0.5),
        );
      }
    });
  }

  /** Moves the keyboard focus along the picker strip, wrapping at the ends. */
  private moveFocus(delta: number): void {
    this.focusVisible = true;
    this.focusIndex = (this.focusIndex + delta + CHARACTER_COUNT) % CHARACTER_COUNT;
    this.rebuildPicker(this.connection.room.state);
  }

  /** Confirms the keyboard-focused character (same message as clicking the tile). */
  private confirmFocus(): void {
    if (!this.focusVisible) return;
    this.connection.room.send('pickCharacter', { character: this.focusIndex });
  }

  /** Enter: confirm the focused character, then start the game (host only). */
  private confirmAndStart(): void {
    this.confirmFocus();
    const state = this.connection.room.state;
    if (state.hostId === this.connection.playerId) {
      this.connection.room.send('start');
    }
  }

  /** Rebuilds the character-picker strip from current state (ownership-aware). */
  private rebuildPicker(state: GameRoomConnection['room']['state']): void {
    for (const o of this.pickerObjects) o.destroy();
    this.pickerObjects = [];

    const total = CHARACTER_COUNT * CELL + (CHARACTER_COUNT - 1) * CELL_GAP;
    const firstX = (this.scale.width - total) / 2 + CELL / 2;
    const cellY = PICKER_Y;
    const myId = this.connection.playerId;

    for (let i = 0; i < CHARACTER_COUNT; i++) {
      const x = firstX + i * (CELL + CELL_GAP);

      // Ownership: first player whose character === i.
      let ownerId: string | null = null;
      let ownerNick = '';
      state.players.forEach((p, id) => {
        if (ownerId === null && p.character === i) {
          ownerId = id;
          ownerNick = p.nickname;
        }
      });
      const mine = ownerId === myId;
      const takenByOther = ownerId !== null && !mine;

      const swatch = addImage(this, x, cellY, TEX.characterTiles[i])
        .setDisplaySize(CELL, CELL)
        .setInteractive({ useHandCursor: true });
      swatch.on('pointerdown', () => this.connection.room.send('pickCharacter', { character: i }));
      // Portrait sized by height and centered inside the swatch (no top overhang).
      const portrait = addImage(this, x, cellY, TEX.players[i]).setOrigin(0.5, 0.5);
      portrait.setScale(44 / portrait.height);
      if (takenByOther) {
        swatch.setAlpha(0.35);
        portrait.setAlpha(0.35);
      }
      this.pickerObjects.push(swatch, portrait);

      if (mine) {
        this.pickerObjects.push(
          this.add
            .rectangle(x, cellY, CELL + 4, CELL + 4)
            .setStrokeStyle(3, 0xffe040)
            .setFillStyle(),
        );
      }
      if (this.focusVisible && i === this.focusIndex) {
        this.pickerObjects.push(
          this.add
            .rectangle(x, cellY, CELL + 10, CELL + 10)
            .setStrokeStyle(2, 0xffffff)
            .setFillStyle(),
        );
      }
      if (takenByOther) {
        this.pickerObjects.push(
          this.add
            .text(x, cellY + CELL / 2 + 4, (ownerNick[0] ?? '?').toUpperCase(), {
              fontFamily: 'monospace',
              fontSize: '13px',
              color: '#cccccc',
              resolution: TEXT_RES,
            })
            .setOrigin(0.5, 0),
        );
      }
    }
  }

  /** Shows/hides the modal skills reference popover (built once, lazily). */
  private toggleSkillsPanel(): void {
    if (this.skillsPanel.length === 0) this.buildSkillsPanel();
    this.skillsShown = !this.skillsShown;
    for (const o of this.skillsPanel) (o as Phaser.GameObjects.Image).setVisible(this.skillsShown);
  }

  /**
   * Builds the modal: a full-screen dim backdrop (click to close) under an
   * opaque panel, so the roster underneath cannot bleed through.
   */
  private buildSkillsPanel(): void {
    const width = 620;
    const height = 318; // header + 7 skill rows
    const cx = this.scale.width / 2;
    const cy = 332;
    const panelLeft = cx - width / 2;
    const panelTop = cy - height / 2;

    const backdrop = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0.6)
      .setOrigin(0, 0)
      .setDepth(90)
      .setInteractive();
    backdrop.on('pointerdown', () => this.toggleSkillsPanel());

    const panel = this.add
      .rectangle(cx, cy, width, height, 0x11121c, 1)
      .setStrokeStyle(2, 0xffe040)
      .setDepth(100);
    const rows = buildSkillsTable(this, panelLeft + 24, panelTop + 24);
    for (const o of rows) (o as Phaser.GameObjects.Image).setDepth(101);
    this.skillsPanel = [backdrop, panel, ...rows];
    for (const o of this.skillsPanel) (o as Phaser.GameObjects.Image).setVisible(false);
  }

  private destroySkillsPanel(): void {
    for (const o of this.skillsPanel) o.destroy();
    this.skillsPanel = [];
    this.skillsShown = false;
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
