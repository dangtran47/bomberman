/** One named region inside a libGDX texture atlas page. Coordinates are
 * pixels from the page's top-left corner. */
export interface AtlasRegion {
  /** Page image filename as written in the atlas (e.g. "gameplay2.png"). */
  page: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Parses the libGDX text atlas format:
 *
 * ```
 * page.png            <- page block starts with the image filename
 * size: 1024, 1024    <- unindented page properties (ignored)
 * regionName          <- unindented bare line = region name
 *   rotate: false     <- indented region properties
 *   xy: 804, 588
 *   size: 110, 148
 * ```
 *
 * Blank lines separate page blocks. Only `xy` and `size` are consumed;
 * `orig`/`offset`/`index` are irrelevant for full-size regions. Rotated
 * regions are rejected because the frame loader does not un-rotate them.
 */
export function parseAtlas(text: string): AtlasRegion[] {
  const regions: AtlasRegion[] = [];
  let page = '';
  let current: AtlasRegion | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line === '') {
      // Blank line ends the page block; the next bare line names a new page.
      page = '';
      current = null;
      continue;
    }

    const indented = line.startsWith(' ') || line.startsWith('\t');
    const trimmed = line.trim();
    const colon = trimmed.indexOf(':');

    if (!indented && colon === -1) {
      if (page === '') {
        page = trimmed;
      } else {
        current = { page, name: trimmed, x: 0, y: 0, w: 0, h: 0 };
        regions.push(current);
      }
      continue;
    }

    if (indented && current !== null && colon !== -1) {
      const key = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      if (key === 'xy') [current.x, current.y] = parsePair(value);
      else if (key === 'size') [current.w, current.h] = parsePair(value);
      else if (key === 'rotate' && value === 'true')
        throw new Error(`Atlas region "${current.name}" is rotated; not supported`);
    }
    // Unindented `key: value` lines are page properties (size/format/...) — ignored.
  }

  return regions;
}

function parsePair(value: string): [number, number] {
  const parts = value.split(',').map((s) => Number.parseInt(s.trim(), 10));
  if (parts.length !== 2 || parts.some(Number.isNaN)) {
    throw new Error(`Malformed atlas pair: "${value}"`);
  }
  return [parts[0], parts[1]];
}
