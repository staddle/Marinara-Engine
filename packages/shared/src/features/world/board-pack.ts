// ──────────────────────────────────────────────
// Board packs (fight-board art slots, Capability API 1.333): the art a fight's board is drawn with, made
// in Pixelforge or imported from a file and kept in the library (`game_board_packs`), as creature packs
// are. A pack is PNG sheets on a grid of cells `tileSize` pixels across (48 for the RPG Maker look), and
// tiles that are rects of whole cells on them, under fixed ids:
//
//   bt_<terrain>          the six terrains, up to eight variants picked per cell, or one pattern larger
//                         than a cell laid over the ground by position
//   bt_edge_water/_wall   a dual-grid block of sixteen pieces, four cells by four (the layout Pixelforge's
//                         edge_ blocks use), blending water and walls into the ground beside them
//   bt_height1..3         a rim drawn over raised ground, by level
//   bo_<overlay>          drawn over a cell for its light, fog, growth, ice, a lasting area, an aim or a
//                         walk's reach, in place of today's tint
//   bp_<name>             a prop's sprite, spanning its cells; bp_<name>_broken once it is broken
//   bz_<name>             a lasting area's look, per cell, in place of bo_zone
//   ic_<name>             an icon (Capability API 1.338), in an `icons` pack: a condition's, an item's,
//                         a spell's or any catalog entry's, in place of today's letter or text
//   pt_<name>[@<mood>]    a portrait (Capability API 1.338), in a `portraits` pack: a pixel bust, with its
//                         expressions as pt_<name>@happy and so on; one without an expression is neutral
//
// A board names its pack with `pack`; with none, the library's pack for its environment, then the built-in
// `board/<environment>`, then today's drawing. Props also read a shared props pack. A tile a pack lacks
// is drawn as today.
// ──────────────────────────────────────────────
import { z } from "zod";
import { TACTICAL_ENVIRONMENTS, TACTICAL_TERRAINS, type TacticalTerrain } from "../tactical-combat/environments.js";
import { sheetPngSize } from "./creature-pack.js";

export const BOARD_PACK_MAX = Object.freeze({ tiles: 600, variants: 8, sheets: 32, span: 8, sheetPx: 8192 });
/** The most a board pack's file may be (its sheets are most of it). */
export const BOARD_PACK_MAX_BYTES = 24_000_000;

