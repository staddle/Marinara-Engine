/**
 * Kit and world share files (worldgen W9d).
 *
 *   - A setting kit file and a world file (its kit, seed, brief and hand edits) read back as written.
 *   - Read strictly: not JSON, another format, a newer version, a kit or brief that does not read, a world
 *     from another generator, a file too large are refused with the reason. What of the brief the kit no
 *     longer fits, and hand edits that do not fit the world, are left out with a note.
 *   - A game's world downloads as a world file, hand edits and all.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_SHARE_FILE_MAX_BYTES,
  WORLD_STARTER_KITS,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  WORLD_FILE_VERSION,
  readWorldFile,
  readWorldKitFile,
  worldFile,
  worldKitFile,
  type WorldEdits,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-share-files-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");

const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
assert.ok(parsed.ok);
const kit = parsed.kit;
const settlementLayer = kit.layers.find((layer) => layer.settlements)!;
const checked = checkWorldBrief(kit, {
  briefVersion: 1,
  premise: "A river kingdom",
  places: [{ name: "Ashford", layer: settlementLayer.id, size: kit.sizes.at(-1)!.id, tags: [] }],
});
assert.ok(checked.ok);
const world = {
  seed: 77,
  generatorVersion: WORLD_GENERATOR_VERSION,
  grounding: "expand" as const,
  brief: checked.brief,
};
const compiled = compileGameWorld({ kit, ...world });
const ashford = compiled.places.find((place) => place.name === "Ashford")!;
const edits: WorldEdits = { editsVersion: 1, places: [{ id: ashford.id, name: "Newhaven" }] };
const text = (value: unknown) => JSON.stringify(value);

try {
  // ── Read back as written ──
  const kitRead = readWorldKitFile(text(worldKitFile(kit)));
  assert.ok(kitRead.ok);
  assert.deepEqual(kitRead.kit, kit);
  const worldRead = readWorldFile(text(worldFile("The river kingdom", kit, { ...world, edits })));
  assert.ok(worldRead.ok, JSON.stringify(worldRead));
  assert.deepEqual([worldRead.name, worldRead.kit, worldRead.world], ["The river kingdom", kit, { ...world, edits }]);
  assert.deepEqual(worldRead.notes, []);

  // ── Refused with the reason ──
  const refused = (read: { ok: boolean; issues?: string[] }) => (read.ok ? "" : read.issues![0]!);
  assert.match(refused(readWorldFile("{nope")), /not JSON/);
  assert.match(refused(readWorldFile(text(worldKitFile(kit)))), /setting kit file, not a world file/);
  assert.match(refused(readWorldKitFile(text(worldFile("x", kit, world)))), /world file, not a setting kit file/);
  assert.match(refused(readWorldFile(text({ format: "something" }))), /not a setting kit or world file/);
  assert.match(
    refused(readWorldFile(text({ ...worldFile("x", kit, world), version: WORLD_FILE_VERSION + 1 }))),
    /newer version/,
  );
  assert.match(refused(readWorldKitFile(text({ ...worldKitFile(kit), kit: { ...kit, layers: [] } }))), /layers/);
  assert.match(
    refused(readWorldFile(text(worldFile("x", kit, { ...world, generatorVersion: WORLD_GENERATOR_VERSION + 1 })))),
    /another version of the generator/,
  );
  assert.match(refused(readWorldFile(text({ ...worldFile("x", kit, world), world: { seed: "x" } }))), /^world\./);
  assert.match(refused(readWorldFile(" ".repeat(WORLD_SHARE_FILE_MAX_BYTES + 1))), /larger/);

  // ── Left out with a note ──
  const unfit = readWorldFile(
    text(worldFile("x", kit, { ...world, edits: { editsVersion: 1, places: [{ id: "p9999", name: "X" }] } })),
  );
  assert.ok(unfit.ok);
  assert.equal(unfit.world.edits, undefined, "hand edits that do not fit are left out");
  assert.match(unfit.notes[0]!, /hand edits do not fit/);
  const repaired = readWorldFile(
    text(
      worldFile("x", kit, {
        ...world,
        brief: { ...world.brief, places: [...world.brief.places, { name: "Nowhere", layer: "galaxy", tags: [] }] },
      }),
    ),
  );
  assert.ok(repaired.ok);
  assert.ok(!repaired.world.brief.places.some((place) => place.name === "Nowhere"));
  assert.ok(
    repaired.notes.some((note) => note.includes("Nowhere")),
    "what of the brief the kit does not fit is noted",
  );
  // Hand edits left out are said first, whatever else the brief needed.
  const both = readWorldFile(
    text(
      worldFile("x", kit, {
        ...world,
        brief: {
          ...world.brief,
          places: [
            ...world.brief.places,
            ...["Nowhere", "Elsewhere", "Neverland"].map((name) => ({ name, layer: "galaxy", tags: [] })),
          ],
        },
        edits: { editsVersion: 1, places: [{ id: "p9999", name: "X" }] },
      }),
    ),
  );
  assert.ok(both.ok && both.notes.length >= 4);
  assert.match(both.notes[0]!, /hand edits do not fit/);

  // ── A game's world downloads as a world file ──
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  try {
    const chats = createChatsStorage(db);
    const chat = await chats.create({ name: "River kingdom", mode: "game", characterIds: [] });
    await chats.patchMetadata(chat.id, { gameWorldKit: kit, gameWorld: { ...world, edits } });
    const downloaded = await app.inject({ method: "GET", url: `/api/game/${chat.id}/world/file` });
    assert.equal(downloaded.statusCode, 200, downloaded.body);
    const read = readWorldFile(downloaded.body);
    assert.ok(read.ok);
    assert.deepEqual([read.name, read.kit, read.world], ["River kingdom", kit, { ...world, edits }]);
    const plain = await chats.create({ name: "No world", mode: "game", characterIds: [] });
    assert.equal((await app.inject({ method: "GET", url: `/api/game/${plain.id}/world/file` })).statusCode, 404);

    // ── Kits for a maker: listed, fetched, checked into a file, read from one ──
    const kits = (await app.inject({ method: "GET", url: "/api/game/world-kits" })).json();
    assert.equal(kits.starters.length, WORLD_STARTER_KITS.length);
    assert.deepEqual(kits.games, [{ chatId: chat.id, name: "River kingdom", label: kit.label }]);
    const starter = await app.inject({ method: "GET", url: "/api/game/world-kits/starter/high_fantasy" });
    assert.deepEqual(starter.json().kit, kit);
    assert.equal((await app.inject({ method: "GET", url: "/api/game/world-kits/starter/nope" })).statusCode, 404);
    assert.deepEqual((await app.inject({ method: "GET", url: `/api/game/${chat.id}/world-kit` })).json().kit, kit);
    assert.equal((await app.inject({ method: "GET", url: `/api/game/${plain.id}/world-kit` })).statusCode, 404);
    const mine = { ...kit, id: "river_kit", label: "River kit" };
    const checkedKit = await app.inject({ method: "POST", url: "/api/game/world-kits/check", payload: { kit: mine } });
    assert.equal(checkedKit.statusCode, 200, checkedKit.body);
    const asFile = readWorldKitFile(JSON.stringify(checkedKit.json().file));
    assert.ok(asFile.ok && asFile.kit.label === "River kit", "the file the check writes reads back");
    const broken = await app.inject({
      method: "POST",
      url: "/api/game/world-kits/check",
      payload: { kit: { ...kit, layers: kit.layers.map((layer) => ({ id: layer.id, label: layer.label })) } },
    });
    assert.equal(broken.statusCode, 400);
    assert.match(broken.json().issues.join(" "), /settlements/);
    const readBack = await app.inject({
      method: "POST",
      url: "/api/game/world-kits/read",
      payload: { text: JSON.stringify(worldKitFile(mine)) },
    });
    assert.equal(readBack.json().kit.id, "river_kit");
    const unread = await app.inject({ method: "POST", url: "/api/game/world-kits/read", payload: { text: "{" } });
    assert.equal(unread.statusCode, 400);
    assert.match(unread.json().error, /not JSON/);
  } finally {
    await app.close();
    await closeDB();
  }
  console.log("World share files: kits and worlds read back as written, refused or noted when they do not fit.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
