/**
 * Money and markets without a ruleset (worldgen W6b).
 *
 *   - A setting kit's money and shop become the same item book, market and checks a ruleset game uses:
 *     every starter kit's shop sells each thing from the place it names and not below, at its price,
 *     paid from the purse with change; earn and pay work in the setting's own coins.
 *   - A kit's money and shop are checked: one coin is the smallest (worth 1), no two coins or things
 *     share a name, and a shop needs money; odd names still make unique ids.
 *   - A game with no ruleset gets its kit's book and market on the server, and the Game Master is
 *     taught the setting's money and market; a game whose kit has no money gets neither.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_STARTER_KITS,
  applyGameInventoryTags,
  parseWorldKit,
  rulesetItemBook,
  rulesetMarketPlace,
  rulesetMarketQuoter,
  worldKitItems,
  type GameInventoryStack,
  type WorldKit,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-money-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { loadGameInventoryItemBook } = await import("../../packages/server/src/services/game/game-inventory.service.js");
const { loadGameKitMarket } = await import("../../packages/server/src/services/game/game-market.service.js");
const { buildGmFormatReminder } = await import("../../packages/server/src/services/game/gm-prompts.js");
const { buildWorldKitWritingPrompt } = await import("../../packages/server/src/services/game/world-kit-writer.js");

const kits = WORLD_STARTER_KITS.map((input) => {
  const parsed = parseWorldKit(input);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.issues.join("; "));
  return parsed.kit;
});
const kitById = (id: string) => kits.find((kit) => kit.id === id)!;
const party = { members: [] as string[] };
const db = await getDB();

/** The kit's book and a quoter at the place of a size. */
function shopAt(kit: WorldKit, rank: number) {
  const items = worldKitItems(kit)!;
  const book = rulesetItemBook(items.definition, items.entries, { plain: "allow", actor: "game-master" });
  const market = items.definition.items!.market!;
  const place = rulesetMarketPlace(market, kit.sizes[rank]!.label)!;
  return { items, book, quoter: rulesetMarketQuoter(items.definition, book, place, () => true) };
}