/** The terrains' tiles. */
export const BOARD_TERRAIN_TILE_IDS = Object.freeze(TACTICAL_TERRAINS.map((terrain) => `bt_${terrain}` as const));
/** The terrains that blend into the ground beside them, with a dual-grid block each. */
export const BOARD_EDGE_TERRAINS = Object.freeze(["water", "wall"] as const satisfies readonly TacticalTerrain[]);
export const BOARD_EDGE_TILE_IDS = Object.freeze(BOARD_EDGE_TERRAINS.map((terrain) => `bt_edge_${terrain}` as const));
/** Raised ground's rims, a level each (three and up share the last). */
export const BOARD_HEIGHT_TILE_IDS = Object.freeze(["bt_height1", "bt_height2", "bt_height3"] as const);
/** What is drawn over a cell. */
export const BOARD_OVERLAY_TILE_IDS = Object.freeze([
  "bo_dim",
  "bo_dark",
  "bo_sunlight",
  "bo_fog_light",
  "bo_fog_heavy",
  "bo_growth",
  "bo_ice",
  "bo_zone",
  "bo_aim",
  "bo_reach",
] as const);
export type BoardOverlayTileId = (typeof BOARD_OVERLAY_TILE_IDS)[number];
/** A prop's art and a lasting area's: `bp_` or `bz_`, then lowercase letters, digits and _. */
export const BOARD_PROP_ART = /^bp_[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const BOARD_ZONE_ART = /^bz_[a-z0-9]+(?:_[a-z0-9]+)*$/;
/** An icon (1.338): `ic_` then lowercase words joined by _. */
export const ART_ICON = /^ic_[a-z0-9]+(?:_[a-z0-9]+)*$/;
/** A portrait (1.338): `pt_` then lowercase words joined by _, and its expression after @ when it has one. */
export const ART_PORTRAIT = /^pt_[a-z0-9]+(?:_[a-z0-9]+)*(?:@[a-z]+(?:_[a-z]+)*)?$/;
/** The expressions a portrait is drawn with, the first five the core set (W5); any other word is allowed. */
export const ART_PORTRAIT_EXPRESSIONS = Object.freeze([
  "neutral",
  "happy",
  "sad",
  "angry",
  "surprised",
  "afraid",
  "disgusted",
  "smug",
  "shy",
  "thinking",
  "tired",
  "hurt",
  "determined",
  "laughing",
  "crying",
  "flirty",
] as const);
/** The packs icons and portraits are kept in, beside the environments' and the props pack. */
export const ART_PACK_KINDS = Object.freeze(["icons", "portraits"] as const);
export type ArtPackKind = (typeof ART_PACK_KINDS)[number];

const artWords = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * The icon a thing is drawn with when it names none (1.338): a condition `ic_cond_<id>`, an item
 * `ic_item_<id or name>`, any other catalog entry `ic_<catalog>_<entry>` (`ic_spells_fireball`). Null
 * for a name with no letters or digits.
 */
export function artIconFor(
  subject: { condition: string } | { catalog: string; entry: string; item?: boolean } | { item: string },
): string | null {
  const parts =
    "condition" in subject
      ? ["cond", ...artWords(subject.condition)]
      : "catalog" in subject
        ? subject.item
          ? ["item", ...artWords(subject.entry)]
          : [...artWords(subject.catalog), ...artWords(subject.entry)]
        : ["item", ...artWords(subject.item)];
  const id = `ic_${parts.join("_")}`;
  return parts.length > 1 && id.length <= 60 && ART_ICON.test(id) ? id : null;
}

/** The portrait a person is drawn with when they name none (1.338): `pt_` and their name's words, and the
 *  expression after @ ("Brenna Hale", happy: pt_brenna_hale@happy). Null for a name with no letters. */
export function artPortraitFor(name: string, expression?: string): string | null {
  const words = artWords(name);
  if (!words.length) return null;
  const mood = expression ? artWords(expression).join("_") : "";
  const id = `pt_${words.join("_")}${mood && mood !== "neutral" ? `@${mood}` : ""}`;
  return id.length <= 60 && ART_PORTRAIT.test(id) ? id : null;
}

/** A portrait id without its expression: what a missing expression falls back to. */
export const artPortraitNeutral = (id: string) => id.split("@")[0]!;

/** A prop's sprite once it is broken. */
export const boardBrokenArt = (art: string) => `${art}_broken`;

const FIXED = new Set<string>([
  ...BOARD_TERRAIN_TILE_IDS,
  ...BOARD_EDGE_TILE_IDS,
  ...BOARD_HEIGHT_TILE_IDS,
  ...BOARD_OVERLAY_TILE_IDS,
]);
/** Whether a tile id is one a board draws. */
export function isBoardTileId(id: string): boolean {
  return (
    FIXED.has(id) || BOARD_PROP_ART.test(id) || BOARD_ZONE_ART.test(id) || ART_ICON.test(id) || ART_PORTRAIT.test(id)
  );
}

/** The built-in pack drawn for an environment when a board names none and the library has none for it. */
export const boardBuiltInPackId = (environment: string) => `board/${environment}`;
/** The built-in pack every board's props are also looked up in. */
export const BOARD_PROPS_PACK_ID = "board/props";

/** A prop's art from its name when it names none: lowercase, "the" dropped, words joined by _
 *  ("The Year-Wheel" is bp_year_wheel). */
export function boardPropArtFor(label: string): string | null {
  const words = label
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.length ? `bp_${words.join("_")}` : null;
}

const PNG_DATA_URL = "data:image/png;base64,";
const sheetId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "A sheet's id is lowercase letters, digits, _ and -");
const packId = z
  .string()
  .max(80)
  .regex(/^(?:[a-z0-9][a-z0-9_-]{0,15}\/)?[a-z0-9][a-z0-9_-]{0,63}$/, "An id is lowercase letters, digits, _ and -");
const cells = z.number().int().min(1).max(BOARD_PACK_MAX.span);

