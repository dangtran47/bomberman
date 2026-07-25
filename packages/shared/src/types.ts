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
}

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface PlayerInput {
  direction: Direction | null;
  placeBomb: boolean;
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
