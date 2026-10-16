// ──────────────────────────────────────────────
// Icons for a ruleset's things (Capability API 1.338): which tile of the game's icons pack a condition,
// an item or any catalog entry is drawn with. The ruleset's own `icon` first, else the name derived from
// its ids (`ic_cond_<id>`, `ic_item_<id>`, `ic_<catalog>_<entry>`). The client draws the first of these the
// icons pack has, and today's look when it has none.
// ──────────────────────────────────────────────
import type { RulesetDefinition } from "../../schemas/ruleset.schema.js";
import { artIconFor } from "../world/board-pack.js";

const byDefinition = new WeakMap<RulesetDefinition, Map<string, string[]>>();

/** The icons an entry may be drawn with, best first, by its "<catalog>/<entry>" ref. Empty for none. */
export function rulesetEntryIcons(definition: RulesetDefinition, ref: string | undefined): string[] {
  if (!ref) return [];
  let known = byDefinition.get(definition);
  if (!known) byDefinition.set(definition, (known = new Map()));
  const cached = known.get(ref);
  if (cached) return cached;
  const cut = ref.indexOf("/");
  const icons: string[] = [];
  if (cut > 0) {
    const [catalogId, entryId] = [ref.slice(0, cut), ref.slice(cut + 1)];
    const catalog = definition.catalogs?.find((one) => one.id === catalogId);
    const entry = catalog?.entries?.find((one) => one.id === entryId);
    if (entry?.icon) icons.push(entry.icon);
    const derived = artIconFor({
      catalog: catalogId,
      entry: entryId,
      item: catalog?.holds === "items" || !!entry?.item,
    });
    if (derived && !icons.includes(derived)) icons.push(derived);
  }
  known.set(ref, icons);
  return icons;
}

/** The icons a condition may be drawn with, best first: the ruleset's `icon` on it, then `ic_cond_<id>`. */
export function rulesetConditionIcons(definition: RulesetDefinition, conditionId: string): string[] {
  const own = definition.sheet.live.conditions.find((one) => one.id === conditionId)?.icon;
  const derived = artIconFor({ condition: conditionId });
  return [...(own ? [own] : []), ...(derived && derived !== own ? [derived] : [])];
}

/** The icons an inventory stack may be drawn with: its ruleset item's (by its "<catalog>/<entry>"), then
 *  `ic_item_<name>` for its own name. */
export function rulesetItemIcons(
  definition: RulesetDefinition | null | undefined,
  stack: { item?: string; name: string },
): string[] {
  const icons = definition && stack.item ? [...rulesetEntryIcons(definition, stack.item)] : [];
  const named = artIconFor({ item: stack.name });
  if (named && !icons.includes(named)) icons.push(named);
  return icons;
}
