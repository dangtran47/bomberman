export const GRID_WIDTH = 15;
export const GRID_HEIGHT = 13;

export const TICK_RATE = 60; // ticks per second
export const TICK_MS = 1000 / TICK_RATE;

/** Ticks for a real-time duration in seconds; keeps timings stable across tick-rate changes. */
export function secs(s: number): number {
  return Math.round(s * TICK_RATE);
}

export const BOMB_FUSE_TICKS = secs(3);
export const EXPLOSION_DURATION_TICKS = secs(0.5);

export const BASE_SPEED = 3; // tiles/sec
export const SPEED_INCREMENT = 0.5;
export const MAX_SPEED = 6;

export const GRACE_CAP = 0.45; // max turn grace (tiles); below 0.5 so it never crosses to the next junction
export const PING_CAP_MS = 400; // clamp reported ping before deriving turn grace

export const BASE_BOMB_COUNT = 1;
export const BASE_BLAST_RADIUS = 1; // tiles beyond bomb tile, cross shape
export const MAX_BOMB_COUNT = 8;
export const MAX_BLAST_RADIUS = 8;

export const SOFT_BLOCK_DENSITY = 0.75; // fraction of eligible floor tiles that become soft blocks
export const POWERUP_DROP_CHANCE = 0.5;
export const POWERUP_TYPE_COUNT = 9;

/**
 * Relative drop weights per PowerupType, in enum order
 * (ExtraBomb, BiggerBlast, Speed, Kick, Gun, Hammer, Mine, Shield, FreezeTime).
 * Bomb count and blast radius are the common drops; the weapons are rare,
 * the shield slightly less so, and freeze-time is rarest (half a weapon's rate).
 */
export const POWERUP_WEIGHTS = [12, 12, 6, 6, 2, 2, 2, 3, 1] as const;
export const POWERUP_WEIGHT_TOTAL = POWERUP_WEIGHTS.reduce((sum, w) => sum + w, 0);

/** Maps a [0, 1) roll to a PowerupType index using POWERUP_WEIGHTS. One roll, so RNG use is unchanged. */
export function powerupTypeForRoll(roll: number): number {
  let remaining = roll * POWERUP_WEIGHT_TOTAL;
  for (let i = 0; i < POWERUP_WEIGHTS.length; i++) {
    remaining -= POWERUP_WEIGHTS[i];
    if (remaining < 0) return i;
  }
  return POWERUP_WEIGHTS.length - 1;
}

export const CHARACTER_COUNT = 6;

export const KICK_DURATION_TICKS = secs(15);
export const KICK_WARNING_TICKS = secs(3); // warning window at the end
export const KICK_SLIDE_SPEED_MULT = 3; // a kicked bomb travels at ~3x the kicker's tiles/sec

/** Ticks between tile-steps for a bomb kicked by a player moving `speed` tiles/sec. */
export function kickSlideInterval(speed: number): number {
  return Math.max(1, Math.round(TICK_RATE / (speed * KICK_SLIDE_SPEED_MULT)));
}

/** Ice tiles are speed lanes: movement budget multiplier while standing on ice. */
export const ICE_SPEED_MULT = 1.5;

export const GUN_AMMO_PER_PICKUP = 2;
export const HAMMER_USES_PER_PICKUP = 3;
export const MINE_AMMO_PER_PICKUP = 2;
export const SKILL_ACTION_COOLDOWN_TICKS = secs(0.3); // shared gun/hammer cooldown

/** Shield immunity window (7s); blocks every attack except sudden death. */
export const SHIELD_DURATION_TICKS = secs(7);
export const SHIELD_WARNING_TICKS = secs(2); // last 2s: the client blinks the tint

/** Mine lifetime, counted from placement: 2s inert, then 3s armed, then buried. */
export const MINE_ARM_TICKS = secs(2);
export const MINE_BURY_TICKS = secs(5);

/** Freeze-time pickup: every other alive player is frozen this long. */
export const FREEZE_DURATION_TICKS = secs(3);

/** A mine's phase from its age: 0 inert (harmless), 1 armed, 2 buried. */
export function minePhase(ticks: number): 0 | 1 | 2 {
  if (ticks < MINE_ARM_TICKS) return 0;
  return ticks < MINE_BURY_TICKS ? 1 : 2;
}

// Bot combat nerf: when a weapon is off cooldown and an enemy is lined up, the
// bot only attacks this fraction of ticks (rolls its rng, else holds fire for a
// tick). Digging soft blocks is unaffected. Lower = weaker bot, more dodge room.
// Chances are per tick, so they scale with TICK_RATE: these keep the same
// real-time attack cadence the 20Hz values (0.3 / 0.5) had.
export const BOT_HAMMER_ATTACK_CHANCE = 0.1; // melee, priority weapon -> harder nerf
export const BOT_GUN_ATTACK_CHANCE = 0.17;

export const SUDDEN_DEATH_START_TICKS = secs(120);
export const SUDDEN_DEATH_INTERVAL_TICKS = secs(0.5); // one tile per 0.5s
/** Border rings converted before the shrink stops (leaves rows 4-8 x cols 4-10 open). */
export const SUDDEN_DEATH_RINGS = 4;
