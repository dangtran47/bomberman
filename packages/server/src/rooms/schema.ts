import { ArraySchema, MapSchema, Schema, type } from '@colyseus/schema';
import { minePhase } from '@bomberman/shared';
import type { GameState } from '@bomberman/shared';

export type Phase = 'lobby' | 'playing' | 'finished';

export class PlayerSchema extends Schema {
  @type('string') id = '';
  /** Colyseus sessionId of the owning client ('' for bots); lets each client find itself. */
  @type('string') sessionId = '';
  @type('string') nickname = '';
  @type('number') x = 0;
  @type('number') y = 0;
  @type('boolean') alive = true;
  @type('number') bombCount = 1;
  @type('number') blastRadius = 1;
  @type('number') speed = 3;
  @type('number') activeBombs = 0;
  @type('boolean') isBot = false;
  @type('number') character = 0;
  @type('number') kickTicks = 0;
  @type('number') gunAmmo = 0;
  @type('number') hammerUses = 0;
  @type('number') mineAmmo = 0;
  @type('number') shieldTicks = 0;
  /** >0 = frozen by a freeze-time pickup; clients tint the sprite from it. */
  @type('number') frozenTicks = 0;
  /** Last requested direction; the client aims skill FX with it. */
  @type('string') facing = 'down';
  @type('number') wins = 0;
  @type('number') placement = 0;
  /** Seq of this player's last input applied to a tick; clients reconcile against it. */
  @type('number') lastInputSeq = 0;
  /** Ice-drift heading carried across ticks ('' = none); predictor rebases from it. */
  @type('string') momentumDir = '';
  @type('number') momentumTicks = 0;
  @type('number') turnTicks = 0;
  /** Lane commitment for the corner slide ('' = none). */
  @type('string') laneDir = '';
}

export class BombSchema extends Schema {
  @type('number') id = 0;
  @type('number') col = 0;
  @type('number') row = 0;
  @type('string') ownerId = '';
  @type('number') fuseTicks = 0;
  @type('number') blastRadius = 1;
  @type('number') slideInterval = 0;
}

export class MineSchema extends Schema {
  @type('number') id = 0;
  @type('number') col = 0;
  @type('number') row = 0;
  @type('string') ownerId = '';
  /** 0 inert, 1 armed, 2 buried — derived from the sim's tick count. */
  @type('number') phase = 0;
}

export class ExplosionSchema extends Schema {
  @type('number') col = 0;
  @type('number') row = 0;
  @type('number') ticksLeft = 0;
}

export class PowerupSchema extends Schema {
  @type('number') col = 0;
  @type('number') row = 0;
  @type('number') type = 0;
}

export class RoomState extends Schema {
  @type('string') phase: Phase = 'lobby';
  @type('string') code = '';
  @type('string') hostId = '';
  @type('boolean') fillBots = true;
  @type('number') tick = 0;
  @type('number') seed = 0;
  /** Map id both sides compile the grid from; '' means classic procedural. */
  @type('string') mapId = '';
  /** row * GRID_WIDTH + col indices of soft blocks destroyed so far (append-only). */
  @type(['number']) destroyedBlocks = new ArraySchema<number>();
  /** row * GRID_WIDTH + col indices of tiles converted to HardBlock by sudden death (append-only). */
  @type(['number']) arenaShrunk = new ArraySchema<number>();
  @type({ map: PlayerSchema }) players = new MapSchema<PlayerSchema>();
  @type({ map: BombSchema }) bombs = new MapSchema<BombSchema>();
  @type({ map: MineSchema }) mines = new MapSchema<MineSchema>();
  @type([ExplosionSchema]) explosions = new ArraySchema<ExplosionSchema>();
  @type([PowerupSchema]) powerups = new ArraySchema<PowerupSchema>();
  /** Winner playerId once phase is 'finished'; '' means draw (or not finished yet). */
  @type('string') winnerId = '';
}

