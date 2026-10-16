/**
 * Markets (#6917, Capability API 1.65): what a place sells and at what price.
 *
 * A place is one of the market's sizes, smallest first. An item is sold at a place at least as big as
 * its own `sold` place, or else the place of the first `sold` rule it matches; an item nothing names is
 * sold anywhere. A seller is at a place at least as big as the seller's own place. A price is an item's
 * cost times a level, worked out in the smallest coin of the cost's family and rounded there, and said
 * in the largest coin the game's layers leave that pays it exactly.
 */
import {
  rulesetCoinAmount,
  rulesetFakeIssue,
  type RulesetCatalogItem,
  type RulesetDefinition,
} from "../../schemas/ruleset.schema.js";
import {
  gameInventoryCoinRef,
  gameInventoryNameKey,
  type GameInventoryCoin,
  type GameInventoryStack,
} from "../../utils/game-inventory-stacks.js";
import type { GameInventoryMarket } from "../../utils/game-inventory-tags.js";
import { rulesetCombatRoller } from "../ruleset-combat/dice.js";
import type { RulesetItemBook } from "./item-book.js";
import { rulesetLayeredCurrencies, type RulesetLayerOptions } from "./layers.js";
import { rollRulesetLootTable, rulesetRolledAmount, type RulesetLootDrop } from "./loot.js";

export type RulesetMarket = NonNullable<NonNullable<RulesetDefinition["items"]>["market"]>;
export type RulesetMarketSeller = NonNullable<RulesetMarket["sellers"]>[number];
export type RulesetMarketLevel = RulesetMarket["prices"][number];
type ItemFilter = RulesetMarketSeller["sells"][number];

export interface RulesetMarketPlace {
  id: string;
  label: string;
  /** Its step on the ladder: 0 for the smallest place. */
  rank: number;
}

/** The place a word names: its id or its label, in any case. */
export function rulesetMarketPlace(market: RulesetMarket, word: string): RulesetMarketPlace | undefined {
  const key = gameInventoryNameKey(word);
  const rank = market.places.findIndex(
    (place) => gameInventoryNameKey(place.id) === key || gameInventoryNameKey(place.label) === key,
  );
  return rank < 0 ? undefined : { id: market.places[rank]!.id, label: market.places[rank]!.label, rank };
}

/** The level a word names (its id or label, in any case), or the default level for no word. */
export function rulesetMarketLevel(market: RulesetMarket, word?: string): RulesetMarketLevel | undefined {
  if (word === undefined || !word.trim()) return market.prices.find((level) => level.default);
  const key = gameInventoryNameKey(word);
  return market.prices.find(
    (level) => gameInventoryNameKey(level.id) === key || gameInventoryNameKey(level.label) === key,
  );
}

/** Whether an item has every word a filter names. */
export function rulesetItemMatchesFilter(item: RulesetCatalogItem, filter: ItemFilter): boolean {
  return (
    (filter.rarity === undefined || item.rarity === filter.rarity) &&
    (filter.category === undefined || item.category === filter.category) &&
    (filter.tag === undefined || !!item.tags?.includes(filter.tag))
  );
}

/** The rank of the smallest place that sells an item: its own `sold` place, else the first rule that
 *  matches it and names a place, else anywhere. */
export function rulesetItemSoldRank(market: RulesetMarket, item: RulesetCatalogItem): number {
  const place =
    item.sold?.place ??
    market.sold?.find((rule) => rule.place !== undefined && rulesetItemMatchesFilter(item, rule.filter))?.place;
  return place === undefined
    ? 0
    : Math.max(
        0,
        market.places.findIndex((each) => each.id === place),
      );
}

/** How many of an item a place keeps on hand in a day, as written (#6934): its own `sold` limit, else
 *  the first rule that matches it and names one. Undefined for as many as wanted. */
export function rulesetItemLimit(market: RulesetMarket, item: RulesetCatalogItem): number | string | undefined {
  return (
    item.sold?.limited ??
    market.sold?.find((rule) => rule.limited !== undefined && rulesetItemMatchesFilter(item, rule.filter))?.limited
  );
}

