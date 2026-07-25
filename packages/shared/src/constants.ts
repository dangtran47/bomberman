export const GRID_WIDTH = 15;
export const GRID_HEIGHT = 13;

export const TICK_RATE = 20; // ticks per second
export const TICK_MS = 50;

export const BOMB_FUSE_TICKS = 60; // 3s
export const EXPLOSION_DURATION_TICKS = 10; // 0.5s

export const BASE_SPEED = 3; // tiles/sec
export const SPEED_INCREMENT = 0.5;
export const MAX_SPEED = 6;

export const BASE_BOMB_COUNT = 1;
export const BASE_BLAST_RADIUS = 1; // tiles beyond bomb tile, cross shape
export const MAX_BOMB_COUNT = 8;
export const MAX_BLAST_RADIUS = 8;

export const SOFT_BLOCK_DENSITY = 0.75; // fraction of eligible floor tiles that become soft blocks
export const POWERUP_DROP_CHANCE = 0.3;
export const POWERUP_TYPE_COUNT = 4;

export const CHARACTER_COUNT = 6;

export const KICK_DURATION_TICKS = 300; // 15s at 20tps
export const KICK_WARNING_TICKS = 60; // last 3s
export const KICK_SLIDE_SPEED_MULT = 3; // a kicked bomb travels at ~3x the kicker's tiles/sec

/** Ticks between tile-steps for a bomb kicked by a player moving `speed` tiles/sec. */
export function kickSlideInterval(speed: number): number {
  return Math.max(1, Math.round(TICK_RATE / (speed * KICK_SLIDE_SPEED_MULT)));
}

export const SUDDEN_DEATH_START_TICKS = 2400; // 2min at 20tps
export const SUDDEN_DEATH_INTERVAL_TICKS = 10; // one tile per 0.5s
/** Border rings converted before the shrink stops (leaves rows 4-8 x cols 4-10 open). */
export const SUDDEN_DEATH_RINGS = 4;