export const boardPackSchema = z
  .object({
    boardPackVersion: z.literal(1),
    id: packId,
    name: z.string().trim().min(1).max(80),
    version: z.number().int().min(1).max(100_000),
    author: z.string().trim().max(80).optional(),
    /** The environment it is drawn for (forest, dungeon ...), which boards of it are drawn with when they
     *  name no pack; `props` for a pack of props every board reads; `icons` and `portraits` for the
     *  game's icons (1.338) and portraits (1.338). Left out: only boards naming it. */
    environment: z.enum([...TACTICAL_ENVIRONMENTS, "props", ...ART_PACK_KINDS]).optional(),
    /** One cell, in pixels (as an image tile pack's and a creature pack's). */
    tileSize: z
      .number()
      .int()
      .min(16)
      .max(96)
      .refine((size) => size % 16 === 0, "A cell is a multiple of 16 pixels"),
    sheets: z
      .array(
        z
          .object({
            id: sheetId,
            png: z
              .string()
              .startsWith(PNG_DATA_URL, "A sheet is a PNG data URL")
              .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u, "A sheet is a PNG data URL"),
            width: z.number().int().min(1).max(BOARD_PACK_MAX.sheetPx),
            height: z.number().int().min(1).max(BOARD_PACK_MAX.sheetPx),
          })
          .strict(),
      )
      .min(1)
      .max(BOARD_PACK_MAX.sheets),
    /** Each tile's variants: a rect of whole cells on a sheet, its top-left cell and its size in cells. */
    tiles: z.record(
      z.string().max(60),
      z
        .array(
          z
            .object({
              sheet: sheetId,
              x: z.number().int().min(0).max(BOARD_PACK_MAX.sheetPx),
              y: z.number().int().min(0).max(BOARD_PACK_MAX.sheetPx),
              w: cells.optional(),
              h: cells.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(BOARD_PACK_MAX.variants),
    ),
  })
  .strict();
export type BoardPack = z.infer<typeof boardPackSchema>;
export type BoardPackTile = BoardPack["tiles"][string][number];
export type BoardPackRead = { ok: true; pack: BoardPack; notes: string[] } | { ok: false; issues: string[] };

/**
 * A board pack read and checked before it is kept: its shape; one id per sheet; every sheet a PNG of the
 * size it states; every tile inside its sheet; an edge block four cells by four. Tiles a board does not
 * draw are left out and noted.
 */
export function parseBoardPack(input: unknown): BoardPackRead {
  let value = input;
  if (typeof input === "string") {
    if (input.length > BOARD_PACK_MAX_BYTES) return { ok: false, issues: ["The board pack is too large."] };
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, issues: ["The board pack is not JSON."] };
    }
  }
  const parsed = boardPackSchema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "pack"}: ${issue.message}`),
    };
  const pack = parsed.data;
  const issues: string[] = [];
  const notes: string[] = [];
  const sheets = new Map<string, BoardPack["sheets"][number]>();
  for (const sheet of pack.sheets) {
    if (sheets.has(sheet.id)) issues.push(`Two sheets are called "${sheet.id}".`);
    sheets.set(sheet.id, sheet);
    const size = sheetPngSize(sheet.png);
    if (!size) issues.push(`The sheet "${sheet.id}" is not a PNG.`);
    else if (size.width !== sheet.width || size.height !== sheet.height)
      issues.push(
        `The sheet "${sheet.id}" is ${size.width} by ${size.height} pixels, not ${sheet.width} by ${sheet.height}.`,
      );
  }
  const entries = Object.entries(pack.tiles);
  if (entries.length > BOARD_PACK_MAX.tiles) issues.push(`A board pack has at most ${BOARD_PACK_MAX.tiles} tiles.`);
  const tiles: BoardPack["tiles"] = {};
  for (const [id, variants] of entries) {
    if (!isBoardTileId(id)) {
      notes.push(`"${id}" is not a tile a board draws, so it was left out.`);
      continue;
    }
    for (const [n, tile] of variants.entries()) {
      const sheet = sheets.get(tile.sheet);
      const label = `The tile "${id}"${variants.length > 1 ? ` (variant ${n + 1})` : ""}`;
      if (!sheet) {
        issues.push(`${label}: no sheet "${tile.sheet}".`);
        continue;
      }
      const [w, h] = [tile.w ?? 1, tile.h ?? 1];
      if ((tile.x + w) * pack.tileSize > sheet.width || (tile.y + h) * pack.tileSize > sheet.height)
        issues.push(`${label} reaches past the edge of the sheet "${sheet.id}".`);
      if ((BOARD_EDGE_TILE_IDS as readonly string[]).includes(id) && (w !== 4 || h !== 4))
        issues.push(`${label} is ${w} by ${h} cells; an edge block is 4 by 4.`);
    }
    tiles[id] = variants;
  }
  return issues.length ? { ok: false, issues: issues.slice(0, 20) } : { ok: true, pack: { ...pack, tiles }, notes };
}

/** A rect on a sheet, in pixels: what is drawn. */
export interface BoardPackSlice {
  sheet: BoardPack["sheets"][number];
  x: number;
  y: number;
  w: number;
  h: number;
}

function slice(pack: BoardPack, tile: BoardPackTile, dx = 0, dy = 0, cw = 1, ch = 1): BoardPackSlice | null {
  const sheet = pack.sheets.find((one) => one.id === tile.sheet);
  if (!sheet) return null;
  const size = pack.tileSize;
  return { sheet, x: (tile.x + dx) * size, y: (tile.y + dy) * size, w: cw * size, h: ch * size };
}

/** Which variant a cell takes: the same every time for the same cell, and mixed across a board. */
function variantAt(count: number, x: number, y: number): number {
  const hash = Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663);
  return (hash >>> 0) % count;
}

/**
 * A cell's piece of a tile at (x, y): a pattern larger than a cell (its first such variant) laid over the
 * board by position, else one of its one-cell variants picked by position. Null when the pack lacks it.
 */
export function boardPackCell(
  pack: BoardPack | null | undefined,
  id: string,
  x: number,
  y: number,
): BoardPackSlice | null {
  const variants = pack?.tiles[id];
  if (!pack || !variants?.length) return null;
  const pattern = variants.find((tile) => (tile.w ?? 1) > 1 || (tile.h ?? 1) > 1);
  if (pattern) {
    const [w, h] = [pattern.w ?? 1, pattern.h ?? 1];
    return slice(pack, pattern, ((x % w) + w) % w, ((y % h) + h) % h);
  }
  return slice(pack, variants[variantAt(variants.length, x, y)]!);
}

/** A sprite whole (a prop's), from the first pack that has it, with its size in cells. */
export function boardPackSprite(
  packs: ReadonlyArray<BoardPack | null | undefined>,
  id: string,
): (BoardPackSlice & { cellsW: number; cellsH: number }) | null {
  for (const pack of packs) {
    const tile = pack?.tiles[id]?.[0];
    if (!pack || !tile) continue;
    const [w, h] = [tile.w ?? 1, tile.h ?? 1];
    const found = slice(pack, tile, 0, 0, w, h);
    if (found) return { ...found, cellsW: w, cellsH: h };
  }
  return null;
}

/** A dual-grid block's piece for each corner mask (0-15), counted across then down its four by four cells;
 *  -1 for none. Mask bits: top-left 1, top-right 2, bottom-left 4, bottom-right 8 (Pixelforge's edge_
 *  layout, SpriteCook's top-down tilesets). */
export const BOARD_EDGE_PIECE_BY_MASK: readonly number[] = Object.freeze([
  -1, 15, 8, 9, 0, 11, 14, 7, 13, 4, 1, 10, 3, 2, 5, 6,
]);

/**
 * A cell's four quarters of an edge block (top-left, top-right, bottom-left, bottom-right), each the
 * matching quarter of the piece on the corner it touches; null where that corner has none of the terrain.
 * `filled` says which cells are the terrain; cells off the board count as the nearest one on it.
 */
export function boardPackEdgeQuarters(
  pack: BoardPack | null | undefined,
  id: string,
  filled: (x: number, y: number) => boolean,
  x: number,
  y: number,
  width: number,
  height: number,
): Array<BoardPackSlice | null> | null {
  const variants = pack?.tiles[id];
  if (!pack || !variants?.length) return null;
  const block = variants[variantAt(variants.length, x, y)]!;
  const at = (cx: number, cy: number) =>
    filled(Math.min(width - 1, Math.max(0, cx)), Math.min(height - 1, Math.max(0, cy)));
  // The corner at (cx, cy) is where cells (cx-1, cy-1), (cx, cy-1), (cx-1, cy) and (cx, cy) meet.
  const piece = (cx: number, cy: number) =>
    BOARD_EDGE_PIECE_BY_MASK[
      (at(cx - 1, cy - 1) ? 1 : 0) | (at(cx, cy - 1) ? 2 : 0) | (at(cx - 1, cy) ? 4 : 0) | (at(cx, cy) ? 8 : 0)
    ] ?? -1;
  // This cell's quarter of each of its four corners' pieces: the corner's own quarter facing the cell.
  const quarters: Array<[number, number, number, number]> = [
    [x, y, 1, 1],
    [x + 1, y, 0, 1],
    [x, y + 1, 1, 0],
    [x + 1, y + 1, 0, 0],
  ];
  const half = pack.tileSize / 2;
  return quarters.map(([cx, cy, qx, qy]) => {
    const index = piece(cx, cy);
    if (index < 0) return null;
    const cell = slice(pack, block, index % 4, Math.floor(index / 4));
    return cell ? { ...cell, x: cell.x + qx * half, y: cell.y + qy * half, w: half, h: half } : null;
  });
}

/** The overlay drawn for a cell's light or fog, by what the board says of it. */
export const BOARD_LIGHT_OVERLAY: Readonly<Record<"dim" | "dark" | "sunlight", BoardOverlayTileId>> = Object.freeze({
  dim: "bo_dim",
  dark: "bo_dark",
  sunlight: "bo_sunlight",
});
export const BOARD_FOG_OVERLAY: Readonly<Record<"light" | "heavy", BoardOverlayTileId>> = Object.freeze({
  light: "bo_fog_light",
  heavy: "bo_fog_heavy",
});
