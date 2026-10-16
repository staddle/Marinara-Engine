/**
 * A world's snapshot (worldgen W11): the world kept as data, so a game plays on in the same world after
 * the generator changes.
 *
 *   - For every starter kit, a world read back from its snapshot (through JSON, as storage keeps it) is the
 *     world as made: its places, its history, the people of every place, every town with the story's
 *     places added, and what the Game Master is told.
 *   - It is read without the generator: with its seed and name lists changed under it, every one of those
 *     is still the same.
 *   - A world with hand edits (places and people added, a person renamed, a town laid out by hand) and a
 *     place the story added in the same town reads back the same.
 *   - A damaged snapshot, or one from a later format, is refused.
 *   - Through the routes: a game made with a world keeps its snapshot; with its recipe changed under it
 *     and its generator version moved on (as after an update), the screen, the town, the journal, the
 *     people and the Game Master's prompt are still its world, and it can no longer be edited or shared
 *     as a recipe. A new session, a branch and an export imported again play in the same world; deleting
 *     one chat leaves the others' worlds.
 */
import assert from "node:assert/strict";
import {
  buildGameSetupShareFile,
  parseGameSetupShareFileJson,
  resolveGameSetupImport,
} from "../../packages/client/src/lib/game-setup-share.js";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_SNAPSHOT_VERSION,
  WORLD_STARTER_KITS,
  checkWorldBrief,
  createConnectionSchema,
  gameWorldFromMetadata,
  gameWorldFromSnapshot,
  parseWorldKit,
  readWorldFile,
  worldFile,
  readWorldSnapshot,
  worldCast,
  worldEditsSchema,
  worldHistory,
  worldOverviewPromptText,
  worldPresent,
  worldSnapshot,
  worldTown,
  worldTownEditIssues,
  worldFold,
  type WorldFold,
  type WorldLedgerEntry,
  worldWhereYouAreText,
  type GameWorld,
  type WorldEdits,
  type WorldKit,
  type WorldPresent,
} from "../../packages/shared/src/index.js";

const NAMES = {
  given: ["Ama", "Tobin", "Hesk", "Mira", "Oswin", "Bryn", "Calla", "Doran", "Edda", "Fenn"],
  family: ["Holt", "Drey", "Marrow", "Vane", "Callow"],
};

const made = (kit: WorldKit, seed: number, edits?: WorldEdits): GameWorld => {
  const checked = checkWorldBrief(kit, {
    briefVersion: 1,
    premise: "A quiet season before trouble.",
    peopleNames: kit.cultures.map((culture) => ({ culture: culture.id, ...NAMES })),
  });
  assert.ok(checked.ok, JSON.stringify(checked));
  const game = gameWorldFromMetadata({
    gameWorldKit: kit,
    gameWorld: {
      seed,
      generatorVersion: WORLD_GENERATOR_VERSION,
      grounding: "expand",
      brief: checked.brief,
      ...(edits ? { edits } : {}),
    },
  });
  assert.ok(game, `${kit.id}: a world`);
  if (edits) assert.ok(game.edits, `${kit.id}: its edits fit`);
  return game;
};

/** Through JSON and back, as storage and files keep it. */
const stored = (game: GameWorld): GameWorld => {
  const read = readWorldSnapshot(JSON.parse(JSON.stringify(worldSnapshot(game))));
  assert.ok(read.ok, read.ok ? "" : read.issues.join("; "));
  return gameWorldFromSnapshot(read.snapshot);
};

/** A present with one place the story added in the start's settlement. */
const withStoryPlace = (game: GameWorld): WorldPresent => {
  const present = worldPresent(game, []);
  const start = game.world.places.find((place) => place.id === game.world.startId)!;
  const settlement = start.rank !== undefined ? start : game.world.places.find((place) => place.id === start.parentId)!;
  present.places.push({ id: "x1", name: "The Gilded Gull", parentId: settlement.id } as never);
  return present;
};