try {
  // ── Every starter kit sells each thing from the place it names, at its price ──
  for (const kit of kits) {
    assert.ok(kit.money && kit.shop?.length, `${kit.id} has money and a shop`);
    const largest = [...kit.money.units].sort((a, b) => b.value - a.value)[0]!;
    for (const thing of kit.shop) {
      const from = thing.from ?? 0;
      const { book, quoter } = shopAt(kit, from);
      // Plenty of the largest coin, so every price can be paid with change.
      const coin = book.coins.find((each) => each.name === largest.label)!;
      const stacks: GameInventoryStack[] = [{ id: "purse", name: coin.name, item: coin.item, quantity: 100_000 }];
      const tag = `[inventory: action="buy" item="${thing.name}"]`;
      const bought = applyGameInventoryTags(tag, stacks, party, undefined, book, undefined, undefined, quoter);
      assert.match(
        bought.content,
        /result="ok"/,
        `${kit.id}: ${thing.name} sold at ${kit.sizes[from]!.label}: ${bought.content}`,
      );
      assert.equal(
        bought.stacks.some((stack) => stack.name === thing.name),
        !thing.service,
        `${kit.id}: ${thing.name} ${thing.service ? "is a service, never carried" : "goes into the bag"}`,
      );
      if (from > 0) {
        const below = shopAt(kit, from - 1);
        const refused = applyGameInventoryTags(
          tag,
          stacks,
          party,
          undefined,
          below.book,
          undefined,
          undefined,
          below.quoter,
        );
        assert.match(refused.content, /reason="not-here"/, `${kit.id}: ${thing.name} not sold below its place`);
      }
    }
  }

  // ── Paying with change, earning, and what is too dear ──
  {
    const { book, quoter } = shopAt(kitById("modern_day"), 2);
    const stacks: GameInventoryStack[] = [{ id: "purse", name: "dollar", item: "coin:dollar", quantity: 30 }];
    const out = applyGameInventoryTags(
      '[inventory: action="buy" item="first-aid kit"] [inventory: action="buy" item="Bicycle"] [inventory: action="earn" amount="5 dollars"] [inventory: action="pay" amount="2 dollars"] [inventory: action="buy" item="Sandwich"]',
      stacks,
      party,
      undefined,
      book,
      undefined,
      undefined,
      quoter,
    );
    assert.match(out.content, /item="First-Aid Kit" count="1" level="fair" result="ok"/);
    assert.match(out.content, /item="Bicycle" count="1" level="fair" result="refused" reason="cannot-afford"/);
    assert.match(out.content, /action="earn" item="dollar" count="5" result="ok"/);
    assert.match(out.content, /action="pay" item="dollar" count="2" result="ok"/);
    const held = Object.fromEntries(out.stacks.map((stack) => [stack.name, stack.quantity]));
    // 30 - 25 + 5 - 2 - 7 for the sandwich.
    assert.equal(held.dollar, 1);
    assert.equal(held["First-Aid Kit"], 1);
    assert.equal(held.Sandwich, 1);
  }

  // ── A kit's money and shop are checked ──
  {
    const base = structuredClone(WORLD_STARTER_KITS.find((kit) => kit.id === "modern_day")!);
    const issues = (patch: Record<string, unknown>) => {
      const parsed = parseWorldKit({ ...base, ...patch });
      return parsed.ok ? [] : parsed.issues;
    };
    assert.ok(
      issues({ money: { label: "money", units: [{ label: "dollar", value: 100 }] } }).some((issue) =>
        /smallest/.test(issue),
      ),
    );
    assert.ok(
      issues({
        money: {
          label: "money",
          units: [
            { label: "cent", value: 1 },
            { label: "Cent", value: 5 },
          ],
        },
      }).some((issue) => /share a name/.test(issue)),
    );
    assert.ok(issues({ money: undefined }).some((issue) => /needs the setting's money/.test(issue)));
    assert.ok(
      issues({
        shop: [
          { name: "Tea", price: 1 },
          { name: "tea", price: 2 },
        ],
      }).some((issue) => /share a name/.test(issue)),
    );
    // A rank past the ladder is its largest size: never refused, never lost.
    const past = parseWorldKit({ ...base, shop: [{ name: "Tea", price: 1, from: base.sizes.length + 2 }] });
    assert.ok(past.ok, past.ok ? "" : past.issues.join("; "));
    assert.deepEqual(worldKitItems(past.kit)!.entries.shop![0]!.item!.sold, { place: past.kit.sizes.at(-1)!.id });
    assert.equal(past.kit.shop![0]!.from, base.sizes.length + 2, "kept as written");
    assert.deepEqual(issues({ money: undefined, shop: undefined }), [], "a kit may have no money at all");
    assert.equal(worldKitItems(null), undefined, "no kit, no money");
    // Odd names still make unique ids, and an id is never empty.
    const odd = parseWorldKit({
      ...base,
      money: {
        label: "money",
        units: [
          { label: "1 ¥", value: 1 },
          { label: "银两", value: 100 },
        ],
      },
      shop: [
        { name: "Café au lait", price: 1 },
        { name: "Cafe au-lait", price: 2 },
        { name: "茶", price: 3 },
      ],
    });
    assert.ok(odd.ok, odd.ok ? "" : odd.issues.join("; "));
    const items = worldKitItems(odd.kit)!;
    const unitIds = items.definition.items!.currencies![0]!.units.map((unit) => unit.id);
    assert.equal(new Set(unitIds).size, 2);
    for (const id of unitIds) assert.match(id, /^[a-z][a-z0-9_]*$/);
    const entryIds = items.entries.shop!.map((entry) => entry.id);
    assert.deepEqual(entryIds, ["cafe-au-lait", "cafe-au-lait-2", "thing-3"]);
  }

  // ── In a game with no ruleset: the server's book, market and the Game Master's lines ──
  {
    const chats = createChatsStorage(db);
    const game = async (metadata: Record<string, unknown>) => {
      const chat = await chats.create({ name: "Money", mode: "game", characterIds: [] });
      await chats.patchMetadata(chat.id, metadata);
      return chat.id;
    };
    const modern = kitById("modern_day");
    const withMoney = await game({ gameWorldKit: modern });
    const book = await loadGameInventoryItemBook(db, { chatId: withMoney }, "game-master");
    assert.ok(book, "a game with no ruleset reads its kit's money");
    assert.deepEqual(
      book.coins.map((coin) => coin.name),
      ["cent", "dollar"],
    );
    assert.deepEqual(
      book.itemNamed("First-Aid Kit")?.facts.cost,
      { amount: 25, unit: "dollar" },
      "said in the largest coin that pays it",
    );
    assert.deepEqual(book.itemNamed("Bottle of Water")?.facts.cost, { amount: 150, unit: "cent" });
    const market = loadGameKitMarket(worldKitItems(modern)!, book, { name: "Elm Street", size: "town" })!;
    assert.equal(market.quote({ item: "First-Aid Kit", count: 1, stacks: [] }).ok, true, "a town sells it");
    const village = loadGameKitMarket(worldKitItems(modern)!, book, { name: "Elmfield", size: "village" })!;
    assert.deepEqual(village.quote({ item: "First-Aid Kit", count: 1, stacks: [] }), { ok: false, reason: "not-here" });
    const noMoney = await game({ gameWorldKit: { ...modern, money: undefined, shop: undefined } });
    assert.equal(await loadGameInventoryItemBook(db, { chatId: noMoney }, "game-master"), undefined);
    assert.equal(await loadGameInventoryItemBook(db, { chatId: await game({}) }, "game-master"), undefined, "no kit");

    const reminder = (kitItems?: ReturnType<typeof worldKitItems>) =>
      buildGmFormatReminder({
        hasSceneModel: false,
        turnNumber: 1,
        ...(kitItems ? { kitItems: kitItems.definition } : {}),
      } as Parameters<typeof buildGmFormatReminder>[0]);
    const taught = reminder(worldKitItems(modern));
    assert.match(taught, /in the setting's money \(/);
    assert.match(taught, /\[inventory: action="buy" item="Name"/);
    assert.match(taught, /\[place: name="Name" size="metropolis"\]/);
    const plain = reminder();
    assert.doesNotMatch(plain, /action="pay"|action="buy"/);
    // Money and no shop: the Game Master pays and earns, and has no market to buy from.
    const moneyOnly = worldKitItems({ ...modern, shop: undefined })!;
    assert.equal(moneyOnly.definition.items?.market, undefined);
    assert.equal(loadGameKitMarket(moneyOnly, book, { name: "Elm Street", size: "town" }), undefined);
    assert.match(reminder(moneyOnly), /action="pay"/);
    assert.doesNotMatch(reminder(moneyOnly), /action="buy"/);
  }

  // ── The model writing a kit is asked for money and a shop ──
  {
    const prompt = buildWorldKitWritingPrompt({ genre: "Modern", setting: "A harbor town", tone: "Cozy" });
    assert.match(prompt.system, /"money" is what this setting pays in/);
    assert.match(prompt.user, /"shop"/);
  }

  console.log("World kit money: every kit's shop sells, pays and earns through the ruleset market's own checks.");
} finally {
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
