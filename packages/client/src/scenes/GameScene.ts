import Phaser from 'phaser';
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  TICK_MS,
  TileType,
  createBot,
  createGame,
  createRng,
} from '@bomberman/shared';
import type { Bot, Direction, Game, GameEvent, GameState, PlayerInput } from '@bomberman/shared';
import { TEX, TILE_SIZE } from '../textures';

export interface GameSceneData {
  mode: 'offline';
  seed: number;
}

export const HUD_HEIGHT = 40;

const HUMAN_ID = 'p0';
const PLAYER_IDS = ['p0', 'p1', 'p2', 'p3'];
/** Max sim steps per frame; if further behind, the backlog is dropped. */
const MAX_STEPS_PER_FRAME = 5;

const DEPTH = {
  floor: 0,
  block: 1,
  powerup: 2,
  bomb: 3,
  explosion: 4,
  player: 5,
  hud: 10,
  overlay: 20,
} as const;

/** Key codes mapped to a direction (arrows + WASD). */
const DIRECTION_KEYS: [key: string, dir: Direction][] = [
  ['UP', 'up'],
  ['W', 'up'],
  ['DOWN', 'down'],
  ['S', 'down'],
  ['LEFT', 'left'],
  ['A', 'left'],
  ['RIGHT', 'right'],
  ['D', 'right'],
];

const cellKey = (col: number, row: number): string => `${col},${row}`;
const toX = (col: number): number => col * TILE_SIZE + TILE_SIZE / 2;
const toY = (row: number): number => HUD_HEIGHT + row * TILE_SIZE + TILE_SIZE / 2;

/**
 * Offline match: human (p0) vs 3 bots. The sim runs on a fixed-tick
 * accumulator; rendering reconciles sprites against GameState snapshots each
 * tick, so the same render path can later be fed server state instead.
 */
export class GameScene extends Phaser.Scene {
  private sim!: Game; // named to avoid Phaser.Scene#game
  private bots!: Bot[];

  private accumulator = 0;
  private gameOver = false;

  private directionKeys: [Phaser.Input.Keyboard.Key, Direction][] = [];
  private spaceKey!: Phaser.Input.Keyboard.Key;
  /** Set on Space press (edge-triggered), consumed by the next sim tick. */
  private pendingBomb = false;

  private playerSprites = new Map<string, Phaser.GameObjects.Image>();
  private softBlockSprites = new Map<string, Phaser.GameObjects.Image>();
  private bombSprites = new Map<number, Phaser.GameObjects.Image>();
  private explosionSprites = new Map<string, Phaser.GameObjects.Image>();
  private powerupSprites = new Map<string, { sprite: Phaser.GameObjects.Image; texture: string }>();

  private hudText!: Phaser.GameObjects.Text;

  constructor() {
    super('Game');
  }

  create(data: GameSceneData): void {
    this.accumulator = 0;
    this.gameOver = false;
    this.pendingBomb = false;
    this.playerSprites.clear();
    this.softBlockSprites.clear();
    this.bombSprites.clear();
    this.explosionSprites.clear();
    this.powerupSprites.clear();

    this.sim = createGame({ seed: data.seed, playerIds: PLAYER_IDS });
    this.bots = PLAYER_IDS.slice(1).map((id, i) => createBot(id, createRng(data.seed + i + 1)));

    this.setupInput();
    this.drawStaticGrid(this.sim.state);
    this.createPlayerSprites(this.sim.state);
    this.createHud();
    this.reconcile(this.sim.state);
    this.updateHud(this.sim.state);
  }

  update(_time: number, delta: number): void {
    if (this.gameOver) return;

    if (Phaser.Input.Keyboard.JustDown(this.spaceKey)) this.pendingBomb = true;

    this.accumulator += delta;
    let steps = 0;
    while (this.accumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= TICK_MS;
      this.stepSim();
      steps++;
    }
    // Fell too far behind (tab hidden, etc.): drop the backlog instead of spiraling.
    if (this.accumulator >= TICK_MS) this.accumulator = 0;

    this.positionPlayers(this.sim.state);
  }

  // --- simulation ---

  private stepSim(): void {
    const state = this.sim.state;
    const inputs: Record<string, PlayerInput> = {
      [HUMAN_ID]: { direction: this.currentDirection(), placeBomb: this.pendingBomb },
    };
    this.pendingBomb = false;
    for (const [i, bot] of this.bots.entries()) {
      inputs[PLAYER_IDS[i + 1]] = bot.computeInput(state);
    }

    const events = this.sim.tick(inputs);
    this.reconcile(state);
    this.updateHud(state);
    for (const event of events) this.handleEvent(event);
  }

  private handleEvent(event: GameEvent): void {
    if (event.type === 'gameEnded') this.showGameOver(event.winnerId);
  }

  // --- input ---

  private setupInput(): void {
    const keyboard = this.input.keyboard!;
    this.directionKeys = DIRECTION_KEYS.map(([key, dir]) => [keyboard.addKey(key), dir]);
    this.spaceKey = keyboard.addKey('SPACE');
  }

  /** Last-pressed-wins: among held direction keys, the most recent one. */
  private currentDirection(): Direction | null {
    let latest: Direction | null = null;
    let latestTime = -1;
    for (const [key, dir] of this.directionKeys) {
      if (key.isDown && key.timeDown > latestTime) {
        latestTime = key.timeDown;
        latest = dir;
      }
    }
    return latest;
  }

  // --- rendering ---

