// ──────────────────────────────────────────────
// What a native win drops, in the setting's own words (worldgen W6a). A kit names its loot by rarity;
// a game with no kit rolls the starter kit its setup genre names, and a genre no starter kit names gets
// a short list that belongs to no setting. Never fantasy by default.
// ──────────────────────────────────────────────
import type { WorldKit, WorldLoot } from "../../schemas/world-kit.schema.js";
import { WORLD_STARTER_KITS } from "./starter-kits.js";

/** The rarities a native drop is rolled at, commonest first. */
export const WORLD_LOOT_RARITIES = Object.freeze(["common", "uncommon", "rare", "epic", "legendary"] as const);
export type WorldLootRarity = (typeof WORLD_LOOT_RARITIES)[number];

/** Loot that belongs to no setting, for a game with no kit whose genre no starter kit names. */
export const WORLD_NEUTRAL_LOOT: WorldLoot = Object.freeze({
  common: ["Coins", "Supplies", "Bandages", "Small Tool"],
  uncommon: ["Keepsake", "Old Map"],
  rare: ["Valuable Trinket"],
  epic: ["Rare Curiosity"],
  legendary: ["Priceless Heirloom"],
});

/** The setup wizard's genres, and the starter kit each names: the most specific first, so "Sci-Fi,
 *  Cyberpunk" is cyberpunk and "wuxia fantasy" is wuxia; horror after the settings it can be set in. */
const GENRE_KITS: Array<[RegExp, string]> = [
  [/\bcyberpunk\b/i, "cyberpunk"],
  [/\bpost-?apocalyptic\b/i, "post_apocalyptic"],
  [/\bwuxia\b|\bxianxia\b|\bcultivation\b/i, "wuxia_xianxia"],
  [/\b1920s\b|\bnoir\b|\bjazz age\b/i, "the_1920s"],
  [/\bfantasy\b/i, "high_fantasy"],
  [/\bsci-?fi\b|\bscience fiction\b|\bspace\b/i, "space_opera"],
  [/\bhorror\b|\bsupernatural\b/i, "modern_supernatural"],
  [/\bmodern\b|\bslice of life\b/i, "modern_day"],
];

/** The loot words a game rolls: its kit's, else its genre's starter kit's, else the neutral list. */
export function worldLootWords(kit: WorldKit | null | undefined, genre: string | null | undefined): WorldLoot {
  if (kit?.loot) return kit.loot;
  const named = genre ? GENRE_KITS.find(([pattern]) => pattern.test(genre))?.[1] : undefined;
  const starter = named ? WORLD_STARTER_KITS.find((each) => each.id === named) : undefined;
  return (starter?.loot as WorldLoot | undefined) ?? WORLD_NEUTRAL_LOOT;
}

/** A word of this rarity, or of the nearest rarity that has words (commoner first). */
export function worldLootPick(loot: WorldLoot, rarity: WorldLootRarity, random: () => number): string {
  const at = WORLD_LOOT_RARITIES.indexOf(rarity);
  const order = [
    at,
    ...WORLD_LOOT_RARITIES.map((_, index) => index)
      .filter((index) => index !== at)
      .sort((a, b) => Math.abs(a - at) - Math.abs(b - at) || a - b),
  ];
  for (const index of order) {
    const words = loot[WORLD_LOOT_RARITIES[index]!];
    if (words?.length) return words[Math.floor(random() * words.length)]!;
  }
  return WORLD_NEUTRAL_LOOT.common[0]!;
}