/** The sellers at a place of this rank, in the ruleset's order. */
export function rulesetMarketSellersAt(market: RulesetMarket, rank: number): RulesetMarketSeller[] {
  return (market.sellers ?? []).filter(
    (seller) => seller.place === undefined || market.places.findIndex((place) => place.id === seller.place) <= rank,
  );
}

/** A fake or a cursed item (Capability API 1.79): never among anybody's wares, never in an honest
 *  seller's stock; a dishonest seller passes a fake off from their stock as what it passes for. */
export function rulesetItemDeceptive(item: RulesetCatalogItem): boolean {
  return item.passesFor !== undefined || item.binds?.cursed === true;
}

/** One thing a seller has in stock today. A fake a dishonest seller passes off is shown as what it
 *  passes for (`item`, `name`) and keeps what it truly is. */
export interface RulesetMarketStockDrop extends RulesetLootDrop {
  truly?: string;
  trulyName?: string;
}

/** Whether a seller sells an item: one of its filters matches it. */
export function rulesetSellerSells(seller: RulesetMarketSeller, item: RulesetCatalogItem): boolean {
  return seller.sells.some((filter) => rulesetItemMatchesFilter(item, filter));
}

/**
 * What `count` of an item costs at a level: owed in the smallest coin of its cost's family (rounded
 * there, at least one where the cost is above nothing), the coins of that family the game's layers
 * leave, and the price said in the coin its cost is written in where that coin pays it exactly (a 5e
 * potion's "50 gold pieces", not "5 platinum pieces"), else the largest that does. Undefined when the
 * family's coins are all gone.
 */
export function rulesetMarketPrice(
  definition: RulesetDefinition,
  cost: { amount: number; unit: string },
  times: number,
  count: number,
  layerOptions?: RulesetLayerOptions | null,
): { owed: number; family: GameInventoryCoin[]; familyId: string; said: string } | undefined {
  const full = definition.items?.currencies?.find((family) => family.units.some((unit) => unit.id === cost.unit));
  const unit = full?.units.find((each) => each.id === cost.unit);
  const left = full
    ? rulesetLayeredCurrencies(definition, layerOptions).find((each) => each.id === full.id)
    : undefined;
  if (!full || !unit || !left || left.units.length === 0) return undefined;
  const worth = cost.amount * unit.value;
  const each = worth === 0 ? 0 : Math.max(1, Math.round(worth * times));
  const owed = each * count;
  const family = [...left.units]
    .sort((a, b) => b.value - a.value)
    .map((coin) => ({
      item: gameInventoryCoinRef(coin.id),
      name: coin.label,
      ...(coin.one ? { one: coin.one } : {}),
      value: coin.value,
    }));
  // The family's smallest coin, worth 1, is always left, so some coin says the price exactly.
  const own = family.find((coin) => coin.item === gameInventoryCoinRef(cost.unit));
  const shown =
    (own && owed % own.value === 0 ? own : family.find((coin) => owed % coin.value === 0)) ?? family.at(-1)!;
  return {
    owed,
    family,
    familyId: full.id,
    said: rulesetCoinAmount({ label: shown.name, one: shown.one }, owed / shown.value),
  };
}

/**
 * What a market day saw before the reply (#6934): the day's name, which seeds what is rolled for it;
 * what was bought today of a place's own wares (by item name) and of a seller's stock (by seller and
 * item, `rulesetMarketStockKey`); and what the sellers here paid out today, by coin family, in its
 * smallest coin. The counts are keyed by display names (answered tags carry no item ref), so a ruleset update
 * that renames an item or a seller mid-day starts its count again.
 */
export interface RulesetMarketDay {
  key: string;
  bought: ReadonlyMap<string, number>;
  stockBought: ReadonlyMap<string, number>;
  paidOut: ReadonlyMap<string, number>;
}

/** The key a seller's stock of an item is counted by in a market day. */
export function rulesetMarketStockKey(seller: string, item: string): string {
  return `${gameInventoryNameKey(seller)}|${gameInventoryNameKey(item)}`;
}