  private drawStaticGrid(state: GameState): void {
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        this.add.image(toX(col), toY(row), TEX.floor).setDepth(DEPTH.floor);
        if (state.grid[row][col] === TileType.HardBlock) {
          this.add.image(toX(col), toY(row), TEX.hardBlock).setDepth(DEPTH.block);
        }
      }
    }
  }

  private createPlayerSprites(state: GameState): void {
    state.players.forEach((player, i) => {
      const sprite = this.add
        .image(toX(player.x), toY(player.y), TEX.players[i % TEX.players.length])
        .setDepth(DEPTH.player);
      this.playerSprites.set(player.id, sprite);
    });
  }

  private positionPlayers(state: GameState): void {
    for (const player of state.players) {
      const sprite = this.playerSprites.get(player.id);
      if (!sprite) continue;
      sprite.setPosition(toX(player.x), toY(player.y));
      sprite.setAlpha(player.alive ? 1 : 0.3); // dead players linger as ghosts
    }
  }

  /**
   * Reconciles dynamic sprites against the state snapshot (15x13 grid — cheap).
   * State-driven rather than event-driven so the same path works for server
   * snapshots in the online mode later.
   */
  private reconcile(state: GameState): void {
    this.reconcileSoftBlocks(state);
    this.reconcileBombs(state);
    this.reconcileExplosions(state);
    this.reconcilePowerups(state);
  }

  private reconcileSoftBlocks(state: GameState): void {
    for (let row = 0; row < GRID_HEIGHT; row++) {
      for (let col = 0; col < GRID_WIDTH; col++) {
        const key = cellKey(col, row);
        const isSoft = state.grid[row][col] === TileType.SoftBlock;
        const sprite = this.softBlockSprites.get(key);
        if (isSoft && !sprite) {
          this.softBlockSprites.set(
            key,
            this.add.image(toX(col), toY(row), TEX.softBlock).setDepth(DEPTH.block),
          );
        } else if (!isSoft && sprite) {
          sprite.destroy();
          this.softBlockSprites.delete(key);
        }
      }
    }
  }

  private reconcileBombs(state: GameState): void {
    const liveIds = new Set(state.bombs.map((b) => b.id));
    for (const [id, sprite] of this.bombSprites) {
      if (!liveIds.has(id)) {
        this.tweens.killTweensOf(sprite);
        sprite.destroy();
        this.bombSprites.delete(id);
      }
    }
    for (const bomb of state.bombs) {
      if (this.bombSprites.has(bomb.id)) continue;
      const sprite = this.add.image(toX(bomb.col), toY(bomb.row), TEX.bomb).setDepth(DEPTH.bomb);
      this.tweens.add({
        targets: sprite,
        scale: { from: 1, to: 1.15 },
        duration: 300,
        yoyo: true,
        repeat: -1,
      });
      this.bombSprites.set(bomb.id, sprite);
    }
  }

  private reconcileExplosions(state: GameState): void {
    const live = new Set(state.explosions.map((c) => cellKey(c.col, c.row)));
    for (const [key, sprite] of this.explosionSprites) {
      if (!live.has(key)) {
        sprite.destroy();
        this.explosionSprites.delete(key);
      }
    }
    for (const cell of state.explosions) {
      const key = cellKey(cell.col, cell.row);
      if (this.explosionSprites.has(key)) continue;
      this.explosionSprites.set(
        key,
        this.add.image(toX(cell.col), toY(cell.row), TEX.explosion).setDepth(DEPTH.explosion),
      );
    }
  }

  private reconcilePowerups(state: GameState): void {
    const live = new Map(state.powerups.map((p) => [cellKey(p.col, p.row), TEX.powerup[p.type]]));
    for (const [key, entry] of this.powerupSprites) {
      if (live.get(key) !== entry.texture) {
        entry.sprite.destroy();
        this.powerupSprites.delete(key);
      }
    }
    for (const [key, texture] of live) {
      if (this.powerupSprites.has(key)) continue;
      const [col, row] = key.split(',').map(Number);
      this.powerupSprites.set(key, {
        sprite: this.add.image(toX(col), toY(row), texture).setDepth(DEPTH.powerup),
        texture,
      });
    }
  }

  // --- HUD ---

  private createHud(): void {
    this.add
      .rectangle(0, 0, this.scale.width, HUD_HEIGHT, 0x111111)
      .setOrigin(0, 0)
      .setDepth(DEPTH.hud);
    this.hudText = this.add
      .text(12, HUD_HEIGHT / 2, '', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: '#ffffff',
      })
      .setOrigin(0, 0.5)
      .setDepth(DEPTH.hud);
  }

  private updateHud(state: GameState): void {
    const me = state.players.find((p) => p.id === HUMAN_ID);
    const aliveCount = state.players.filter((p) => p.alive).length;
    if (!me) return;
    this.hudText.setText(
      `Bombs: ${me.bombCount}   Blast: ${me.blastRadius}   Speed: ${me.speed.toFixed(1)}   Alive: ${aliveCount}`,
    );
  }

  // --- game over ---

  private showGameOver(winnerId: string | null): void {
    this.gameOver = true;
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0.6)
      .setOrigin(0, 0)
      .setDepth(DEPTH.overlay);

    const message = winnerId === HUMAN_ID ? 'You win!' : winnerId === null ? 'Draw' : 'You lose';
    this.add
      .text(cx, cy - 40, message, {
        fontFamily: 'monospace',
        fontSize: '48px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.overlay);

    const back = this.add
      .text(cx, cy + 40, 'Back to menu', {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: '#ffe040',
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.overlay)
      .setInteractive({ useHandCursor: true });
    back.on('pointerover', () => back.setColor('#ffffff'));
    back.on('pointerout', () => back.setColor('#ffe040'));
    back.on('pointerdown', () => this.scene.start('Menu'));
  }
}
