import { BOMB_FUSE_TICKS, GRACE_CAP, PING_CAP_MS, TileType, stepPlayer } from '@bomberman/shared';
import type { Direction, MovementBomb, MovementPlayer, MovementWorld } from '@bomberman/shared';

export interface PredictedPlayer extends MovementPlayer {
  alive: boolean;
  bombCount: number;
  activeBombs: number;
}

export interface PendingInput {
  seq: number;
  direction: Direction | null;
  placeBomb: boolean;
  /** RTT reported with this input; replay must use it so the grace the server
   * will compute for the very same input is reproduced. */
  pingMs: number;
}

export interface PredictedBomb {
  id: number; // negative: -seq of the placing input
  col: number;
  row: number;
  fuseTicks: number;
}

interface Obstacle {
  col: number;
  row: number;
}

/**
 * Predicts the local player only. Applies inputs instantly through the shared
 * movement code, then on each server ack rebases to authoritative state and
 * replays unacked inputs — identical code on both sides means replay normally
 * reproduces the prediction with zero visible correction.
 *
 * Known soft spot: a kicked bomb's slide is server-driven, so replaying past a
 * just-kicked bomb can disagree for a few ticks; the caller blends the error.
 */
export class Predictor {
  player: PredictedPlayer;
  pending: PendingInput[] = [];
  bombs: PredictedBomb[] = [];
  private nextSeq = 0;

  constructor(initial: PredictedPlayer) {
    this.player = { ...initial };
  }

  step(
    direction: Direction | null,
    bombHeld: boolean,
    grid: TileType[][],
    ice: boolean[][],
    serverBombs: Obstacle[],
    pingMs = 0,
  ): PendingInput {
    const input: PendingInput = { seq: ++this.nextSeq, direction, placeBomb: bombHeld, pingMs };
    this.pending.push(input);
    this.apply(input, grid, ice, serverBombs);
    return input;
  }

  reconcile(
    server: PredictedPlayer,
    acked: number,
    grid: TileType[][],
    ice: boolean[][],
    serverBombs: Obstacle[],
  ): { dx: number; dy: number } {
    const prevX = this.player.x;
    const prevY = this.player.y;

    this.player = { ...server };
    this.pending = this.pending.filter((i) => i.seq > acked);
    this.bombs = []; // rebuilt by replaying unacked placements
    for (const input of this.pending) this.apply(input, grid, ice, serverBombs);

    return { dx: prevX - this.player.x, dy: prevY - this.player.y };
  }

  /** Predicted fuses only tick for rendering; the server owns detonation. */
  ageBombs(): void {
    for (const b of this.bombs) b.fuseTicks--;
    this.bombs = this.bombs.filter((b) => b.fuseTicks > 0);
  }

  /**
   * Mirrors GameImpl.tick order: kick timer, turn grace, bomb placement,
   * movement, freeze countdown.
   */
  private apply(
    input: PendingInput,
    grid: TileType[][],
    ice: boolean[][],
    serverBombs: Obstacle[],
  ): void {
    if (!this.player.alive) return;
    if (this.player.kickTicks > 0) this.player.kickTicks--;
    // Same formula as GameImpl.tick: the server grants this exact latitude for
    // this exact input, so replay through the shared movement code converges.
    const oneWaySec = Math.min(input.pingMs, PING_CAP_MS) / 2 / 1000;
    this.player.turnGrace = Math.min(GRACE_CAP, this.player.speed * oneWaySec);
    if (input.placeBomb && this.player.frozenTicks <= 0) {
      this.tryPlaceBomb(input.seq, grid, serverBombs);
    }
    const world: MovementWorld = {
      grid,
      ice,
      bombs: this.obstacles(serverBombs).map(asMovementBomb),
    };
    stepPlayer(world, this.player, input.direction);
    if (this.player.frozenTicks > 0) this.player.frozenTicks--;
  }

  private tryPlaceBomb(seq: number, grid: TileType[][], serverBombs: Obstacle[]): void {
    const col = Math.round(this.player.x);
    const row = Math.round(this.player.y);
    if (this.player.activeBombs >= this.player.bombCount) return;
    if (grid[row]?.[col] !== TileType.Floor) return;
    if (this.obstacles(serverBombs).some((o) => o.col === col && o.row === row)) return;
    this.bombs.push({ id: -seq, col, row, fuseTicks: BOMB_FUSE_TICKS });
    this.player.activeBombs++;
  }

  private obstacles(serverBombs: Obstacle[]): Obstacle[] {
    return [...serverBombs, ...this.bombs];
  }
}

function asMovementBomb(o: Obstacle): MovementBomb {
  return { col: o.col, row: o.row, slideDC: 0, slideDR: 0, slideCooldown: 0, slideInterval: 0 };
}
