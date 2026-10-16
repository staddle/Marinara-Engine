/**
 * Sites on the overworld (design-game-overworld-sites.md): a cave or a barrow out in the world, not in a
 * town, is a site. A trip to one leaves the world's ways on foot from its nearest settlement; the party at
 * a site is there on the overworld, and goes into it as into a place in town. A site the story names
 * stays closed (no trip, no going in) until the Game Master reveals it, read from the replies so a
 * regenerated reply takes its reveal with it; the Game Master is told what is closed and how to open it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  carryWorldLedger,
  checkWorldBrief,
  compileGameWorld,
  createConnectionSchema,
  parseWorldKit,
  readGameDungeonTags,
  worldIsSite,
  worldRoute,
  worldSiteAnchor,
  worldSiteLocks,
  worldSites,
  worldTrip,
  type GameWorld,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-overworld-sites-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
// No local embedding model: memory recall would start fetching one after each turn and hold the process open.
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
  // The tag that opens a closed site, and never a map.
  assert.deepEqual(readGameDungeonTags('At last. [map: reveal name="Old Barrow"]'), [
    { reveal: true, name: "Old Barrow" },
  ]);

  const game = gameOf("high_fantasy", 21);
  const settlements = game.world.places.filter((place) => place.rank !== undefined);
  const city = settlements.reduce((best, place) => (place.rank! > best.rank! ? place : best));
  const province = game.world.places.find((place) => place.id === city.parentId)!;
  // Two places added by hand a few steps out of the city (its layer below the settlements).
  const taken = new Set(game.world.places.map((place) => `${place.at.x},${place.at.y}`));
  const free = (from: { x: number; y: number }, dx: number) => {
    for (let step = 3; step < 40; step++) {
      const at = { x: from.x + dx * step, y: from.y };
      if (at.x >= 1 && at.x < game.world.width - 1 && !taken.has(`${at.x},${at.y}`)) return at;
    }
    throw new Error("no free cell");
  };
  const caveAt = free(city.at, 1);
  const barrowAt = free(city.at, -1);
  const added = [
    { id: "e1", name: "Wolf Den Caves", layer: "quarter", parentId: city.id, at: caveAt },
    { id: "e2", name: "Old Barrow", layer: "quarter", parentId: city.id, at: barrowAt },
  ];

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
  const replies: string[] = [];
  const prompts: string[] = [];
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
    const chat = await chats.create({ name: "Sites", mode: "game", characterIds: [], connectionId: connection!.id });
    const chatId = chat.id;
    await chats.patchMetadata(chatId, {
      gameId: `sites-${chatId}`,
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameWorldKit: game.kit,
      gameWorld: { seed: game.seed, generatorVersion: WORLD_GENERATOR_VERSION, grounding: "expand", brief: game.brief },
      gameTime: { day: 1, hour: 10, minute: 0 },
    });
    await chats.createMessage({
      chatId,
      role: "assistant",
      content: `The gates. [place: name="${city.name}" result="ok"]`,
    });
    const saved = await app.inject({
      method: "PUT",
      url: `/api/game/${chatId}/world/edits`,
      payload: { edits: { editsVersion: 1, added } },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const world = (await app.inject({ method: "GET", url: `/api/game/${chatId}/world` })).json().world as GameWorld;
    const meta = async () => JSON.parse((await chats.getById(chatId))!.metadata as string) as Record<string, any>;
    const overworld = async () =>
      (await app.inject({ method: "GET", url: `/api/game/${chatId}/overworld` })).json().overworld;
    const walk = (to: string) =>
      app.inject({ method: "POST", url: `/api/game/${chatId}/overworld/walk`, payload: { to } });
    const enter = (place: string) =>
      app.inject({ method: "POST", url: `/api/game/${chatId}/map/enter`, payload: { place } });
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

    // ── Not sites: a cave on its town's own cell (a building in town), a region with a cave's name ──
    const unitEdits = await app.inject({
      method: "PUT",
      url: `/api/game/${chatId}/world/edits`,
      payload: {
        edits: {
          editsVersion: 1,
          places: [{ id: province.id, name: "The Sunken Caverns" }],
          added: [...added, { id: "e3", name: "Old Mine", layer: "quarter", parentId: city.id, at: city.at }],
        },
      },
    });
    assert.equal(unitEdits.statusCode, 200, unitEdits.body);
    const unitWorld = (await app.inject({ method: "GET", url: `/api/game/${chatId}/world` })).json().world as GameWorld;
    assert.ok(!worldIsSite(unitWorld, "e3"), "on its settlement's own cell: in town, not out in the world");
    assert.ok(!worldIsSite(unitWorld, province.id), "a region holding settlements is never a site");
    assert.ok(worldIsSite(unitWorld, "e1"));
    const reset = await app.inject({
      method: "PUT",
      url: `/api/game/${chatId}/world/edits`,
      payload: { edits: { editsVersion: 1, added } },
    });
    assert.equal(reset.statusCode, 200, reset.body);

    // ── Which places are sites ──
    const sites = worldSites(world).map((place) => place.id);
    assert.ok(sites.includes("e1") && sites.includes("e2"), "the cave and the barrow are sites");
    assert.ok(!sites.includes(city.id) && !sites.includes(province.id), "never a settlement or a region");
    assert.ok(worldIsSite(world, "e1"));

    // ── Trips: off the road from the nearest settlement ──
    const cave = world.world.places.find((place) => place.id === "e1")!;
    const anchor = worldSiteAnchor(world, cave)!;
    const toCave = worldTrip(world, city.id, "e1")!;
    assert.equal(toCave.path[0], city.id);
    assert.equal(toCave.path.at(-1), "e1");
    const roads = anchor.id === city.id ? 0 : worldRoute(world.world, city.id, anchor.id)!.days;
    assert.ok(toCave.days > roads, "the last leg leaves the road");
    assert.equal(toCave.legs.at(-1)!.to, "e1");
    const between = worldTrip(world, "e1", "e2")!;
    assert.deepEqual([between.path[0], between.path.at(-1)], ["e1", "e2"], "site to site by their settlements");
    assert.equal(worldTrip(world, "e1", "e1"), null);

    // ── No story: nothing is closed ──
    assert.equal((await overworld()).locked, undefined, "an overworld with nothing closed reads as before");

    // ── The story names the barrow: it is closed ──
    await chats.patchMetadata(chatId, {
      gameStory: {
        storyVersion: 1,
        events: [{ id: "barrow", when: { on: "arrive", place: "e2" }, do: [{ tell: "The barrow breathes." }] }],
      },
    });
    assert.deepEqual((await overworld()).locked, { e2: "sealed" }, "the story's site is sealed");
    assert.equal((await walk("e2")).statusCode, 400, "no trip to a closed site");

    // ── To the cave and into it ──
    const before = await meta();
    const walked = await walk("e1");
    assert.equal(walked.statusCode, 200, walked.body);
    assert.equal(walked.json().walk.to, "e1");
    const after = await meta();
    assert.ok(
      after.gameTime.day * 1440 + after.gameTime.hour * 60 + after.gameTime.minute >
        before.gameTime.day * 1440 + before.gameTime.hour * 60 + before.gameTime.minute,
      "the trip's time on the clock",
    );
    await turn("You reach the caves.");
    assert.match(prompts.join("\n"), /travelled from .* to Wolf Den Caves/u, "the Game Master is told the trip");
    assert.match(
      prompts.join("\n"),
      /Closed to the party until you reveal them with \[map: reveal name=\\"\.\.\.\\"\]: Old Barrow\./u,
      "and what is closed",
    );
    assert.equal((await overworld()).here, "e1", "the party is at the cave on the overworld");
    assert.equal((await enter(city.id)).statusCode, 400, "only a site it is at");
    const entered = await enter("e1");
    assert.equal(entered.statusCode, 200, entered.body);
    const map = entered.json().map;
    assert.equal(map.place, "e1");
    assert.equal(map.set, "cave_rock");
    const left = await app.inject({ method: "POST", url: `/api/game/${chatId}/map/leave`, payload: { map: map.id } });
    assert.equal(left.statusCode, 200, left.body);
    assert.equal((await overworld()).here, "e1", "out at the cave again");

    // ── The Game Master reveals the barrow; a regeneration without it closes it again ──
    await turn('The way to the barrow lies open. [map: reveal name="Old Barrow"]');
    assert.equal((await overworld()).locked, undefined, "opened");
    assert.equal((await meta()).gameDungeonMap, null, "a reveal opens no map");
    const revealing = (await chats.listMessages(chatId)).filter((m: any) => m.role === "assistant").at(-1)!;
    await turn("Mist hides the way.", { regenerateMessageId: revealing.id, userMessage: undefined });
    assert.deepEqual((await overworld()).locked, { e2: "sealed" }, "the reveal went with the reply");
    assert.equal((await enter("e2")).statusCode, 400);
    await turn('You find the barrow. [map: reveal name="Old Barrow"]');
    const toBarrow = await walk("e2");
    assert.equal(toBarrow.statusCode, 200, toBarrow.body);
    assert.equal((await enter("e1")).statusCode, 400, "only into the site the party is at");

    // ── The creator's own locks (edits.sites): hidden until revealed, or open though the story names it ──
    const locked = await app.inject({
      method: "PUT",
      url: `/api/game/${chatId}/world/edits`,
      payload: {
        edits: {
          editsVersion: 3,
          added,
          sites: [
            { place: "e1", lock: "hidden" },
            { place: "e2", lock: "open" },
          ],
        },
      },
    });
    assert.equal(locked.statusCode, 200, locked.body);
    const lockedWorld = (await app.inject({ method: "GET", url: `/api/game/${chatId}/world` })).json()
      .world as GameWorld;
    const story = {
      storyVersion: 1,
      flags: [],
      directions: [],
      events: [{ id: "barrow", when: { on: "arrive", place: "e2" }, do: [{ tell: "x" }] }],
      cutscenes: [],
    } as never;
    assert.deepEqual(
      [...worldSiteLocks(lockedWorld, story, [])],
      [["e1", "hidden"]],
      "hidden by the creator; open though the story names it",
    );
    assert.deepEqual(
      [...worldSiteLocks(lockedWorld, story, ['[map: reveal name="Wolf Den Caves"]'])],
      [],
      "a reveal shows a hidden site",
    );
    // At a closed site, the party still does not go in.
    await chats.patchMetadata(chatId, { gameWorldWalk: null });
    await turn('Back to the caves. [place: name="Wolf Den Caves"]');
    assert.equal((await overworld()).here, "e1");
    assert.equal((await enter("e1")).statusCode, 400, "not into a hidden site");
    const shown = await overworld();
    assert.ok(!Object.keys(shown.locked ?? {}).includes("e1"), "a hidden site is never sent as sealed");
    assert.deepEqual(shown.hidden, ["e1"]);
    // A reveal is carried into the next session with the world's own tags.
    const carried = carryWorldLedger(null, ['At last. [map: reveal name="Wolf Den Caves"]']);
    assert.match(carried.tags, /\[map: reveal name="Wolf Den Caves"\]/u);
    assert.deepEqual([...worldSiteLocks(lockedWorld, story, [carried.tags])], [], "open in the session after");
    // So is a site gone into by name; leaving it is not carried.
    const wentIn = carryWorldLedger(null, ['Down we go. [map: kind="cave" name="Wolf Den Caves"] [map: leave]']);
    assert.equal(wentIn.tags, '[map: kind="cave" name="Wolf Den Caves"]');
    assert.deepEqual(
      [...worldSiteLocks(lockedWorld, story, [wentIn.tags])],
      [],
      "gone into, open in the session after",
    );
  } finally {
    await app.close();
    await closeDB();
    await new Promise<void>((resolve) => standIn.close(() => resolve()));
  }

  console.log("Overworld sites: trips off the road, gone into from the overworld, closed until the story opens them.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
