/**
 * Fight-board art slots (Capability API 1.333):
 *
 *   - A board pack is read strictly: every sheet a PNG of the size it says, every tile inside its sheet,
 *     an edge block four cells by four; tiles a board does not draw are left out and noted.
 *   - Which piece a cell draws: a terrain's variant by position, a pattern larger than a cell laid over
 *     the board, a dual-grid edge block's quarters, a prop's sprite across its cells (broken, its broken
 *     look), a lasting area's own look; a prop with no art is looked up by its name.
 *   - The library files packs under `local/`, and a board is drawn with the pack it names, else the
 *     library's for its environment; props also read the props pack.
 *   - A painted prop and a board carry their art into a fight and onto the view; a catalog zone's art
 *     reaches the board; refused shapes; the install gate.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRulesetCombatChoice,
  boardPackCell,
  boardPackEdgeQuarters,
  boardPackSprite,
  boardPropArtFor,
  createRulesetEncounter,
  parseBoardPack,
  parseRulesetDefinition,
  rowsFromCatalogEntry,
  rulesetCombatOptions,
  rulesetSheetBuildSchema,
  rulesetZonesShown,
  supportedCapabilityApi,
  worldBattlefieldMapSchema,
  type BoardPack,
  type RulesetCatalogEntry,
  type DirectedRulesetView,
  type RulesetDefinition,
  type RulesetStatBlock,
} from "../../packages/shared/src/index.js";
import { boardCellArt, boardSliceStyle } from "../../packages/client/src/lib/board-art-cells.js";
import { rulesetBoardCells } from "../../packages/client/src/lib/ruleset-combat-board.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-board-packs-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameBoardPacksRoutes } = await import("../../packages/server/src/routes/game-board-packs.routes.js");
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");
const { directedRulesetView } =
  await import("../../packages/server/src/services/game/ruleset-combat-director.service.js");

/** A PNG's signature and header for a picture of this size (all the checks read). */
const png = (width: number, height: number) => {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt8(8, 24);
  bytes.writeUInt8(6, 25);
  return `data:image/png;base64,${bytes.toString("base64")}`;
};
// One sheet 8 cells by 8 (48 px cells): plains in two variants at (0,0) and (1,0), a 2 x 2 forest pattern
// at (2,0), the water edge block at (4,0), a bonfire (1 x 2) at (0,2) and its broken look at (1,2), the
// dark overlay at (2,2), a fog zone at (3,2), the Year-Wheel (2 x 2) at (0,4).
const forest = (extra: Record<string, unknown> = {}) => ({
  boardPackVersion: 1,
  id: "forest-fights",
  name: "Forest fights",
  version: 1,
  environment: "forest",
  tileSize: 48,
  sheets: [{ id: "s1", png: png(384, 384), width: 384, height: 384 }],
  tiles: {
    bt_plains: [
      { sheet: "s1", x: 0, y: 0 },
      { sheet: "s1", x: 1, y: 0 },
    ],
    bt_forest: [{ sheet: "s1", x: 2, y: 0, w: 2, h: 2 }],
    bt_edge_water: [{ sheet: "s1", x: 4, y: 0, w: 4, h: 4 }],
    bp_bonfire: [{ sheet: "s1", x: 0, y: 2, h: 2 }],
    bp_bonfire_broken: [{ sheet: "s1", x: 1, y: 2 }],
    bo_dark: [{ sheet: "s1", x: 2, y: 2 }],
    bz_fog: [{ sheet: "s1", x: 3, y: 2 }],
    bp_year_wheel: [{ sheet: "s1", x: 0, y: 4, w: 2, h: 2 }],
  },
  ...extra,
});

