/**
 * Sites in generated worlds (generator 2; design-game-overworld-sites.md): a new world has caves, ruins
 * and crypts a few steps out of its settlements, up to two a region, in every starter kit (wuxia's towns
 * gained a ward layer for them). A version 1 recipe is made again exactly as before, with none, and stays
 * readable and editable; a version this Engine does not know is refused.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  checkWorldBrief,
  compileWorld,
  dungeonSetForPlace,
  gameWorldFromMetadata,
  parseWorldKit,
  worldGeneratorReads,
  worldIsSite,
  worldKitArtFamily,
  worldSites,
  worldSnapshot,
  type GameWorld,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-generated-sites-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.MARINARA_LITE = "true";
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");

const briefOf = (kit: ReturnType<typeof parseWorldKit> & { ok: true }) =>
  checkWorldBrief(kit.kit, {
    briefVersion: 1,
    premise: "x",
    placeNames: kit.kit.cultures.map((culture) => ({
      culture: culture.id,
      names: [
        "Ashby",
        "Wending",
        "Calder",
        "Ravel",
        "Brennock",
        "Sallow",
        "Merrow",
        "Tarn",
        "Hale",
        "Oakes",
        "Vell",
        "Corbin",
      ],
    })),
    peopleNames: kit.kit.cultures.map((culture) => ({
      culture: culture.id,
      given: ["Ama", "Tobin", "Hesk", "Mira", "Oswin", "Bryn", "Calla", "Doran"],
      family: ["Holt", "Drey", "Marrow", "Vane"],
      order: "given-family" as const,
    })),
  });

try {
  assert.equal(WORLD_GENERATOR_VERSION, 2);
  assert.ok(worldGeneratorReads(1) && worldGeneratorReads(2) && !worldGeneratorReads(3) && !worldGeneratorReads("2"));

  for (const starter of WORLD_STARTER_KITS) {
    const parsed = parseWorldKit(starter);
    assert.ok(parsed.ok);
    const checked = briefOf(parsed);
    assert.ok(checked.ok, starter.id);
    const kit = parsed.kit;
    for (const seed of [21, 4242]) {
      const label = `${starter.id} ${seed}`;
      const v1 = compileWorld({ seed, kit, brief: checked.brief, generatorVersion: 1 });
      const v2 = compileWorld({ seed, kit, brief: checked.brief });
      assert.equal(v1.generatorVersion, 1);
      assert.equal(v2.generatorVersion, 2);
      // Version 2 is version 1 with sites after it: nothing else moves.
      assert.deepEqual(
        { ...v2, generatorVersion: 1, places: v2.places.slice(0, v1.places.length) },
        v1,
        `${label}: the rest of the world as version 1 made it`,
      );
      assert.deepEqual(
        compileWorld({ seed, kit, brief: checked.brief }),
        v2,
        `${label}: the same seed, the same sites`,
      );
      const game: GameWorld = { kit, seed, grounding: "expand", brief: checked.brief, world: v2 };
      const added = v2.places.slice(v1.places.length);
      assert.ok(added.length >= 1, `${label}: a new world has sites`);
      assert.deepEqual(
        worldSites(game).map((place) => place.id),
        added.map((place) => place.id),
        `${label}: every generated site is a site, and nothing else became one`,
      );
      assert.equal(worldSites({ ...game, world: v1, generatorVersion: 1 }).length, 0, `${label}: version 1 has none`);
      // A version 1 world's own place a few steps out of town, named like one to go into, stays a building
      // in its town: only generator 2 reads sites from names.
      const named = { ...v1, places: [...v1.places, added[0]!] };
      assert.equal(
        worldIsSite({ ...game, world: named, generatorVersion: 1 }, added[0]!.id),
        false,
        `${label}: not by name in version 1`,
      );
      const family = worldKitArtFamily(kit);
      const names = new Set(v2.places.map((place) => place.name.toLowerCase()));
      assert.equal(names.size, v2.places.length, `${label}: names stay unique`);
      const regions = new Map<string | null, number>();
      for (const site of added) {
        const settlement = v2.places.find((place) => place.id === site.parentId)!;
        assert.equal(settlement.rank !== undefined, true, `${label}: beside a settlement`);
        assert.equal(site.depth, settlement.depth + 1);
        const far = Math.max(Math.abs(site.at.x - settlement.at.x), Math.abs(site.at.y - settlement.at.y));
        assert.ok(far >= 2 && far <= 4, `${label}: ${site.name} a few steps out`);
        assert.ok(
          !v2.places.some((place) => place !== site && place.at.x === site.at.x && place.at.y === site.at.y),
          `${label}: a cell of its own`,
        );
        assert.ok(dungeonSetForPlace(site, family), `${label}: ${site.name} reads as a place to go into`);
        assert.ok(worldIsSite(game, site.id));
        regions.set(settlement.parentId, (regions.get(settlement.parentId) ?? 0) + 1);
      }
      assert.ok(
        [...regions.values()].every((count) => count <= 2),
        `${label}: at most two a region`,
      );
    }
  }

  // A site never takes a name the world has: a brief naming "Bayside Caves", "Bayside Ruins" and "Bayside
  // Tunnels" in its city leaves the generator to skip one there, never to repeat it.
  {
    const parsed = parseWorldKit(WORLD_STARTER_KITS.find((kit) => kit.id === "modern_day")!);
    assert.ok(parsed.ok);
    const [, , city, inner] = parsed.kit.layers.map((layer) => layer.id);
    const brief = checkWorldBrief(parsed.kit, {
      briefVersion: 1,
      premise: "x",
      places: [
        { name: "Bayside", layer: city!, tags: [] },
        ...["Caves", "Ruins", "Tunnels"].map((word) => ({
          name: `Bayside ${word}`,
          layer: inner!,
          parent: "Bayside",
          tags: [],
        })),
      ],
    });
    assert.ok(brief.ok, JSON.stringify(!brief.ok && brief.issues));
    let beside = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const world = compileWorld({ seed, kit: parsed.kit, brief: brief.brief });
      const v1 = compileWorld({ seed, kit: parsed.kit, brief: brief.brief, generatorVersion: 1 });
      const names = world.places.map((place) => place.name.toLowerCase());
      assert.equal(new Set(names).size, names.length, `seed ${seed}: names stay unique`);
      const bayside = world.places.find((place) => place.name === "Bayside")!;
      if (world.places.slice(v1.places.length).some((site) => site.parentId === bayside.id)) beside++;
    }
    // Bayside's own names taken, a site the generator would have put beside it is skipped.
    assert.equal(beside, 0, "no site beside Bayside: every name it could take is the brief's");
  }

  // Wuxia's ward layer changes nothing a version 1 recipe made with the kit as it was.
  const wuxia = parseWorldKit(WORLD_STARTER_KITS.find((kit) => kit.id === "wuxia_xianxia")!);
  assert.ok(wuxia.ok);
  const before = { ...wuxia.kit, layers: wuxia.kit.layers.filter((layer) => layer.id !== "ward") };
  const wuxiaBrief = briefOf(wuxia);
  assert.ok(wuxiaBrief.ok);
  assert.deepEqual(
    compileWorld({ seed: 21, kit: wuxia.kit, brief: wuxiaBrief.brief, generatorVersion: 1 }),
    compileWorld({ seed: 21, kit: before, brief: wuxiaBrief.brief, generatorVersion: 1 }),
    "the old wuxia kit and the new make the same version 1 world",
  );

  // ── A game made on version 1: read, edited and kept as version 1, with no sites ──
  const fantasy = parseWorldKit(WORLD_STARTER_KITS.find((kit) => kit.id === "high_fantasy")!);
  assert.ok(fantasy.ok);
  const fantasyBrief = briefOf(fantasy);
  assert.ok(fantasyBrief.ok);
  const recipe = (version: number) => ({
    gameWorldKit: fantasy.kit,
    gameWorld: { seed: 21, generatorVersion: version, grounding: "expand", brief: fantasyBrief.brief },
  });
  const old = gameWorldFromMetadata(recipe(1))!;
  assert.ok(old, "a version 1 recipe still reads");
  assert.equal(old.world.generatorVersion, 1);
  assert.equal(worldSites(old).length, 0, "with no sites");
  assert.equal(worldSnapshot(old).generatorVersion, 1, "and its snapshot says version 1");
  assert.ok(worldSites(gameWorldFromMetadata(recipe(2))!).length > 0, "a version 2 recipe has them");
  assert.equal(gameWorldFromMetadata(recipe(3)), null, "a version this Engine does not know is refused");

  // A version 1 world read in a new game's setup (a world file, a setup file, a library world, a map
  // pack) is made again as version 1; a new seed or brief makes a version 2 world.
  {
    const { worldDraftFromWorld, worldDraftConfig } =
      await import("../../packages/client/src/components/game/GameSetupWorldChooser.tsx");
    const draft = worldDraftFromWorld({
      seed: 21,
      generatorVersion: 1,
      grounding: "expand",
      brief: fantasyBrief.brief,
    });
    const kept = worldDraftConfig(fantasy.kit, draft);
    assert.ok(kept.ok);
    assert.equal(kept.world.generatorVersion, 1, "the setup keeps the world's version");
    const reseeded = worldDraftConfig(fantasy.kit, { ...draft, seed: "22" });
    assert.ok(reseeded.ok);
    assert.equal(reseeded.world.generatorVersion, WORLD_GENERATOR_VERSION, "a new seed is a new world");
    const unknown = worldDraftConfig(
      { ...fantasy.kit, label: "Other kit" },
      worldDraftFromWorld({ seed: 21, generatorVersion: 99, grounding: "expand", brief: fantasyBrief.brief }),
    );
    assert.ok(unknown.ok);
    assert.equal(unknown.world.generatorVersion, WORLD_GENERATOR_VERSION, "never a version this Engine does not make");
    const fresh = worldDraftConfig(fantasy.kit, worldDraftFromWorld({ seed: 21, brief: fantasyBrief.brief }));
    assert.ok(fresh.ok);
    assert.equal(fresh.world.generatorVersion, WORLD_GENERATOR_VERSION);
  }

  // A map pack's world is its version too: the same seed and brief on version 2 is not its map.
  {
    const { mapPackLockIssue } = await import("../../packages/server/src/services/game/map-pack.service.js");
    const shipped = { seed: 21, generatorVersion: 1, grounding: "expand" as const, brief: fantasyBrief.brief };
    const pack = {
      packageId: "p",
      name: "Old Maps",
      kit: fantasy.kit,
      worlds: [{ world: shipped }],
      tiles: [],
    } as never;
    assert.equal(mapPackLockIssue(pack, { worldKit: fantasy.kit, world: shipped }), null, "its own world");
    assert.match(
      mapPackLockIssue(pack, { worldKit: fantasy.kit, world: { ...shipped, generatorVersion: 2 } }) ?? "",
      /sets the game's world to one of its own maps/u,
      "not the same seed made by another version",
    );
  }

  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  try {
    const chats = createChatsStorage(db);
    const chat = await chats.create({ name: "Old world", mode: "game", characterIds: [] });
    await chats.patchMetadata(chat.id, { gameId: `old-${chat.id}`, gameSessionStatus: "active", ...recipe(1) });
    const read = async () => (await app.inject({ method: "GET", url: `/api/game/${chat.id}/world` })).json().world;
    assert.equal(worldSites(await read()).length, 0, "the game plays on with no sites");
    const city = old.world.places.find((place) => place.rank !== undefined)!;
    const edited = await app.inject({
      method: "PUT",
      url: `/api/game/${chat.id}/world/edits`,
      payload: { edits: { editsVersion: 1, places: [{ id: city.id, name: "New Ashby" }] } },
    });
    assert.equal(edited.statusCode, 200, `a version 1 world is still edited: ${edited.body}`);
    const after = await read();
    assert.ok(after.world.places.some((place: { name: string }) => place.name === "New Ashby"));
    assert.equal(worldSites(after).length, 0, "and stays without sites");
    assert.equal(after.world.places.length, old.world.places.length);
  } finally {
    await app.close();
    await closeDB();
  }

  console.log("Generated sites: new worlds have caves, ruins and crypts; version 1 worlds are made as before.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
