export enum TileType {
  Floor,
  HardBlock,
  SoftBlock,
}

export enum PowerupType {
  ExtraBomb,
  BiggerBlast,
  Speed,
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
}

export interface Bomb {
  id: number;
  col: number;
  row: number;
  ownerId: string;
  fuseTicks: number;
  blastRadius: number;
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
