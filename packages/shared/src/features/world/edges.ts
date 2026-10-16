// ──────────────────────────────────────────────
// Edge tiles (Pixelforge edges): water, roads and a town's streets drawn so they blend into the ground
// around them. A dual grid: each piece sits on a corner where four cells meet, and which of the four are
// the terrain (a 4-bit mask) picks one of a block's sixteen pieces, laid out four by four as SpriteCook's
// top-down tilesets are (mask bits: top-left 1, top-right 2, bottom-left 4, bottom-right 8). An image pack
// carries a terrain's blocks as the tile `edge_<terrain>`, each variant a block four cells across and 4, 6 or
// 30 down (WORLD_EDGE_BLOCK_ROWS): the sixteen pieces, then slanted corners (WORLD_EDGE_SLANT_PIECE_BY_MASK),
// then curved runs (worldEdgePiece).
// ──────────────────────────────────────────────

/** The blending terrains, in the order they are drawn: water before roads, a town's streets before its
 *  square (the square drawn over the street where they meet). */
export const WORLD_EDGE_TERRAINS = Object.freeze(["water", "road", "street", "square"] as const);
/** Terrains that blend only on a place's own map (map editor Phase 3: caves, dungeons, stations): the
 *  liquid of a dungeon set (water, lava, acid, coolant ...), drawn from the map's pack. The overworld and the
 *  towns never draw them. */
export const WORLD_MAP_EDGE_TERRAINS = Object.freeze(["dn_liquid"] as const);
export type WorldEdgeTerrain = (typeof WORLD_EDGE_TERRAINS)[number] | (typeof WORLD_MAP_EDGE_TERRAINS)[number];

/** A block's piece for each mask (0-15), counted across then down its four by four cells; -1 for none.
 *  Mask 15 (fully inside) is piece 6, the terrain's own middle. */
export const WORLD_EDGE_PIECE_BY_MASK: readonly number[] = Object.freeze([
  -1, 15, 8, 9, 0, 11, 14, 7, 13, 4, 1, 10, 3, 2, 5, 6,
]);

/** An edge block's rows: the sixteen pieces; with the slanted corners; with the curved runs as well. */
export const WORLD_EDGE_BLOCK_ROWS = Object.freeze([4, 6, 30] as const);

/** A terrain's variant blocks that have all their pieces, 16, 24 or 120 (a block whose sheet did not load is
 *  left out rather than drawn with holes). */
export function worldWholeEdgeBlocks<T>(blocks: ReadonlyArray<ReadonlyArray<T | undefined> | undefined>): T[][] {
  return blocks.filter(
    (block): block is T[] =>
      !!block &&
      WORLD_EDGE_BLOCK_ROWS.some((rows) => rows * 4 === block.length) &&
      Array.from(block).every((piece) => piece !== undefined),
  );
}

/** Slanted corners (user, 2026-10-05: "a soft slant edge" instead of every corner rounded): a corner where
 *  one cell is the terrain (an outer corner) or one is not (an inner corner) may be cut by a 45 degree line
 *  instead, crossing the piece's borders where the rounded piece does, so either fits beside any piece. A
 *  block four by six carries them on its last two rows: the outer corners, then the inner ones, each in the
 *  order of the odd cell (top-left, top-right, bottom-left, bottom-right). -1 for masks with none. */
export const WORLD_EDGE_SLANT_PIECE_BY_MASK: readonly number[] = Object.freeze([
  -1, 16, 17, -1, 18, -1, -1, 23, 19, -1, -1, 22, -1, 21, 20, -1,
]);

/**
 * Whether the corner at (x, y), of the mask `mask`, takes its slanted piece: an outer or inner corner on a
 * step that carries on diagonally (a staircase of cells), so the run reads as one slanted edge instead of a
 * zigzag. The corner of a plain rectangle keeps its rounded piece. Cells outside the map count as the
 * nearest edge cell, as in worldEdgeMask.
 */