try {
  assert.ok(supportedCapabilityApi.minor >= 333);

  // ── Read strictly ──
  const read = parseBoardPack({ ...forest(), tiles: { ...forest().tiles, flower: [{ sheet: "s1", x: 0, y: 0 }] } });
  assert.ok(read.ok, read.ok ? "" : read.issues.join("; "));
  assert.equal(read.pack.tiles.flower, undefined);
  assert.ok(read.notes[0]!.includes('"flower"'));
  const pack = read.pack as BoardPack;
  const issuesOf = (value: unknown) => {
    const result = parseBoardPack(value);
    assert.equal(result.ok, false, "refused");
    return result.ok ? [] : result.issues;
  };
  assert.ok(
    issuesOf(forest({ sheets: [{ id: "s1", png: png(100, 384), width: 384, height: 384 }] }))[0]!.includes(
      "100 by 384",
    ),
  );
  assert.ok(
    issuesOf(forest({ tiles: { bt_wall: [{ sheet: "s1", x: 7, y: 7, w: 2 }] } }))[0]!.includes("past the edge"),
  );
  assert.ok(
    issuesOf(forest({ tiles: { bt_edge_wall: [{ sheet: "s1", x: 0, y: 0, w: 2, h: 2 }] } }))[0]!.includes("4 by 4"),
  );
  assert.ok(issuesOf(forest({ tiles: { bt_wall: [{ sheet: "s2", x: 0, y: 0 }] } }))[0]!.includes('no sheet "s2"'));
  assert.ok(issuesOf("x".repeat(24_000_001))[0]!.includes("too large"));
  assert.equal(parseBoardPack(forest({ environment: "moon" })).ok, false);

  // ── Which piece a cell draws ──
  const plains = new Set(
    Array.from({ length: 6 }, (_, x) => boardPackCell(pack, "bt_plains", x, 3)!.x).map((x) => x / 48),
  );
  assert.deepEqual([...plains].sort(), [0, 1], "both variants, mixed by position");
  assert.deepEqual(
    boardPackCell(pack, "bt_plains", 2, 3),
    boardPackCell(pack, "bt_plains", 2, 3),
    "the same each time",
  );
  // A pattern two cells by two: cell (3, 1) draws its right-hand, lower cell.
  const patterned = boardPackCell(pack, "bt_forest", 3, 1)!;
  assert.deepEqual([patterned.x, patterned.y, patterned.w, patterned.h], [3 * 48, 1 * 48, 48, 48]);
  assert.equal(boardPackCell(pack, "bt_ruin", 0, 0), null, "a tile it lacks");
  // Water in the cell at (1,1) alone: the cell's top-left quarter is the bottom-right quarter of the corner
  // piece whose only filled cell is its bottom-right (mask 8, piece 13: cell (1,3) of the block).
  const water = (x: number, y: number) => x === 1 && y === 1;
  const quarters = boardPackEdgeQuarters(pack, "bt_edge_water", water, 1, 1, 4, 4)!;
  assert.deepEqual(
    [quarters[0]!.x, quarters[0]!.y, quarters[0]!.w],
    [(4 + 1) * 48 + 24, 3 * 48 + 24, 24],
    "top-left quarter of the corner with water at its bottom-right",
  );
  assert.equal(boardPackEdgeQuarters(pack, "bt_edge_water", water, 3, 3, 4, 4)![3], null, "no water near");
  assert.deepEqual(
    [boardPackSprite([null, pack], "bp_year_wheel")?.cellsW, boardPackSprite([pack], "bp_year_wheel")?.cellsH],
    [2, 2],
  );
  assert.equal(boardPropArtFor("The Year-Wheel"), "bp_year_wheel");
  assert.equal(boardPropArtFor("  "), null);
  // A rect shown filling its element: the sheet scaled so the rect is the element, and moved to it.
  assert.deepEqual(boardSliceStyle({ sheet: pack.sheets[0]!, x: 96, y: 48, w: 48, h: 48 }), {
    backgroundImage: `url(${pack.sheets[0]!.png})`,
    backgroundSize: "800% 800%",
    backgroundPosition: `${(96 / 336) * 100}% ${(48 / 336) * 100}%`,
    backgroundRepeat: "no-repeat",
    imageRendering: "pixelated",
  });

  // ── The library, and what a board is drawn with ──
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameBoardPacksRoutes, { prefix: "/api/game-tile-packs/boards" });
  try {
    const save = (body: unknown) =>
      app.inject({ method: "POST", url: "/api/game-tile-packs/boards", payload: { pack: body } });
    const saved = await save(forest());
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().pack, { id: "local/forest-fights", version: 1, name: "Forest fights", tiles: 8 });
    assert.equal((await save(forest())).json().status, "unchanged");
    assert.equal((await save(forest({ name: "Other" }))).statusCode, 409, "a version is never rewritten");
    assert.equal((await save({ ...forest(), version: 0 })).statusCode, 400);
    const props = {
      ...forest(),
      id: "props",
      name: "Props",
      environment: "props",
      tiles: { bp_coffin: [{ sheet: "s1", x: 0, y: 0, h: 2 }] },
    };
    assert.equal((await save(props)).statusCode, 200);
    const drawnWith = async (query: string) =>
      (await app.inject({ method: "GET", url: `/api/game-tile-packs/boards/for?${query}` })).json();
    const byEnvironment = await drawnWith("environment=forest");
    assert.deepEqual([byEnvironment.board?.id, byEnvironment.props?.id], ["local/forest-fights", "local/props"]);
    const named = await drawnWith("pack=local/forest-fights&environment=cave");
    assert.equal(named.board?.id, "local/forest-fights", "the pack it names, whatever its place");
    assert.deepEqual(await drawnWith("environment=cave"), { board: null, props: named.props }, "none for caves");
    assert.equal((await drawnWith("pack=local/nothing")).board, null);
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/game-tile-packs/boards/pack?id=board/forest" })).statusCode,
      404,
      "no built-in pack shipped yet",
    );
    const removed = await app.inject({ method: "DELETE", url: "/api/game-tile-packs/boards?id=local/props" });
    assert.equal(removed.json().removed, 1);
    assert.equal((await drawnWith("environment=forest")).props, null);
  } finally {
    await app.close();
    await closeDB();
  }

  // ── Into a fight, and onto the board ──
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const fog = {
    id: "fog",
    label: "Fog",
    rows: [{ list: "spells", values: { name: "Fog", level: 1, prepared: true } }],
    mechanics: {
      kind: "utility",
      cost: [{ pool: "slots_1", amount: 1 }],
      area: { shape: "burst", size: 5 },
      range: 120,
      zone: { art: "bz_fog", rounds: 10, triggers: [], obscures: {} },
    },
  } as unknown as RulesetCatalogEntry;
  const document = (art = true): Record<string, any> => {
    const doc = JSON.parse(fiveEText);
    const entry = structuredClone(fog) as any;
    if (!art) delete entry.mechanics.zone.art;
    doc.catalogs.push({ id: "spells", label: "Spells", feeds: ["spells"], entries: [entry] });
    return doc;
  };
  const parsed = parseRulesetDefinition(document());
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.issues.join("; "));
  const definition: RulesetDefinition = parsed.definition;
  const build = rulesetSheetBuildSchema.parse({
    abilities: { str: 10, dex: 10, con: 14, int: 10, wis: 16, cha: 10 },
    fields: { level: 5, ac: 12, speed: 30, hp_max: 60, spellcasting_ability: "wis", slots_max_1: 9 },
    lists: { spells: rowsFromCatalogEntry("spells", fog).map((row) => row.row) },
  });
  const block: RulesetStatBlock = {
    health: 100,
    defense: 5,
    initiativeModifier: 0,
    speed: 30,
    actions: [{ name: "Claw", budget: "action", toHit: 4, damage: { count: 1, sides: 4, flat: 0 } }],
  } as RulesetStatBlock;
  const state = createRulesetEncounter({
    definition,
    seed: 1,
    roller: () => 10,
    combatants: [
      { id: "mage", name: "Mage", side: "party", build, live: {}, catalogs: { spells: [fog] } },
      { id: "a", name: "A", side: "enemy", block },
    ],
    board: {
      grid: { width: 12, height: 8, tiles: Array.from({ length: 8 }, () => Array(12).fill("plains")) } as never,
      placements: { mage: { x: 1, y: 1 }, a: { x: 10, y: 6 } },
      environment: "forest",
      pack: "local/forest-fights",
      props: [
        {
          id: "p1",
          label: "The Year-Wheel",
          cells: [
            { x: 5, y: 3 },
            { x: 6, y: 3 },
            { x: 5, y: 4 },
            { x: 6, y: 4 },
          ],
          health: 20,
        },
        { id: "p2", label: "Bonfire", art: "bp_bonfire", cells: [{ x: 8, y: 1 }], health: 5 },
        { id: "p3", label: "Crate", art: "Not art!", cells: [{ x: 9, y: 1 }], health: 5 },
      ],
    },
  });
  state.order = ["mage", "a"];
  state.turn = 0;
  assert.equal(state.board!.pack, "local/forest-fights");
  assert.deepEqual(
    state.board!.props!.map((prop) => prop.art),
    [undefined, "bp_bonfire", undefined],
    "an art id that is not one is dropped",
  );
  const option = rulesetCombatOptions(definition, state, "mage").find((one) => one.label === "Fog")!;
  const cast = applyRulesetCombatChoice(
    definition,
    state,
    { actorId: "mage", optionId: option.id, targetIds: [], at: { x: 2, y: 6 } },
    () => 10,
  );
  assert.equal(rulesetZonesShown(cast.state)[0]?.art, "bz_fog");
  const view = directedRulesetView(definition, {
    style: "ruleset",
    rulesetFight: { encounter: cast.state, events: [], eventSeq: 0, controllers: {}, live: {}, adjustments: [] },
  } as never) as DirectedRulesetView;
  assert.equal(view.grid?.pack, "local/forest-fights");
  assert.equal(view.grid?.environment, "forest");
  assert.equal(view.props?.find((prop) => prop.id === "p2")?.art, "bp_bonfire");
  assert.equal(view.zones?.[0]?.art, "bz_fog");
  // Drawn: the Wheel by its name, a piece a cell; the fog by its own look; plains from the pack.
  const cells = rulesetBoardCells(view, null);
  const art = { board: pack, props: null };
  const cellAt = (x: number, y: number) => cells.find((cell) => cell.x === x && cell.y === y)!;
  const drawn = (x: number, y: number) => boardCellArt(art, cellAt(x, y), () => "plains", 12, 8);
  assert.deepEqual([drawn(6, 4).prop?.x, drawn(6, 4).prop?.y], [48, 5 * 48], "the Wheel's lower right");
  assert.deepEqual([drawn(8, 1).prop?.x, drawn(8, 1).prop?.y], [0, 2 * 48], "the bonfire's top");
  assert.equal(drawn(9, 1).prop, undefined, "a crate with no art: drawn as today");
  assert.deepEqual(
    drawn(2, 6).zones.map((slice) => slice.x),
    [3 * 48],
    "its own fog",
  );
  assert.ok(drawn(0, 0).ground && drawn(0, 0).ground!.y === 0);
  const broken = boardCellArt(
    art,
    { ...cellAt(8, 1), prop: { ...cellAt(8, 1).prop!, health: 0 } },
    () => "plains",
    12,
    8,
  );
  assert.equal(broken.prop?.x, 48, "the bonfire broken");
  const none = boardCellArt({ board: null, props: null }, cellAt(6, 4), () => "plains", 12, 8);
  assert.deepEqual(none, { edges: [], zones: [] }, "no pack: drawn as today");

  // ── Painted, refused, and the gate ──
  const map = {
    id: "b24",
    name: "The Wheel",
    place: "p1",
    size: "small",
    scene: "forest",
    pack: "local/forest-fights",
    rows: Array(8).fill("pppppppppppp"),
    props: [{ id: "p1", label: "The Year-Wheel", art: "bp_year_wheel", cells: [{ x: 5, y: 3 }], health: 20 }],
  };
  assert.ok(
    worldBattlefieldMapSchema.safeParse(map).success,
    JSON.stringify(worldBattlefieldMapSchema.safeParse(map).error?.issues),
  );
  assert.equal(
    worldBattlefieldMapSchema.safeParse({ ...map, props: [{ ...map.props[0], art: "year wheel" }] }).success,
    false,
  );
  const badZone = document();
  badZone.catalogs.at(-1).entries[0].mechanics.zone.art = "fog";
  assert.equal(parseRulesetDefinition(badZone).ok, false);
  const gate =
    "A ruleset with a lasting area drawn with its own art on a fight's board requires schemaVersion 2 and capabilityApi 1.333 or newer";
  const manifest = (minor: number) => ({
    schemaVersion: 2,
    capabilityApi: { major: 1, minor },
    id: "fivee",
    name: "5e",
    version: "1.0.0",
    kind: ["ruleset"],
    entrypoints: {},
    contributions: { assets: { paths: ["ruleset.json"] } },
    files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
    permissions: [],
    restartRequired: false,
  });
  assert.equal(getCapabilityPackageInstallIssue(manifest(332) as never, document()), gate);
  assert.notEqual(getCapabilityPackageInstallIssue(manifest(333) as never, document()), gate);
  assert.notEqual(getCapabilityPackageInstallIssue(manifest(332) as never, document(false)), gate);

  console.log(
    "Board packs: read strictly, kept in the library, chosen by the board or its place, and drawn a cell at a time: ground, edges, overlays, props and lasting areas.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
