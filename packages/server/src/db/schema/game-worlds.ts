// ──────────────────────────────────────────────
// Game: the library of worlds (worldgen W9f)
//
// Worlds made outside any game (from a kit and a seed), edited and given a story in a maker, kept to
// start new games from and to ship in map packs. Each is kept as its world share file (kit, world with
// its hand edits, story). A game takes a COPY when it starts, so editing a library world never changes
// a game that came from it.
// ──────────────────────────────────────────────

import { fileTable, text } from "../file-schema.js";

export const gameWorlds = fileTable("game_worlds", {
  /** `w_<hex>`. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** The world share file's JSON text. */
  file: text("file").notNull(),
  updatedAt: text("updated_at").notNull(),
});
