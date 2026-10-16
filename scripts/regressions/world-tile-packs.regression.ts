/**
 * Tile packs (worldgen W9a).
 *
 *   - A pack is a palette and every tile as sixteen rows of sixteen characters; a pixel outside the
 *     palette, a row the wrong length or a palette too big is refused; a tile the Engine does not draw
 *     is left out and noted. Pixels decode to the palette's colours, "." to clear.
 *   - The Engine serves each family's own pack; packs saved from the maker or imported from a file are
 *     filed under `local/`, a version is never rewritten (the same bytes again are unchanged, different
 *     ones a conflict), the latest version is the one served, and a family can be drawn with one.
 *   - Removing a pack sends any family drawn with it back to its own.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TILE_PACK_ALPHABET, parseTilePack, tilePackPixels, type TilePack } from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-tile-packs-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameTilePacksRoutes } = await import("../../packages/server/src/routes/game-tile-packs.routes.js");

const rows = (char: string) => Array.from({ length: 16 }, () => char.repeat(16));
const pack = (extra: Partial<TilePack> = {}): TilePack => ({
  tilePackVersion: 1,
  id: "my-meadows",
  name: "My meadows",
  family: "fantasy",
  version: 1,
  palette: ["#336633", "#00000080"],
  tiles: { grass: [rows("0"), rows("1")], party: [[".".repeat(16), ...rows("0").slice(1)]] },
  ...extra,
});

try {
  // ── The format ──
  const good = parseTilePack(pack());
  assert.ok(good.ok);
  assert.deepEqual(good.notes, []);
  assert.ok(
    !parseTilePack({ ...pack(), tiles: { grass: [["0".repeat(15), ...rows("0").slice(1)]] } }).ok,
    "a short row",
  );
  const outside = parseTilePack({ ...pack(), tiles: { grass: [rows("2")] } });
  assert.ok(!outside.ok && outside.issues[0]!.includes('"2" is not in the palette'), "a pixel outside the palette");
  assert.ok(
    !parseTilePack({ ...pack(), palette: Array.from({ length: TILE_PACK_ALPHABET.length + 1 }, () => "#000000") }).ok,
    "a palette too big",
  );
  assert.ok(!parseTilePack({ ...pack(), palette: ["red"] }).ok, "a colour is #rrggbb or #rrggbbaa");
  assert.ok(!parseTilePack("{not json").ok, "not JSON");
  const extra = parseTilePack({ ...pack(), tiles: { ...pack().tiles, dragon: [rows("0")] } });
  assert.ok(extra.ok && !("dragon" in extra.pack.tiles) && extra.notes[0]!.includes('"dragon"'), "an unknown tile");
  const pixels = tilePackPixels(pack(), pack().tiles.party![0]!);
  assert.deepEqual([...pixels.slice(0, 4)], [0, 0, 0, 0], "a clear pixel");
  assert.deepEqual([...pixels.slice(16 * 4, 16 * 4 + 4)], [0x33, 0x66, 0x33, 255], "the palette's colour");
  assert.deepEqual([...tilePackPixels(pack(), rows("1")).slice(0, 4)], [0, 0, 0, 0x80], "with its alpha");

  // ── The library ──
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameTilePacksRoutes, { prefix: "/api/game-tile-packs" });
  try {
    const library = async () => (await app.inject({ method: "GET", url: "/api/game-tile-packs" })).json();
    const empty = await library();
    assert.deepEqual(empty.packs, []);
    assert.ok(empty.builtIn.includes("wuxia"), "each family has its own pack");
    const own = await app.inject({ method: "GET", url: "/api/game-tile-packs/builtin/wuxia" });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().pack.family, "wuxia");
    assert.equal((await app.inject({ method: "GET", url: "/api/game-tile-packs/builtin/noir" })).statusCode, 404);

    // Saved from the maker: filed under local/; the same again is unchanged; other tiles under the same
    // version a conflict; a new version is the one served.
    const save = (body: TilePack) =>
      app.inject({ method: "POST", url: "/api/game-tile-packs", payload: { pack: body } });
    const saved = await save(pack());
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual([saved.json().status, saved.json().pack.id], ["added", "local/my-meadows"]);
    assert.equal((await save(pack())).json().status, "unchanged");
    assert.equal((await save(pack({ tiles: { grass: [rows("1")] } }))).statusCode, 409, "a version is never rewritten");
    assert.equal((await save(pack({ version: 2, tiles: { grass: [rows("1")] } }))).json().status, "added");
    const served = await app.inject({ method: "GET", url: "/api/game-tile-packs/pack?id=local/my-meadows" });
    assert.equal(served.json().pack.version, 2, "the latest version");
    assert.equal(
      (await library()).packs.find((listed: { id: string }) => listed.id === "local/my-meadows")?.version,
      2,
      "the library lists the latest version",
    );
    assert.deepEqual(served.json().pack.tiles.grass, [rows("1")]);
    assert.equal(
      (await save({ ...pack(), palette: ["nope"] } as TilePack)).statusCode,
      400,
      "a pack that does not read",
    );

    // Imported from a file, filed under local/.
    const file = JSON.stringify(pack({ id: "shared-pack", name: "Shared" }), null, 2);
    const imported = await app.inject({
      method: "POST",
      url: "/api/game-tile-packs/import",
      payload: { definition: file },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().pack.id, "local/shared-pack");
    assert.equal((await library()).packs.length, 2);
    // The same file again is unchanged, and so is the same pack saved back from the maker.
    const again = await app.inject({
      method: "POST",
      url: "/api/game-tile-packs/import",
      payload: { definition: file },
    });
    assert.equal(again.json().status, "unchanged");
    const readBack = (await app.inject({ method: "GET", url: "/api/game-tile-packs/pack?id=local/shared-pack" })).json()
      .pack;
    assert.equal((await save(readBack)).json().status, "unchanged", "saved back as it was read");
    // An id too long to file under local/ is refused, never cut short into another pack's.
    assert.equal((await save(pack({ id: "a".repeat(78) }))).statusCode, 400);
    // A save larger than a share file can be is refused, as an import of it is.
    const oversized = pack({
      id: "oversized",
      tiles: Object.fromEntries(
        Array.from({ length: 500 }, (_, at) => [`extra${at}`, Array.from({ length: 8 }, () => rows("0"))]),
      ),
    });
    assert.ok(JSON.stringify(oversized).length > 1_000_000, "(larger than a share file)");
    assert.equal((await save(oversized)).statusCode, 413);
    const oversizedFile = await app.inject({
      method: "POST",
      url: "/api/game-tile-packs/import",
      payload: { definition: JSON.stringify(oversized) },
    });
    assert.equal(oversizedFile.statusCode, 400);

    // A family drawn with a stored pack, and back to its own when the pack is removed.
    const choose = (packId: string | null) =>
      app.inject({ method: "PUT", url: "/api/game-tile-packs/selection", payload: { family: "fantasy", packId } });
    assert.equal((await choose("local/nothing")).statusCode, 404, "only a stored pack");
    const elsewhere = await app.inject({
      method: "PUT",
      url: "/api/game-tile-packs/selection",
      payload: { family: "wuxia", packId: "local/shared-pack" },
    });
    assert.equal(elsewhere.statusCode, 400, "only for its own family");
    assert.deepEqual((await choose("local/shared-pack")).json().selection, { fantasy: "local/shared-pack" });
    assert.deepEqual((await library()).selection, { fantasy: "local/shared-pack" });
    const removed = await app.inject({ method: "DELETE", url: "/api/game-tile-packs?id=local/shared-pack" });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual((await library()).selection, {}, "back to its own");
    assert.equal(
      (await app.inject({ method: "DELETE", url: "/api/game-tile-packs?id=local/shared-pack" })).statusCode,
      404,
    );
    assert.deepEqual((await choose(null)).json().selection, {});
  } finally {
    await app.close();
    await closeDB();
  }
  console.log("World tile packs: packs read strictly, and the library keeps, serves and chooses them.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
