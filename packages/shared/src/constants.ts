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
export const POWERUP_TYPE_COUNT = 6;

export const CHARACTER_COUNT = 6;

export const KICK_DURATION_TICKS = 300; // 15s at 20tps
export const KICK_WARNING_TICKS = 60; // last 3s
export const KICK_SLIDE_SPEED_MULT = 3; // a kicked bomb travels at ~3x the kicker's tiles/sec

/** Ticks between tile-steps for a bomb kicked by a player moving `speed` tiles/sec. */
export function kickSlideInterval(speed: number): number {
  return Math.max(1, Math.round(TICK_RATE / (speed * KICK_SLIDE_SPEED_MULT)));
}

/** Ice drift: how long a released heading keeps gliding, and how it decays. */
export const ICE_GLIDE_TICKS = 12;
export const ICE_GLIDE_SPEED_MULT = 1;
/** Ticks of the old heading before a turn takes effect on ice. */
export const ICE_TURN_DELAY_TICKS = 3;

export const GUN_AMMO_PER_PICKUP = 2;
export const HAMMER_USES_PER_PICKUP = 3;
export const SKILL_ACTION_COOLDOWN_TICKS = 6; // shared gun/hammer cooldown

// Bot combat nerf: when a weapon is off cooldown and an enemy is lined up, the
// bot only attacks this fraction of ticks (rolls its rng, else holds fire for a
// tick). Digging soft blocks is unaffected. Lower = weaker bot, more dodge room.
export const BOT_HAMMER_ATTACK_CHANCE = 0.3; // melee, priority weapon -> harder nerf
export const BOT_GUN_ATTACK_CHANCE = 0.5;

export const SUDDEN_DEATH_START_TICKS = 2400; // 2min at 20tps
export const SUDDEN_DEATH_INTERVAL_TICKS = 10; // one tile per 0.5s
/** Border rings converted before the shrink stops (leaves rows 4-8 x cols 4-10 open). */
export const SUDDEN_DEATH_RINGS = 4;