/** Everything a game reads of its world, as plain data. */
const reading = (game: GameWorld, present: WorldPresent) => {
  const settlements = game.world.places.filter((place) => place.rank !== undefined);
  const start = game.world.places.find((place) => place.id === game.world.startId)!;
  return {
    world: game.world,
    history: worldHistory(game),
    casts: game.world.places.map((place) => worldCast(game, place.id)),
    towns: settlements.map((place) => worldTown(game, place.id, present)),
    overview: worldOverviewPromptText(game),
    here: worldWhereYouAreText(game, { place: start, present }),
  };
};

// ── Every starter kit: the same world from its snapshot, and with its recipe changed under it ──
let largest = 0;
let storyPlaced = 0;
for (const raw of WORLD_STARTER_KITS) {
  const parsed = parseWorldKit(raw);
  assert.ok(parsed.ok);
  const live = made(parsed.kit, 20261004);
  const present = withStoryPlace(live);
  const expected = reading(live, present);
  const frozen = stored(live);
  assert.ok(frozen.frozen, `${raw.id}: read from its snapshot`);
  assert.deepEqual(reading(frozen, present), expected, `${raw.id}: the snapshot's world is the world as made`);
  // A town with no free lot and no empty home has no room for it.
  if (expected.towns.some((town) => town?.buildings.some((building) => building.id === "x1"))) storyPlaced++;
  // The recipe changed under it: a generator reading it would make another world.
  const tampered: GameWorld = {
    ...frozen,
    seed: frozen.seed + 1,
    brief: { ...frozen.brief, peopleNames: [] },
  };
  assert.deepEqual(reading(tampered, present), expected, `${raw.id}: nothing is made again from the recipe`);
  largest = Math.max(largest, JSON.stringify(worldSnapshot(live)).length);
}

assert.ok(storyPlaced >= WORLD_STARTER_KITS.length / 2, `the story's place stood in ${storyPlaced} towns`);

