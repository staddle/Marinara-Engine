/**
 * Native loot in the setting's own words (worldgen W6a).
 *
 *   - Every starter kit names its loot by rarity, and a won fight in a game with that kit drops only
 *     its words: a modern-day game never drops a fantasy item.
 *   - A game with no kit rolls the starter kit its genre names, and a genre no starter kit names rolls
 *     loot that belongs to no setting, never fantasy by default.
 *   - A rarity with no words falls back to the nearest one that has them; a kit's loot names at least
 *     one thing and at most twenty of each rarity.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_LOOT_RARITIES,
  WORLD_NEUTRAL_LOOT,
  WORLD_STARTER_KITS,
  parseWorldKit,
  worldLootPick,
  worldLootWords,
  type WorldKit,
  type WorldLoot,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-loot-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { generateCombatLoot } = await import("../../packages/server/src/services/game/loot.service.js");
const { planGameVictoryLoot } = await import("../../packages/server/src/services/game/game-loot.service.js");
const { buildWorldKitWritingPrompt } = await import("../../packages/server/src/services/game/world-kit-writer.js");

const kits = WORLD_STARTER_KITS.map((input) => {
  const parsed = parseWorldKit(input);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.issues.join("; "));
  return parsed.kit;
});
const kitById = (id: string) => kits.find((kit) => kit.id === id)!;
const wordsOf = (loot: WorldLoot) => new Set(WORLD_LOOT_RARITIES.flatMap((rarity) => loot[rarity]));
/** A seeded stream, so the rolls below are the same every run. */
const stream = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const db = await getDB();

