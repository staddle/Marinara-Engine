// ──────────────────────────────────────────────
// The battlefields a tactical board can be laid out as: each steers the generated terrain (grid-gen)
// and the client's palette. Kept apart with no imports, so a setting kit's schema can name them
// (worldgen W6d) without importing the tactical engine.
// ──────────────────────────────────────────────
export const TACTICAL_ENVIRONMENTS = Object.freeze([
  "forest",
  "dungeon",
  "desert",
  "cave",
  "city",
  "ruins",
  "snow",
  "water",
  "castle",
  "wasteland",
  "plains",
  "mountains",
  "swamp",
  "volcanic",
  "spaceship",
  "mansion",
] as const);
export type TacticalEnvironment = (typeof TACTICAL_ENVIRONMENTS)[number];

/** The six kinds of tile on a board. */
export const TACTICAL_TERRAINS = Object.freeze(["plains", "forest", "mountain", "ruin", "water", "wall"] as const);
export type TacticalTerrain = (typeof TACTICAL_TERRAINS)[number];