// ── A world with hand edits and a place the story added, in one town ──
{
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
  assert.ok(parsed.ok);
  const kit = parsed.kit;
  const base = made(kit, 31);
  const city = [...base.world.places]
    .filter((place) => place.rank !== undefined)
    .sort((a, b) => b.rank! - a.rank! || a.id.localeCompare(b.id))[0]!;
  const inner = kit.layers[kit.layers.findIndex((layer) => layer.settlements) + 1]!;
  const town = worldTown(base, city.id)!;
  const home = town.buildings.find((building) => building.kind === "home")!;
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const free = town.lots.filter((lot) => town.buildings.every((building) => !overlaps(building, lot)));
  const edits = worldEditsSchema.parse({
    editsVersion: 1,
    added: [{ id: "e1", name: "The Lantern", layer: inner.id, parentId: city.id, at: city.at }],
    addedPeople: [
      { id: `${city.id}-e1`, placeId: city.id, name: "Wren Hollis", role: "a cartographer" },
      { id: "e1-e1", placeId: "e1", name: "Pell Garrow" },
    ],
    people: [{ id: `${city.id}-1`, name: "Old Tomas" }],
    towns: [
      { settlement: city.id, moves: [{ building: home.id, x: free.at(-1)!.x, y: free.at(-1)!.y, w: free.at(-1)!.w }] },
    ],
  });
  const live = made(kit, 31, edits);
  const present = worldPresent(live, []);
  present.places.push({ id: "x1", name: "The Gilded Gull", parentId: city.id } as never);
  const frozen = stored(live);
  assert.deepEqual(reading(frozen, present), reading(live, present), "an edited world reads back the same");
  const laidOut = worldTown(frozen, city.id, present)!;
  const lantern = laidOut.buildings.findIndex((building) => building.id === "e1");
  const gull = laidOut.buildings.findIndex((building) => building.id === "x1");
  assert.ok(lantern >= 0 && gull > lantern, "the place added by hand stands before the story's");
  assert.equal(laidOut.buildings.find((building) => building.id === home.id)!.x, free.at(-1)!.x, "the move holds");
  assert.ok(
    laidOut.people.some((person) => person.name === "Wren Hollis"),
    "an added person lives in town",
  );
  assert.ok(
    laidOut.people.some((person) => person.name === "Old Tomas"),
    "a renamed person keeps the name",
  );
  assert.deepEqual(worldSnapshot(frozen), frozen.frozen, "a frozen world's snapshot is the one it was read from");

  // Edits saved on a world read from its snapshot are checked against the world they make: people added
  // and the new home they need moved, in one save, as a maker sends them.
  const crowd = [
    ...edits.addedPeople!,
    ...[2, 3, 4, 5, 6, 7].map((n) => ({ id: `${city.id}-e${n}`, placeId: city.id, name: `Crowd ${n}` })),
  ];
  const crowded = worldTown(made(kit, 31, { ...edits, addedPeople: crowd, towns: [] }), city.id)!;
  const newHome = crowded.buildings.find(
    (each) => each.kind === "home" && !laidOut.buildings.some((old) => old.id === each.id),
  )!;
  assert.ok(newHome, "the crowd needs a new home");
  const room = crowded.lots.find((lot) => crowded.buildings.every((each) => !overlaps(each, lot)))!;
  const moved = worldEditsSchema.parse({
    ...edits,
    addedPeople: crowd,
    towns: [{ settlement: city.id, moves: [{ building: newHome.id, x: room.x, y: room.y, w: room.w }] }],
  });
  assert.deepEqual(worldTownEditIssues(frozen, moved), [], "the new home is in the town the edits make");

  // A story's place never opens its door on ground painted since: every free lot's street door painted
  // with a tree, it takes a lot whose door is still on the street, or an empty home.
  const doors = new Set(town.buildings.map((building) => building.door.y * town.width + building.door.x));
  const painted = [...town.ground].fill(".");
  for (const lot of free) {
    const cell = lot.door.y * town.width + lot.door.x;
    if (!doors.has(cell)) painted[cell] = "t";
  }
  const treed = made(
    kit,
    31,
    worldEditsSchema.parse({ editsVersion: 1, towns: [{ settlement: city.id, ground: painted.join("") }] }),
  );
  const story = worldPresent(treed, []);
  story.places.push({ id: "x1", name: "The Gilded Gull", parentId: city.id } as never);
  const treedTown = worldTown(stored(treed), city.id, story)!;
  const gullAt = treedTown.buildings.find((building) => building.id === "x1");
  assert.ok(gullAt, "the story's place stands in town");
  assert.match(treedTown.ground[gullAt.door.y * treedTown.width + gullAt.door.x]!, /[sq]/, "its door is on the street");
}

// ── The living world folds on from a session's checkpoint exactly as from the start ──
for (const raw of WORLD_STARTER_KITS) {
  const parsed = parseWorldKit(raw);
  assert.ok(parsed.ok);
  for (const seed of [11, 12]) {
    const game = made(parsed.kit, seed);
    const settlements = game.world.places.filter((place) => place.rank !== undefined);
    const [home, away] = [settlements[0]!, settlements.at(-1)!];
    const earlier: WorldLedgerEntry[] = [
      { at: home.name },
      { days: "20" },
      { event: "A fire takes the granary", kind: "catastrophe", place: away.name },
      { at: away.name },
      { days: "16" },
    ];
    const later: WorldLedgerEntry[] = [{ days: "9" }, { at: home.name }, { days: "30" }];
    const checkpoint = JSON.parse(JSON.stringify(worldFold(game, earlier))) as WorldFold;
    assert.deepEqual(
      worldPresent(game, [{ from: checkpoint }, ...later]),
      worldPresent(game, [...earlier, ...later]),
      `${raw.id} ${seed}: from the checkpoint, the same present`,
    );
  }
}

