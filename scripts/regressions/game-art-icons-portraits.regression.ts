/**
 * Icon and portrait art slots (Capability API 1.338):
 *
 *   - A board pack of kind `icons` holds `ic_` tiles, one of kind `portraits` holds `pt_` busts with
 *     their expressions as `pt_<name>@<mood>`; other ids are left out and noted.
 *   - The names things are drawn with when they name none: a condition `ic_cond_<id>`, an item
 *     `ic_item_<id or name>`, any other catalog entry `ic_<catalog>_<entry>`, a person `pt_<name>`.
 *   - A ruleset's own `icon` on a catalog entry or a condition comes first.
 *   - A portrait's expression the pack lacks falls back to its neutral bust; a thing the pack lacks
 *     draws as today.
 *   - The library serves the `icons` and `portraits` packs; refused shapes; the install gate.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artIconFor,
  artPortraitFor,
  parseBoardPack,
  parseRulesetDefinition,
  rulesetConditionIcons,
  rulesetEntryIcons,
  rulesetItemIcons,
  supportedCapabilityApi,
  type BoardPack,
} from "../../packages/shared/src/index.js";
import { artPackSlice } from "../../packages/client/src/lib/art-pack.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-art-icons-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameBoardPacksRoutes } = await import("../../packages/server/src/routes/game-board-packs.routes.js");
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

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
const pack = (kind: "icons" | "portraits", tiles: Record<string, unknown>) => ({
  boardPackVersion: 1,
  id: kind,
  name: kind,
  version: 1,
  environment: kind,
  tileSize: 48,
  sheets: [{ id: "s1", png: png(384, 384), width: 384, height: 384 }],
  tiles,
});

try {
  assert.ok(supportedCapabilityApi.minor >= 338);

  // ── The packs ──
  const iconsRead = parseBoardPack(
    pack("icons", {
      ic_cond_poisoned: [{ sheet: "s1", x: 0, y: 0 }],
      ic_item_longsword: [{ sheet: "s1", x: 1, y: 0 }],
      ic_spells_fireball: [{ sheet: "s1", x: 2, y: 0 }],
      ic_teapot: [{ sheet: "s1", x: 3, y: 0 }],
      icon_wrong: [{ sheet: "s1", x: 4, y: 0 }],
    }),
  );
  assert.ok(iconsRead.ok, iconsRead.ok ? "" : iconsRead.issues.join("; "));
  const icons = iconsRead.pack as BoardPack;
  assert.deepEqual(Object.keys(icons.tiles).sort(), [
    "ic_cond_poisoned",
    "ic_item_longsword",
    "ic_spells_fireball",
    "ic_teapot",
  ]);
  assert.deepEqual(iconsRead.notes, ['"icon_wrong" is not a tile a board draws, so it was left out.']);
  // A bust is two cells by two: 96 px at 48 px cells.
  const portraitsRead = parseBoardPack(
    pack("portraits", {
      pt_brenna_hale: [{ sheet: "s1", x: 0, y: 0, w: 2, h: 2 }],
      "pt_brenna_hale@happy": [{ sheet: "s1", x: 2, y: 0, w: 2, h: 2 }],
      "pt_brenna_hale@Happy": [{ sheet: "s1", x: 4, y: 0, w: 2, h: 2 }],
    }),
  );
  assert.ok(portraitsRead.ok, portraitsRead.ok ? "" : portraitsRead.issues.join("; "));
  const portraits = portraitsRead.pack as BoardPack;
  assert.deepEqual(Object.keys(portraits.tiles).sort(), ["pt_brenna_hale", "pt_brenna_hale@happy"]);
  assert.equal(parseBoardPack({ ...pack("icons", {}), environment: "faces" }).ok, false);

  // ── The names ──
  assert.equal(artIconFor({ condition: "poisoned" }), "ic_cond_poisoned");
  assert.equal(artIconFor({ condition: "rime-held" }), "ic_cond_rime_held");
  assert.equal(artIconFor({ catalog: "items", entry: "longsword", item: true }), "ic_item_longsword");
  assert.equal(artIconFor({ catalog: "spells", entry: "fireball" }), "ic_spells_fireball");
  assert.equal(artIconFor({ item: "The Hymnal of Fennick" }), "ic_item_hymnal_of_fennick");
  assert.equal(artIconFor({ item: "!!!" }), null);
  assert.equal(artPortraitFor("Brenna Hale"), "pt_brenna_hale");
  assert.equal(artPortraitFor("Brenna Hale", "Happy"), "pt_brenna_hale@happy");
  assert.equal(artPortraitFor("Brenna Hale", "neutral"), "pt_brenna_hale", "neutral is the bust itself");
  assert.equal(artPortraitFor("???"), null);

  // ── What is drawn ──
  assert.deepEqual(artPackSlice(icons, ["ic_cond_poisoned"])?.x, 0);
  assert.equal(artPackSlice(icons, [null, "ic_missing", "ic_item_longsword"])?.x, 48, "the first the pack has");
  assert.equal(artPackSlice(icons, ["ic_missing"]), null, "none: today's look");
  assert.equal(artPackSlice(null, ["ic_cond_poisoned"]), null, "no pack: today's look");
  const happy = artPackSlice(portraits, [artPortraitFor("Brenna Hale", "happy")]);
  assert.deepEqual([happy?.x, happy?.w, happy?.h], [96, 96, 96]);
  assert.equal(
    artPackSlice(portraits, [artPortraitFor("Brenna Hale", "angry")])?.x,
    0,
    "an expression the pack lacks: the neutral bust",
  );

  // ── A ruleset's own icons first ──
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const withIcons = (edit: (doc: Record<string, any>) => void = () => {}) => {
    const doc = JSON.parse(fiveEText);
    const condition = doc.sheet.live.conditions[0];
    condition.icon = "ic_skull";
    const catalog = doc.catalogs.find((one: { entries?: unknown[] }) => one.entries?.length);
    catalog.entries[0].icon = "ic_star";
    edit(doc);
    return doc;
  };
  const read = parseRulesetDefinition(withIcons());
  assert.ok(read.ok, read.ok ? "" : read.issues.join("; "));
  const definition = read.definition;
  const condition = definition.sheet.live.conditions[0]!;
  assert.deepEqual(rulesetConditionIcons(definition, condition.id), [
    "ic_skull",
    artIconFor({ condition: condition.id }),
  ]);
  const second = definition.sheet.live.conditions[1]!;
  assert.deepEqual(rulesetConditionIcons(definition, second.id), [artIconFor({ condition: second.id })]);
  const catalog = definition.catalogs!.find((one) => one.entries?.length)!;
  const ref = `${catalog.id}/${catalog.entries![0]!.id}`;
  assert.equal(rulesetEntryIcons(definition, ref)[0], "ic_star");
  assert.equal(rulesetEntryIcons(definition, ref).length, 2);
  assert.deepEqual(rulesetEntryIcons(definition, undefined), []);
  assert.deepEqual(rulesetItemIcons(null, { name: "Pell's Teapot" }), ["ic_item_pell_s_teapot"]);
  assert.equal(rulesetItemIcons(definition, { item: ref, name: "Thing" })[0], "ic_star");
  // Refused: not an ic_ id.
  assert.equal(parseRulesetDefinition(withIcons((doc) => (doc.sheet.live.conditions[0].icon = "skull"))).ok, false);

  // ── The library serves them ──
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameBoardPacksRoutes, { prefix: "/api/game-tile-packs/boards" });
  try {
    const art = async (kind: string) =>
      app.inject({ method: "GET", url: `/api/game-tile-packs/boards/art?kind=${kind}` });
    assert.equal((await art("icons")).json().pack, null, "none stored, none built in");
    for (const body of [pack("icons", icons.tiles), pack("portraits", portraits.tiles)]) {
      const saved = await app.inject({ method: "POST", url: "/api/game-tile-packs/boards", payload: { pack: body } });
      assert.equal(saved.statusCode, 200, saved.body);
    }
    assert.equal((await art("icons")).json().pack?.id, "local/icons");
    assert.equal((await art("portraits")).json().pack?.id, "local/portraits");
    assert.ok((await art("faces")).statusCode >= 400, "no such kind");
  } finally {
    await app.close();
    await closeDB();
  }

  // ── The gate ──
  const gate =
    "A ruleset with an icon on a catalog entry or a condition requires schemaVersion 2 and capabilityApi 1.338 or newer";
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
  assert.equal(getCapabilityPackageInstallIssue(manifest(337) as never, withIcons()), gate);
  assert.notEqual(getCapabilityPackageInstallIssue(manifest(338) as never, withIcons()), gate);
  assert.notEqual(getCapabilityPackageInstallIssue(manifest(337) as never, JSON.parse(fiveEText)), gate);
  // An icon in a catalog file asks for 1.338 as well.
  const iconFile = new Map([
    ["catalogs/spells.json", { id: "spells", entries: [{ id: "cloud", icon: "ic_poison_cloud" }] }],
  ]);
  assert.equal(getCapabilityPackageInstallIssue(manifest(337) as never, JSON.parse(fiveEText), iconFile), gate);
  assert.notEqual(getCapabilityPackageInstallIssue(manifest(338) as never, JSON.parse(fiveEText), iconFile), gate);

  console.log("Art icons and portraits: icon and portrait packs, derived names, a ruleset's own icons, the gate.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
