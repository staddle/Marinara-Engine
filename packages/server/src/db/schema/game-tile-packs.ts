// ──────────────────────────────────────────────
// Game: tile packs (worldgen W9a)
//
// The overworld's and the towns' art made in Pixelforge or imported from a file: one row per
// (namespaced pack id, VERSION), the file kept exactly as it was saved, so a re-save of the same bytes
// is recognisable and a changed one needs a new version. The Engine's own packs are not stored here;
// they ship in src/assets/overworld-tiles. Nothing owns a row: removing a pack is a deliberate act.
// ──────────────────────────────────────────────

import { fileTable, text, integer } from "../file-schema.js";

export const gameTilePacks = fileTable("game_tile_packs", {
  /** `<namespaced pack id>@<version>`. */
  id: text("id").primaryKey(),
  /** Namespaced (`local/my-fantasy`), never a built-in family's bare id. */
  packId: text("pack_id").notNull(),
  version: integer("version").notNull(),
  family: text("family").notNull(),
  name: text("name").notNull(),
  sha256: text("sha256").notNull(),
  /** The pack's JSON text, verbatim. */
  definition: text("definition").notNull(),
  createdAt: text("created_at").notNull(),
});