// ── Files from another generator: a world file names one generator, and a setup file carries the snapshot ──
{
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
  assert.ok(parsed.ok);
  const live = made(parsed.kit, 9);
  const older = { ...worldSnapshot(live), generatorVersion: WORLD_GENERATOR_VERSION + 1 };
  const recipe = {
    seed: live.seed,
    generatorVersion: WORLD_GENERATOR_VERSION + 1,
    grounding: live.grounding,
    brief: live.brief,
  };
  const mixed = readWorldFile(JSON.stringify(worldFile("Mixed", live.kit, recipe, null, worldSnapshot(live))));
  assert.ok(!mixed.ok && /different generators/.test(mixed.issues[0]!), "a recipe and snapshot of two generators");
  const setupBase = {
    genre: "Fantasy",
    setting: "A river kingdom",
    tone: "Grim",
    difficulty: "normal",
    rating: "sfw",
    playerGoals: "",
    gmMode: "standalone",
    partyCharacterIds: [],
    worldKit: live.kit,
    world: recipe,
  } as unknown as Parameters<typeof buildGameSetupShareFile>[0]["config"];
  const resources = { characters: [], connections: [], lorebooks: [], personas: [], promptPresets: [] };
  const setupText = (config: Record<string, unknown>) =>
    JSON.stringify(
      buildGameSetupShareFile({ gameName: "Old", config: { ...setupBase, ...config } as typeof setupBase }),
    );
  assert.throws(() => parseGameSetupShareFileJson(setupText({})), "another generator's world without its snapshot");
  const carried = resolveGameSetupImport(parseGameSetupShareFileJson(setupText({ worldSnapshot: older })), resources);
  assert.deepEqual(carried.config.worldSnapshot, older, "a setup file carries the world as it was made");
  assert.throws(
    () =>
      parseGameSetupShareFileJson(
        setupText({ worldSnapshot: { ...older, kit: { ...older.kit, label: "Another kit" } } }),
      ),
    "a snapshot of another kit than the file's",
  );
  const current = resolveGameSetupImport(
    parseGameSetupShareFileJson(
      setupText({ world: { ...recipe, generatorVersion: WORLD_GENERATOR_VERSION }, worldSnapshot: older }),
    ),
    resources,
  );
  assert.equal(current.config.worldSnapshot, undefined, "this generator's world is made from its recipe");
  // An existing game takes no world from a setup file, so it takes none of the world's parts either.
  const existing = resolveGameSetupImport(parseGameSetupShareFileJson(setupText({ worldSnapshot: older })), {
    ...resources,
    isNewGame: false,
  });
  for (const field of ["worldKit", "world", "story", "worldSnapshot"] as const) {
    assert.equal(existing.config[field], undefined, `an existing game takes no ${field} from a setup file`);
  }
}

// ── Two worlds of one recipe keep their own present: one read from its snapshot, one made now ──
{
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
  assert.ok(parsed.ok);
  const live = made(parsed.kit, 77);
  const snapshot = structuredClone(worldSnapshot(live));
  const changed = snapshot.compiled.places.find((place) => place.prosperity && place.prosperity !== "struggling")!;
  changed.prosperity = "struggling";
  const old = gameWorldFromSnapshot(snapshot);
  assert.notEqual(worldPresent(live, []).fortune[changed.id], 20);
  assert.equal(worldPresent(old, []).fortune[changed.id], 20, "the snapshot's own present, never the live world's");
}

