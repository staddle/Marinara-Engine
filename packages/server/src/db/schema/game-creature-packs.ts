// ──────────────────────────────────────────────
// Game: creature packs (design-game-creature-art.md)
//
// Art for the creatures Game Mode fights, made in Pixelforge or imported from a file: one row per
// (namespaced pack id, VERSION), the file kept exactly as it was saved, as tile packs are. Nothing owns a
// row: removing a pack is a deliberate act.
// ──────────────────────────────────────────────

import { fileTable, text, integer } from "../file-schema.js";

export const gameCreaturePacks = fileTable("game_creature_packs", {
  /** `<namespaced pack id>@<version>`. */
  id: text("id").primaryKey(),
  /** Namespaced (`local/monsters`). */
  packId: text("pack_id").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  /** How many creatures it has art for, for the library's list. */
  creatures: integer("creatures").notNull(),
  sha256: text("sha256").notNull(),
  /** The pack's JSON text, verbatim. */
  definition: text("definition").notNull(),
  createdAt: text("created_at").notNull(),
});
