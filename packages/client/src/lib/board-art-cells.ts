// How one cell of a fight's board is drawn from its packs (fight-board art slots, Capability API 1.333):
// which tile, overlay and piece of a prop each part takes, and the CSS that shows one rect of a sheet
// filling an element. Pure, so the regressions can read it without a server.
import {
  BOARD_EDGE_TERRAINS,
  BOARD_FOG_OVERLAY,
  BOARD_LIGHT_OVERLAY,
  boardBrokenArt,
  boardPackCell,
  boardPackEdgeQuarters,
  boardPackSprite,
  boardPropArtFor,
  type BoardPack,
  type BoardPackSlice,
  type TacticalTerrain,
} from "@marinara-engine/shared";
import type { CSSProperties } from "react";

export interface BoardArt {
  /** The pack the board's ground, overlays and lasting areas are drawn from. */
  board: BoardPack | null;
  /** Where props are looked up after the board's own pack. */
  props: BoardPack | null;
}

/** The background that shows `slice` of its sheet filling the element it is put on, whatever its size. */
export function boardSliceStyle(slice: BoardPackSlice): CSSProperties {
  const { sheet, x, y, w, h } = slice;
  const across = sheet.width === w ? 0 : (x / (sheet.width - w)) * 100;
  const down = sheet.height === h ? 0 : (y / (sheet.height - h)) * 100;
  return {
    backgroundImage: `url(${sheet.png})`,
    backgroundSize: `${(sheet.width / w) * 100}% ${(sheet.height / h) * 100}%`,
    backgroundPosition: `${across}% ${down}%`,
    backgroundRepeat: "no-repeat",
    imageRendering: "pixelated",
  };
}

/** What a cell of a board draws from its packs; a part left out is drawn as before. */
export interface BoardCellArt {
  /** Its ground: its terrain's tile, or the plains under a terrain that blends in with an edge block. */
  ground?: BoardPackSlice;
  /** The edge blocks' quarters over it: top-left, top-right, bottom-left, bottom-right. */
  edges: Array<{ quarter: 0 | 1 | 2 | 3; slice: BoardPackSlice }>;
  rim?: BoardPackSlice;
  light?: BoardPackSlice;
  fog?: BoardPackSlice;
  growth?: BoardPackSlice;
  ice?: BoardPackSlice;
  /** One per lasting area over it, first cast first: its own look, else the pack's `bo_zone`. */
  zones: BoardPackSlice[];
  reach?: BoardPackSlice;
  aim?: BoardPackSlice;
  /** This cell's piece of its prop's sprite, standing or broken. */
  prop?: BoardPackSlice;
}

interface ArtCell {
  x: number;
  y: number;
  terrain: TacticalTerrain;
  height: number;
  light?: "sunlight" | "dim" | "dark";
  fog?: "light" | "heavy";
  growth?: true;
  season?: string;
  zones?: string[];
  zoneArt?: string[];
  reach?: unknown;
  aim?: unknown;
  laid?: true;
  prop?: { label: string; health: number; art?: string; dx: number; dy: number };
}

/** A cell's art, worked out from the board's packs; `terrainAt` reads any cell's terrain. */
export function boardCellArt(
  art: BoardArt,
  cell: ArtCell,
  terrainAt: (x: number, y: number) => TacticalTerrain,
  width: number,
  height: number,
): BoardCellArt {
  const { board } = art;
  const at = (id: string) => boardPackCell(board, id, cell.x, cell.y) ?? undefined;
  const out: BoardCellArt = { edges: [], zones: [] };
  if (!board && !art.props) return out;
  const blends =
    (BOARD_EDGE_TERRAINS as readonly string[]).includes(cell.terrain) && !!board?.tiles[`bt_edge_${cell.terrain}`];
  out.ground = at(blends ? "bt_plains" : `bt_${cell.terrain}`);
  for (const terrain of BOARD_EDGE_TERRAINS) {
    const quarters = boardPackEdgeQuarters(
      board,
      `bt_edge_${terrain}`,
      (x, y) => terrainAt(x, y) === terrain,
      cell.x,
      cell.y,
      width,
      height,
    );
    quarters?.forEach((slice, quarter) => {
      if (slice) out.edges.push({ quarter: quarter as 0 | 1 | 2 | 3, slice });
    });
  }
  if (cell.height > 0) out.rim = at(`bt_height${Math.min(cell.height, 3)}`);
  if (cell.light) out.light = at(BOARD_LIGHT_OVERLAY[cell.light]);
  if (cell.fog) out.fog = at(BOARD_FOG_OVERLAY[cell.fog]);
  if (cell.growth) out.growth = at("bo_growth");
  if (cell.season === "winter") out.ice = at("bo_ice");
  for (const [n] of (cell.zones ?? []).entries()) {
    const own = cell.zoneArt?.[n];
    const slice = (own ? at(own) : undefined) ?? at("bo_zone");
    if (slice) out.zones.push(slice);
  }
  if (cell.reach) out.reach = at("bo_reach");
  if (cell.aim || cell.laid) out.aim = at("bo_aim");
  if (cell.prop) {
    const name = cell.prop.art ?? boardPropArtFor(cell.prop.label);
    const packs = [board, art.props];
    // Broken, its broken look; with none, it is drawn as its rubble is today.
    const sprite = name ? boardPackSprite(packs, cell.prop.health > 0 ? name : boardBrokenArt(name)) : null;
    if (sprite && cell.prop.dx < sprite.cellsW && cell.prop.dy < sprite.cellsH) {
      const size = sprite.w / sprite.cellsW;
      out.prop = {
        sheet: sprite.sheet,
        x: sprite.x + cell.prop.dx * size,
        y: sprite.y + cell.prop.dy * size,
        w: size,
        h: size,
      };
    }
  }
  return out;
}
