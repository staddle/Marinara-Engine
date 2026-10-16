/**
 * The towns (worldgen W8b).
 *
 *   - A settlement is laid out from the seed: streets, a square, buildings on lots that never overlap
 *     each other, the streets or the square, each with its door on a street. The places in it (the
 *     world's own and those the story added) are buildings, a bigger place has its hall, the trades it is
 *     known for have workplaces, and everyone has a home.
 *   - People are at work by day, out at dusk, at home at night.
 *   - A walk across town passes its minutes on the clock and is told on the next turn; a visit to a named
 *     place makes it the place in force; a regeneration tells it again.
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
  worldPresent,
  worldIsSite,
  worldTown,
  worldTownDoor,
  worldTownMinutes,
  worldTownTier,
  worldTownWhere,
  type GameWorld,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-towns-"));
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
  // ── Every starter world's towns are well laid out ──
  for (const kit of WORLD_STARTER_KITS) {
    const game = gameOf(kit.id, 31);
    const settlements = game.world.places.filter((place) => place.rank !== undefined);
    for (const settlement of settlements) {
      const town = worldTown(game, settlement.id)!;
      const label = `${kit.id} ${settlement.name}`;
      assert.deepEqual(worldTown(game, settlement.id), town, `${label}: the same world, the same town`);
      assert.equal(town.ground.length, town.width * town.height);
      const used = new Map<number, string>();
      for (const building of town.buildings) {
        assert.ok(building.x >= 0 && building.y >= 0, label);
        assert.ok(building.x + building.w <= town.width && building.y + building.h <= town.height, label);
        for (let y = building.y; y < building.y + building.h; y++)
          for (let x = building.x; x < building.x + building.w; x++) {
            const cell = y * town.width + x;
            assert.equal(town.ground[cell], ".", `${label}: ${building.id} on open ground`);
            assert.ok(!used.has(cell), `${label}: ${building.id} overlaps ${used.get(cell)}`);
            used.set(cell, building.id);
          }
        const door = town.ground[building.door.y * town.width + building.door.x];
        assert.ok(door === "s" || door === "q", `${label}: ${building.id}'s door is on a street`);
        const beside =
          building.door.x >= building.x - 1 &&
          building.door.x <= building.x + building.w &&
          building.door.y >= building.y - 1 &&
          building.door.y <= building.y + building.h;
        assert.ok(beside, `${label}: ${building.id}'s door is at the building`);
      }
      // The places in town are buildings; everyone has a home.
      // (A site a few steps out of town, generator 2, is on the overworld instead.)
      for (const inside of game.world.places.filter(
        (place) => place.parentId === settlement.id && !worldIsSite(game, place.id),
      )) {
        assert.ok(
          town.buildings.some((building) => building.placeId === inside.id),
          `${label}: ${inside.name} is in town`,
        );
      }
      for (const person of town.people) assert.ok(town.homeOf[person.id], `${label}: ${person.name} has a home`);
      if (worldTownTier(game, settlement) >= 2) {
        assert.ok(
          town.buildings.some((building) => building.kind === "landmark"),
          `${label}: its hall`,
        );
      }
      assert.equal(worldTownMinutes(town, "square", "square") >= 1, true);
    }
  }

  // ── Where people are by the hour ──
  const game = gameOf("high_fantasy", 21);
  const settlements = game.world.places.filter((place) => place.rank !== undefined);
  const city = settlements.reduce((best, place) => (place.rank! > best.rank! ? place : best));
  const town = worldTown(game, city.id)!;
  const worker = town.people.find((person) => town.workOf[person.id])!;
  assert.ok(worker, "someone works in the city");
  assert.equal(worldTownWhere(town, worker.id, 10), town.workOf[worker.id], "at work by day");
  // At dusk a third of the town is in the square, a third at the first tavern and a third at home, each
  // person always the same third (worldgen W13 split the evening); a tavern's own staff are at work.
  const taverns = town.buildings
    .filter((building) => building.kind !== "home" && building.use === "tavern")
    .map((building) => building.id);
  const third = (id: string) => [...id].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7) % 3;
  const evening = town.people.filter((person) => !taverns.includes(town.workOf[person.id] ?? ""));
  for (const person of evening) {
    const home = town.homeOf[person.id];
    const expected =
      third(person.id) === 1 && taverns[0] ? taverns[0] : third(person.id) === 2 && home ? home : "square";
    assert.equal(worldTownWhere(town, person.id, 19), expected, `${person.id} at dusk`);
  }
  assert.ok(
    evening.some((person) => worldTownWhere(town, person.id, 19) === "square"),
    "someone is in the square at dusk",
  );
  assert.equal(worldTownWhere(town, worker.id, 23), town.homeOf[worker.id], "home at night");
  const known = game.kit.people?.roles.find((role) => role.tags?.some((tag) => city.tags.includes(tag)));
  if (known && town.people.some((person) => person.role === known.label)) {
    assert.ok(
      town.buildings.some((building) => building.kind === "work" && building.role === known.label),
      "the trade the place is known for has its workplace",
    );
  }
  // A place the story added in the city is a building there.
  const present = worldPresent(game, []);
  present.places.push({ id: "x1", name: "The Gilded Gull", parentId: city.id } as never);
  const withInn = worldTown(game, city.id, present)!;
  assert.ok(withInn.buildings.some((building) => building.placeId === "x1" && building.name === "The Gilded Gull"));
  // The town as the world laid it out does not move for it: every building keeps its lot and id, and only
  // an empty home gives way to it (keeping its id, so a party saved standing there is still in town).
  for (const building of town.buildings) {
    const same = withInn.buildings.find((each) => each.id === building.id);
    assert.ok(same, building.id);
    assert.deepEqual([same.x, same.y], [building.x, building.y], building.id);
    if (same.kind !== building.kind) {
      assert.deepEqual([building.kind, building.people.length, same.placeId], ["home", 0, "x1"], building.id);
    }
  }
  assert.equal(
    worldTownMinutes(town, town.buildings[0]!.id, town.buildings.at(-1)!.id),
    worldTownMinutes(town, town.buildings.at(-1)!.id, town.buildings[0]!.id),
    "the same walk both ways",
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
    const chat = await chats.create({ name: "Town", mode: "game", characterIds: [], connectionId: connection!.id });
    const chatId = chat.id;
    await chats.patchMetadata(chatId, {
      gameId: `town-${chatId}`,
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameWorldKit: game.kit,
      gameWorld: { seed: game.seed, generatorVersion: WORLD_GENERATOR_VERSION, grounding: "expand", brief: game.brief },
      gameTime: { day: 1, hour: 10, minute: 0 },
    });
    // The party is in the city.
    await chats.createMessage({
      chatId,
      role: "assistant",
      content: `The gates. [place: name="${city.name}" result="ok"]`,
    });
    const meta = async () => JSON.parse((await chats.getById(chatId))!.metadata as string) as Record<string, any>;
    const read = async () => (await app.inject({ method: "GET", url: `/api/game/${chatId}/town` })).json().town;
    const visit = (to: string) =>
      app.inject({ method: "POST", url: `/api/game/${chatId}/town/visit`, payload: { to } });
    const turn = async (reply: string, extra: Record<string, unknown> = {}) => {
      replies.push(reply);
      prompts.length = 0;
      const response = await app.inject({
        method: "POST",
        url: "/api/generate/",
        payload: { chatId, userMessage: "We look around.", streaming: false, ...extra },
      });
      assert.equal(response.statusCode, 200, response.body);
    };
    const minutesOf = (time: { day: number; hour: number; minute: number }) =>
      (time.day * 24 + time.hour) * 60 + time.minute;

    const first = await read();
    assert.equal(first.settlementId, city.id, "the town the party is in");
    assert.equal(first.at, "square", "the party starts in the square");
    assert.equal((await visit("square")).statusCode, 400, "already there");
    assert.equal((await visit("b999")).statusCode, 400, "no such place");

    // Walk to a workplace: the minutes pass, the party stands there, the next turn tells it.
    const work = town.buildings.find((building) => building.kind === "work" || building.kind === "landmark")!;
    const before = minutesOf((await meta()).gameTime);
    const walked = await visit(work.id);
    assert.equal(walked.statusCode, 200, walked.body);
    const minutes = worldTownMinutes(town, "square", work.id);
    assert.equal(minutesOf((await meta()).gameTime) - before, minutes, "the walk's minutes on the clock");
    assert.equal((await read()).at, work.id, "the party stands there");
    const pending = (await meta()).gameTownVisit;
    await turn("Smoke and hammering.");
    assert.match(prompts.join("\n"), new RegExp(`In ${city.name}, the party has walked to`, "u"));
    assert.match(prompts.join("\n"), /That time is counted already/);
    assert.equal((await meta()).gameTownVisit, null, "told, no longer pending");
    const saved = (await chats.listMessages(chatId)).filter((m: any) => m.role === "assistant").at(-1)!;
    assert.equal(JSON.parse(saved.extra as string).worldTownVisit.id, pending.id, "kept with the reply");
    await turn("Sparks.", { regenerateMessageId: saved.id, userMessage: undefined });
    assert.match(prompts.join("\n"), new RegExp(`In ${city.name}, the party has walked to`, "u"), "told again");

    // A visit to a named place in town (one the story added) makes it the place in force.
    await chats.createMessage({
      chatId,
      role: "assistant",
      content: `A sign creaks. [world: fact="place" name="The Gilded Gull" in="${city.name}" result="ok"]`,
    });
    const inn = (await read()).buildings.find((building: { name?: string }) => building.name === "The Gilded Gull");
    assert.ok(inn, "the added place is a building in town");
    const innVisit = await visit(inn.id);
    assert.equal(innVisit.statusCode, 200, innVisit.body);
    await turn("Warm light and ale.");
    assert.match(prompts.join("\n"), /The party is in The Gilded Gull/u, "the Game Master is told the party is there");
    const told = (await chats.listMessages(chatId))
      .filter((m: any) => m.role === "assistant")
      .map((m: any) => m.content);
    assert.equal(lastGamePlace(told)?.name, "The Gilded Gull", "the place in force is the inn");
    assert.equal((await read()).at, inn.id, "and the town has the party there");
    assert.ok(worldTownDoor(withInn, "square"));

    // A visit in the city, then a walk away before the turn: told in that order, and the party ends up
    // where it walked, not where it visited.
    // (To the square and back to the inn, so the visit told before the walk names a place.)
    assert.equal((await visit("square")).statusCode, 200);
    assert.equal((await visit(inn.id)).statusCode, 200);
    const away = game.world.links.find((link) => link.from === city.id || link.to === city.id)!;
    const next = game.world.places.find((place) => place.id === (away.from === city.id ? away.to : away.from))!;
    const left = await app.inject({
      method: "POST",
      url: `/api/game/${chatId}/overworld/walk`,
      payload: { to: next.id },
    });
    assert.equal(left.statusCode, 200, left.body);
    await turn("The road again.");
    const order = prompts.join("\n");
    const [visitAt, walkAt] = [
      order.indexOf(`In ${city.name}, the party has walked to`),
      order.indexOf("On the overworld"),
    ];
    assert.ok(visitAt >= 0 && walkAt > visitAt, "the visit, then the walk");
    assert.match(order, new RegExp(`The party is in ${next.name}`, "u"), "where it walked");
    const after = (await chats.listMessages(chatId))
      .filter((m: any) => m.role === "assistant")
      .map((m: any) => m.content);
    assert.equal(lastGamePlace(after)?.name, next.name, "the place in force is where it walked");
  } finally {
    await app.close();
    await closeDB();
    await new Promise<void>((resolve) => standIn.close(() => resolve()));
  }

  console.log("World towns: settlements are laid out from the seed, and walks across town are told next turn.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
