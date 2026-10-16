// ──────────────────────────────────────────────
// A setting's battlefields (worldgen W6d): the kinds of place its fights happen in, in its own words,
// each laid out on a tactical board like one of the engine's sixteen (so the generated terrain and the
// weather still know what a "rooftop" or a "teahouse" is), and its words for the six kinds of tile. The
// model picks a scene by the setting's word; the engine reads the battlefield it is like.
// ──────────────────────────────────────────────
import { gameWorldKitFromMetadata, type WorldKit } from "../../schemas/world-kit.schema.js";
import {
  TACTICAL_ENVIRONMENTS,
  TACTICAL_TERRAINS,
  type TacticalEnvironment,
  type TacticalTerrain,
} from "../tactical-combat/environments.js";

export interface WorldBattlefields {
  scenes: Array<{ label: string; like: TacticalEnvironment }>;
  tiles: Record<TacticalTerrain, string>;
}

/** The engine's own tile words. */
const TILE_WORDS: Record<TacticalTerrain, string> = {
  plains: "Plains",
  forest: "Forest",
  mountain: "Mountain",
  ruin: "Ruins",
  water: "Water",
  wall: "Wall",
};

/** The engine's own sixteen, each as itself (its id), and the engine's tile words. */
export const WORLD_DEFAULT_BATTLEFIELDS: WorldBattlefields = Object.freeze({
  scenes: Object.freeze(
    // Each named by its own id, so a game without a kit is asked exactly what it always was.
    TACTICAL_ENVIRONMENTS.map((like) => Object.freeze({ label: like, like })),
  ) as WorldBattlefields["scenes"],
  tiles: Object.freeze({ ...TILE_WORDS }),
}) as WorldBattlefields;

/** A game's battlefields: its kit's scenes and tile words (each falling back to the engine's), or the engine's. */
export function worldBattlefields(kit: WorldKit | null | undefined): WorldBattlefields {
  if (!kit?.scenes && !kit?.tiles) return WORLD_DEFAULT_BATTLEFIELDS;
  return {
    scenes: kit.scenes ?? WORLD_DEFAULT_BATTLEFIELDS.scenes,
    tiles: Object.fromEntries(
      TACTICAL_TERRAINS.map((terrain) => [terrain, kit.tiles?.[terrain]?.trim() || TILE_WORDS[terrain]]),
    ) as Record<TacticalTerrain, string>,
  };
}

/** A game's own battlefields from its stored kit, or undefined when the kit names none. */
export function gameWorldBattlefields(
  metadata: Record<string, unknown> | null | undefined,
): WorldBattlefields | undefined {
  const kit = gameWorldKitFromMetadata(metadata);
  return kit?.scenes || kit?.tiles ? worldBattlefields(kit) : undefined;
}

/** The battlefield a scene word is laid out like: a setting scene by its label (any case), or one of the
 *  engine's sixteen by name. Undefined for a word that is neither. */
export function worldSceneLike(
  fields: WorldBattlefields,
  word: string | null | undefined,
): TacticalEnvironment | undefined {
  const key = word?.trim().toLowerCase();
  if (!key) return undefined;
  const scene = fields.scenes.find((each) => each.label.trim().toLowerCase() === key);
  if (scene) return scene.like;
  return TACTICAL_ENVIRONMENTS.find((each) => each === key);
}
