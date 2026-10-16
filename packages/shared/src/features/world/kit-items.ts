// ──────────────────────────────────────────────
// A setting's money and shop as a game's items (worldgen W6b). A game with no ruleset buys, pays and
// earns through the same item book, market and checks a ruleset game does: this builds the part of a
// ruleset those read (its `items` block and one catalog of things for sale) from the kit's own words,
// so a modern town sells a first-aid kit for dollars and a wuxia market town buns for copper cash.
// Nothing else of a ruleset comes with it: no sheets, no dice, no checks.
// ──────────────────────────────────────────────
import type { RulesetCatalogEntry, RulesetDefinition } from "../../schemas/ruleset.schema.js";
import type { WorldKit } from "../../schemas/world-kit.schema.js";

/** The one catalog a kit's shop is, and the one coin family its money is. */
export const WORLD_KIT_SHOP_CATALOG = "shop";
export const WORLD_KIT_MONEY_FAMILY = "money";

/** A word as an id of the given shape, unique among `taken`. */
function slug(word: string, separator: "_" | "-", fallback: string, taken: Set<string>): string {
  const base =
    word
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, separator)
      .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, "g"), "")
      .slice(0, 36) || fallback;
  // A sheet id starts with a letter.
  const shaped = separator === "_" && !/^[a-z]/.test(base) ? `n_${base}`.slice(0, 36) : base;
  let id = shaped;
  for (let count = 2; taken.has(id); count++) id = `${shaped}${separator}${count}`;
  taken.add(id);
  return id;
}

export interface WorldKitItems {
  /** The ruleset-shaped part the item book and market read: `items` and the shop catalog. */
  definition: RulesetDefinition;
  /** The shop's entries, by catalog id, as a ruleset's loaded catalogs are. */
  entries: Record<string, RulesetCatalogEntry[]>;
}

/** The kit's money and shop as a game's items, or undefined for a kit (or a game) with no money. */
export function worldKitItems(kit: WorldKit | null | undefined): WorldKitItems | undefined {
  if (!kit?.money) return undefined;
  const unitIds = new Set<string>();
  const units = [...kit.money.units]
    .sort((a, b) => a.value - b.value)
    .map((unit, index) => ({
      id: slug(unit.label, "_", `coin_${index + 1}`, unitIds),
      label: unit.label,
      value: unit.value,
    }));
  // A price is said in the largest coin that pays it exactly (25 dollars, not 2500 cents).
  const largestFirst = [...units].sort((a, b) => b.value - a.value);
  const coinFor = (price: number) => largestFirst.find((unit) => price % unit.value === 0) ?? units[0]!;
  const places = kit.sizes.map((size) => ({ id: size.id, label: size.label }));
  const entryIds = new Set<string>();
  const shop: RulesetCatalogEntry[] = (kit.shop ?? []).map((thing, index) => ({
    id: slug(thing.name, "-", `thing-${index + 1}`, entryIds),
    label: thing.name,
    item: {
      category: thing.service ? "service" : "goods",
      cost: { amount: thing.price / coinFor(thing.price).value, unit: coinFor(thing.price).id },
      // A rank past a ladder that has since lost sizes is its largest size, never refused: the kit
      // editor rewords sizes a keystroke at a time, and the rank comes back when the ladder does.
      sold: { place: places[Math.min(thing.from ?? 0, places.length - 1)]!.id },
      ...(thing.service ? { service: true as const } : {}),
    },
  }));
  const definition = {
    id: "setting-kit",
    name: kit.label,
    // Nothing on a sheet is read for goods with only a price; the empty sheet keeps any reader safe.
    sheet: { abilities: [], skills: [], saves: [], fields: [], derived: [], live: { pools: [], conditions: [] } },
    items: {
      categories: [
        { id: "goods", label: "goods" },
        { id: "service", label: "service" },
      ],
      currencies: [{ id: WORLD_KIT_MONEY_FAMILY, label: kit.money.label, units }],
      // A kit with money and no shop pays and earns, but has no market to buy from.
      ...(shop.length > 0
        ? { market: { prices: [{ id: "fair", label: "fair", times: 1, default: true as const }], places } }
        : {}),
      // The Game Master's own plain items stay as they are in a game with no ruleset; it invents none.
      propose: false,
      native: true,
      freeform: "plain" as const,
    },
    catalogs: [{ id: WORLD_KIT_SHOP_CATALOG, label: "shop", holds: "items" as const, entries: shop }],
  } as unknown as RulesetDefinition;
  return { definition, entries: { [WORLD_KIT_SHOP_CATALOG]: shop } };
}