// ── A damaged snapshot, or a later one, is refused ──
{
  const parsed = parseWorldKit(WORLD_STARTER_KITS[0]!);
  assert.ok(parsed.ok);
  const snapshot = JSON.parse(JSON.stringify(worldSnapshot(made(parsed.kit, 5))));
  assert.equal(snapshot.snapshotVersion, WORLD_SNAPSHOT_VERSION);
  const refused = (change: (value: Record<string, unknown>) => void, words: RegExp) => {
    const value = structuredClone(snapshot);
    change(value);
    const read = readWorldSnapshot(value);
    assert.ok(!read.ok, `refused: ${words}`);
    assert.match(read.issues.join(" "), words);
  };
  refused((value) => (value.snapshotVersion = WORLD_SNAPSHOT_VERSION + 1), /newer version/);
  // A snapshot made before rooms drawn by hand (version 1) still reads.
  assert.ok(readWorldSnapshot({ ...structuredClone(snapshot), snapshotVersion: 1 }).ok, "a version 1 snapshot reads");
  refused((value) => ((value.compiled as { ground: string }).ground += "0"), /ground does not fill/);
  refused((value) => (value.extra = true), /extra|Unrecognized/i);
  refused((value) => ((value.kit as { id: unknown }).id = 5), /snapshot\.kit/);
  refused((value) => delete value.history, /history/);
  // A world that does not hold together: no reader may walk round in it or off it.
  const places = (value: Record<string, unknown>) =>
    (value.compiled as { places: Array<Record<string, unknown>> }).places;
  refused((value) => {
    const [first, second] = places(value);
    first!.parentId = second!.id;
    second!.parentId = first!.id;
  }, /inside no place above it/);
  refused((value) => ((value.compiled as { startId: string }).startId = "nowhere"), /start is no place/);
  refused((value) => {
    const compiled = value.compiled as { ground: string };
    compiled.ground = "z" + compiled.ground.slice(1);
  }, /terrain it does not have/);
  refused((value) => ((value.casts as Record<string, unknown>).zz9 = []), /people of a place/);
  refused((value) => {
    const towns = value.towns as Record<string, unknown>;
    const [key] = Object.keys(towns);
    towns.zz9 = towns[key!];
  }, /town of no settlement/);
  assert.equal(readWorldSnapshot(null).ok, false);
}

// ── Through the routes ──
const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-save-state-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createGameWorldSnapshotsStorage } =
  await import("../../packages/server/src/services/storage/game-world-snapshots.storage.js");
