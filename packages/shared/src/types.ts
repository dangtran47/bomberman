export enum TileType {
  Floor,
  HardBlock,
  SoftBlock,
}

export enum PowerupType {
  ExtraBomb,
  BiggerBlast,
  Speed,
  Kick,
  Gun,
  Hammer,
  Mine, // append only: the wire protocol sends these values
  Shield,
  FreezeTime,
}

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface PlayerInput {
  direction: Direction | null;
  placeBomb: boolean;
  fireGun?: boolean; // optional: sources that never use the skills omit these
  swingHammer?: boolean;
  placeMine?: boolean;
  pingMs?: number; // round-trip time reported by the client; absent for bots/offline
}

/** x/y are in tile units; a player standing on tile (c, r) has x=c, y=r, with floats during movement. */
export interface Player {
  id: string;
  x: number;
  y: number;
  alive: boolean;
  speed: number;
  bombCount: number;
  blastRadius: number;
  activeBombs: number;
  kickTicks: number; // 0 = no kick
  gunAmmo: number; // shots left, 0 = no gun
  hammerUses: number; // swings left, 0 = no hammer
  mineAmmo: number; // mines left to place, 0 = no mine
  shieldTicks: number; // remaining immunity ticks, 0 = no shield
  frozenTicks: number; // >0 = frozen solid: no movement, bombs, or skills
  actionCooldown: number; // ticks until the next gun/hammer use is allowed
  triggerHeld: boolean; // placeBomb held last tick, so skills fire on the press only
  skillTriggerHeld: boolean; // this press already served a skill; no bomb until it is released
  facing: Direction; // last requested direction; aims gun and hammer
  momentumDir: Direction | null; // heading carried across ice, null when at rest
  momentumTicks: number; // remaining glide budget on ice
  turnTicks: number; // ticks spent fighting the current heading on ice
  laneDir: Direction | null; // direction that pulled the player off-lane; the corner slide follows it
  turnGrace: number; // tiles of trailing-side latitude when committing a turn this tick; 0 offline
  deathTick: number | null; // null while alive/survivor
}

export interface Bomb {
  id: number;
  col: number;
  row: number;
  ownerId: string;
  fuseTicks: number;
  blastRadius: number;
  slideDC: number; // slideDC===0 && slideDR===0 => stationary
  slideDR: number;
  slideCooldown: number;
  slideInterval: number; // ticks per tile-step for this bomb; 0 until kicked
}

/** Walkable and immobile: mines never block a tile, never slide and never expire. */
export interface Mine {
  id: number;
  col: number;
  row: number;
  ownerId: string;
  ticks: number; // age since placement; drives minePhase
}

export interface ExplosionCell {
  col: number;
  row: number;
  ticksLeft: number;
}

export interface Powerup {
  col: number;
  row: number;
  type: PowerupType;
}
