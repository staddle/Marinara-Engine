/**
 * The World tab (worldgen W7): the world as the party knows it.
 *
 *   - Where the party is, how widely it is known, its standing and its deeds, the news that has reached
 *     it and the past any local would tell, all as the story has left the world.
 *   - Only what the party could know: trouble brewing that it has not heard of, and the Game Master's
 *     pending ids and holds, never reach the screen.
 *   - Through the route, folded from the replies as a turn folds them; a game without a world has none.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  WORLD_STEP_DAYS,
  applyWorldTags,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  readWorldLedger,
  worldBrewingNear,
  worldDayPlural,
  worldJournal,
  worldPresent,
  type GameWorld,
  type WorldKit,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-journal-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");

const kit = (() => {
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
  assert.ok(parsed.ok);
  return parsed.kit;
})();

/** A world of four rival groups, each seated at one of the biggest places. */
function rivalWorld(worldKit: WorldKit, seed: number): GameWorld {
  const plain = checkWorldBrief(worldKit, { briefVersion: 1, premise: "x" });
  assert.ok(plain.ok);
  const layout = compileGameWorld({ kit: worldKit, seed, grounding: "expand", brief: plain.brief });
  const big = layout.places.filter((place) => place.rank !== undefined).sort((a, b) => b.rank! - a.rank!);
  const checked = checkWorldBrief(worldKit, {
    briefVersion: 1,
    premise: "x",
    places: big.slice(0, 4).map((place) => ({ name: place.name, layer: place.layer })),
    groups: [0, 1, 2, 3].map((index) => ({
      name: `Group ${index}`,
      kind: worldKit.groupKinds[index % worldKit.groupKinds.length]!.id,
      seat: big[index % big.length]!.name,
      rivals: index ? [`Group ${index - 1}`] : [],
    })),
  });
  assert.ok(checked.ok, checked.ok ? "" : checked.issues.join("; "));
  const inputs = { kit: worldKit, seed, grounding: "expand" as const, brief: checked.brief };
  return { ...inputs, world: compileGameWorld(inputs) };
}

function play(game: GameWorld, said: string[]): string[] {
  const replies: string[] = [];
  for (const reply of said) replies.push(applyWorldTags(reply, game, readWorldLedger(replies)));
  return replies;
}
const weeks = (count: number) => Array.from({ length: count }, () => `[world: days="${WORLD_STEP_DAYS}"]`);

try {
  // A world whose Game Master knows of trouble the party has not heard of yet.
  let found: { game: GameWorld; replies: string[] } | undefined;
  for (let seed = 1; seed < 60 && !found; seed++) {
    const game = rivalWorld(kit, seed);
    const start = game.world.places.find((place) => place.id === game.world.startId)!;
    // The party is said to be where it starts, so its deed is done somewhere.
    const replies = play(game, [
      `[place: name="${start.name}" result="ok"]`,
      `[world: deed="ally" group="Group 0"]`,
      `[world: deed="improve" place="${start.name}" note="mended the walls"]`,
      ...weeks(40),
    ]);
    const present = worldPresent(game, readWorldLedger(replies));
    const home = game.world.places.find((place) => place.rank !== undefined && start.id === place.id) ?? start;
    const brewing = worldBrewingNear(game, present, home.rank !== undefined ? home.id : undefined);
    if (brewing.some((each) => !each.heard) && present.news.length > 0) found = { game, replies };
  }
  assert.ok(found, "some world brews trouble the party has not heard of");
  const { game, replies } = found;
  const present = worldPresent(game, readWorldLedger(replies));
  const journal = worldJournal(game, present, {});
  const start = game.world.places.find((place) => place.id === game.world.startId)!;

  // ── Where, renown, standing, deeds ──
  assert.equal(journal.where[0], start.name, "the party is where the world starts it, until a place is said");
  assert.ok(journal.where.length >= 1);
  assert.equal(journal.renown, "unknown", "one deed makes nobody famous");
  assert.deepEqual(
    journal.standing.find((each) => each.group === "Group 0"),
    { group: "Group 0", band: "good" },
    "an alliance, at half weight while the party is unknown, puts it on good terms",
  );
  assert.deepEqual(
    journal.deeds.find((each) => /mended the walls/u.test(each.text)),
    { place: start.name, text: "The party improved it (mended the walls)." },
    "a deed done to a place is listed there",
  );
  assert.ok(journal.past.length > 0, "the past any local would tell");
  // News says how many of the setting's days ago, for the screen to word in its own language.
  for (const each of journal.news) {
    assert.ok(Number.isInteger(each.ago) && each.ago >= 0, "news is some whole number of days old");
    assert.deepEqual([each.day, each.days], [game.kit.calendar.day, worldDayPlural(game.kit.calendar.day)]);
  }
  // Deeds keep the order they were done in, across places, so the latest are the ones kept.
  const elsewhere = game.world.places.find((place) => place.id !== start.id)!;
  const inOrder = play(game, [
    `[world: deed="improve" place="${start.name}" note="first"]`,
    `[world: deed="improve" place="${elsewhere.name}" note="second"]`,
    `[world: deed="improve" place="${start.name}" note="third"]`,
  ]);
  assert.deepEqual(
    worldJournal(game, worldPresent(game, readWorldLedger(inOrder)), {}).deeds.map(
      (each) => /\((\w+)\)/u.exec(each.text)?.[1],
    ),
    ["first", "second", "third"],
    "deeds in the order done, not grouped by place",
  );

  // ── Only what the party could know ──
  const home = start.rank !== undefined ? start.id : undefined;
  const heard = worldBrewingNear(game, present, home).filter((each) => each.heard).length;
  assert.equal(journal.brewing.length, heard, "never trouble the party has not heard of");
  const shown = JSON.stringify(journal);
  for (const pending of present.pending) assert.ok(!shown.includes(pending.id), "never the Game Master's pending ids");
  assert.doesNotMatch(shown, /has not heard|\[world:/u);

  // ── Through the route ──
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  try {
    const chats = createChatsStorage(db);
    const read = async (metadata: Record<string, unknown>, said: string[]) => {
      const chat = await chats.create({ name: "World", mode: "game", characterIds: [] });
      await chats.patchMetadata(chat.id, metadata);
      for (const content of said) await chats.createMessage({ chatId: chat.id, role: "assistant", content });
      const response = await app.inject({ method: "GET", url: `/api/game/${chat.id}/world-journal` });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().journal as ReturnType<typeof worldJournal> | null;
    };
    const stored = {
      gameWorldKit: game.kit,
      gameWorld: {
        seed: game.seed,
        generatorVersion: WORLD_GENERATOR_VERSION,
        grounding: game.grounding,
        brief: game.brief,
      },
    };
    assert.deepEqual(await read(stored, replies), journal, "the route folds the replies as a turn does");
    // A place the Engine answered moves where the party is.
    const elsewhere = game.world.places.find((place) => place.id !== start.id && place.rank !== undefined)!;
    const moved = await read(stored, [...replies, `[place: name="${elsewhere.name}" result="ok"]`]);
    assert.equal(moved?.where[0], elsewhere.name);
    assert.equal(await read({}, []), null, "a game without a world has none");
    assert.equal((await app.inject({ method: "GET", url: "/api/game/nope/world-journal" })).statusCode, 404);
  } finally {
    await app.close();
    await closeDB();
  }

  console.log("World journal: the world as the party knows it, never what only the Game Master knows.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
