/**
 * A setting's art and music (worldgen W6f).
 *
 *   - Every kit names the family its art and music live in; folders named for a family the Engine
 *     knows are used only by games of that family, and the bundled fantasy backgrounds and combat
 *     sounds count as fantasy. A game without a kit uses everything, as before.
 *   - Music: a cyberpunk fight never plays the fantasy battle track (nothing plays rather than the
 *     wrong family), and a wuxia game's own tracks count and come first.
 *   - Sounds: a shoot-out is quiet rather than full of swords, unless the family has its own.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_ART_FAMILIES,
  WORLD_STARTER_KITS,
  createConnectionSchema,
  gameArtFamily,
  parseWorldKit,
  scoreMusic,
  worldAssetFamily,
  worldAssetUsable,
  worldAssetsForFamily,
  worldFamilySound,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-art-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { gameAssetsRoutes } = await import("../../packages/server/src/routes/game-assets.routes.js");
const { buildAssetManifest, ensureAssetDirs, GAME_ASSETS_DIR } =
  await import("../../packages/server/src/services/game/asset-manifest.service.js");
const { buildWorldKitWritingPrompt } = await import("../../packages/server/src/services/game/world-kit-writer.js");
const { injectGameGmPromptRuntime } =
  await import("../../packages/server/src/services/generation/game-gm-prompt-runtime.js");

const kits = WORLD_STARTER_KITS.map((input) => {
  const parsed = parseWorldKit(input);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.issues.join("; "));
  return parsed.kit;
});
const kitById = (id: string) => kits.find((kit) => kit.id === id)!;
const BATTLE = "music:combat:fantasy:intense:battle-epic";
const DRUMS = "music:combat:wuxia:intense:war-drums";
const DREAD = "music:exploration:horror:tense:dark-forest";
const FIELD = "music:exploration:fantasy:calm:field-of-dreams";
const GUQIN = "music:exploration:wuxia:calm:guqin";
const TOWN = "music:exploration:slice_of_life:calm:town-peaceful";

try {
  // ── Every kit names its family; the starter kits use the families the Engine knows ──
  assert.deepEqual(Object.fromEntries(kits.map((kit) => [kit.id, kit.family])), {
    high_fantasy: "fantasy",
    wuxia_xianxia: "wuxia",
    modern_day: "modern",
    modern_supernatural: "modern",
    the_1920s: "jazz_age",
    cyberpunk: "scifi",
    space_opera: "scifi",
    post_apocalyptic: "wasteland",
  });
  for (const kit of kits) assert.ok(WORLD_ART_FAMILIES.includes(kit.family), kit.id);
  // A kit saved before families still loads: a starter's takes the starter's family, another uses
  // every folder, as a game without a kit does.
  const { family: _, ...noFamily } = structuredClone(WORLD_STARTER_KITS.find((kit) => kit.id === "cyberpunk")!);
  assert.ok(parseWorldKit(noFamily).ok, "a kit saved before families still loads");
  assert.equal(gameArtFamily({ gameWorldKit: noFamily }), "scifi", "a starter's own family");
  assert.equal(gameArtFamily({ gameWorldKit: { ...noFamily, id: "written" } }), undefined, "every folder");
  assert.equal(gameArtFamily({ gameWorldKit: { ...noFamily, id: "written", family: "steampunk" } }), "steampunk");
  assert.ok(!parseWorldKit({ ...noFamily, family: "Steam Punk" }).ok, "a family is an id");
  assert.equal(gameArtFamily({ gameWorldKit: kitById("cyberpunk") }), "scifi");
  assert.equal(gameArtFamily({}), undefined);

  // ── Which assets belong to a family ──
  const families: Array<[string, string | undefined]> = [
    [BATTLE, "fantasy"],
    [DRUMS, "wuxia"],
    [DREAD, undefined],
    ["music:area:old-mill:theme", undefined],
    ["music:tier:boss:theme", undefined],
    ["backgrounds:scifi:hangar", "scifi"],
    ["backgrounds:user:enchanted_forest", "fantasy"],
    ["backgrounds:user:city_night", "modern"],
    ["backgrounds:user:dark_forest", undefined],
    ["backgrounds:my-forests:glade", undefined],
    ["sprites:generic-fantasy:goblin", "fantasy"],
    ["sfx:combat:sword-swing", "fantasy"],
    ["sfx:combat:scifi:sword-swing", "scifi"],
    ["sfx:ui:click", undefined],
    ["ambient:nature:birds-singing", undefined],
  ];
  for (const [tag, family] of families) assert.equal(worldAssetFamily(tag), family, tag);
  assert.ok(worldAssetUsable(BATTLE, undefined), "a game without a kit uses everything");
  assert.ok(!worldAssetUsable(BATTLE, "scifi"));
  assert.ok(worldAssetUsable(DREAD, "scifi"), "a mood is shared");
  const library = Object.fromEntries([BATTLE, DRUMS, DREAD, FIELD, GUQIN].map((tag) => [tag, { path: tag }]));
  assert.equal(worldAssetsForFamily(library, undefined), library);
  assert.deepEqual(Object.keys(worldAssetsForFamily(library, "wuxia")!), [DRUMS, DREAD, GUQIN]);

  // ── Music: never the wrong family, and the setting's own first ──
  const fight = (family?: string, available = [BATTLE, DRUMS]) =>
    scoreMusic({
      state: "combat",
      musicIntensity: "intense",
      availableMusic: available,
      ...(family ? { family } : {}),
    });
  assert.equal(fight(), BATTLE, "a game without a kit fights to the fantasy track, as before");
  assert.equal(fight("scifi"), null, "a cyberpunk fight plays nothing rather than fantasy");
  assert.equal(fight("wuxia"), DRUMS, "a wuxia family's own track counts though wuxia is not a genre");
  for (let roll = 0; roll < 20; roll++) {
    assert.equal(
      scoreMusic({
        state: "exploration",
        musicIntensity: "calm",
        // A shared calm track fits as well as the setting's own: only the family puts its own first.
        availableMusic: [DREAD, FIELD, TOWN, GUQIN],
        family: "wuxia",
      }),
      GUQIN,
      "the setting's own music before music any setting shares",
    );
  }

  // ── Sounds ──
  assert.equal(worldFamilySound("sfx:combat:sword-swing", undefined, {}), "sfx:combat:sword-swing");
  assert.equal(worldFamilySound("sfx:combat:sword-swing", "fantasy", {}), "sfx:combat:sword-swing");
  assert.equal(worldFamilySound("sfx:combat:sword-swing", "scifi", {}), null, "no swords in a shoot-out");
  assert.equal(
    worldFamilySound("sfx:combat:sword-swing", "scifi", { "sfx:combat:scifi:sword-swing": {} }),
    "sfx:combat:scifi:sword-swing",
  );
  assert.equal(worldFamilySound("sfx:ui:click", "scifi", {}), "sfx:ui:click");

  // ── The server: folders, generated backgrounds, and the scene's music ──
  ensureAssetDirs();
  for (const family of WORLD_ART_FAMILIES) {
    assert.ok(existsSync(join(GAME_ASSETS_DIR, "backgrounds", family)), `a backgrounds folder for ${family}`);
  }
  const put = (relative: string, bytes: Buffer = Buffer.from("x")) => {
    const path = join(GAME_ASSETS_DIR, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  };
  // A one-pixel PNG, so a background already there is used rather than generated again.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6XfbYkAAAAASUVORK5CYII=",
    "base64",
  );
  put("backgrounds/wuxia/teahouse.png", png);
  mkdirSync(join(dataDir, "backgrounds"), { recursive: true });
  for (const name of ["enchanted_forest", "dark_forest"])
    writeFileSync(join(dataDir, "backgrounds", `${name}.jpg`), png);
  put("music/combat/fantasy/intense/battle-epic.mp3");
  put("music/combat/wuxia/intense/war-drums.mp3");
  buildAssetManifest();

  const replies: string[] = [];
  const standIn = createServer(async (req, res) => {
    for await (const _chunk of req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: replies.shift() ?? '{"musicGenre":"fantasy","musicIntensity":"intense"}',
            },
          },
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
  await app.register(gameAssetsRoutes, { prefix: "/api/game-assets" });
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
    const sceneMusic = async (metadata: Record<string, unknown>) => {
      const chat = await chats.create({ name: "Scene", mode: "game", characterIds: [], connectionId: connection!.id });
      await chats.patchMetadata(chat.id, metadata);
      const response = await app.inject({
        method: "POST",
        url: "/api/game/scene-wrap",
        payload: {
          chatId: chat.id,
          narration: "Steel rings in the street.",
          streaming: false,
          context: {
            currentState: "combat",
            availableBackgrounds: [],
            availableSfx: [],
            activeWidgets: [],
            trackedNpcs: [],
            characterNames: [],
            currentBackground: null,
            currentMusic: null,
            currentWeather: null,
            currentTimeOfDay: null,
          },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      return (response.json() as { result: { music?: string | null } | null }).result?.music ?? null;
    };
    assert.equal(await sceneMusic({}), BATTLE, "a game without a kit, as before");
    assert.equal(
      await sceneMusic({ gameWorldKit: kitById("cyberpunk") }),
      null,
      "no fantasy battle in a cyberpunk game",
    );
    assert.equal(await sceneMusic({ gameWorldKit: kitById("wuxia_xianxia") }), DRUMS);

    // Backgrounds through the route: a wuxia game's are filed under wuxia, and when making one fails, a
    // cyberpunk game falls back to a shared background, never the enchanted forest.
    const imageConnection = await createConnectionsStorage(db).create(
      createConnectionSchema.parse({
        name: "Image stand-in",
        provider: "image_generation",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "stand-in",
        apiKey: "sk-stand-in",
      }),
    );
    const backgrounds = async (metadata: Record<string, unknown>, backgroundTag: string) => {
      const chat = await chats.create({ name: "Art", mode: "game", characterIds: [] });
      await chats.patchMetadata(chat.id, {
        ...metadata,
        enableSpriteGeneration: true,
        gameImageConnectionId: imageConnection!.id,
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/game/generate-assets",
        payload: { chatId: chat.id, backgroundTag },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json() as { generatedBackground: string | null; fallbackBackground: string | null };
    };
    assert.equal(
      (await backgrounds({ gameWorldKit: kitById("wuxia_xianxia") }, "teahouse")).generatedBackground,
      "backgrounds:wuxia:teahouse",
      "a wuxia game's backgrounds are filed under wuxia, not fantasy",
    );
    assert.equal((await backgrounds({}, "enchanted glade")).fallbackBackground, "backgrounds:user:enchanted_forest");
    assert.equal(
      (await backgrounds({ gameWorldKit: kitById("cyberpunk") }, "enchanted glade")).fallbackBackground,
      "backgrounds:user:dark_forest",
    );

    // A setting's family may stand where a genre does in a music folder; anything else is still refused.
    const upload = (subcategory: string) =>
      app.inject({
        method: "POST",
        url: "/api/game-assets/upload",
        payload: { category: "music", subcategory, filename: "guqin.mp3", data: Buffer.from("x").toString("base64") },
      });
    assert.equal((await upload("exploration/wuxia/calm")).statusCode, 200);
    assert.equal((await upload("exploration/Wuxia Hall/calm")).statusCode, 400);
    assert.equal((await upload("exploration/wuxia/loud")).statusCode, 400);
  } finally {
    await app.close();
    await closeDB();
    await new Promise<void>((resolve) => standIn.close(() => resolve()));
  }

  // ── A game with a setting kit and no genre is never "fantasy" to the Game Master ──
  const genreLine = async (chatMetadata: Record<string, unknown>) => {
    const messages = [{ role: "system", content: "placeholder" }];
    await injectGameGmPromptRuntime({
      messages,
      chatId: "art",
      chat: {},
      chatMetadata,
      characterIds: [],
      chars: { getById: async () => null, getPersona: async () => null },
      chats: { getById: async () => null, updateMetadata: async () => undefined },
      selectedGameStateSnapshotPromise: Promise.resolve(null),
      mappedMessages: [],
      personaName: "Player",
      resolvePromptMacros: (value: string) => value,
    } as unknown as Parameters<typeof injectGameGmPromptRuntime>[0]);
    return messages
      .map((message) => message.content)
      .join("\n")
      .match(/- Genre: [^\n]*/)?.[0];
  };
  assert.equal(await genreLine({ gameSetupConfig: {}, gameWorldKit: kitById("cyberpunk") }), "- Genre: Cyberpunk.");
  assert.equal(await genreLine({ gameSetupConfig: {} }), "- Genre: fantasy.", "a game without a kit, as before");

  // ── The model writing a kit is asked for its family ──
  assert.match(
    buildWorldKitWritingPrompt({ genre: "Steampunk", setting: "x", tone: "Adventure" }).system,
    /"family" is where the setting's art and music live: one of fantasy, scifi, modern, wuxia, jazz_age, wasteland/,
  );

  console.log("World kit art: each setting's own art, music and sounds, never another family's.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