try {
  // ── Every starter kit names its loot, and drops only its own words ──
  const fantasy = wordsOf(kitById("high_fantasy").loot!);
  for (const kit of kits) {
    assert.ok(kit.loot, `${kit.id} names its loot`);
    for (const rarity of WORLD_LOOT_RARITIES) assert.ok(kit.loot[rarity].length > 0, `${kit.id} ${rarity}`);
    const own = wordsOf(kit.loot);
    const random = stream(kit.id.length);
    for (const difficulty of ["casual", "normal", "hard", "brutal"]) {
      for (const drop of generateCombatLoot(8, difficulty, random, kit.loot)) {
        assert.ok(own.has(drop.item.name), `${kit.id}: ${drop.item.name}`);
      }
    }
    if (kit.id !== "high_fantasy") {
      const shared = [...own].filter((word) => fantasy.has(word));
      // Plain things every setting has (bandages, an antidote) may be shared; a fantasy item never is.
      for (const word of shared) assert.ok(["Bandages", "Antidote"].includes(word), `${kit.id} borrows ${word}`);
    }
  }
  // A harder game drops rarer things: every rarity turns up over enough brutal fights.
  {
    const seen = new Set<string>();
    const random = stream(7);
    for (let fight = 0; fight < 200; fight++) {
      for (const drop of generateCombatLoot(3, "brutal", random, kitById("modern_day").loot!))
        seen.add(drop.item.rarity);
    }
    assert.deepEqual([...seen].sort(), [...WORLD_LOOT_RARITIES].sort());
  }

  // ── Which words a game rolls ──
  {
    const modern = kitById("modern_day");
    assert.equal(worldLootWords(modern, "Fantasy"), modern.loot, "the kit's own first");
    const noLoot: WorldKit = { ...modern, loot: undefined };
    assert.deepEqual(worldLootWords(noLoot, "Cyberpunk"), kitById("cyberpunk").loot, "a kit without loot: its genre's");
    for (const [genre, kit] of [
      ["Fantasy", "high_fantasy"],
      ["Sci-Fi", "space_opera"],
      ["Modern", "modern_day"],
      ["Horror", "modern_supernatural"],
      ["Post-Apocalyptic", "post_apocalyptic"],
      ["Cyberpunk", "cyberpunk"],
      ["dark fantasy, horror", "high_fantasy"],
      ["Sci-Fi, Cyberpunk", "cyberpunk"],
      ["Wuxia fantasy", "wuxia_xianxia"],
      ["Modern, Horror", "modern_supernatural"],
      ["Post-Apocalyptic, Sci-Fi", "post_apocalyptic"],
    ] as const) {
      assert.deepEqual(worldLootWords(null, genre), kitById(kit).loot, genre);
    }
    for (const genre of ["Steampunk", "Historical", "", undefined, null]) {
      assert.equal(worldLootWords(null, genre), WORLD_NEUTRAL_LOOT, `${genre}: never fantasy by default`);
    }
    const neutral = wordsOf(WORLD_NEUTRAL_LOOT);
    assert.ok(
      ![...neutral].some((word) => fantasy.has(word) && word !== "Bandages"),
      "the neutral list is no setting's",
    );
  }

  // ── A rarity with no words falls back to the nearest that has them ──
  {
    const thin: WorldLoot = { common: ["Pebble"], uncommon: [], rare: ["Ring"], epic: [], legendary: [] };
    assert.equal(
      worldLootPick(thin, "legendary", () => 0),
      "Ring",
      "nearest first",
    );
    assert.equal(
      worldLootPick(thin, "uncommon", () => 0),
      "Pebble",
      "commoner first at the same distance",
    );
    assert.equal(
      worldLootPick(thin, "epic", () => 0),
      "Ring",
    );
  }

  // ── A kit's loot is checked ──
  {
    const base = structuredClone(WORLD_STARTER_KITS.find((kit) => kit.id === "modern_day")!);
    const empty = parseWorldKit({ ...base, loot: { common: [], uncommon: [], rare: [], epic: [], legendary: [] } });
    assert.ok(!empty.ok && empty.issues.some((issue) => /at least one thing/.test(issue)));
    const crowded = parseWorldKit({
      ...base,
      loot: { ...base.loot, common: Array.from({ length: 21 }, (_, index) => `Thing ${index}`) },
    });
    assert.ok(!crowded.ok);
    assert.ok(parseWorldKit({ ...base, loot: undefined }).ok, "a kit may leave its loot out");
  }

  // ── The model writing a kit is asked for loot in the setting's own words ──
  {
    const prompt = buildWorldKitWritingPrompt({ genre: "Modern", setting: "A harbor town", tone: "Cozy" });
    assert.match(prompt.system, /"loot" names what a won fight can drop, by rarity/);
    assert.match(prompt.user, /"loot"/, "the kit it starts from shows the shape");
  }

  // ── In a game: a won fight drops the setting's words ──
  {
    const chats = createChatsStorage(db);
    const won = async (metadata: Record<string, unknown>) => {
      const chat = await chats.create({ name: "Loot", mode: "game", characterIds: [] });
      await chats.patchMetadata(chat.id, metadata);
      const plan = await planGameVictoryLoot(
        db,
        chat.id,
        { tables: [], defeated: 4, difficulty: "normal" },
        () => 1,
        stream(3),
      );
      return (plan?.ops ?? []).map((op) => op.name);
    };
    const modern = wordsOf(kitById("modern_day").loot!);
    const withKit = await won({ gameSetupConfig: { genre: "Fantasy" }, gameWorldKit: kitById("modern_day") });
    assert.ok(withKit.length > 0 && withKit.every((name) => modern.has(name)), withKit.join(", "));
    const byGenre = await won({ gameSetupConfig: { genre: "Modern" } });
    assert.ok(byGenre.length > 0 && byGenre.every((name) => modern.has(name)), byGenre.join(", "));
    const neutral = wordsOf(WORLD_NEUTRAL_LOOT);
    const steampunk = await won({ gameSetupConfig: { genre: "Steampunk" } });
    assert.ok(steampunk.length > 0 && steampunk.every((name) => neutral.has(name)), steampunk.join(", "));
  }

  console.log(
    "World kit loot: every kit drops its own words, a game without one rolls its genre's, never fantasy by default.",
  );
} finally {
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
