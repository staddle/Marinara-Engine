/**
 * One place, the world's and the map's (worldgen W7).
 *
 *   - The place in force is where the game's map has the party when that is one of the world's places
 *     (an atlas made from the world), else the place the replies last named; read as an answered place
 *     tag reads it, on the market's ladder.
 *   - The World tab reads it so, under World Maps.
 *   - A reply that names a world place on the map moves the map there, unless the reply moved the map
 *     itself; a game whose map is not the world's is left alone.
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
  gameInventoryNameKey,
  parseWorldKit,
  worldCast,
  worldPlaceInForce,
  worldSpatialDraft,
  type GameWorld,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-one-place-"));
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
const { registerCapabilityService, resetCapabilityServices } =
  await import("../../packages/server/src/services/capability-packages/capability-service-registry.service.js");

const kit = (() => {
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
  assert.ok(parsed.ok);
  return parsed.kit;
})();
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
const inputs = { kit, seed: 21, grounding: "expand" as const, brief: checked.brief };
const game: GameWorld = { ...inputs, world: compileGameWorld(inputs) };
const settlements = game.world.places.filter((place) => place.rank !== undefined);
const [here, there] = [settlements[0]!, settlements[1]!];
const atlas = worldSpatialDraft(game).definition;

try {
  // ── The place in force ──
  const named = { name: there.name, size: "said" };
  assert.deepEqual(
    worldPlaceInForce(game, named, here.id),
    { name: here.name, size: here.size },
    "the map's world place",
  );
  assert.equal(
    worldPlaceInForce(game, named, "loc_somewhere_else"),
    named,
    "a map place the world lacks: the named one",
  );
  assert.equal(worldPlaceInForce(game, named, undefined), named, "no map: the named one");
  assert.equal(worldPlaceInForce(null, named, here.id), named, "no world: the named one");
  const ladder = [{ id: "small" }, { id: "big" }];
  assert.ok(["small", "big"].includes(worldPlaceInForce(game, null, here.id, ladder)!.size!), "on the market's ladder");

  // ── Under a stand-in World Maps: the map at `here`, the replies last naming `there` ──
  const mapAt = here.id;
  const moves: unknown[] = [];
  registerCapabilityService("hierarchical-maps:projection", {
    resolveOwnerSpatialProjection: async () => ({
      kind: "owner",
      currentLocationId: mapAt,
      breadcrumb: [],
      destinations: [],
    }),
    buildOwnerSpatialProjection: () => null,
    formatOwnerSpatialBreadcrumb: () => "",
    formatOwnerSpatialPrompt: () => "",
    injectOwnerSpatialPrompt: (messages: unknown) => messages,
    projectGameSnapshotLocation: (snapshot: unknown) => snapshot,
    omitAuthoritativeGameLocation: (patch: unknown) => patch,
  });
  registerCapabilityService("hierarchical-maps:state-resolution", {
    parseStoredSpatialDefinition: (metadata: Record<string, unknown>) =>
      (metadata?.spatialContext as typeof atlas | undefined) ?? null,
    materializeAssistantSpatialState: async (input: { directive?: unknown }) => {
      moves.push(input.directive ?? null);
      return null;
    },
  });

  const replies: string[] = [];
  const prompts: string[] = [];
  const standIn = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    prompts.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: replies.shift() ?? "Rain." } },
        ],
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
    const newGame = async (spatialContext: unknown) => {
      const chat = await chats.create({ name: "Place", mode: "game", characterIds: [], connectionId: connection!.id });
      await chats.patchMetadata(chat.id, {
        gameId: `place-${chat.id}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        enableAgents: true,
        activeAgentIds: ["hierarchical-maps"],
        gameWorldMapMode: "hierarchical",
        gameWorldKit: kit,
        gameWorld: {
          seed: game.seed,
          generatorVersion: WORLD_GENERATOR_VERSION,
          grounding: "expand",
          brief: game.brief,
        },
        spatialContext,
      });
      await chats.createMessage({
        chatId: chat.id,
        role: "assistant",
        content: `Rain on the road. [place: name="${there.name}" result="ok"]`,
      });
      return chat.id;
    };

    // The World tab: the map's world place is where the party is, whatever the replies last named.
    const chatId = await newGame(atlas);
    const tab = await app.inject({ method: "GET", url: `/api/game/${chatId}/world-journal` });
    assert.equal(tab.statusCode, 200, tab.body);
    assert.equal(tab.json().journal.where[0], here.name);

    // A reply naming a world place on the map moves the map there.
    const turn = async (id: string, reply: string) => {
      moves.length = 0;
      replies.push(reply);
      const response = await app.inject({
        method: "POST",
        url: "/api/generate/",
        payload: { chatId: id, userMessage: "We go on.", streaming: false },
      });
      assert.equal(response.statusCode, 200, response.body);
      return moves.at(-1);
    };
    // The Game Master is told the party is where the map has it, not where the replies last named.
    prompts.length = 0;
    // Someone of the map's place, named in full, is someone met there (the people of the place in force).
    const local = worldCast(game, here.id).find(
      (person) => person.named && !worldCast(game, there.id).some((other) => other.name === person.name),
    )!;
    assert.ok(local, "a person of the map's place who is not also of the named place");
    await turn(chatId, `${local.name} waves from the doorway.`);
    assert.match(prompts.join("\n"), new RegExp(`The party is in ${here.name}`, "u"));
    const npcs = JSON.parse((await chats.getById(chatId))!.metadata as string).gameNpcs as Array<{ worldId?: string }>;
    assert.ok(
      npcs.some((npc) => npc.worldId === local.id),
      "met at the map's place",
    );

    assert.deepEqual(await turn(chatId, `The road bends. [place: name="${there.name}"]`), {
      type: "move",
      destinationId: there.id,
    });
    // A move the reply made itself is the one kept.
    assert.deepEqual(
      await turn(chatId, `[spatial_move: destination="${here.id}"] They turn back. [place: name="${there.name}"]`),
      { type: "move", destinationId: here.id },
    );
    // A game with a market but no world answers place tags without a world to map them on.
    const marketOnly = await newGame(atlas);
    await chats.patchMetadata(marketOnly, { gameWorld: null });
    assert.equal(await turn(marketOnly, `They reach the square. [place: name="${there.name}" size="town"]`), null);
    // A location renamed on the map is still the world's place, and the map still follows it.
    const renamed = {
      ...atlas,
      locations: atlas.locations.map((location) => ({ ...location, name: `${location.name} (renamed)` })),
    };
    assert.deepEqual(await turn(await newGame(renamed), `On. [place: name="${there.name}"]`), {
      type: "move",
      destinationId: there.id,
    });
    // A map that is not the world's (its own ids) is left alone.
    const own = (id: string) => `loc_${id}`;
    const otherMap = {
      ...atlas,
      startingLocationId: atlas.startingLocationId ? own(atlas.startingLocationId) : null,
      locations: atlas.locations.map((location) => ({
        ...location,
        id: own(location.id),
        parentId: location.parentId ? own(location.parentId) : null,
        links: location.links.map((link) => ({ ...link, targetId: own(link.targetId) })),
      })),
    };
    assert.equal(await turn(await newGame(otherMap), `On. [place: name="${there.name}"]`), null);

    // With a ruleset's market where the map has the party (and the replies last named somewhere else),
    // each reply says it was at that world place, so the market day there runs on across turns.
    {
      const { readFileSync } = await import("node:fs");
      const { createGameRulesetsStorage } =
        await import("../../packages/server/src/services/storage/game-rulesets.storage.js");
      const gravewatch = JSON.parse(
        readFileSync(new URL("../../docs/examples/rulesets/gravewatch.json", import.meta.url), "utf8"),
      ) as { version: number };
      await createGameRulesetsStorage(db).put({
        rulesetId: "local/gravewatch-world",
        version: gravewatch.version,
        sourceKind: "local",
        definition: JSON.stringify({ ...gravewatch, id: "gravewatch-world" }),
      });
      const traded = await newGame(atlas);
      await chats.patchMetadata(traded, {
        gameRuleset: { id: "local/gravewatch-world", version: gravewatch.version, packageId: null, options: {} },
      });
      await turn(traded, "They browse the stalls.");
      const last = (await chats.listMessages(traded)).filter((message) => message.role === "assistant").at(-1)!;
      assert.ok(
        String(JSON.parse(last.extra as string).gameMarketPlace).startsWith(
          `world|${gameInventoryNameKey(here.name)}|`,
        ),
        last.extra as string,
      );
    }
  } finally {
    await app.close();
    await closeDB();
    await new Promise<void>((resolve) => standIn.close(() => resolve()));
  }

  console.log("World one place: the map's world place is in force, and the map follows the places the story names.");
} finally {
  resetCapabilityServices();
  rmSync(dataDir, { recursive: true, force: true });
}
