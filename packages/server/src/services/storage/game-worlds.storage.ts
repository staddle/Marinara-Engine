// ──────────────────────────────────────────────
// Storage: the library of worlds (worldgen W9f)
//
// The write side of `game_worlds`. A change is read, checked and written in one transaction, so two
// makers saving at once never leave a world that does not hold together.
// ──────────────────────────────────────────────
import { randomBytes } from "node:crypto";
import { eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { gameWorlds } from "../../db/schema/index.js";
import { now } from "../../utils/id-generator.js";

export interface GameWorldRow {
  id: string;
  name: string;
  file: string;
  updatedAt: string;
}

export function createGameWorldsStorage(db: DB) {
  return {
    async list(): Promise<GameWorldRow[]> {
      const rows = (await db.select().from(gameWorlds)) as GameWorldRow[];
      return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },

    async get(id: string): Promise<GameWorldRow | null> {
      const rows = (await db.select().from(gameWorlds).where(eq(gameWorlds.id, id))) as GameWorldRow[];
      return rows[0] ?? null;
    },

    async create(name: string, file: string): Promise<GameWorldRow> {
      const row: GameWorldRow = { id: `w_${randomBytes(6).toString("hex")}`, name, file, updatedAt: now() };
      await db.insert(gameWorlds).values(row);
      return row;
    },

    /** Change a world as it is now: `change` returns its new name and file, or a refusal (nothing is
     *  written then), or null when there is no such world. */
    async update<T extends { refused: string; issues?: string[] }>(
      id: string,
      change: (row: GameWorldRow) => { name: string; file: string } | T,
    ): Promise<{ row: GameWorldRow } | T | null> {
      return db.transaction(async (tx) => {
        const rows = (await tx.select().from(gameWorlds).where(eq(gameWorlds.id, id))) as GameWorldRow[];
        const current = rows[0];
        if (!current) return null;
        const next = change(current);
        if ("refused" in next) return next;
        const row: GameWorldRow = { ...current, ...next, updatedAt: now() };
        await tx.update(gameWorlds).set(row).where(eq(gameWorlds.id, id));
        return { row };
      });
    },

    async remove(id: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        const rows = (await tx.select().from(gameWorlds).where(eq(gameWorlds.id, id))) as GameWorldRow[];
        if (!rows.length) return false;
        await tx.delete(gameWorlds).where(eq(gameWorlds.id, id));
        return true;
      });
    },
  };
}
