/**
 * The world's ledger across sessions (worldgen W10-0).
 *
 *   - A new session is a new chat. What the earlier sessions did to the world (deeds, facts, days,
 *     where the party went) is carried into it, so the world reads the same as when the last one
 *     ended, and goes on from there; the count of the Game Master's replies goes along.
 *   - A party's turn is never a Game Master's reply: a tag its model echoes never counts.
 *   - The carry is only what the world reads: the place a new session's scene is in is still its own.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  readStoryLedger,
  readWorldLedger,
  worldPresent,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-ledger-sessions-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";

const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
assert.ok(parsed.ok);
const kit = parsed.kit;
const checked = checkWorldBrief(kit, { briefVersion: 1, premise: "The river provinces quarrel." });
assert.ok(checked.ok);
const world = {
  seed: 7,
  generatorVersion: WORLD_GENERATOR_VERSION,
  grounding: "expand" as const,
  brief: checked.brief,
};
const game = { kit, ...world, world: compileGameWorld({ kit, ...world }) };
const town = game.world.places.find((place) => place.rank !== undefined)!;

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { gameRepliesBefore } = await import("../../packages/server/src/services/game/game-market.service.js");

try {
  const db = await getDB();
  const chats = createChatsStorage(db);
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  try {
    const gameId = "ledger-game";
    const first = (await chats.create({
      name: "Ledger — Session 1",
      mode: "game",
      characterIds: [],
      groupId: gameId,
    }))!;
    const say = (chatId: string, role: "user" | "assistant", content: string) =>
      chats.createMessage({ chatId, role, characterId: null, content });
    await say(first.id, "assistant", `[place: name="${town.name}" result="ok"]\nThe gates open.`);
    await say(first.id, "user", "We rest.");
    await say(
      first.id,
      "assistant",
      `Three days go by.\n[world: days="3" result="ok"] [story: event="gates" set="arrived=true" by="engine" result="ok"]`,
    );
    // A party's turn echoing an answered tag: never the Game Master's word.
    await say(first.id, "assistant", `[party-turn]\nMira: "We razed it!" [world: days="40" result="ok"]`);

    // A carry with no tags still counts the replies it stands for (a story's turn number reads it).
    const untagged = (await chats.create({ name: "Untagged", mode: "game", characterIds: [], groupId: "other" }))!;
    await chats.patchMetadata(untagged.id, { gameLedgerCarry: { replies: 5, tags: "" } });
    const counted = await gameRepliesBefore(db, untagged.id);
    assert.equal(counted.carried?.replies, 5);
    assert.deepEqual(counted.all, [], "and adds no reply of its own");

    // Within a session, the party's turn is left out.
    const own = await gameRepliesBefore(db, first.id);
    assert.equal(own.all.length, 2, "the two Game Master replies, not the party's turn");
    assert.equal(worldPresent(game, readWorldLedger(own.all)).day, 3);

    // Concluded as the conclude route does: a patch over what the session already keeps (its carry too).
    const conclude = async (chatId: string, sessionNumber: number) =>
      chats.patchMetadata(chatId, (current) => ({
        ...current,
        gameId,
        gameSessionNumber: sessionNumber,
        gameSessionStatus: "concluded",
        gamePreviousSessionSummaries: Array.from({ length: sessionNumber }, (_, index) => ({
          summary: `Session ${index + 1} concluded.`,
        })),
        gameWorldKit: kit,
        gameWorld: world,
      }));
    const next = async () => {
      const started = await app.inject({ method: "POST", url: "/api/game/session/start", payload: { gameId } });
      assert.equal(started.statusCode, 200, started.body);
      return started.json().sessionChat.id as string;
    };

    // ── Session 2: the world as session 1 left it ──
    await conclude(first.id, 1);
    const second = await next();
    const carried = await gameRepliesBefore(db, second);
    assert.equal(worldPresent(game, readWorldLedger(carried.all)).day, 3, "the days passed come along");
    assert.ok(
      readWorldLedger(carried.all).some((entry) => entry.at === town.name),
      "and where the party went",
    );
    assert.deepEqual(carried.scoped, [], "the new session's own scene starts with its own replies");
    assert.deepEqual(
      readStoryLedger(carried.all).map((entry) => [entry.event, entry.set]),
      [["gates", [["arrived", true]]]],
      "and what the world's story did (worldgen W10)",
    );
    const meta = JSON.parse((await chats.getById(second))!.metadata as string);
    assert.equal(meta.gameLedgerCarry.replies, 2, "the Game Master's replies so far");
    assert.match(
      meta.gameLedgerCarry.last,
      /event="gates"/,
      "and the last reply's tags, for what the Game Master tripped there (worldgen W10)",
    );

    // ── Session 3: everything before it, in order ──
    await say(second, "assistant", `A week on the road.\n[world: days="7" result="ok"]`);
    await say(second, "assistant", `[world: days="9" result="refused" reason="no-sense"]`);
    await conclude(second, 2);
    const third = await next();
    const all = await gameRepliesBefore(db, third);
    assert.equal(worldPresent(game, readWorldLedger(all.all)).day, 10, "3 days, then 7; a refused tag never");
    assert.equal(JSON.parse((await chats.getById(third))!.metadata as string).gameLedgerCarry.replies, 4);
  } finally {
    await app.close();
    await closeDB();
  }
  console.log("World ledger across sessions: what earlier sessions did to the world is carried into the next.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