/**
 * Mirrors the authoritative sim state into the synced schema after a tick.
 * Players, bombs and mines are updated in place by key; the short-lived
 * explosion/powerup lists are updated in place by index (see the note below).
 */
export function copySimToSchema(sim: GameState, out: RoomState): void {
  out.tick = sim.tick;

  for (const player of sim.players) {
    const ps = out.players.get(player.id);
    if (!ps) continue;
    ps.x = player.x;
    ps.y = player.y;
    ps.alive = player.alive;
    ps.bombCount = player.bombCount;
    ps.blastRadius = player.blastRadius;
    ps.speed = player.speed;
    ps.activeBombs = player.activeBombs;
    ps.kickTicks = player.kickTicks;
    ps.gunAmmo = player.gunAmmo;
    ps.hammerUses = player.hammerUses;
    ps.mineAmmo = player.mineAmmo;
    ps.shieldTicks = player.shieldTicks;
    ps.frozenTicks = player.frozenTicks;
    ps.facing = player.facing;
    ps.momentumDir = player.momentumDir ?? '';
    ps.momentumTicks = player.momentumTicks;
    ps.turnTicks = player.turnTicks;
    ps.laneDir = player.laneDir ?? '';
  }

  const liveBombIds = new Set(sim.bombs.map((b) => String(b.id)));
  for (const key of [...out.bombs.keys()]) {
    if (!liveBombIds.has(key)) out.bombs.delete(key);
  }
  for (const bomb of sim.bombs) {
    const key = String(bomb.id);
    let bs = out.bombs.get(key);
    if (!bs) {
      bs = new BombSchema();
      bs.id = bomb.id;
      bs.ownerId = bomb.ownerId;
      bs.blastRadius = bomb.blastRadius;
      out.bombs.set(key, bs);
    }
    // Sliding bombs move, so col/row are refreshed every tick alongside the fuse.
    bs.col = bomb.col;
    bs.row = bomb.row;
    bs.fuseTicks = bomb.fuseTicks;
    bs.slideInterval = bomb.slideInterval;
  }

  const liveMineIds = new Set(sim.mines.map((m) => String(m.id)));
  for (const key of [...out.mines.keys()]) {
    if (!liveMineIds.has(key)) out.mines.delete(key);
  }
  for (const mine of sim.mines) {
    const key = String(mine.id);
    let ms = out.mines.get(key);
    if (!ms) {
      ms = new MineSchema();
      ms.id = mine.id;
      ms.col = mine.col;
      ms.row = mine.row;
      ms.ownerId = mine.ownerId;
      out.mines.set(key, ms);
    }
    // Mines never move, so phase is the only field that changes — and only
    // twice per lifetime. Guard the write so idle mines cost no delta.
    const phase = minePhase(mine.ticks);
    if (ms.phase !== phase) ms.phase = phase;
  }

  // Explosions/powerups are updated in place by index, reusing schema
  // instances. The old clear()-and-recreate path allocated fresh instances
  // every tick, and each one costs a permanent entry in the encoder's ref
  // table (Root.refCount is never pruned for the life of the room) — ~10k
  // leaked entries per match. Reuse only allocates when the list grows.
  while (out.explosions.length > sim.explosions.length) out.explosions.pop();
  for (const [i, cell] of sim.explosions.entries()) {
    let es = out.explosions[i];
    if (!es) {
      es = new ExplosionSchema();
      out.explosions.push(es);
    }
    es.col = cell.col;
    es.row = cell.row;
    es.ticksLeft = cell.ticksLeft;
  }

  while (out.powerups.length > sim.powerups.length) out.powerups.pop();
  for (const [i, powerup] of sim.powerups.entries()) {
    let ps = out.powerups[i];
    if (!ps) {
      ps = new PowerupSchema();
      out.powerups.push(ps);
    }
    ps.col = powerup.col;
    ps.row = powerup.row;
    ps.type = powerup.type;
  }
}
