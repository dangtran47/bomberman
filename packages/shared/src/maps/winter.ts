import { TileType } from '../types';
import type { MapDef } from './types';

/**
 * Winter arena: symmetric ice lanes around a central house, hard winter walls
 * on the classic odd/odd anchors near the corners. Edit `rows` freely — the
 * compiler validates dimensions, legend coverage, spawn clearance and props.
 */
export const WINTER_MAP: MapDef = {
  id: 'winter',
  name: 'Winter',
  theme: 'winter',
  rows: [
    '..obc#sws#cbo..',
    '.#.k.b.c.b.k.#.',
    'o.#ci.o#o.ic#.o',
    'bkciiw.s.wiickb',
    'c.#i#.kbk.#i#.c',
    '#b.i.cHHHc.i.b#',
    's.oiwbHHHbwio.s',
    '#b.i.cHHHc.i.b#',
    'c.#i#.kbk.#i#.c',
    'bkciiw.s.wiickb',
    'o.#ci.o#o.ic#.o',
    '.#.k.b.c.b.k.#.',
    '..obc#sws#cbo..',
  ],
  legend: {
    '.': { tile: TileType.Floor },
    ',': { tile: TileType.Floor, visual: 'floorAlt' },
    '#': { tile: TileType.HardBlock },
    i: { tile: TileType.Floor, ice: true },
    H: { tile: TileType.HardBlock, visual: 'house' },
    b: { tile: TileType.SoftBlock, visual: 'bottles' },
    c: { tile: TileType.SoftBlock, visual: 'cans' },
    s: { tile: TileType.SoftBlock, visual: 'sled' },
    w: { tile: TileType.SoftBlock, visual: 'window' },
    o: { tile: TileType.SoftBlock, visual: 'snowball' },
    // Brick, not the plain snow block: the snow block art is a near-copy of
    // the floor tile, which made these walls look like walkable lanes.
    k: { tile: TileType.SoftBlock, visual: 'brick' },
    '?': { tile: TileType.Floor, visual: 'brick', maybeSoft: true },
  },
  // The sim sees nine hard blocks; the client draws one 3x3 house sprite.
  props: [{ visual: 'house', col: 6, row: 5, cols: 3, rows: 3 }],
};