export function worldEdgeSlanted(
  filled: (x: number, y: number) => boolean,
  x: number,
  y: number,
  width: number,
  height: number,
  mask: number,
): boolean {
  const single = [1, 2, 4, 8].indexOf(mask);
  const gap = [14, 13, 11, 7].indexOf(mask);
  if (single < 0 && gap < 0) return false;
  const at = (cx: number, cy: number) =>
    filled(Math.min(width - 1, Math.max(0, cx)), Math.min(height - 1, Math.max(0, cy)));
  const q = single >= 0 ? single : gap;
  // The odd cell, and the direction from it toward the corner's other three.
  const [ox, oy] = [x - 1 + (q & 1), y - 1 + (q >> 1)];
  const [dx, dy] = [q & 1 ? -1 : 1, q >> 1 ? -1 : 1];
  // An outer corner's step carries on where a cell past it, diagonally, is the terrain too; an inner
  // corner's where a cell past it is not.
  return single >= 0 ? at(ox - dx, oy + dy) || at(ox + dx, oy - dy) : !at(ox + dx, oy - dy) || !at(ox - dx, oy + dy);
}

/** The order of a curved piece's two crossing offsets, each -1, 0 or +1 (a quarter cell up or left, at the
 *  middle, a quarter cell down or right), both 0 left out (that is the plain or slanted piece). */
export const WORLD_EDGE_CURVE_OFFSETS: ReadonlyArray<readonly [number, number]> = Object.freeze(
  [-1, 0, 1].flatMap((a) => [-1, 0, 1].map((b) => [a, b] as const)).filter(([a, b]) => a || b),
);
/** Curved runs (user, 2026-10-05, for "things like ovals"): rows 7-14 of a 30-row block are the straight
 *  pieces (masks 12, 3, 10, 5: the terrain below, above, right, left) whose crossings sit off the middle,
 *  eight each in WORLD_EDGE_CURVE_OFFSETS' order (the first crossing: the left one, or the top one); rows
 *  15-30 the corners (masks 1, 2, 4, 8, 14, 13, 11, 7), each a slant through its two crossings (the first:
 *  on its top or bottom border; the second: on its side), eight each. */
const CURVE_STRAIGHTS = [12, 3, 10, 5];
const CURVE_CORNERS = [1, 2, 4, 8, 14, 13, 11, 7];

/**
 * The piece of a block `rows` long (4, 6 or 30) for the corner at (x, y), or -1 for none. With slanted
 * corners, a corner on a step that carries on diagonally takes its slant (worldEdgeSlanted). With curved
 * runs, every crossing where the terrain meets the ground moves up to a quarter cell toward the average of
 * its neighbours' (so a staircase of cells reads as one smooth run, an oval as an oval), and a piece whose
 * crossings moved takes its curved piece. Each crossing is worked out from the cells around its own border,
 * so the two pieces sharing a border always agree on it.
 */
