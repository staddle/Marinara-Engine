// ──────────────────────────────────────────────
// Game: a world's snapshot storage (worldgen W11)
//
// One row a chat, its id the chat's. A save is an upsert on that id, so two saves for one chat leave one
// row. A row is checked whole when it is read (`readWorldSnapshot`), and the last few reads are kept
// parsed, since a turn reads its world more than once.
// ──────────────────────────────────────────────

import { eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { gameWorldSnapshots } from "../../db/schema/index.js";
import { now } from "../../utils/id-generator.js";
import { logger } from "../../lib/logger.js";
import { readWorldSnapshot, type WorldFold, type WorldSnapshot } from "@marinara-engine/shared";

const parsed = new Map<string, { text: string; snapshot: WorldSnapshot }>();
const PARSED_KEPT = 16;

const remember = (chatId: string, text: string, snapshot: WorldSnapshot) => {
  parsed.delete(chatId);
  parsed.set(chatId, { text, snapshot });
  if (parsed.size > PARSED_KEPT) parsed.delete(parsed.keys().next().value!);
};

export function createGameWorldSnapshotsStorage(db: DB) {
  const rowOf = async (chatId: string) =>
    (
      (await db.select().from(gameWorldSnapshots).where(eq(gameWorldSnapshots.chatId, chatId))) as Array<{
        id: string;
        snapshot: string;
        fold: string | null;
        createdAt: string;
      }>
    )[0];
  return {
    /** The chat's world snapshot, or null when it has none or it cannot be read. */
    async get(chatId: string): Promise<WorldSnapshot | null> {
      const row = await rowOf(chatId);
      if (!row) return null;
      const known = parsed.get(chatId);
      if (known && known.text === row.snapshot) return known.snapshot;
      let value: unknown;
      try {
        value = JSON.parse(row.snapshot);
      } catch {
        value = null;
      }
      const read = readWorldSnapshot(value);
      if (!read.ok) {
        logger.warn("World snapshot for chat %s cannot be read: %s", chatId, read.issues.join("; "));
        return null;
      }
      remember(chatId, row.snapshot, read.snapshot);
      return read.snapshot;
    },

    /** Keeps a chat's snapshot, in place of any it had. */
    async put(chatId: string, snapshot: WorldSnapshot): Promise<void> {
      const text = JSON.stringify(snapshot);
      const existing = await rowOf(chatId);
      await db
        .insert(gameWorldSnapshots)
        .values({ id: chatId, chatId, snapshot: text, createdAt: existing?.createdAt ?? now() })
        .onConflictDoUpdate({ target: gameWorldSnapshots.id, set: { snapshot: text } });
      remember(chatId, text, snapshot);
    },

    /** Gives one chat another's snapshot and fold (a new session, a branch); nothing when it has none. */
    async copy(fromChatId: string, toChatId: string): Promise<boolean> {
      const row = await rowOf(fromChatId);
      if (!row) return false;
      await db
        .insert(gameWorldSnapshots)
        .values({ id: toChatId, chatId: toChatId, snapshot: row.snapshot, fold: row.fold ?? null, createdAt: now() })
        .onConflictDoUpdate({ target: gameWorldSnapshots.id, set: { snapshot: row.snapshot, fold: row.fold ?? null } });
      return true;
    },

    /** The living world as the chat's earlier sessions left it, or null (a first session, or none kept). */
    async getFold(chatId: string): Promise<WorldFold | null> {
      const text = (await rowOf(chatId))?.fold;
      if (!text) return null;
      try {
        const fold = JSON.parse(text) as WorldFold;
        return fold && typeof fold === "object" && fold.present && typeof fold.present === "object" ? fold : null;
      } catch {
        return null;
      }
    },

    /** Keeps the living world a session starts from; nothing for a chat with no snapshot. */
    async setFold(chatId: string, fold: WorldFold): Promise<void> {
      if (!(await rowOf(chatId))) return;
      await db
        .update(gameWorldSnapshots)
        .set({ fold: JSON.stringify(fold) })
        .where(eq(gameWorldSnapshots.chatId, chatId));
    },

    /** Takes a chat's snapshot away (a world that was not given after all). */
    async remove(chatId: string): Promise<void> {
      await db.delete(gameWorldSnapshots).where(eq(gameWorldSnapshots.chatId, chatId));
      parsed.delete(chatId);
    },

    /** The stored text as it is, for an export that carries it. */
    async raw(chatId: string): Promise<string | null> {
      return (await rowOf(chatId))?.snapshot ?? null;
    },
  };
}