/** A day's own number from its name: FNV-1a, so a day always rolls the same shelf. */
function dayHash(text: string): number {
  let hash = 0x811c9dc5;
  for (const character of text) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A market day's shelf at a place (#6934): what each seller there has in stock today, rolled from
 * their `stock` table (items only, never coins), and how many of a limited item the place keeps today.
 * Both are seeded by the day's name, so the same day always shows the same shelf.
 */
export function rulesetMarketShelf(
  definition: RulesetDefinition,
  book: Pick<RulesetItemBook, "entries" | "coins">,
  place: RulesetMarketPlace,
  day: string,
): {
  stock: ReadonlyMap<string, RulesetMarketStockDrop[]>;
  limit: (ref: string, item: RulesetCatalogItem) => number | undefined;
} {
  const market = definition.items?.market;
  const stock = new Map<string, RulesetMarketStockDrop[]>();
  const coins = new Set(book.coins.map((coin) => coin.item));
  const byRef = new Map(book.entries.map((entry) => [entry.item, entry]));
  for (const seller of market ? rulesetMarketSellersAt(market, place.rank) : []) {
    if (!seller.stock) continue;
    const rolled = rollRulesetLootTable(
      definition,
      book,
      seller.stock.table,
      rulesetCombatRoller(dayHash(`${day}|stock|${seller.id}`), 0),
    );
    // Coins never, and no fake or cursed item from an honest seller: dropped after the roll, so the
    // day still rolls the same shelf. A dishonest seller passes a fake off as what it passes for, while
    // that is an item the game offers and one it may pass for.
    const drops = (rolled ?? []).flatMap((drop): RulesetMarketStockDrop[] => {
      if (coins.has(drop.item)) return [];
      const item = byRef.get(drop.item)?.entry.item;
      if (!item || !rulesetItemDeceptive(item)) return [drop];
      if (seller.honest !== false || !item.passesFor) return [];
      const target = byRef.get(item.passesFor);
      if (!target?.entry.item || rulesetFakeIssue(drop.item, item, target.entry.item)) return [];
      return [{ item: target.item, name: target.name, count: drop.count, truly: drop.item, trulyName: drop.name }];
    });
    // One line per item shown: where a fake and the real thing both came up, the seller passes the fake.
    stock.set(
      seller.id,
      drops.filter((drop) => drop.truly || !drops.some((other) => other.truly && other.item === drop.item)),
    );
  }
  return {
    stock,
    limit: (ref, item) => {
      const written = market ? rulesetItemLimit(market, item) : undefined;
      return written === undefined
        ? undefined
        : rulesetRolledAmount(written, rulesetCombatRoller(dayHash(`${day}|limit|${ref}`), 0));
    },
  };
}

/**
 * The Game Master's buys and sales answered at a place (#6917, #6934): a market for
 * `applyGameInventoryTags`. `place` is the place in force for the reply, or null where none was said;
 * `meets` says whether a buyer (the player for no name), carrying what the stacks hold at that tag,
 * passes a seller's `only`; `day` is what the market day saw before the reply. The market counts what
 * the reply itself buys and sells (`record`), so make a fresh one for every reading of a reply.
 */
export function rulesetMarketQuoter(
  definition: RulesetDefinition,
  book: Pick<RulesetItemBook, "itemNamed" | "offers" | "entries" | "coins">,
  place: RulesetMarketPlace | null,
  meets: (
    only: NonNullable<RulesetMarketSeller["only"]>,
    who: string | undefined,
    stacks: readonly GameInventoryStack[],
  ) => boolean,
  layerOptions?: RulesetLayerOptions | null,
  day?: RulesetMarketDay,
): GameInventoryMarket {
  const bought = new Map(day?.bought ?? []);
  const stockBought = new Map(day?.stockBought ?? []);
  const paidOut = new Map(day?.paidOut ?? []);
  // The place's shelf for the day, rolled once, the first time a buy needs it (only ever once a
  // place is in force).
  let rolledShelf: ReturnType<typeof rulesetMarketShelf> | undefined;
  const shelf = () => (rolledShelf ??= rulesetMarketShelf(definition, book, place!, day?.key ?? ""));
  const named = (seller: RulesetMarketSeller, word: string | undefined) =>
    word === undefined ||
    gameInventoryNameKey(seller.id) === gameInventoryNameKey(word) ||
    gameInventoryNameKey(seller.label) === gameInventoryNameKey(word);
  return {
    quote(request) {
      const market = definition.items?.market;
      if (!market) return { ok: false, reason: "no-market" };
      if (!place) return { ok: false, reason: "no-place" };
      const level = rulesetMarketLevel(market, request.level);
      if (!level) return { ok: false, reason: "unknown-level" };
      const found = book.itemNamed(request.item);
      const item = found?.entry.item;
      if (!found || !item || !book.offers(found.item)) return { ok: false, reason: "unknown-item" };
      if (!item.cost) return { ok: false, reason: "not-for-sale" };
      const price = rulesetMarketPrice(definition, item.cost, level.times, request.count, layerOptions);
      if (!price) return { ok: false, reason: "not-for-sale" };
      const sold = { ok: true as const, item: found.item, name: found.name, service: item.service === true };
      const answer = { family: price.family, owed: price.owed, price: price.said, level: level.label };
      // A dishonest seller the buy names passes a fake off first, while their stock today has one.
      if (request.seller !== undefined) {
        const dishonest = rulesetMarketSellersAt(market, place.rank).filter(
          (each) => each.honest === false && named(each, request.seller),
        );
        for (const seller of dishonest) {
          if (seller.only && !meets(seller.only, request.who, request.stacks)) continue;
          const drop = shelf()
            .stock.get(seller.id)
            ?.find((each) => each.truly && each.item === found.item);
          if (!drop) continue;
          const left = drop.count - (stockBought.get(rulesetMarketStockKey(seller.label, found.name)) ?? 0);
          if (request.count <= left) {
            return { ...sold, ...answer, seller: seller.label, stock: true, truly: drop.truly! };
          }
        }
      }
      // The place's own wares first: sold here, by a seller here who sells it (anybody, without
      // sellers), as many as the place keeps today.
      let refused: "not-here" | "no-seller" | "not-to-you" | "sold-out" = "not-here";
      if (!rulesetItemDeceptive(item) && rulesetItemSoldRank(market, item) <= place.rank) {
        let seller: RulesetMarketSeller | undefined;
        if (market.sellers?.length) {
          const asked = rulesetMarketSellersAt(market, place.rank).filter(
            (each) => rulesetSellerSells(each, item) && named(each, request.seller),
          );
          seller = asked.find((each) => !each.only || meets(each.only, request.who, request.stacks));
          refused = asked.length === 0 ? "no-seller" : "not-to-you";
        }
        if (seller || !market.sellers?.length) {
          const limit = shelf().limit(found.item, item);
          const left = limit === undefined ? Infinity : limit - (bought.get(gameInventoryNameKey(found.name)) ?? 0);
          if (request.count <= left) return { ...sold, ...answer, ...(seller ? { seller: seller.label } : {}) };
          refused = "sold-out";
        }
      }
      // Else a seller's stock today: that seller only, as many as they rolled less what was bought.
      // A fake is passed off only by the seller the buy names: a buy without a seller never gets one.
      const offered = (drop: RulesetMarketStockDrop) =>
        drop.item === found.item && (!drop.truly || request.seller !== undefined);
      const stocked = rulesetMarketSellersAt(market, place.rank).filter(
        (seller) => named(seller, request.seller) && shelf().stock.get(seller.id)?.some(offered),
      );
      for (const seller of stocked) {
        if (seller.only && !meets(seller.only, request.who, request.stacks)) {
          if (refused !== "sold-out") refused = "not-to-you";
          continue;
        }
        const drop = shelf().stock.get(seller.id)!.find(offered)!;
        const left = drop.count - (stockBought.get(rulesetMarketStockKey(seller.label, found.name)) ?? 0);
        if (request.count <= left) {
          return {
            ...sold,
            ...answer,
            seller: seller.label,
            stock: true,
            ...(drop.truly ? { truly: drop.truly } : {}),
          };
        }
        refused = "sold-out";
      }
      return { ok: false, reason: rulesetItemDeceptive(item) && refused === "not-here" ? "not-for-sale" : refused };
    },
    sale(request) {
      const market = definition.items?.market;
      if (!market) return { ok: false, reason: "no-market" };
      if (!place) return { ok: false, reason: "no-place" };
      if (market.buyBack === undefined) return { ok: false, reason: "not-bought" };
      const found = book.itemNamed(request.item);
      const item = found?.entry.item;
      if (!found || !item) return { ok: false, reason: "unknown-item" };
      if (!item.cost || item.service) return { ok: false, reason: "not-for-sale" };
      // Somebody here who sells that kind of thing buys it (anybody, without sellers).
      let seller: RulesetMarketSeller | undefined;
      if (market.sellers?.length) {
        seller = rulesetMarketSellersAt(market, place.rank).find(
          (each) => rulesetSellerSells(each, item) && named(each, request.seller),
        );
        if (!seller) return { ok: false, reason: "not-bought" };
      }
      const fair = rulesetMarketLevel(market)!;
      // A fake sold to an honest buyer (anybody, without sellers) is spotted: they say what it truly is
      // and pay what that is worth to them, or nothing where it has no price. A dishonest buyer takes it
      // as what it seems.
      const spotted = request.truly !== undefined && seller?.honest !== false;
      const trueEntry = spotted ? book.entries.find((entry) => entry.item === request.truly) : undefined;
      const revealed = spotted ? { item: request.truly!, name: trueEntry?.name ?? request.truly! } : undefined;
      const worthOf = spotted ? trueEntry?.entry.item : item;
      const price =
        worthOf?.cost && !worthOf.service
          ? rulesetMarketPrice(definition, worthOf.cost, fair.times * market.buyBack, request.count, layerOptions)
          : undefined;
      if (!price) return { ok: false, reason: "not-for-sale", ...(revealed ? { revealed } : {}) };
      // What the place's sellers pay out in a day, counted in the purse's own family.
      const purse = market.places[place.rank]?.purse;
      if (purse) {
        const family = definition.items?.currencies?.find((each) => each.units.some((unit) => unit.id === purse.unit));
        const value = family?.units.find((unit) => unit.id === purse.unit)?.value ?? 1;
        if (family?.id === price.familyId) {
          const left = purse.amount * value - (paidOut.get(family.id) ?? 0);
          if (price.owed > left) return { ok: false, reason: "purse-spent", ...(revealed ? { revealed } : {}) };
        }
      }
      return {
        ok: true,
        item: revealed?.item ?? found.item,
        name: revealed?.name ?? found.name,
        family: price.family,
        familyId: price.familyId,
        worth: price.owed,
        price: price.said,
        ...(revealed ? { revealed } : {}),
        ...(seller ? { seller: seller.label } : {}),
      };
    },
    record(done) {
      if ("buy" in done) {
        const key = done.buy.stock
          ? rulesetMarketStockKey(done.buy.seller ?? "", done.buy.name)
          : gameInventoryNameKey(done.buy.name);
        const counts = done.buy.stock ? stockBought : bought;
        counts.set(key, (counts.get(key) ?? 0) + done.buy.count);
      } else paidOut.set(done.sell.familyId, (paidOut.get(done.sell.familyId) ?? 0) + done.sell.worth);
    },
  };
}

/** The most items the Game Master's market block lists for one seller; the rest are bought by name. */
const MARKET_PROMPT_ITEMS = 12;

/**
 * The Game Master's market block for the place the scene is in (#6917, #6934): the place and its size,
 * the price levels, and each seller here with what they sell at the default level, cheapest first
 * (with how many are left of what the place keeps only a few of) and what they have in stock today;
 * then what the sellers here pay for what the party sells, and how much of today's purse is left.
 * Anything a seller sells can be bought by name; the block lists a handful of each.
 */
export function rulesetMarketPromptText(
  definition: RulesetDefinition,
  book: Pick<RulesetItemBook, "entries" | "coins">,
  place: { name?: string; size?: string } | null,
  layerOptions?: RulesetLayerOptions | null,
  day?: RulesetMarketDay,
): string | undefined {
  const market = definition.items?.market;
  if (!market) return undefined;
  if (!place) return "MARKET: no place said yet. Say where the party is with [place:] before anyone buys.";
  const at = place.size ? rulesetMarketPlace(market, place.size) : undefined;
  const where = place.name ?? "Here";
  if (!at) return `MARKET: ${where} has no market.`;
  const shelf = rulesetMarketShelf(definition, book, at, day?.key ?? "");
  const fair = rulesetMarketLevel(market)!;
  const levels = market.prices.map((level) => `${level.label} ×${level.times}`).join(", ");
  const sold = book.entries.flatMap((entry) => {
    const item = entry.entry.item;
    if (!item?.cost || rulesetItemDeceptive(item) || rulesetItemSoldRank(market, item) > at.rank) return [];
    const price = rulesetMarketPrice(definition, item.cost, fair.times, 1, layerOptions);
    if (!price) return [];
    const limit = shelf.limit(entry.item, item);
    const left =
      limit === undefined ? undefined : Math.max(0, limit - (day?.bought.get(gameInventoryNameKey(entry.name)) ?? 0));
    return [{ name: entry.name, item, price, left }];
  });
  // An honest seller warns before selling what can turn on its buyer; a dishonest one says nothing.
  const warning = (item: RulesetCatalogItem, honest: boolean) =>
    honest && item.risky ? ` (warn the buyer first: ${item.risky})` : "";
  const line = (
    label: string,
    wares: typeof sold,
    stock: RulesetMarketStockDrop[] = [],
    seller = "",
    honest = true,
  ) => {
    const listed = [...wares]
      .sort((a, b) => a.price.owed - b.price.owed)
      .slice(0, MARKET_PROMPT_ITEMS)
      .map(
        (ware) =>
          `${ware.name} ${ware.price.said}${ware.item.service ? " (a service)" : ""}${ware.left !== undefined ? ` (${ware.left} left)` : ""}${warning(ware.item, honest)}`,
      );
    const more = wares.length - listed.length;
    const inStock = stock.flatMap((drop) => {
      const item = book.entries.find((entry) => entry.item === drop.item)?.entry.item;
      const price = item?.cost ? rulesetMarketPrice(definition, item.cost, fair.times, 1, layerOptions) : undefined;
      const left = drop.count - (day?.stockBought.get(rulesetMarketStockKey(seller, drop.name)) ?? 0);
      const told = drop.truly
        ? ` (FAKE: really ${drop.trulyName}; this seller passes it off as the real thing)`
        : item
          ? warning(item, honest)
          : "";
      return price && left > 0 ? [`${drop.name} ×${left} ${price.said}${told}`] : [];
    });
    return `- ${label}: ${listed.length ? listed.join(", ") : "nothing"}${more > 0 ? `, and ${more} more` : ""}${inStock.length ? `; in stock today: ${inStock.join(", ")}` : ""}`;
  };
  const here = market.sellers?.length ? rulesetMarketSellersAt(market, at.rank) : undefined;
  const sellers = here
    ? here.map((seller) =>
        line(
          `${seller.label}${seller.only ? ` (to ${seller.only.label} only)` : ""}${seller.honest === false ? " (dishonest)" : ""}`,
          sold.filter((ware) => rulesetSellerSells(seller, ware.item)),
          shelf.stock.get(seller.id),
          seller.label,
          seller.honest !== false,
        ),
      )
    : [line("Sold here", sold)];
  if (here?.length === 0) sellers.push("- No seller keeps shop in a place this size.");
  const lines = [
    `MARKET: ${where}, a ${at.label}. Prices at ${fair.label}, the default level (${levels}).`,
    ...sellers,
  ];
  if (market.buyBack !== undefined) {
    const purse = market.places[at.rank]?.purse;
    const family = purse
      ? definition.items?.currencies?.find((each) => each.units.some((unit) => unit.id === purse.unit))
      : undefined;
    const unit = family?.units.find((each) => each.id === purse?.unit);
    const left = purse && family && unit ? purse.amount * unit.value - (day?.paidOut.get(family.id) ?? 0) : undefined;
    const said =
      left === undefined || !family
        ? ""
        : (() => {
            // In the purse's own coin when it says it exactly, else the largest that does.
            const coins = [unit!, ...[...family.units].sort((a, b) => b.value - a.value)];
            const shown = coins.find((coin) => Math.max(0, left) % coin.value === 0) ?? coins.at(-1)!;
            return `, up to ${rulesetCoinAmount(unit!, purse!.amount)} a day (${rulesetCoinAmount(shown, Math.max(0, left) / shown.value)} left today)`;
          })();
    lines.push(`Selling: sellers here buy what they sell at ×${market.buyBack} of the ${fair.label} price${said}.`);
    if (here?.some((seller) => seller.honest === false)) {
      lines.push(
        "A dishonest seller buys a fake as what it seems; an honest one sees through it, says what it truly is and pays what that is worth.",
      );
    }
  }
  return lines.join("\n");
}
