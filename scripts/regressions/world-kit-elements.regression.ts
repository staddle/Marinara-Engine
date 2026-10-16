/**
 * Elements in the setting's own words (worldgen W6c).
 *
 *   - A game with no kit, or a kit that names none, fights with the classic six exactly as before; a
 *     word another telling uses ("pyro") is read as the classic element, so the screen and the fight
 *     agree.
 *   - A kit's elements are one set for every reader: the classic fight's reactions, the tactical wheel,
 *     how rain treats an element, and the model's words when it builds a fight; a kit with an empty list
 *     has no elemental attacks at all.
 *   - A kit's elements are checked: no two share a name, and what beats and reactions name is its own.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_DEFAULT_ELEMENTS,
  WORLD_STARTER_KITS,
  createConnectionSchema,
  createTacticalCombat,
  elementMultiplier,
  gameWorldElementSet,
  parseWorldKit,
  weatherDamageMultiplier,
  worldElementId,
  worldElementSet,
  type CombatWeather,
  type Combatant,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-elements-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { getElementPreset, resolveElementApplication } =
  await import("../../packages/server/src/services/game/element-reactions.service.js");
const { buildInitPrompt, encounterRoutes } = await import("../../packages/server/src/routes/encounter.routes.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { buildWorldKitWritingPrompt } = await import("../../packages/server/src/services/game/world-kit-writer.js");

const kits = WORLD_STARTER_KITS.map((input) => {
  const parsed = parseWorldKit(input);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.issues.join("; "));
  return parsed.kit;
});
const kitById = (id: string) => kits.find((kit) => kit.id === id)!;
const storm: CombatWeather = { version: 1, type: "storm", wind: "windy", visibility: "reduced", exposure: "exposed" };

// ── The classic six, as every game had them ──
{
  const classic = getElementPreset("default");
  assert.deepEqual(
    classic.elements.map((element) => element.id),
    ["fire", "ice", "lightning", "poison", "holy", "shadow"],
  );
  assert.equal(classic.reactions.length, 8);
  const melt = resolveElementApplication({ element: "fire", gauge: 1, sourceId: "a" }, "ice", "b").reaction;
  assert.equal(melt?.reaction, "Melt");
  assert.equal(melt?.damageMultiplier, 1.5);
  // A word another telling uses is the classic element: the screen calls fire "pyro".
  assert.equal(
    resolveElementApplication({ element: "pyro", gauge: 1, sourceId: "a" }, "cryo", "b").reaction?.reaction,
    "Melt",
    "pyro and cryo are fire and ice",
  );
  assert.equal(worldElementId(WORLD_DEFAULT_ELEMENTS, "Electro"), "lightning");
  assert.equal(worldElementId(WORLD_DEFAULT_ELEMENTS, "hydro"), undefined, "no classic element is water");
  // Rain damps fire and feeds lightning, by whatever word.
  assert.equal(weatherDamageMultiplier(storm, "fire"), 0.85);
  assert.equal(weatherDamageMultiplier(storm, "pyro"), 0.85);
  assert.equal(weatherDamageMultiplier(storm, "lightning"), 1.15);
  assert.equal(weatherDamageMultiplier(storm, "ice"), 1);
  // The classic tactical wheel.
  assert.equal(elementMultiplier("fire", "ice"), 1.5);
  assert.equal(elementMultiplier("ice", "fire"), 0.5);
  assert.equal(elementMultiplier("holy", "shadow"), 1.5);
  assert.equal(elementMultiplier("shadow", "holy"), 1.5);
  assert.equal(elementMultiplier("poison", "fire"), 1);
  assert.equal(elementMultiplier("pyro", "cryo"), 1.5);
  // A game with no kit, or a kit that names none, carries no set of its own.
  assert.equal(gameWorldElementSet({}), undefined);
  assert.equal(gameWorldElementSet({ gameWorldKit: kitById("high_fantasy") }), undefined);
  assert.equal(worldElementSet(kitById("high_fantasy")), WORLD_DEFAULT_ELEMENTS);
  // Every game shares the defaults, so no reader can change them.
  assert.throws(() => {
    (WORLD_DEFAULT_ELEMENTS.reactions[0] as { damageMultiplier: number }).damageMultiplier = 9;
  });
  assert.throws(() => {
    (WORLD_DEFAULT_ELEMENTS.beats.fire as string[]).push("shadow");
  });
  assert.equal(WORLD_DEFAULT_ELEMENTS.reactions[0]!.damageMultiplier, 1.5);
}

// ── A kit's own elements, one set for every reader ──
{
  const wuxia = worldElementSet(kitById("wuxia_xianxia"));
  assert.deepEqual(
    wuxia.elements.map((element) => element.id),
    ["wood", "fire", "earth", "metal", "water"],
  );
  assert.deepEqual(gameWorldElementSet({ gameWorldKit: kitById("wuxia_xianxia") }), wuxia);
  // The overcoming cycle in a tactical fight.
  assert.equal(elementMultiplier("Water", "Fire", wuxia), 1.5);
  assert.equal(elementMultiplier("Fire", "Water", wuxia), 0.5);
  assert.equal(elementMultiplier("Wood", "Water", wuxia), 1);
  assert.equal(elementMultiplier("fire", "ice", wuxia), 1, "the classic wheel is not this setting's");
  // Its reactions, by its own words.
  const growth = resolveElementApplication({ element: "Water", gauge: 1, sourceId: "a" }, "wood", "b", wuxia).reaction;
  assert.equal(growth?.reaction, "Entangling Growth");
  assert.equal(growth?.damageMultiplier, 1.4);
  assert.equal(
    resolveElementApplication({ element: "fire", gauge: 1, sourceId: "a" }, "ice", "b", wuxia).reaction,
    null,
    "no classic reaction in this setting",
  );
  // How rain treats its elements.
  const cyber = worldElementSet(kitById("cyberpunk"));
  assert.equal(weatherDamageMultiplier(storm, "Thermal", cyber), 0.85);
  // The fight's AI weighs its blows by the same set.
  const { estimateClassicAttack } = await import("../../packages/server/src/services/game/combat-ai.service.js");
  const raider = {
    id: "r",
    name: "r",
    hp: 30,
    maxHp: 30,
    attack: 20,
    defense: 2,
    speed: 5,
    level: 3,
    element: "Thermal",
  };
  const target = { ...raider, id: "t", name: "t", element: undefined };
  assert.ok(
    estimateClassicAttack(raider as never, target as never, undefined, "normal", storm, cyber).damage <
      estimateClassicAttack(raider as never, target as never, undefined, "normal", storm).damage,
    "rain damps a hot element in the AI's estimate too",
  );
  assert.equal(weatherDamageMultiplier(storm, "em", cyber), 1.15);
  assert.equal(weatherDamageMultiplier(storm, "Kinetic", cyber), 1);
  assert.equal(weatherDamageMultiplier(storm, "fire", cyber), 1, "fire is not one of its elements");
  // A tactical fight keeps the set it was made with.
  const unit = (id: string, side: "player" | "enemy", element: string): Combatant =>
    ({
      id,
      name: id,
      side,
      hp: 30,
      maxHp: 30,
      attack: 8,
      defense: 4,
      speed: 5,
      level: 1,
      skills: [],
      element,
    }) as Combatant;
  const fight = createTacticalCombat([unit("Hero", "player", "Water")], [unit("Brute", "enemy", "Fire")], {
    seed: 7,
    difficulty: "normal",
    elements: wuxia,
  });
  assert.deepEqual(fight.elements, wuxia);
  // A setting with an empty list has no elemental attacks at all.
  const modern = worldElementSet(kitById("modern_day"));
  assert.deepEqual(modern.elements, []);
  assert.equal(elementMultiplier("fire", "ice", modern), 1);
}

// ── The model is told the setting's elements when it builds a fight ──
{
  const build = (elements?: ReturnType<typeof worldElementSet>) =>
    buildInitPrompt("Ada", "", "", [], "", "", false, undefined, null, { guess: true, ruleset: [] }, elements)
      .map((message) => message.content)
      .join("\n");
  assert.match(build(), /"element": "optional"/);
  assert.match(
    build(worldElementSet(kitById("wuxia_xianxia"))),
    /"element": "optional, one of Wood, Fire, Earth, Metal, Water"/,
  );
  assert.match(build(worldElementSet(kitById("modern_day"))), /"element": "leave out"/);
  assert.doesNotMatch(build(worldElementSet(kitById("modern_day"))), /"element": "optional/);
  const writing = buildWorldKitWritingPrompt({ genre: "Wuxia", setting: "A river of sects", tone: "Epic" });
  assert.match(writing.system, /"elements" are what an elemental attack can be/);
}

// ── A kit's elements are checked ──
{
  const base = structuredClone(WORLD_STARTER_KITS.find((kit) => kit.id === "wuxia_xianxia")!);
  const issues = (patch: Record<string, unknown>) => {
    const parsed = parseWorldKit({ ...base, ...patch });
    return parsed.ok ? [] : parsed.issues;
  };
  assert.ok(issues({ elements: [{ label: "Wood" }, { label: "wood" }] }).some((issue) => /share a name/.test(issue)));
  assert.ok(
    issues({ elements: [{ label: "Wood", beats: ["Void"] }], reactions: [] }).some((issue) =>
      /Beats "Void", which is not one of the kit's elements/.test(issue),
    ),
  );
  assert.ok(
    issues({ reactions: [{ on: "Wood", with: "Void", label: "X", times: 1.2 }] }).some((issue) =>
      /Names "Void", which is not one of the kit's elements/.test(issue),
    ),
  );
  assert.ok(
    issues({ elements: undefined, reactions: [{ on: "Wood", with: "Fire", label: "X", times: 1.2 }] }).some((issue) =>
      /Reactions need the kit's elements/.test(issue),
    ),
  );
  assert.ok(issues({ elements: [{ label: "Wood", color: "green" }], reactions: [] }).length > 0, "a color is #rrggbb");
  assert.deepEqual(issues({ elements: [], reactions: undefined }), [], "a setting may have no elements");
}

// ── A game's own elements reach its fights through the routes ──
{
  // A stand-in model that only records what it is asked.
  const requests: Array<{ messages: Array<{ content: string }> }> = [];
  const standIn = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "{}" } }] }),
    );
  });
  await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
  const address = standIn.address();
  assert.ok(address && typeof address !== "string");
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  await app.register(encounterRoutes, { prefix: "/api/encounter" });
  try {
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
    const chat = await chats.create({
      name: "Five phases",
      mode: "game",
      characterIds: [],
      connectionId: connection!.id,
    });
    await chats.patchMetadata(chat.id, {
      gameWorldKit: kitById("wuxia_xianxia"),
      gameSetupConfig: { difficulty: "normal" },
    });
    const fighter = (id: string, side: "player" | "enemy", extra: Record<string, unknown>) => ({
      id,
      name: id,
      side,
      hp: 500,
      maxHp: 500,
      attack: 40,
      defense: 1,
      speed: side === "player" ? 50 : 1,
      level: 5,
      skills: [],
      ...extra,
    });
    // Wood landing on a Water aura is this setting's Entangling Growth, every time the blow lands.
    let hits = 0;
    for (let attempt = 0; attempt < 20 && hits < 3; attempt++) {
      const response = await app.inject({
        method: "POST",
        url: "/api/game/combat/round",
        payload: {
          chatId: chat.id,
          round: 1,
          combatants: [
            fighter("Hero", "player", { element: "wood" }),
            fighter("Bandit", "enemy", { elementAura: { element: "water", gauge: 1, sourceId: "gm" } }),
          ],
          playerAction: { type: "attack", targetId: "Bandit" },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      const { result } = response.json() as {
        result: { actions: Array<{ attackerId: string; isMiss?: boolean }>; reactions: Array<{ reaction: string }> };
      };
      const blow = result.actions.find((action) => action.attackerId === "Hero");
      if (!blow || blow.isMiss) continue;
      hits += 1;
      assert.deepEqual(
        result.reactions.map((reaction) => reaction.reaction),
        ["Entangling Growth"],
      );
    }
    assert.ok(hits > 0, "the hero's blow lands at least once in twenty rounds");
    // A tactical fight starts with the setting's set.
    const tactical = await app.inject({
      method: "POST",
      url: "/api/game/combat/tactical/start",
      payload: {
        chatId: chat.id,
        party: [fighter("Hero", "player", { element: "water" })],
        enemies: [fighter("Bandit", "enemy", { element: "fire" })],
        seed: 7,
      },
    });
    assert.equal(tactical.statusCode, 200, tactical.body);
    const state = (tactical.json() as { state: { elements?: { elements: Array<{ id: string }> } } }).state;
    assert.deepEqual(
      state.elements?.elements.map((element) => element.id),
      ["wood", "fire", "earth", "metal", "water"],
    );
    // A directed fight keeps the set, and so does the tactical field it lays out.
    const { createCombatDirector } = await import("../../packages/server/src/services/game/combat-director.service.js");
    const wuxia = worldElementSet(kitById("wuxia_xianxia"));
    const directed = createCombatDirector({
      id: "fight",
      anchor: "anchor",
      party: [fighter("Hero", "player", { element: "water" })] as never,
      enemies: [fighter("Bandit", "enemy", { element: "fire" })] as never,
      style: "tactical",
      gm: false,
      difficulty: "normal",
      seed: 7,
      elements: wuxia,
    });
    assert.deepEqual(directed.elements, wuxia);
    // A state the client sends back with a malformed set is refused, never read.
    const broken = { ...state, elements: { elements: "wood" } };
    const refused = await app.inject({
      method: "POST",
      url: "/api/game/combat/tactical/action",
      payload: { chatId: chat.id, state: broken, action: { type: "wait" } },
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.match(refused.json().error, /state\.elements/, "refused by the check, not by the engine choking on it");
    // The model building a fight in this game is told its five phases.
    await app.inject({ method: "POST", url: "/api/encounter/init", payload: { chatId: chat.id, settings: {} } });
    assert.equal(requests.length, 1, "the fight builder reached the model");
    assert.match(
      requests[0]!.messages.map((message) => message.content).join("\n"),
      /"element": "optional, one of Wood, Fire, Earth, Metal, Water"/,
    );
    assert.deepEqual(directed.tactical?.elements, wuxia);
  } finally {
    await app.close();
    await closeDB();
    await new Promise<void>((resolve) => standIn.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log(
  "World kit elements: one set for the fight, the wheel, the weather and the model's words, the classic six by default.",
);
