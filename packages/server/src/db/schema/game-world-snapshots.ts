// ──────────────────────────────────────────────
// Game: a world's snapshot (worldgen W11)
//
// The world a game was made with, kept as data (`WorldSnapshot`, shared/features/world/snapshot.ts) so
// the game plays on in the same world after the generator changes. One row per chat, its id the chat's:
// each session of a game holds its own copy, made when the session starts, so deleting one session
// never takes another's world with it.
//
// A table rather than chat metadata: a snapshot is tens to a hundred-odd kilobytes, and metadata is
// copied into every session and read on every turn and chat list.
//
// `fold` is the living world as the game's earlier sessions left it (`WorldFold`), made when the session
// starts: the session's turns fold on from it, so a change to how the world steps never remakes the
// weeks earlier sessions played. Kept here rather than in metadata, which the client may write.
// ──────────────────────────────────────────────

import { fileTable, text } from "../file-schema.js";
import { chats } from "./chats.js";

export const gameWorldSnapshots = fileTable("game_world_snapshots", {
  /** The chat's id: one snapshot a chat. */
  id: text("id").primaryKey(),
  chatId: text("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  /** Serialized `WorldSnapshot`. */
  snapshot: text("snapshot").notNull(),
  /** Serialized `WorldFold`, for a session after the first. */
  fold: text("fold"),
  createdAt: text("created_at").notNull(),
});