export function worldEdgePiece(
  filled: (x: number, y: number) => boolean,
  x: number,
  y: number,
  width: number,
  height: number,
  rows: number,
): number {
  const mask = worldEdgeMask(filled, x, y, width, height);
  const plain = WORLD_EDGE_PIECE_BY_MASK[mask] ?? -1;
  if (plain < 0 || rows < 6) return plain;
  const slanted = worldEdgeSlanted(filled, x, y, width, height, mask);
  if (rows >= 30) {
    const at = (cx: number, cy: number) =>
      filled(Math.min(width - 1, Math.max(0, cx)), Math.min(height - 1, Math.max(0, cy)));
    // The kind of boundary in column k at row r (between cells (k, r-1) and (k, r)): the terrain below (1),
    // above (-1), or none; and in row j at column c (between cells (c-1, j) and (c, j)): right or left.
    const across = (k: number, r: number) => (at(k, r) && !at(k, r - 1) ? 1 : !at(k, r) && at(k, r - 1) ? -1 : 0);
    const down = (j: number, c: number) => (at(c, j) && !at(c - 1, j) ? 1 : !at(c, j) && at(c - 1, j) ? -1 : 0);
    // A crossing's offset: toward the average of the same boundary in the next line each side (within two
    // cells), a quarter cell at most; none where either side has no such boundary (a wall, a corner).
    const offset = (kindAt: (line: number, at: number) => number, line: number, where: number) => {
      const kind = kindAt(line, where);
      if (!kind) return 0;
      const nearest = (next: number) => {
        for (const d of [0, -1, 1, -2, 2]) if (kindAt(next, where + d) === kind) return where + d;
        return null;
      };
      const [a, b] = [nearest(line - 1), nearest(line + 1)];
      if (a === null || b === null) return 0;
      return Math.max(-1, Math.min(1, a + b - 2 * where));
    };
    const [left, right] = [offset(across, x - 1, y), offset(across, x, y)];
    const [top, bottom] = [offset(down, y - 1, x), offset(down, y, x)];
    const curve = (base: number, index: number, a: number, b: number) =>
      base + index * 8 + WORLD_EDGE_CURVE_OFFSETS.findIndex(([oa, ob]) => oa === a && ob === b);
    const straight = CURVE_STRAIGHTS.indexOf(mask);
    if (straight >= 0) {
      const [a, b] = straight < 2 ? [left, right] : [top, bottom];
      if (a || b) return curve(24, straight, a, b);
    }
    const corner = CURVE_CORNERS.indexOf(mask);
    if (corner >= 0) {
      const q = corner & 3;
      const [a, b] = [q >> 1 ? bottom : top, q & 1 ? right : left];
      if (a || b) return curve(56, corner, a, b);
    }
  }
  return slanted ? WORLD_EDGE_SLANT_PIECE_BY_MASK[mask]! : plain;
}

/**
 * The mask of the corner at (x, y), where the cells (x-1, y-1), (x, y-1), (x-1, y) and (x, y) meet, from
 * whether each is the terrain. Outside the map a cell counts as the nearest cell on its edge, so the
 * terrain runs on past the map's border instead of stopping at a shore drawn along it.
 */
export function worldEdgeMask(
  filled: (x: number, y: number) => boolean,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const at = (cx: number, cy: number) =>
    filled(Math.min(width - 1, Math.max(0, cx)), Math.min(height - 1, Math.max(0, cy)));
  return (at(x - 1, y - 1) ? 1 : 0) | (at(x, y - 1) ? 2 : 0) | (at(x - 1, y) ? 4 : 0) | (at(x, y) ? 8 : 0);
}

/**
 * The cells a way between two settlements passes through on the overworld, walked four-connected (each
 * step one cell across or down, never a corner-to-corner step, so a road never pinches to a diagonal),
 * from the middle of one cell to the middle of the other. `skip` leaves cells out (water, a settlement's
 * own cell). Walked the same way whichever end it starts from (ties between the two axes would otherwise
 * lay a way and its way back side by side), and listed from `from`.
 */
export function worldRoadCells(
  start: { x: number; y: number },
  end: { x: number; y: number },
  skip: (x: number, y: number) => boolean,
): Array<{ x: number; y: number }> {
  const flip = start.y > end.y || (start.y === end.y && start.x > end.x);
  const [from, to] = flip ? [end, start] : [start, end];
  const out: Array<{ x: number; y: number }> = [];
  let [x, y] = [from.x, from.y];
  const [dx, dy] = [Math.abs(to.x - from.x), Math.abs(to.y - from.y)];
  const [sx, sy] = [Math.sign(to.x - from.x), Math.sign(to.y - from.y)];
  // A supercover walk: step along whichever axis the line reaches the next cell border on first.
  let [ix, iy] = [0, 0];
  const push = () => {
    if (!skip(x, y)) out.push({ x, y });
  };
  push();
  while (ix < dx || iy < dy) {
    if ((0.5 + ix) * dy < (0.5 + iy) * dx || iy >= dy) {
      x += sx;
      ix++;
    } else {
      y += sy;
      iy++;
    }
    push();
  }
  return flip ? out.reverse() : out;
}
