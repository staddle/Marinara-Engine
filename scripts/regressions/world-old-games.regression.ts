/**
 * A world for a game made without one (worldgen W12): only when the player asks, through
 * POST /game/:chatId/world, checked as a new game's world is.
 *
 *   - An older game takes a world: kept as its snapshot, named in its metadata, read back as made, and the
 *     Game Master's next prompt has it; a new session keeps it.
 *   - Refused: a game that has a world already, one an Experience decides, a brief that does not hold
 *     together, another generator's world without its snapshot. Another generator's world with its
 *     snapshot is taken as it was made.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  checkWorldBrief,
  compileGameWorld,
  createConnectionSchema,
  lastGamePlace,
  parseWorldKit,
  worldSnapshot,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-old-games-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createGameWorldSnapshotsStorage } =
  await import("../../packages/server/src/services/storage/game-world-snapshots.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { gameRepliesBefore } = await import("../../packages/server/src/services/game/game-market.service.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");

const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
assert.ok(parsed.ok);
const kit = parsed.kit;
const checked = checkWorldBrief(kit, { briefVersion: 1, premise: "The river provinces quarrel." });
assert.ok(checked.ok);
const world = {
  seed: 777,
  generatorVersion: WORLD_GENERATOR_VERSION,
  grounding: "expand" as const,
  brief: checked.brief,
};
const made = compileGameWorld({ kit, ...world });

const prompts: string[] = [];
const standIn = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  prompts.push(Buffer.concat(chunks).toString());
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Onward." } }],
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
  const snapshots = createGameWorldSnapshotsStorage(db);
  // A game made before worlds: a session with no world in its metadata.
  let games = 0;
  const olderGame = async (extra: Record<string, unknown> = {}) => {
    const gameId = `old-game-${++games}`;
    const chat = (await chats.create({
      name: "Old game",
      mode: "game",
      characterIds: [],
      groupId: gameId,
      connectionId: connection!.id,
    }))!;
    await chats.patchMetadata(chat.id, {
      gameId,
      gameSessionNumber: 1,
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameSetupConfig: {
        genre: "Fantasy",
        setting: "A river kingdom",
        tone: "Grim",
        difficulty: "normal",
        rating: "sfw",
        playerGoals: "",
        gmMode: "standalone",
        partyCharacterIds: [],
      },
      ...extra,
    });
    await chats.createMessage({ chatId: chat.id, role: "assistant", characterId: null, content: "The road goes on." });
    return chat.id as string;
  };
  const give = (chatId: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/game/${chatId}/world`, payload });

  const chatId = await olderGame();
  // Overworld games locked (MARINARA_OVERWORLD_GAMES off): a legacy game is not given a world.
  const overworldBefore = process.env.MARINARA_OVERWORLD_GAMES;
  delete process.env.MARINARA_OVERWORLD_GAMES;
  try {
    const locked = await give(chatId, { worldKit: kit, world });
    assert.equal(locked.statusCode, 403, locked.body);
    assert.equal(locked.json().code, "overworld_locked");
  } finally {
    process.env.MARINARA_OVERWORLD_GAMES = overworldBefore ?? "true";
  }
  const given = await give(chatId, { worldKit: kit, world });
  assert.equal(given.statusCode, 200, given.body);
  assert.deepEqual(given.json().world.world, made, "the world as this generator makes it");
  assert.ok(await snapshots.get(chatId), "kept as the game's snapshot");
  const meta = JSON.parse((await chats.getById(chatId))!.metadata as string);
  assert.equal(meta.gameWorld.seed, 777);
  assert.equal(meta.gameWorldKit.id, kit.id);
  const read = await app.inject({ method: "GET", url: `/api/game/${chatId}/world` });
  assert.deepEqual(read.json().world.world, made, "read back as made");
  // The Game Master knows it from the next turn.
  const turn = await app.inject({
    method: "POST",
    url: "/api/generate/",
    payload: { chatId, userMessage: "We look around.", streaming: false },
  });
  assert.equal(turn.statusCode, 200, turn.body);
  assert.match(prompts.join("\n"), /world_places/, "the prompt has the world");

  // Refused: a world already, an Experience's game, a brief that does not hold, another generator bare.
  assert.equal((await give(chatId, { worldKit: kit, world })).statusCode, 409, "a game with a world already");
  const experience = await olderGame({ gameExperienceId: "some-experience" });
  assert.equal((await give(experience, { worldKit: kit, world })).statusCode, 409, "an Experience decides its world");
  // A brief whose places the kit does not have is repaired as a new game's is, never stored as written.
  const repaired = await olderGame();
  const repairedSave = await give(repaired, {
    worldKit: kit,
    world: { ...world, brief: { ...world.brief, places: [{ name: "X", layer: "nowhere" }] } },
  });
  assert.ok([200, 400].includes(repairedSave.statusCode), repairedSave.body);
  const repairedWorld = JSON.parse((await chats.getById(repaired))!.metadata as string).gameWorld;
  assert.ok(!repairedWorld || !JSON.stringify(repairedWorld).includes('"nowhere"'), "the brief as checked");
  const unread = await olderGame();
  const older = { ...world, generatorVersion: WORLD_GENERATOR_VERSION + 1 };
  const bare = await give(unread, { worldKit: kit, world: older });
  assert.equal(bare.statusCode, 400, "another generator's world without its snapshot");
  assert.equal(await snapshots.raw(unread), null, "nothing kept for a refused world");
  // With its snapshot: taken as it was made.
  const asMade = { ...worldSnapshot({ kit, ...world, world: made }), generatorVersion: WORLD_GENERATOR_VERSION + 1 };
  const kept = await give(unread, { worldKit: kit, world: older, worldSnapshot: asMade });
  assert.equal(kept.statusCode, 200, kept.body);
  assert.equal(
    JSON.parse((await chats.getById(unread))!.metadata as string).gameWorld.generatorVersion,
    WORLD_GENERATOR_VERSION + 1,
  );
  assert.equal(
    (await snapshots.get(unread))!.generatorVersion,
    WORLD_GENERATOR_VERSION + 1,
    "the snapshot it came with",
  );

  // The world starts now: a place the game was in that it does not list is left behind.
  const atInn = await olderGame();
  await chats.createMessage({
    chatId: atInn,
    role: "assistant",
    characterId: null,
    content: 'The common room. [place: name="Brindle Inn" result="ok"]',
  });
  assert.equal((await give(atInn, { worldKit: kit, world })).statusCode, 200);
  assert.equal(lastGamePlace((await gameRepliesBefore(db, atInn)).scoped), null, "the old place is behind it");
  prompts.length = 0;
  await app.inject({
    method: "POST",
    url: "/api/generate/",
    payload: { chatId: atInn, userMessage: "We look around.", streaming: false },
  });
  assert.doesNotMatch(
    prompts.join("\n"),
    /Brindle Inn, which this world does not list/,
    "the prompt is at the world's start",
  );

  // Only the latest session takes a world: an older one would lose it at the next session's start.
  const twoSessions = await olderGame();
  const twoMeta = JSON.parse((await chats.getById(twoSessions))!.metadata as string);
  await chats.patchMetadata(twoSessions, {
    gameSessionStatus: "concluded",
    gamePreviousSessionSummaries: [{ summary: "One." }],
  });
  const nextStarted = await app.inject({
    method: "POST",
    url: "/api/game/session/start",
    payload: { gameId: twoMeta.gameId },
  });
  assert.equal(nextStarted.statusCode, 200, nextStarted.body);
  const latestId = nextStarted.json().sessionChat.id as string;
  const older409 = await give(twoSessions, { worldKit: kit, world });
  assert.equal(older409.statusCode, 409, "an older session");
  assert.match(older409.json().error, /latest session/);
  assert.equal((await give(latestId, { worldKit: kit, world })).statusCode, 200, "the latest one");
  assert.equal((await give(latestId, { worldKit: kit, world })).statusCode, 409, "and only once for the game");

  // A game made with a setting kit keeps it.
  const kitted = await olderGame({ gameWorldKit: kit });
  const otherKit = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id !== "high_fantasy")!);
  assert.ok(otherKit.ok);
  const swapped = await give(kitted, {
    worldKit: otherKit.kit,
    world: { ...world, brief: checkWorldBrief(otherKit.kit, { briefVersion: 1, premise: "x" }).brief },
  });
  assert.equal(swapped.statusCode, 409, "another kit for a game with its own");
  assert.equal((await give(kitted, { worldKit: kit, world })).statusCode, 200, "its own kit");

  // A game chat outside any session group takes a world too.
  const loose = (await chats.create({ name: "Loose", mode: "game", characterIds: [], connectionId: connection!.id }))!;
  await chats.patchMetadata(loose.id, { gameId: "loose-game", gameSessionStatus: "active", gameIntroPresented: true });
  assert.equal((await give(loose.id, { worldKit: kit, world })).statusCode, 200, "a chat in no group");

  // Two saves at once: one world, in the snapshot and the metadata alike.
  const raced = await olderGame();
  const statuses = (
    await Promise.all([
      give(raced, { worldKit: kit, world }),
      give(raced, { worldKit: kit, world: { ...world, seed: 778 } }),
    ])
  )
    .map((response) => response.statusCode)
    .sort();
  assert.deepEqual(statuses, [200, 409], "one of two saves at once");
  const racedMeta = JSON.parse((await chats.getById(raced))!.metadata as string);
  assert.equal(
    (await snapshots.get(raced))!.seed,
    racedMeta.gameWorld.seed,
    "the snapshot is the world the metadata names",
  );

  // A new session keeps the world.
  await chats.patchMetadata(chatId, {
    gameSessionStatus: "concluded",
    gamePreviousSessionSummaries: [{ summary: "Done." }],
  });
  const started = await app.inject({
    method: "POST",
    url: "/api/game/session/start",
    payload: { gameId: meta.gameId },
  });
  assert.equal(started.statusCode, 200, started.body);
  const second = started.json().sessionChat.id as string;
  const secondWorld = await app.inject({ method: "GET", url: `/api/game/${second}/world` });
  assert.deepEqual(secondWorld.json().world.world, made, "the next session's world");
} finally {
  await app.close();
  await closeDB();
  await new Promise<void>((resolve) => standIn.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}
console.log("world-old-games regression passed");
