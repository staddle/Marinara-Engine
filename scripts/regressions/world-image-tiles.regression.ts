/**
 * Image tile packs (tile pack v2, Pixelforge image tiles).
 *
 *   - A pack is PNG sheets on a grid of cells (a multiple of 16 pixels) and every tile a rect of whole
 *     cells in one of them: one cell, or a sprite of several. A sheet that is not a whole, undamaged PNG
 *     of its stated size, a rect past its sheet's edge, an unknown sheet, two sheets with one id, a cell
 *     size that is no multiple of 16, sheets over 16 megapixels together or over 6 MB are refused; a tile
 *     the Engine does not draw is left out and noted. Drawn (v1) packs read as before.
 *   - The library keeps an image pack like a drawn one (saved, imported, exported, chosen), its sheets
 *     re-encoded by the Engine where it can; the list says which packs are images; an image pack keeps
 *     its newest eight versions.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TILE_PACK_IMAGE_MAX_BYTES,
  WORLD_EDGE_PIECE_BY_MASK,
  characterFacing,
  characterFrameAt,
  parseTilePack,
  pngDataUrlCheck,
  worldEdgeMask,
  worldRoadCells,
  worldWholeEdgeBlocks,
  WORLD_FRINGE_ORDER,
  WORLD_PATTERN_TILE_IDS,
  WORLD_SEASON_DAYS,
  worldSeason,
  WORLD_GROUND_LOOKS,
  WORLD_TILE_IDS,
  WORLD_IMAGE_ONLY_TILE_IDS,
  WORLD_DUNGEON_PROP_COUNT,
  WORLD_DUNGEON_WAY_OUT_PROP,
  WORLD_EDGE_TERRAINS,
  WORLD_MAP_EDGE_TERRAINS,
  worldEdgeSlanted,
  worldEdgePiece,
  WORLD_EDGE_CURVE_OFFSETS,
  WORLD_EDGE_SLANT_PIECE_BY_MASK,
  type ImageTilePack,
  type TilePack,
} from "../../packages/shared/src/index.js";
import { imageTilePack, pngBytes, pngDataUrl } from "./fixtures/image-tile-pack.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-image-tiles-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameTilePacksRoutes } = await import("../../packages/server/src/routes/game-tile-packs.routes.js");
const { IMAGE_PACK_VERSIONS_KEPT } =
  await import("../../packages/server/src/services/storage/game-tile-packs.storage.js");

const refused = (input: unknown, pattern: RegExp, label: string) => {
  const read = parseTilePack(input);
  assert.ok(!read.ok, `${label}: refused`);
  assert.ok(
    read.issues.some((issue) => pattern.test(issue)),
    `${label}: ${JSON.stringify(read.issues)}`,
  );
};

try {
  // ── The format ──
  const good = parseTilePack(imageTilePack());
  assert.ok(good.ok, JSON.stringify(!good.ok && good.issues));
  assert.equal(good.pack.tilePackVersion, 2);
  assert.ok(parseTilePack(JSON.stringify(imageTilePack())).ok, "read from a file's text");
  const sheet = imageTilePack().sheets[0]!;
  assert.deepEqual(pngDataUrlCheck(sheet.png), { width: 192, height: 96 }, "its size from its header");

  // A sheet's PNG checked whole without decoding it.
  const bytes = Buffer.from(sheet.png.slice("data:image/png;base64,".length), "base64");
  const damaged = Buffer.from(bytes);
  damaged[40] = damaged[40]! ^ 0xff;
  assert.match((pngDataUrlCheck(pngDataUrl(damaged)) as { issue: string }).issue, /damaged/);
  assert.match((pngDataUrlCheck(pngDataUrl(bytes.subarray(0, bytes.length - 6))) as { issue: string }).issue, /ends/);
  assert.match(
    (pngDataUrlCheck(pngDataUrl(Buffer.concat([bytes, Buffer.from([0])]))) as { issue: string }).issue,
    /after its end/,
  );
  assert.match((pngDataUrlCheck("data:image/png;base64,R0lGODlhAQABAAAAACw=") as { issue: string }).issue, /not a PNG/);
  // Its header first: a whole PNG with a chunk before its header is refused.
  const padded = pngBytes(192, 96, () => [0, 0, 0, 0], 8);
  const ihdrAt = padded.indexOf(Buffer.from("IHDR")) - 4;
  const textAt = padded.indexOf(Buffer.from("tEXt")) - 4;
  const textEnd = padded.indexOf(Buffer.from("IDAT")) - 4;
  const reordered = Buffer.concat([
    padded.subarray(0, 8),
    padded.subarray(textAt, textEnd),
    padded.subarray(ihdrAt, textAt),
    padded.subarray(textEnd),
  ]);
  assert.match(
    (pngDataUrlCheck(pngDataUrl(reordered)) as { issue?: string } | null)?.issue ?? "",
    /does not begin with its header/,
  );
  const withSheet = (png: string, width = 192, height = 96) =>
    imageTilePack({ sheets: [{ id: "town", png, width, height }] });
  refused(withSheet(pngDataUrl(damaged)), /damaged/, "a damaged sheet");
  refused(withSheet(sheet.png, 192, 144), /is 192 x 96, not 192 x 144/, "a sheet of another size");
  refused(withSheet("data:image/jpeg;base64,AAAA"), /PNG data URL/, "not a PNG");
  refused(
    imageTilePack({ tiles: { house: [{ sheet: "town", x: 3, y: 0, w: 2, h: 2 }] } }),
    /reaches past the edge/,
    "a sprite past its sheet's edge",
  );
  refused(imageTilePack({ tiles: { grass: [{ sheet: "nope", x: 0, y: 0 }] } }), /no sheet "nope"/, "an unknown sheet");
  refused(imageTilePack({ sheets: [sheet, sheet] }), /Two sheets are called "town"/, "two sheets, one id");
  refused(imageTilePack({ tileSize: 40 }), /multiple of 16/, "a cell of 40 pixels");
  refused(imageTilePack({ tileSize: 112 }), /tileSize/, "a cell larger than 96");
  refused(
    imageTilePack({ tiles: { grass: [{ sheet: "town", x: 0, y: 0, w: 9 }] } }),
    /spans 9 by 1 cells; at most 8 each way/,
    "a sprite wider than eight cells",
  );
  // 16 megapixels across all sheets: five of 2048 x 2048 (about 21) is too many.
  const wide = pngDataUrl(pngBytes(2048, 2048, () => [0, 0, 0, 0]));
  refused(
    imageTilePack({
      sheets: Array.from({ length: 5 }, (_, at) => ({ id: `s${at}`, png: wide, width: 2048, height: 2048 })),
      tiles: { grass: [{ sheet: "s0", x: 0, y: 0 }] },
    }),
    /16,777,216 pixels/,
    "sheets over 16 megapixels",
  );
  // Over 6 MB of sheets.
  const noisy = pngBytes(1000, 1000, (x, y) => [(x * 7919 + y * 104729) % 251, (x * y) % 253, (x ^ y) % 255, 255]);
  const heavy = pngDataUrl(noisy);
  assert.ok(
    heavy.length < TILE_PACK_IMAGE_MAX_BYTES && heavy.length * 2 > TILE_PACK_IMAGE_MAX_BYTES,
    `${heavy.length}`,
  );
  refused(
    imageTilePack({
      sheets: Array.from({ length: 2 }, (_, at) => ({ id: `s${at}`, png: heavy, width: 1000, height: 1000 })),
      tiles: { grass: [{ sheet: "s0", x: 0, y: 0 }] },
    }),
    /The sheets are larger than a tile pack can be/,
    "sheets over 6 MB",
  );
  // Sheets just under the cap: the whole file (names and tiles beside them) is still read.
  const near = pngBytes(48, 48, () => [1, 2, 3, 255]);
  const base64For = (bytes: number) => Math.ceil(bytes / 3) * 4;
  const padTo = TILE_PACK_IMAGE_MAX_BYTES - 100 - "data:image/png;base64,".length;
  let pad = Math.floor((padTo * 3) / 4) - near.length - 20;
  while (base64For(pngBytes(48, 48, () => [1, 2, 3, 255], pad).length) + 22 > TILE_PACK_IMAGE_MAX_BYTES) pad -= 3;
  const full = imageTilePack({
    sheets: [{ id: "town", png: pngDataUrl(pngBytes(48, 48, () => [1, 2, 3, 255], pad)), width: 48, height: 48 }],
    tiles: { grass: [{ sheet: "town", x: 0, y: 0 }] },
  });
  const fullText = JSON.stringify(full, null, 2);
  assert.ok(fullText.length > TILE_PACK_IMAGE_MAX_BYTES, `(the file is over the sheets' cap: ${fullText.length})`);
  assert.ok(parseTilePack(fullText).ok, "a file whose sheets are within the cap reads");
  // A drawn pack has no whole-building sprite: left out and noted.
  const drawnHouse = parseTilePack({
    tilePackVersion: 1,
    id: "drawn-house",
    name: "Drawn",
    family: "fantasy",
    version: 1,
    palette: ["#336633"],
    tiles: { house: [Array.from({ length: 16 }, () => "0".repeat(16))] },
  });
  assert.ok(
    drawnHouse.ok && !("house" in drawnHouse.pack.tiles) && drawnHouse.notes.some((note) => /image pack/.test(note)),
  );
  // A tile the Engine does not draw is left out and noted.
  const extra = parseTilePack(
    imageTilePack({ tiles: { ...imageTilePack().tiles, dragon: [{ sheet: "town", x: 0, y: 0 }] } }),
  );
  assert.ok(extra.ok && !("dragon" in extra.pack.tiles) && extra.notes.some((note) => /dragon/.test(note)));
  // A drawn pack still reads, and a drawn pack over 1 MB is still refused.
  const rows = (char: string) => Array.from({ length: 16 }, () => char.repeat(16));
  const drawn: TilePack = {
    tilePackVersion: 1,
    id: "drawn",
    name: "Drawn",
    family: "fantasy",
    version: 1,
    palette: ["#336633"],
    tiles: { grass: [rows("0")] },
  };
  assert.ok(parseTilePack(drawn).ok);
  assert.ok(!parseTilePack(`${JSON.stringify(drawn)}${" ".repeat(1_000_001)}`).ok, "a drawn pack's own limit");

  // ── Characters (Pixelforge characters): walking blocks, RPG Maker's layout ──
  const people = pngBytes(288, 384, (x, y) => [x % 48 < 4 ? 0 : 120, Math.floor(y / 96) * 60, 90, 255]);
  const withPeople = (characters: unknown[]) =>
    imageTilePack({
      sheets: [...imageTilePack().sheets, { id: "people", png: pngDataUrl(people), width: 288, height: 384 }],
      characters,
    } as Partial<ImageTilePack>);
  const walker = { id: "c1", sheet: "people", x: 0, y: 0 };
  const walking = parseTilePack(
    withPeople([
      walker,
      { id: "c2", sheet: "people", x: 3, y: 0, for: ["folk"], recolour: { hair: ["#3c2a1e"], skin: ["#f1c9a5"] } },
      { id: "c3", sheet: "people", x: 3, y: 4, h: 1 },
    ]),
  );
  assert.ok(walking.ok, JSON.stringify(!walking.ok && walking.issues));
  assert.equal(walking.pack.tilePackVersion === 2 && walking.pack.characters?.length, 3);
  refused(withPeople([{ ...walker, x: 4 }]), /reaches past the edge/, "a block past its sheet's right edge");
  refused(withPeople([{ ...walker, y: 1 }]), /reaches past the edge/, "a block of 1 x 2 frames past its bottom");
  refused(withPeople([{ ...walker, sheet: "nope" }]), /no sheet "nope"/, "an unknown sheet");
  refused(withPeople([walker, walker]), /Two characters are called "c1"/, "two characters, one id");
  refused(
    withPeople([{ ...walker, recolour: { hair: ["#112233"], clothes: ["#112233"] } }]),
    /both hair and clothes/,
    "a colour in two regions",
  );
  refused(withPeople([{ ...walker, recolour: { eyes: ["blue"] } }]), /colour/i, "a colour that is no colour");
  refused(withPeople([{ ...walker, h: 4 }]), /h/, "a frame four cells tall");
  refused(
    withPeople(Array.from({ length: 65 }, (_, at) => ({ ...walker, id: `c${at}` }))),
    /characters/,
    "more than 64",
  );
  // More characters than one canvas can hold are refused (64 blocks of 96 px cells, 2 by 3 frames).
  const bigPeople = pngBytes(576, 1152, () => [0, 0, 0, 0]);
  refused(
    imageTilePack({
      tileSize: 96,
      sheets: [{ id: "people", png: pngDataUrl(bigPeople), width: 576, height: 1152 }],
      tiles: { grass: [{ sheet: "people", x: 0, y: 0 }] },
      characters: Array.from({ length: 64 }, (_, at) => ({ id: `c${at}`, sheet: "people", x: 0, y: 0, w: 2, h: 3 })),
    } as Partial<ImageTilePack>),
    /more room than a pack can draw/,
    "characters that would not fit their canvas",
  );
  // How a walk is drawn: step, stand, step, stand; facing the larger axis of the move, the way it went
  // kept near the diagonal and when it does not move.
  assert.deepEqual([0, 180, 360, 540, 720].map(characterFrameAt), [0, 1, 2, 1, 0]);
  assert.equal(characterFacing(5, 1), "right");
  assert.equal(characterFacing(-5, 1), "left");
  assert.equal(characterFacing(1, -5), "up");
  assert.equal(characterFacing(0, 5), "down");
  assert.equal(characterFacing(5, 5, "left"), "right", "on the diagonal, a sideways walk stays sideways");
  assert.equal(characterFacing(5, 5, "up"), "down", "on the diagonal, an up-and-down walk stays so");
  assert.equal(characterFacing(0, 0, "left"), "left", "standing still keeps the facing");

  // ── Edge tiles: a terrain's blocks of sixteen pieces, four cells by four ──
  const blocks = pngBytes(192, 288, () => [10, 60, 250, 255]);
  const tall = pngBytes(192, 1440, () => [10, 60, 250, 255]);
  const withEdges = (tiles: Record<string, unknown[]>) =>
    imageTilePack({
      sheets: [
        ...imageTilePack().sheets,
        { id: "edges", png: pngDataUrl(blocks), width: 192, height: 288 },
        { id: "tall", png: pngDataUrl(tall), width: 192, height: 1440 },
      ],
      tiles: { ...imageTilePack().tiles, ...tiles },
    } as Partial<ImageTilePack>);
  assert.ok(parseTilePack(withEdges({ edge_water: [{ sheet: "edges", x: 0, y: 0, w: 4, h: 4 }] })).ok, "a 4 x 4 block");
  assert.ok(
    parseTilePack(withEdges({ edge_water: [{ sheet: "edges", x: 0, y: 0, w: 4, h: 6 }] })).ok,
    "a 4 x 6 block, with its slanted corners",
  );
  refused(
    withEdges({ edge_water: [{ sheet: "edges", x: 0, y: 0, w: 4, h: 3 }] }),
    /an edge tile's block is 4 by 4, 4 by 6, or 4 by 30/,
    "a block of the wrong size",
  );
  refused(withEdges({ edge_water: [{ sheet: "edges", x: 0, y: 0, w: 4, h: 5 }] }), /4 by 6/, "nor five rows");
  assert.ok(
    parseTilePack(withEdges({ edge_water: [{ sheet: "tall", x: 0, y: 0, w: 4, h: 30 }] })).ok,
    "a 4 x 30 block, with its curved runs",
  );
  refused(withEdges({ edge_water: [{ sheet: "tall", x: 0, y: 0, w: 4, h: 31 }] }), /h/, "nor 31");
  refused(withEdges({ house: [{ sheet: "tall", x: 0, y: 0, w: 4, h: 9 }] }), /at most 8 each way/, "a sprite 9 tall");
  // Fringes: a block of sixteen masks for a ground look, four by four only.
  assert.ok(parseTilePack(withEdges({ fringe_forest: [{ sheet: "edges", x: 0, y: 0, w: 4, h: 4 }] })).ok, "a fringe");
  refused(
    withEdges({ fringe_forest: [{ sheet: "edges", x: 0, y: 0, w: 4, h: 6 }] }),
    /a fringe's block is 4 by 4/,
    "6 rows",
  );
  assert.ok(
    WORLD_GROUND_LOOKS.every((look) => WORLD_TILE_IDS.includes(`fringe_${look}` as never)),
    "every ground look may have a fringe",
  );
  assert.deepEqual(
    WORLD_GROUND_LOOKS.filter((look) => !WORLD_FRINGE_ORDER.includes(look)),
    [],
    "every ground look has its place in the fringe order",
  );
  assert.deepEqual(
    [...new Set(WORLD_FRINGE_ORDER)].length,
    WORLD_FRINGE_ORDER.length,
    "each look once in the fringe order",
  );
  assert.ok(WORLD_FRINGE_ORDER.indexOf("forest") > WORLD_FRINGE_ORDER.indexOf("grass"), "a forest overhangs the grass");
  // Patterns: the ground, a town's ground, streets and square, and a room's floor and walls.
  assert.ok(
    ["grass", "town_ground", "in_floor", "in_wall"].every((id) => WORLD_PATTERN_TILE_IDS.includes(id as never)),
  );
  assert.ok(!WORLD_PATTERN_TILE_IDS.includes("house" as never), "a house is a sprite");
  // Maps of places (caves, dungeons, stations): one set's floor, wall and liquid as patterns, the liquid's
  // edges as a whole 4 by 30 block, and eight props, the sixth the way out; all image-only.
  const dungeonRead = parseTilePack(
    withEdges({
      dn_floor: [{ sheet: "edges", x: 0, y: 0, w: 4, h: 4 }],
      dn_wall: [{ sheet: "edges", x: 0, y: 0, w: 4, h: 4 }],
      dn_liquid: [{ sheet: "edges", x: 0, y: 0, w: 4, h: 4 }],
      edge_dn_liquid: [{ sheet: "tall", x: 0, y: 0, w: 4, h: 30 }],
      ...Object.fromEntries(
        Array.from({ length: WORLD_DUNGEON_PROP_COUNT }, (_, i) => [
          `dn_prop${i}`,
          [{ sheet: "edges", x: i % 4, y: 0 }],
        ]),
      ),
      dn_prop8: [{ sheet: "edges", x: 0, y: 0 }],
    }),
  );
  assert.ok(dungeonRead.ok, JSON.stringify(!dungeonRead.ok && dungeonRead.issues));
  if (dungeonRead.ok) {
    for (const id of [
      "dn_floor",
      "dn_wall",
      "dn_liquid",
      "edge_dn_liquid",
      "dn_prop0",
      WORLD_DUNGEON_WAY_OUT_PROP,
      "dn_prop7",
    ])
      assert.ok(dungeonRead.pack.tiles[id]?.length, `${id} kept`);
    assert.ok(!dungeonRead.pack.tiles.dn_prop8, "only eight props");
    assert.ok(
      dungeonRead.notes.some((note) => note.includes("dn_prop8")),
      "the ninth noted",
    );
  }
  refused(
    withEdges({ edge_dn_liquid: [{ sheet: "edges", x: 0, y: 0, w: 4, h: 5 }] }),
    /4 by 6/,
    "the liquid's edges are a whole block",
  );
  assert.equal(WORLD_DUNGEON_WAY_OUT_PROP, `dn_prop${5}`);
  assert.deepEqual([...WORLD_MAP_EDGE_TERRAINS], ["dn_liquid"]);
  assert.ok(
    !WORLD_EDGE_TERRAINS.includes("dn_liquid" as never),
    "the overworld and towns never draw a dungeon's liquid",
  );
  assert.ok(["dn_floor", "dn_wall", "dn_liquid"].every((id) => WORLD_PATTERN_TILE_IDS.includes(id as never)));
  assert.ok(!WORLD_PATTERN_TILE_IDS.includes("dn_prop0" as never), "a prop is a sprite");
  assert.ok(
    WORLD_TILE_IDS.filter((id) => id.includes("dn_")).every((id) => WORLD_IMAGE_ONLY_TILE_IDS.includes(id)),
    "a drawn pack needs no dungeon tiles",
  );
  // Seasons, for drawing: the game's day, a season every WORLD_SEASON_DAYS, from spring.
  assert.deepEqual(
    [1, WORLD_SEASON_DAYS, WORLD_SEASON_DAYS + 1, 3 * WORLD_SEASON_DAYS + 1, 4 * WORLD_SEASON_DAYS + 1, 0].map(
      worldSeason,
    ),
    ["spring", "spring", "summer", "winter", "spring", "spring"],
  );
  const seasonalRead = parseTilePack(
    withEdges({
      "grass@winter": [{ sheet: "edges", x: 0, y: 0 }],
      "fringe_forest@autumn": [{ sheet: "edges", x: 0, y: 0, w: 4, h: 4 }],
      "house@winter": [{ sheet: "edges", x: 0, y: 0 }],
      "grass@monsoon": [{ sheet: "edges", x: 0, y: 0 }],
    }),
  );
  assert.ok(seasonalRead.ok);
  if (seasonalRead.ok) {
    assert.ok(seasonalRead.pack.tiles["grass@winter"], "seasonal ground kept");
    assert.ok(seasonalRead.pack.tiles["fringe_forest@autumn"], "a seasonal fringe kept");
    assert.ok(!seasonalRead.pack.tiles["house@winter"], "a house has no seasons");
    assert.ok(!seasonalRead.pack.tiles["grass@monsoon"], "nor is there a fifth season");
    assert.ok(
      seasonalRead.notes.some((note) => note.includes("house@winter")),
      "noted",
    );
  }
  // A drawn pack has no edge tiles (their blocks are image sprites): left out and noted.
  const drawnEdges = parseTilePack({
    tilePackVersion: 1,
    id: "drawn-edges",
    name: "Drawn",
    family: "fantasy",
    version: 1,
    palette: ["#336633"],
    tiles: { edge_water: [Array.from({ length: 16 }, () => "0".repeat(16))] },
  });
  assert.ok(drawnEdges.ok && !("edge_water" in drawnEdges.pack.tiles));
  // The corner masks: a corner's four cells, outside the map counting as the nearest cell on its edge.
  const lake = new Set(["2,2", "3,2", "2,3", "3,3"]);
  const inLake = (x: number, y: number) => lake.has(`${x},${y}`);
  assert.equal(worldEdgeMask(inLake, 2, 2, 6, 6), 8, "the lake's top-left corner: only its bottom-right cell");
  assert.equal(worldEdgeMask(inLake, 3, 3, 6, 6), 15, "its middle: all four");
  assert.equal(worldEdgeMask(inLake, 4, 3, 6, 6), 5, "its right side: the two cells to the left");
  assert.equal(worldEdgeMask(inLake, 0, 0, 6, 6), 0, "away from it: none");
  // Slanted corners: a rectangle's corners stay rounded; a staircase's steps slant.
  assert.equal(worldEdgeSlanted(inLake, 2, 2, 6, 6, 8), false, "a rectangle's outer corner stays rounded");
  const stairs = (x: number, y: number) => x + y >= 6;
  assert.equal(worldEdgeMask(stairs, 3, 3, 8, 8), 8, "(a step's outer corner)");
  assert.equal(worldEdgeSlanted(stairs, 3, 3, 8, 8, 8), true, "a staircase's outer corner slants");
  assert.equal(worldEdgeMask(stairs, 4, 3, 8, 8), 14, "(a step's inner corner)");
  assert.equal(worldEdgeSlanted(stairs, 4, 3, 8, 8, 14), true, "and its inner corner");
  const ell = (x: number, y: number) => x >= 3 || y >= 3;
  assert.equal(worldEdgeMask(ell, 3, 3, 8, 8), 14, "(an L's inner corner)");
  assert.equal(worldEdgeSlanted(ell, 3, 3, 8, 8, 14), false, "an L's inner corner stays rounded");
  assert.equal(worldEdgeSlanted(stairs, 4, 4, 8, 8, 15), false, "only single cells and gaps slant");
  // Every outer and inner corner has its own slanted piece on the block's last two rows.
  assert.deepEqual(
    [1, 2, 4, 8, 14, 13, 11, 7].map((mask) => WORLD_EDGE_SLANT_PIECE_BY_MASK[mask]),
    [16, 17, 18, 19, 20, 21, 22, 23],
  );
  assert.equal(WORLD_EDGE_SLANT_PIECE_BY_MASK.filter((piece) => piece >= 0).length, 8);
  // Curved runs: what a piece says about its corner (its mask, and where it crosses each border).
  const decode = (piece: number) => {
    const at = { L: 0, R: 0, T: 0, B: 0 };
    let mask = WORLD_EDGE_PIECE_BY_MASK.indexOf(piece);
    if (piece >= 16 && piece < 24) mask = WORLD_EDGE_SLANT_PIECE_BY_MASK.indexOf(piece);
    if (piece >= 24 && piece < 56) {
      const [si, [a, b]] = [(piece - 24) >> 3, WORLD_EDGE_CURVE_OFFSETS[(piece - 24) & 7]!];
      mask = [12, 3, 10, 5][si]!;
      if (si < 2) [at.L, at.R] = [a, b];
      else [at.T, at.B] = [a, b];
    }
    if (piece >= 56 && piece < 120) {
      const [ki, [a, b]] = [(piece - 56) >> 3, WORLD_EDGE_CURVE_OFFSETS[(piece - 56) & 7]!];
      mask = [1, 2, 4, 8, 14, 13, 11, 7][ki]!;
      const q = ki & 3;
      if (q >> 1) at.B = a;
      else at.T = a;
      if (q & 1) at.R = b;
      else at.L = b;
    }
    return { mask, ...at };
  };
  // Every pair of neighbouring pieces agrees where they meet, and each piece is its corner's.
  const agrees = (filled: (x: number, y: number) => boolean, size: number, label: string) => {
    const pieceAt = (x: number, y: number) => worldEdgePiece(filled, x, y, size, size, 30);
    let curved = 0;
    for (let y = 0; y <= size; y++)
      for (let x = 0; x <= size; x++) {
        const piece = pieceAt(x, y);
        const mask = worldEdgeMask(filled, x, y, size, size);
        if (piece < 0) {
          assert.ok(mask === 0, `${label}: a piece at ${x},${y}`);
          continue;
        }
        const here = decode(piece);
        assert.equal(here.mask, mask, `${label}: the piece at ${x},${y} is its corner's`);
        if (piece >= 24) curved++;
        const right = pieceAt(x + 1, y);
        if (x < size && right >= 0) assert.equal(decode(right).L, here.R, `${label}: ${x},${y} meets the next across`);
        const below = pieceAt(x, y + 1);
        if (y < size && below >= 0) assert.equal(decode(below).T, here.B, `${label}: ${x},${y} meets the next down`);
      }
    return curved;
  };
  const oval = (x: number, y: number) => (x - 7.5) ** 2 / 36 + (y - 7.5) ** 2 / 12 < 1;
  assert.ok(agrees(oval, 16, "an oval") > 4, "an oval takes curved pieces");
  assert.ok(agrees((x, y) => y >= 7 - Math.floor(x / 2), 16, "a gentle run") > 4, "a gentle run takes them");
  const diagonal = (x: number, y: number) => x + y >= 9;
  agrees(diagonal, 16, "a 45 degree run");
  // Away from the map's edge (where it meets the edge's straight run), its corners are the slants.
  for (const [x, y] of [
    [4, 5],
    [5, 5],
    [6, 4],
    [6, 3],
  ] as const) {
    const piece = worldEdgePiece(diagonal, x, y, 16, 16, 30);
    assert.ok(piece >= 16 && piece < 24, `a 45 degree run slants at ${x},${y} (${piece})`);
  }
  assert.equal(agrees(inLake, 6, "a rectangle"), 0, "a rectangle keeps its plain pieces");
  assert.equal(worldEdgePiece(inLake, 2, 2, 6, 6, 30), WORLD_EDGE_PIECE_BY_MASK[8], "its corner stays rounded");
  assert.equal(worldEdgePiece(stairs, 3, 3, 8, 8, 30), 19, "a staircase's corner slants with curves on hand too");
  assert.equal(worldEdgePiece(stairs, 3, 3, 8, 8, 4), WORLD_EDGE_PIECE_BY_MASK[8], "a 16-piece block: rounded");
  const run = (x: number, y: number) => y >= 7 - Math.floor(x / 2);
  const somewhere = Array.from({ length: 17 * 17 }, (_, i) => [i % 17, Math.floor(i / 17)] as const);
  assert.ok(
    somewhere.every(([x, y]) => worldEdgePiece(run, x, y, 16, 16, 6) < 24),
    "a 24-piece block never asks for a curve",
  );
  const sea = (x: number) => x === 0;
  assert.equal(
    worldEdgeMask((x) => sea(x), 0, 0, 6, 6),
    15,
    "past the map's edge the sea runs on",
  );
  assert.equal(
    worldEdgeMask((x) => sea(x), 1, 3, 6, 6),
    5,
  );
  assert.deepEqual(
    [0, 15].map((mask) => WORLD_EDGE_PIECE_BY_MASK[mask]),
    [-1, 6],
    "nothing, and the middle",
  );
  assert.equal(new Set(WORLD_EDGE_PIECE_BY_MASK.slice(1)).size, 15, "every mask its own piece");
  // A road's cells: four-connected (no corner-to-corner step), ends included, skipped cells left out.
  const road = worldRoadCells({ x: 0, y: 0 }, { x: 4, y: 2 }, () => false);
  assert.deepEqual(road[0], { x: 0, y: 0 });
  assert.deepEqual(road.at(-1), { x: 4, y: 2 });
  assert.equal(road.length, 4 + 2 + 1, "one cell a step");
  for (let at = 1; at < road.length; at++)
    assert.equal(Math.abs(road[at]!.x - road[at - 1]!.x) + Math.abs(road[at]!.y - road[at - 1]!.y), 1, "4-connected");
  assert.ok(!worldRoadCells({ x: 0, y: 0 }, { x: 4, y: 0 }, (x) => x === 2).some((cell) => cell.x === 2), "skipped");
  const piece = { sx: 0, sy: 0 };
  const whole = Array.from({ length: 16 }, () => piece);
  const holed: Array<typeof piece | undefined> = [...whole];
  holed[5] = undefined;
  assert.deepEqual(
    worldWholeEdgeBlocks([whole, holed, whole.slice(1), undefined, whole]),
    [whole, whole],
    "whole blocks only",
  );
  assert.deepEqual(worldWholeEdgeBlocks([holed]), [], "none whole");
  const slanting = Array.from({ length: 24 }, () => piece);
  assert.deepEqual(worldWholeEdgeBlocks([slanting, slanting.slice(0, 20)]), [slanting], "with its slants, or without");
  const curving = Array.from({ length: 120 }, () => piece);
  assert.deepEqual(worldWholeEdgeBlocks([curving, curving.slice(0, 100)]), [curving], "with its curves");
  const there = worldRoadCells({ x: 1, y: 1 }, { x: 4, y: 4 }, () => false);
  const back = worldRoadCells({ x: 4, y: 4 }, { x: 1, y: 1 }, () => false);
  assert.deepEqual(back, [...there].reverse(), "a way and its way back lie on the same cells");
  assert.deepEqual(back[0], { x: 4, y: 4 }, "listed from where it starts");

  // ── The library ──
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameTilePacksRoutes, { prefix: "/api/game-tile-packs" });
  try {
    const save = (body: unknown) =>
      app.inject({ method: "POST", url: "/api/game-tile-packs", payload: { pack: body } });
    const saved = await save(imageTilePack());
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().pack.id, "local/riverlands-art");
    const library = (await app.inject({ method: "GET", url: "/api/game-tile-packs" })).json();
    assert.deepEqual(
      library.packs.map((pack: { id: string; tilePackVersion: number }) => [pack.id, pack.tilePackVersion]),
      [["local/riverlands-art", 2]],
      "the list says it is an image pack",
    );
    const served = (
      await app.inject({ method: "GET", url: "/api/game-tile-packs/pack?id=local/riverlands-art" })
    ).json().pack as ImageTilePack;
    assert.equal(served.tilePackVersion, 2);
    assert.deepEqual(served.tiles, imageTilePack().tiles, "its tiles as saved");
    // Its sheet stored as a PNG of the same size (written again by the Engine where sharp is there).
    assert.deepEqual(pngDataUrlCheck(served.sheets[0]!.png), { width: 192, height: 96 });
    assert.equal((await save(served)).json().status, "unchanged", "saved back as it was read");
    // Imported from a file, and exported back as it is kept.
    const imported = await app.inject({
      method: "POST",
      url: "/api/game-tile-packs/import",
      payload: { definition: JSON.stringify(imageTilePack({ id: "shared-art", name: "Shared art" })) },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().pack.id, "local/shared-art");
    // A save that is no pack at all is refused, not an error.
    assert.equal((await app.inject({ method: "POST", url: "/api/game-tile-packs", payload: {} })).statusCode, 400);
    assert.equal((await save("text")).statusCode, 400);
    // A PNG whose structure is whole but whose pixels do not decode (its data is not compressed image
    // data) is refused where the Engine can decode sheets.
    const undecodable = Buffer.from(bytes);
    const idat = undecodable.indexOf(Buffer.from("IDAT"));
    const idatLength = undecodable.readUInt32BE(idat - 4);
    undecodable.fill(0x41, idat + 4, idat + 4 + idatLength);
    const { crc32 } = await import("node:zlib");
    undecodable.writeUInt32BE(crc32(undecodable.subarray(idat, idat + 4 + idatLength)) >>> 0, idat + 4 + idatLength);
    assert.ok(!("issue" in pngDataUrlCheck(pngDataUrl(undecodable))), "(its structure is whole)");
    const { getSharp } = await import("../../packages/server/src/services/image/sharp-runtime.js");
    const sharpHere = await getSharp().then(
      () => true,
      () => false,
    );
    assert.ok(sharpHere || process.platform === "android", "(sharp decodes here)");
    if (sharpHere) assert.equal((await save(withSheet(pngDataUrl(undecodable)))).statusCode, 400, "does not decode");
    // A damaged sheet is refused through the route as well.
    assert.equal((await save(withSheet(pngDataUrl(damaged)))).statusCode, 400);
    // Chosen for its family like any pack.
    const chosen = await app.inject({
      method: "PUT",
      url: "/api/game-tile-packs/selection",
      payload: { family: "fantasy", packId: "local/riverlands-art" },
    });
    assert.equal(chosen.statusCode, 200, chosen.body);

    // Its newest eight versions are kept.
    for (let version = 2; version <= IMAGE_PACK_VERSIONS_KEPT + 3; version++) {
      const next = await save(imageTilePack({ version, name: `Riverlands art ${version}` }));
      assert.equal(next.statusCode, 200, next.body);
    }
    const versions = (
      await db.select().from((await import("../../packages/server/src/db/schema/index.js")).gameTilePacks)
    )
      .filter((row: { packId: string }) => row.packId === "local/riverlands-art")
      .map((row: { version: number }) => row.version)
      .sort((a: number, b: number) => a - b);
    assert.deepEqual(
      versions,
      Array.from({ length: IMAGE_PACK_VERSIONS_KEPT }, (_, at) => at + 4),
      "the oldest versions dropped",
    );
    // A version older than every one kept would be dropped at once: refused, and nothing is lost.
    const tooOld = await save(imageTilePack({ version: 2, name: "Riverlands art again" }));
    assert.equal(tooOld.statusCode, 409, tooOld.body);
    assert.equal(tooOld.json().code, "tile_pack_version_too_old");
    // A drawn pack keeps every version.
    for (let version = 1; version <= IMAGE_PACK_VERSIONS_KEPT + 2; version++) await save({ ...drawn, version });
    const drawnVersions = (
      await db.select().from((await import("../../packages/server/src/db/schema/index.js")).gameTilePacks)
    ).filter((row: { packId: string }) => row.packId === "local/drawn").length;
    assert.equal(drawnVersions, IMAGE_PACK_VERSIONS_KEPT + 2, "every drawn version kept");
  } finally {
    await app.close();
    await closeDB();
  }

  console.log("World image tiles: image packs read, checked, kept and listed beside drawn ones.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
