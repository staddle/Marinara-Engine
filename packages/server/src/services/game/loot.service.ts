import {
  WORLD_NEUTRAL_LOOT,
  normalizeGameDifficulty,
  worldLootPick,
  type WorldLoot,
  type WorldLootRarity,
} from "@marinara-engine/shared";
// ──────────────────────────────────────────────
// Game: native loot
//
// Weighted random loot, no model needed: the difficulty sets how rare a drop is, and the setting's own
// loot words say what it is (worldgen W6a: the kit's, its genre's starter kit's, or words that belong
// to no setting; `worldLootWords`). Only names reach the bags.
// ──────────────────────────────────────────────

export interface LootDrop {
  item: { name: string; rarity: WorldLootRarity };
  quantity: number;
}

// ── Rarity Weights by Difficulty ──

const RARITY_WEIGHTS: Record<string, Record<WorldLootRarity, number>> = {
  casual: { common: 50, uncommon: 30, rare: 15, epic: 4, legendary: 1 },
  normal: { common: 40, uncommon: 30, rare: 20, epic: 8, legendary: 2 },
  hard: { common: 30, uncommon: 30, rare: 25, epic: 12, legendary: 3 },
  brutal: { common: 20, uncommon: 25, rare: 30, epic: 18, legendary: 7 },
};

/** Pick a weighted random rarity based on difficulty. */
function pickRarity(difficulty: string, random: () => number): WorldLootRarity {
  const weights = RARITY_WEIGHTS[normalizeGameDifficulty(difficulty)] ?? RARITY_WEIGHTS.normal!;
  const total = Object.values(weights).reduce((s, w) => s + w, 0);
  let roll = random() * total;

  for (const [rarity, weight] of Object.entries(weights)) {
    roll -= weight;
    if (roll <= 0) return rarity as WorldLootRarity;
  }
  return "common";
}

/** Generate loot appropriate for a combat encounter based on enemy count and difficulty. */
export function generateCombatLoot(
  enemyCount: number,
  difficulty: string = "normal",
  random: () => number = Math.random,
  loot: WorldLoot = WORLD_NEUTRAL_LOOT,
): LootDrop[] {
  // Base drops: 1-2 per enemy, plus bonus for harder difficulties
  const difficultyBonus: Record<string, number> = { casual: 0, normal: 0, hard: 1, brutal: 2 };
  const bonus = difficultyBonus[normalizeGameDifficulty(difficulty)] ?? 0;
  const count = Math.min(10, enemyCount + Math.floor(random() * (enemyCount + 1)) + bonus);
  return Array.from({ length: count }, () => {
    const rarity = pickRarity(difficulty, random);
    return { item: { name: worldLootPick(loot, rarity, random), rarity }, quantity: 1 };
  });
}
