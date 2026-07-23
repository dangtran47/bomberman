import { ArraySchema, MapSchema, Schema, type } from '@colyseus/schema';
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
}

export class BombSchema extends Schema {
  @type('number') id = 0;
  @type('number') col = 0;
  @type('number') row = 0;
  @type('string') ownerId = '';
  @type('number') fuseTicks = 0;
  @type('number') blastRadius = 1;
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
  /** row * GRID_WIDTH + col indices of soft blocks destroyed so far (append-only). */
  @type(['number']) destroyedBlocks = new ArraySchema<number>();
  /** row * GRID_WIDTH + col indices of tiles converted to HardBlock by sudden death (append-only). */
  @type(['number']) arenaShrunk = new ArraySchema<number>();
  @type({ map: PlayerSchema }) players = new MapSchema<PlayerSchema>();
  @type({ map: BombSchema }) bombs = new MapSchema<BombSchema>();
  @type([ExplosionSchema]) explosions = new ArraySchema<ExplosionSchema>();
  @type([PowerupSchema]) powerups = new ArraySchema<PowerupSchema>();
  /** Winner playerId once phase is 'finished'; '' means draw (or not finished yet). */
  @type('string') winnerId = '';
}

/**
 * Mirrors the authoritative sim state into the synced schema after a tick.
 * Players and bombs are updated in place (delta-friendly); the short-lived
 * explosion/powerup lists are rebuilt (tiny at this scale).
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
      bs.col = bomb.col;
      bs.row = bomb.row;
      bs.ownerId = bomb.ownerId;
      bs.blastRadius = bomb.blastRadius;
      out.bombs.set(key, bs);
    }
    bs.fuseTicks = bomb.fuseTicks;
  }

  out.explosions.clear();
  for (const cell of sim.explosions) {
    const es = new ExplosionSchema();
    es.col = cell.col;
    es.row = cell.row;
    es.ticksLeft = cell.ticksLeft;
    out.explosions.push(es);
  }

  out.powerups.clear();
  for (const powerup of sim.powerups) {
    const ps = new PowerupSchema();
    ps.col = powerup.col;
    ps.row = powerup.row;
    ps.type = powerup.type;
    out.powerups.push(ps);
  }
}