const { importSTChat } = await import("../../packages/server/src/services/import/st-chat.importer.js");
const { gameRepliesBefore } = await import("../../packages/server/src/services/game/game-market.service.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { gameWorldsRoutes } = await import("../../packages/server/src/routes/game-worlds.routes.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const prompts: string[] = [];
const standIn = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  prompts.push(Buffer.concat(chunks).toString());
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "The square is busy." } }],
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
await app.register(chatsRoutes, { prefix: "/api/chats" });
await app.register(gameWorldsRoutes, { prefix: "/api/game-worlds" });
await app.register(generateRoutes, { prefix: "/api/generate" });
try {
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
  assert.ok(parsed.ok);
  const kit = parsed.kit;
  const live = made(kit, 20261004);
  const snapshots = createGameWorldSnapshotsStorage(db);
  const chats = createChatsStorage(db);
  const connection = await createConnectionsStorage(db).create(
    createConnectionSchema.parse({
      name: "Stand-in",
      provider: "custom",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "stand-in",
      apiKey: "sk-stand-in",
    }),
  );
  const recipe = {
    seed: live.seed,
    generatorVersion: WORLD_GENERATOR_VERSION,
    grounding: live.grounding,
    brief: live.brief,
  };
  const created = await app.inject({
    method: "POST",
    url: "/api/game/create",
    payload: {
      name: "Snapshot",
      connectionId: connection!.id,
      setupConfig: {
        genre: "Fantasy",
        setting: "A river kingdom",
        tone: "Grim",
        difficulty: "normal",
        rating: "sfw",
        playerGoals: "",
        gmMode: "standalone",
        partyCharacterIds: [],
        worldKit: kit,
        world: recipe,
      },
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  const chatId = created.json().sessionChat.id as string;
  const gameId = JSON.parse(created.json().sessionChat.metadata).gameId as string;
  assert.ok(await snapshots.get(chatId), "a game made with a world keeps its snapshot");
  const start = live.world.places.find((place) => place.id === live.world.startId)!;
  const settlement = start.rank !== undefined ? start : live.world.places.find((place) => place.id === start.parentId)!;
  await chats.patchMetadata(chatId, { gameSessionStatus: "active", gameIntroPresented: true });
  await chats.createMessage({
    chatId,
    role: "assistant",
    characterId: null,
    content: `The gates. [place: name="${settlement.name}" result="ok"]`,
  });
  const get = async (id: string, path: string) => {
    const response = await app.inject({ method: "GET", url: `/api/game/${id}/${path}` });
    assert.equal(response.statusCode, 200, `${path}: ${response.body}`);
    return response.json();
  };
  const seen = async (id: string) => ({
    world: (await get(id, "world")).world,
    town: (await get(id, "town")).town,
    journal: (await get(id, "world-journal")).journal,
    people: (await get(id, `world/people?place=${settlement.id}`)).people,
  });
  // Edits saved make the snapshot again: the world shows them at once.
  const renamed = await app.inject({
    method: "PUT",
    url: `/api/game/${chatId}/world/edits`,
    payload: { edits: { editsVersion: 1, places: [{ id: settlement.id, name: "Newbridge" }] } },
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal((await snapshots.get(chatId))!.edits?.places?.[0]?.name, "Newbridge", "the snapshot has the edits");
  const asMade = await seen(chatId);
  assert.equal(
    asMade.world.world.places.find((place: { id: string }) => place.id === settlement.id).name,
    "Newbridge",
    "the screen's world has the edits",
  );
  assert.equal(asMade.world.world.startId, live.world.startId);
  assert.equal(asMade.town.settlementId, settlement.id, "the party is in its town");
  assert.ok(asMade.people.length > 0);
  // A chat file of this generator's world is made from its recipe on import, as its edits are saved later:
  // a snapshot changed by hand in the file never becomes the game's world.
  {
    const file = await app.inject({ method: "GET", url: `/api/chats/${chatId}/export?format=jsonl` });
    assert.equal(file.statusCode, 200, file.body);
    const lines = file.body.split("\n");
    const header = JSON.parse(lines[0]!);
    const sent = header.chat_metadata.marinara_metadata.gameWorldSnapshot;
    assert.equal(sent?.generatorVersion, WORLD_GENERATOR_VERSION, "the file carries this generator's snapshot");
    sent.world.places.find((place: { id: string }) => place.id === settlement.id).name = "Forgedton";
    lines[0] = JSON.stringify(header);
    const forged = (await importSTChat(lines.join("\n"), db)) as { chatId?: string; chat?: { id: string } };
    const forgedId = (forged.chatId ?? forged.chat?.id)!;
    assert.ok(forgedId, JSON.stringify(forged));
    await chats.update(forgedId, { mode: "game" });
    assert.deepEqual((await get(forgedId, "world")).world, asMade.world, "made from its recipe, edits and all");
    assert.equal((await snapshots.get(forgedId))?.world?.places.find((p) => p.id === settlement.id)?.name, "Newbridge");
    await chats.remove(forgedId);
  }

  // The recipe changed under it, and the generator moved on (as after an update).
  await chats.patchMetadata(chatId, {
    gameWorld: {
      ...recipe,
      generatorVersion: WORLD_GENERATOR_VERSION + 1,
      seed: recipe.seed + 1,
      brief: { ...recipe.brief, peopleNames: [] },
    },
  });
  // As an update leaves it: the snapshot made by a generator this Engine no longer is.
  const kept = (await snapshots.get(chatId))!;
  await snapshots.put(chatId, { ...kept, generatorVersion: WORLD_GENERATOR_VERSION + 1 });
  assert.deepEqual(await seen(chatId), asMade, "the same world after the generator moved on");
  for (const [method, path, payload] of [
    ["GET", "world/edit", undefined],
    ["GET", `world/town?settlement=${settlement.id}`, undefined],
    ["GET", `world/interior?settlement=${settlement.id}&building=h0`, undefined],
    ["PUT", "world/edits", { edits: { editsVersion: 1 } }],
  ] as const) {
    const refused = await app.inject({ method, url: `/api/game/${chatId}/${path}`, payload });
    assert.equal(refused.statusCode, 409, `${path} is refused for a world from an earlier generator`);
    assert.match(refused.json().error, /earlier version of the world generator/);
  }
  // Its file carries the snapshot (W11d): read back, it is the world as made, kit, recipe and all.
  const oldFile = await app.inject({ method: "GET", url: `/api/game/${chatId}/world/file` });
  assert.equal(oldFile.statusCode, 200, oldFile.body);
  assert.equal(oldFile.json().world.generatorVersion, WORLD_GENERATOR_VERSION + 1, "the generator that made it");
  const fileRead = readWorldFile(oldFile.body);
  assert.ok(fileRead.ok && fileRead.snapshot, "read from its snapshot");
  assert.deepEqual(gameWorldFromSnapshot(fileRead.snapshot).world, asMade.world.world, "the world as made");
  // Into the library, readable and played as it was made, never edited.
  const library = await app.inject({ method: "POST", url: "/api/game-worlds/import", payload: { text: oldFile.body } });
  assert.equal(library.statusCode, 200, library.body);
  const libraryId = library.json().world.id as string;
  assert.equal(library.json().world.reads, true, "the library reads it");
  const libraryEdit = await app.inject({ method: "GET", url: `/api/game-worlds/${libraryId}/world/edit` });
  assert.equal(libraryEdit.statusCode, 409, "the library will not edit it");
  const libraryFile = await app.inject({ method: "GET", url: `/api/game-worlds/${libraryId}/world/file` });
  assert.deepEqual(libraryFile.json().snapshot, fileRead.snapshot, "the library's file keeps the snapshot");
  // A new game from it is the world as made; its setup never keeps the snapshot in metadata.
  const fromFile = await app.inject({
    method: "POST",
    url: "/api/game/create",
    payload: {
      name: "From the file",
      setupConfig: {
        genre: "Fantasy",
        setting: "A river kingdom",
        tone: "Grim",
        difficulty: "normal",
        rating: "sfw",
        playerGoals: "",
        gmMode: "standalone",
        partyCharacterIds: [],
        worldKit: fileRead.kit,
        world: fileRead.world,
        worldSnapshot: fileRead.snapshot,
      },
    },
  });
  assert.equal(fromFile.statusCode, 200, fromFile.body);
  const fromFileId = fromFile.json().sessionChat.id as string;
  assert.deepEqual((await get(fromFileId, "world")).world.world, asMade.world.world, "a new game in the world as made");
  const fromFileMeta = JSON.parse(fromFile.json().sessionChat.metadata);
  assert.equal(fromFileMeta.gameWorld.generatorVersion, WORLD_GENERATOR_VERSION + 1);
  assert.ok(!JSON.stringify(fromFileMeta).includes('"worldSnapshot"'), "no snapshot in the game's metadata");
  // Without its snapshot, such a world is refused, as before.
  const bare = await app.inject({
    method: "POST",
    url: "/api/game/create",
    payload: {
      name: "Bare",
      setupConfig: {
        genre: "Fantasy",
        setting: "x",
        tone: "Grim",
        difficulty: "normal",
        rating: "sfw",
        playerGoals: "",
        gmMode: "standalone",
        partyCharacterIds: [],
        worldKit: fileRead.kit,
        world: fileRead.world,
      },
    },
  });
  assert.equal(bare.statusCode, 400, "another generator's world with no snapshot");
  // The Game Master is told of the snapshot's people, not people the changed recipe would make.
  const named = asMade.people.find((person: { named: boolean }) => person.named)!;
  const turn = await app.inject({
    method: "POST",
    url: "/api/generate/",
    payload: { chatId, userMessage: "We look around.", streaming: false },
  });
  assert.equal(turn.statusCode, 200, turn.body);
  assert.ok(prompts.join("\n").includes(named.name), "the prompt's people are the snapshot's");

  // Twenty days pass in the first session.
  await chats.createMessage({
    chatId,
    role: "assistant",
    characterId: null,
    content: 'Three weeks on the road. [world: days="20" result="ok"]',
  });
  // A new session plays in the same world.
  await chats.patchMetadata(chatId, {
    gameSessionStatus: "concluded",
    gamePreviousSessionSummaries: [{ summary: "Done." }],
  });
  const started = await app.inject({ method: "POST", url: "/api/game/session/start", payload: { gameId } });
  assert.equal(started.statusCode, 200, started.body);
  const second = started.json().sessionChat.id as string;
  // It folds on from the living world the first session left (W11), not from the carried tags: with them
  // wiped, the twenty days still stand.
  const fold = await snapshots.getFold(second);
  assert.equal(fold?.present.day, 20, "the session starts from the first one's living world");
  const carriedIn = JSON.parse((await chats.getById(second))!.metadata as string).gameLedgerCarry;
  await chats.patchMetadata(second, { gameLedgerCarry: { replies: 3, tags: "" } });
  const secondWorld = gameWorldFromSnapshot((await snapshots.get(second))!);
  assert.equal(
    worldPresent(secondWorld, (await gameRepliesBefore(db, second)).ledger).day,
    20,
    "folded on from the checkpoint",
  );
  // A later session exported and imported again starts from the same living world, folded again from
  // what it carried.
  await chats.patchMetadata(second, { gameLedgerCarry: carriedIn });
  const secondExport = await app.inject({ method: "GET", url: `/api/chats/${second}/export?format=jsonl` });
  const secondImported = (await importSTChat(secondExport.body, db)) as { chatId?: string; chat?: { id: string } };
  const secondImportedId = (secondImported.chatId ?? secondImported.chat?.id)!;
  assert.equal(
    (await snapshots.getFold(secondImportedId))?.present.day,
    20,
    "an imported session keeps its checkpoint",
  );
  assert.deepEqual((await get(second, "world")).world, asMade.world, "the new session's world");
  // A branch of it starts from the same living world.
  const secondBranch = await app.inject({ method: "POST", url: `/api/chats/${second}/branch`, payload: {} });
  assert.equal(secondBranch.statusCode, 200, secondBranch.body);
  const secondBranchId = (secondBranch.json().id ?? secondBranch.json().chat?.id) as string;
  assert.equal((await snapshots.getFold(secondBranchId))?.present.day, 20, "a branch keeps the checkpoint");

  // A branch, and an export imported again, too.
  const branched = await app.inject({ method: "POST", url: `/api/chats/${chatId}/branch`, payload: {} });
  assert.equal(branched.statusCode, 200, branched.body);
  const branch = (branched.json().id ?? branched.json().chat?.id) as string;
  assert.ok(branch, branched.body);
  assert.deepEqual((await get(branch, "world")).world, asMade.world, "the branch's world");
  const exported = await app.inject({ method: "GET", url: `/api/chats/${chatId}/export?format=jsonl` });
  assert.equal(exported.statusCode, 200);
  const imported = await importSTChat(exported.body, db);
  assert.ok(!("error" in imported) || !imported.error, JSON.stringify(imported));
  const importedId = ((imported as { chatId?: string; chat?: { id: string } }).chatId ??
    (imported as { chat?: { id: string } }).chat?.id) as string;
  assert.ok(importedId, JSON.stringify(imported));
  await chats.update(importedId, { mode: "game" });
  assert.deepEqual((await get(importedId, "world")).world, asMade.world, "the imported game's world");

  // Deleting one chat takes only its own snapshot.
  await chats.remove(branch);
  assert.equal(await snapshots.raw(branch), null, "the branch's snapshot went with it");
  assert.ok(await snapshots.get(chatId), "the others keep theirs");
} finally {
  await app.close();
  await closeDB();
  await new Promise<void>((resolve) => standIn.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`world-save-state regression passed (largest snapshot ${Math.round(largest / 1024)} KB)`);
