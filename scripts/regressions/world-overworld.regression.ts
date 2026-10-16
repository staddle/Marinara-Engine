/**
 * The overworld's walks and clock (worldgen W8).
 *
 *   - Each kind of ground has a look by the words in its id, else by its kind.
 *   - A walk goes along the world's ways by the cheapest route, from the settlement of the place in
 *     force, and passes its days on the game's clock at once; a second walk before a turn extends it.
 *   - The next turn tells it: the Game Master is told, the reply carries its days and where it ended, so
 *     the world steps and the party is there; it stays with the reply for a regeneration.
 *   - Days the Game Master's own telling passes move the clock on a new turn, not on a regeneration.
 *   - The overworld's real time passes minutes on the clock.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORLD_ART_FAMILIES,
  WORLD_DAYS_CAP,
  WORLD_GENERATOR_VERSION,
  WORLD_IMAGE_ONLY_TILE_IDS,
  WORLD_TILE_IDS,
  parseTilePack,
  WORLD_STARTER_KITS,
  checkWorldBrief,
  compileGameWorld,
  createConnectionSchema,
  parseWorldKit,
  readWorldLedger,
  worldGroundCells,
  worldGroundLooks,
  worldOverworldHere,
  worldPresent,
  worldRoute,
  worldSetOutFrom,
  worldTerrainLook,
  WORLD_GROUND_LOOK_FALLBACK,
  worldWalkJoined,
  worldWalkTags,
  worldWalkText,
  worldKitArtFamily,
  type GameWorld,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-overworld-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
// No local embedding model: memory recall would download one in the background after each turn, and the
// process would wait for that download (or its timeout) before exiting.
process.env.MARINARA_LITE = "true";
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");

const gameOf = (id: string, seed: number): GameWorld => {
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === id)!);
  assert.ok(parsed.ok);
  const kit = parsed.kit;
  const checked = checkWorldBrief(kit, {
    briefVersion: 1,
    premise: "x",
    peopleNames: kit.cultures.map((culture) => ({
      culture: culture.id,
      given: ["Ama", "Tobin", "Hesk", "Mira", "Oswin", "Bryn", "Calla", "Doran"],
      family: ["Holt", "Drey", "Marrow", "Vane"],
      order: "given-family" as const,
    })),
  });
  assert.ok(checked.ok);
  const inputs = { kit, seed, grounding: "expand" as const, brief: checked.brief };
  return { ...inputs, world: compileGameWorld(inputs) };
};

try {
  // ── Looks ──
  const looks = Object.fromEntries(
    WORLD_STARTER_KITS.flatMap((kit) =>
      (parseWorldKit(kit).ok
        ? ((parseWorldKit(kit) as { ok: true; kit: GameWorld["kit"] }).kit.terrain ?? [])
        : []
      ).map((terrain) => [terrain.id, worldTerrainLook(terrain)]),
    ),
  );
  assert.deepEqual(
    {
      rice_paddies: looks.rice_paddies,
      bamboo_forest: looks.bamboo_forest,
      river_and_lakes: looks.river_and_lakes,
      toxic_lakes: looks.toxic_lakes,
      gravity_well: looks.gravity_well,
      asteroid_field: looks.asteroid_field,
      dead_forest: looks.dead_forest,
      corporate_core: looks.corporate_core,
      industrial_zone: looks.industrial_zone,
      craters: looks.craters,
      mountains: looks.mountains,
      sea: looks.sea,
    },
    {
      rice_paddies: "paddies",
      bamboo_forest: "bamboo",
      river_and_lakes: "lake",
      toxic_lakes: "toxic_water",
      gravity_well: "gravity_well",
      asteroid_field: "asteroids",
      dead_forest: "dead_forest",
      corporate_core: "city",
      industrial_zone: "industry",
      craters: "craters",
      mountains: "mountains",
      sea: "sea",
    },
    "the starter kits' ground, by the words in its ids",
  );
  assert.equal(worldTerrainLook({ id: "entry_3", kind: "water" }), "sea", "no words: by kind");
  assert.equal(worldTerrainLook({ id: "entry_4", kind: "barrier" }), "mountains");
  assert.equal(worldTerrainLook({ id: "entry_5", kind: "open" }), "grass");
  // More forests: conifers for cold regions, jungle, autumn; a plain forest stays a forest.
  assert.equal(worldTerrainLook({ id: "taiga", kind: "open" }), "conifer_forest");
  assert.equal(worldTerrainLook({ id: "pine_woods", kind: "open" }), "conifer_forest");
  assert.equal(worldTerrainLook({ id: "deep_jungle", kind: "open" }), "jungle");
  assert.equal(worldTerrainLook({ id: "autumn_woods", kind: "open" }), "autumn_forest");
  assert.equal(worldTerrainLook({ id: "old_forest", kind: "open" }), "forest");
  assert.equal(worldTerrainLook({ id: "dead_forest", kind: "open" }), "dead_forest");
  assert.equal(worldTerrainLook({ id: "bamboo_forest", kind: "open" }), "bamboo");
  for (const look of ["conifer_forest", "autumn_forest", "jungle"] as const)
    assert.equal(WORLD_GROUND_LOOK_FALLBACK[look], "forest", `${look}: a pack without it draws the forest`);

  // ── Each family's tile pack (W9a): every tile the overworld and the towns draw, as the script draws it ──
  const packOf = (root: string, family: string) =>
    parseTilePack(readFileSync(join(root, `packages/server/src/assets/overworld-tiles/${family}.json`), "utf8"));
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  for (const family of WORLD_ART_FAMILIES) {
    const read = packOf(repo, family);
    assert.ok(read.ok, `${family}: its pack reads`);
    assert.deepEqual(read.notes, [], `${family}: nothing in it the Engine does not draw`);
    for (const id of WORLD_TILE_IDS)
      if (!WORLD_IMAGE_ONLY_TILE_IDS.includes(id)) assert.ok(read.pack.tiles[id]?.length, `${family}: ${id}`);
  }
  for (const kit of WORLD_STARTER_KITS) {
    assert.ok(
      (WORLD_ART_FAMILIES as readonly string[]).includes(worldKitArtFamily(kit) ?? ""),
      `${kit.id}: drawn with its family's tiles`,
    );
  }
  // The committed packs are the script's (change the art there, never in the packs).
  const drawn = mkdtempSync(join(tmpdir(), "marinara-overworld-tiles-"));
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL("../art/build-overworld-tiles.mjs", import.meta.url))], {
      env: { ...process.env, OVERWORLD_TILES_OUT: drawn },
    });
    for (const family of WORLD_ART_FAMILIES) {
      assert.deepEqual(packOf(drawn, family), packOf(repo, family), `${family}: the tiles are the script's`);
    }
  } finally {
    rmSync(drawn, { recursive: true, force: true });
  }

  const game = gameOf("high_fantasy", 21);
  const { world } = game;
  assert.equal(worldGroundLooks(game).length, world.terrain.length);
  assert.equal(worldGroundCells(world).length, world.width * world.height);
  assert.ok(
    [...worldGroundCells(world)].every((cell) => cell < world.terrain.length),
    "every cell is one of the ground classes",
  );

  // ── Where the party sets out from ──
  const settlements = world.places.filter((place) => place.rank !== undefined);
  const start = worldSetOutFrom(game, world.startId)!;
  assert.equal(start.id, world.startId, "the world starts the party in a settlement");
  const inner = world.places.find((place) => place.parentId === start.id);
  if (inner) assert.equal(worldSetOutFrom(game, inner.id)!.id, start.id, "a place inside: its settlement");
  const region = world.places.find((place) => place.depth === 0)!;
  const fromRegion = worldSetOutFrom(game, region.id)!;
  assert.ok(fromRegion.rank !== undefined, "a region: a settlement");
  const regionSettlements = settlements.filter((place) => {
    for (let up: typeof place | undefined = place; up; up = world.places.find((each) => each.id === up!.parentId)) {
      if (up.id === region.id) return true;
    }
    return false;
  });
  const away = (place: (typeof settlements)[number]) => Math.hypot(place.at.x - region.at.x, place.at.y - region.at.y);
  assert.equal(away(fromRegion), Math.min(...regionSettlements.map(away)), "the nearest within it");
  const present = worldPresent(game, []);
  assert.equal(worldOverworldHere(game, present, "Nowhere The World Lists")!.id, world.startId);
  assert.equal(worldOverworldHere(game, present, settlements[3]!.name.toUpperCase())!.id, settlements[3]!.id);

  // ── Routes ──
  assert.equal(worldRoute(world, start.id, start.id), null, "nowhere to walk");
  assert.equal(worldRoute(world, start.id, "p9999"), null);
  const far = settlements
    .map((place) => worldRoute(world, start.id, place.id))
    .filter((route) => route !== null)
    .sort((a, b) => b!.path.length - a!.path.length)[0]!;
  assert.ok(far.path.length >= 3, "a route over more than one way");
  assert.equal(far.path[0], start.id);
  assert.equal(
    far.days,
    Math.round(far.legs.reduce((sum, leg) => sum + leg.days, 0) * 100) / 100,
    "a route's days are its legs'",
  );
  far.legs.forEach((leg, index) => {
    assert.deepEqual([leg.from, leg.to].sort(), [far.path[index]!, far.path[index + 1]!].sort(), "legs join the path");
  });
  // No route is dearer than a straight link it could have taken.
  for (const link of world.links) {
    assert.ok(worldRoute(world, link.from, link.to)!.days <= link.days, "the cheapest way");
  }
  // A long way round that is quicker than the straight road: found, not the first road seen.
  const tri = {
    ...world,
    places: ["a", "b", "c"].map((id, index) => ({ ...world.places[0]!, id, at: { x: index, y: 0 } })),
    links: [
      { from: "a", to: "c", way: "road", days: 10 },
      { from: "a", to: "b", way: "road", days: 1 },
      { from: "b", to: "c", way: "road", days: 1 },
    ],
  };
  assert.deepEqual(
    [worldRoute(tri, "a", "c")!.path, worldRoute(tri, "a", "c")!.days],
    [["a", "b", "c"], 2],
    "the quicker way round",
  );
  const back = worldRoute(world, far.path.at(-1)!, start.id)!;
  assert.equal(back.days, far.days, "the same way back");

  // ── The walk ──
  const firstLeg = worldRoute(world, start.id, far.path[1]!)!;
  const walk = worldWalkJoined(null, firstLeg, "w1");
  assert.deepEqual([walk.from, walk.to, walk.days], [start.id, far.path[1], firstLeg.days]);
  const on = worldWalkJoined(walk, worldRoute(world, far.path[1]!, far.path[2]!)!, "w2");
  assert.equal(on.from, start.id, "a walk taken further keeps where it set out from");
  assert.equal(
    on.days,
    Math.round((walk.days + worldRoute(world, far.path[1]!, far.path[2]!)!.days) * 100) / 100,
    "and adds its days",
  );
  assert.equal(on.to, far.path[2]);
  assert.equal(new Set(on.ways).size, on.ways.length, "each way once");
  assert.match(worldWalkText(game, on), new RegExp(`from ${start.name} to `, "u"));
  assert.match(worldWalkText(game, on), /do not record those days again/);
  assert.match(worldWalkText(game, { ...on, to: on.from }), /out from .* and back/);
  assert.equal(
    worldWalkTags(game, { ...on, days: 0.4 }),
    `[place: name="${world.places.find((p) => p.id === on.to)!.name}"]`,
  );
  const long = worldWalkTags(game, { ...on, days: WORLD_DAYS_CAP + 10.6 });
  assert.deepEqual(
    readWorldLedger([long.replace(/\]/g, ' result="ok"]')]).flatMap((entry) => (entry.days ? [entry.days] : [])),
    [String(WORLD_DAYS_CAP), "11"],
    "a walk past the most one tag passes is told in more than one",
  );

  // ── Through the routes, with a stand-in model ──
  const replies: string[] = [];
  const prompts: string[] = [];
  const standIn = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    prompts.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: replies.shift() ?? "" } }],
      }),
    );
  });
  await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
  const address = standIn.address();
  assert.ok(address && typeof address !== "string");
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  await app.register(generateRoutes, { prefix: "/api/generate" });
  try {
    const connection = await createConnectionsStorage(db).create(
      createConnectionSchema.parse({
        name: "Stand-in",
        provider: "custom",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "stand-in",
        apiKey: "sk-stand-in",
      }),
    );
    const chats = createChatsStorage(db);
    const chat = await chats.create({ name: "Walk", mode: "game", characterIds: [], connectionId: connection!.id });
    const chatId = chat.id;
    await chats.patchMetadata(chatId, {
      gameId: `walk-${chatId}`,
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameWorldKit: game.kit,
      gameWorld: { seed: game.seed, generatorVersion: WORLD_GENERATOR_VERSION, grounding: "expand", brief: game.brief },
      gameTime: { day: 1, hour: 8, minute: 0 },
    });
    await chats.createMessage({ chatId, role: "assistant", content: "The road is quiet." });
    const meta = async () => JSON.parse((await chats.getById(chatId))!.metadata as string) as Record<string, any>;
    const overworld = async () => (await app.inject({ method: "GET", url: `/api/game/${chatId}/overworld` })).json();
    const walkTo = (to: string) =>
      app.inject({ method: "POST", url: `/api/game/${chatId}/overworld/walk`, payload: { to } });
    const turn = async (reply: string, extra: Record<string, unknown> = {}) => {
      replies.push(reply);
      prompts.length = 0;
      const response = await app.inject({
        method: "POST",
        url: "/api/generate/",
        payload: { chatId, userMessage: "We go on.", streaming: false, ...extra },
      });
      assert.equal(response.statusCode, 200, response.body);
    };
    const lastReply = async () => (await chats.listMessages(chatId)).filter((m: any) => m.role === "assistant").at(-1)!;
    const minutesOf = (time: { day: number; hour: number; minute: number }) =>
      time.day * 24 * 60 + time.hour * 60 + time.minute;

    assert.deepEqual((await overworld()).overworld, { here: start.id, walk: null, ruined: [] });
    // A chat that is not a game has no overworld, whatever its metadata says.
    const roleplay = await chats.create({ name: "Not a game", mode: "roleplay", characterIds: [] });
    await chats.patchMetadata(roleplay.id, { gameWorldKit: game.kit, gameWorld: (await meta()).gameWorld });
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/game/${roleplay.id}/overworld` })).json().overworld,
      null,
    );
    const refused = await app.inject({
      method: "POST",
      url: `/api/game/${roleplay.id}/overworld/walk`,
      payload: { to: far.path[1] },
    });
    assert.equal(refused.statusCode, 400);

    // The real time the overworld passes.
    const ticked = await app.inject({ method: "POST", url: "/api/game/time/advance", payload: { chatId, minutes: 7 } });
    assert.equal(ticked.statusCode, 200, ticked.body);
    assert.deepEqual((await meta()).gameTime, { day: 1, hour: 8, minute: 7 });

    // Nowhere to walk to: the same place, or one no way reaches.
    assert.equal((await walkTo(start.id)).statusCode, 400);
    assert.equal((await walkTo("p9999")).statusCode, 400);

    // A walk passes its days at once, and the party is where it walked.
    const before = minutesOf((await meta()).gameTime);
    const first = await walkTo(far.path[1]!);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(
      minutesOf((await meta()).gameTime) - before,
      Math.round(firstLeg.days * 24 * 60),
      "the days on the clock",
    );
    assert.equal((await overworld()).overworld.here, far.path[1]);
    const second = await walkTo(far.path[2]!);
    assert.equal(second.statusCode, 200, second.body);
    const pending = (await meta()).gameWorldWalk;
    assert.equal(pending.from, start.id, "taken further, from where it set out");
    assert.equal(pending.to, far.path[2]);

    // A reply with nothing to tell does not tell it.
    replies.push("");
    await app.inject({
      method: "POST",
      url: "/api/generate/",
      payload: { chatId, userMessage: "Hm.", streaming: false },
    });
    assert.ok((await meta()).gameWorldWalk, "still pending");

    // The next turn tells it.
    const clockBefore = (await meta()).gameTime;
    await turn("They reach the gate at dusk.");
    const told = prompts.join("\n");
    assert.match(told, /On the overworld, the party has travelled from/);
    const to = world.places.find((place) => place.id === far.path[2])!;
    assert.match(told, new RegExp(`The party is in ${to.name}`, "u"), "the Game Master is told the party is there");
    const saved = await lastReply();
    assert.match(saved.content, new RegExp(`\\[place: name="${to.name}"[^\\]]*result="ok"`, "u"));
    assert.equal((await meta()).gameWorldWalk, null, "no longer pending");
    assert.equal(JSON.parse(saved.extra as string).worldWalk.id, pending.id, "kept with the reply");
    assert.deepEqual((await meta()).gameTime, clockBefore, "the walk's days are not passed twice");
    const replyTexts = (await chats.listMessages(chatId))
      .filter((m: any) => m.role === "assistant")
      .map((m: any) => m.content);
    const day = worldPresent(game, readWorldLedger(replyTexts)).day;
    assert.equal(day, Math.round(pending.days), "the world steps by the walk's whole days");
    assert.equal((await overworld()).overworld.here, to.id, "the party is where it walked");

    // A regeneration tells it again.
    await turn("They reach the gate at dawn.", { regenerateMessageId: saved.id, userMessage: undefined });
    assert.match(prompts.join("\n"), /On the overworld, the party has travelled from/);
    assert.match((await chats.getMessage(saved.id))!.content, new RegExp(`\\[place: name="${to.name}"`, "u"));

    // The Game Master's own days move the clock on a new turn.
    const clock = minutesOf((await meta()).gameTime);
    await turn('Three days of rain. [world: days="3"]');
    assert.equal(minutesOf((await meta()).gameTime) - clock, 3 * 24 * 60);
    const rained = await lastReply();
    await turn('Five days of rain. [world: days="5"]', { regenerateMessageId: rained.id, userMessage: undefined });
    assert.equal(minutesOf((await meta()).gameTime) - clock, 3 * 24 * 60, "not again on a regeneration");
    assert.ok(!/On the overworld/.test(prompts.join("\n")), "a turn with no walk tells none");
  } finally {
    await app.close();
    await closeDB();
    await new Promise<void>((resolve) => standIn.close(() => resolve()));
  }

  console.log("World overworld: walks go along the world's ways, pass their days, and the next turn tells them.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
