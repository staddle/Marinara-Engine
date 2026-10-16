// ──────────────────────────────────────────────
// Storage: board packs (fight-board art slots, Capability API 1.333)
//
// The write side of `game_board_packs`, as tile packs': a version is never rewritten (the same bytes
// again are a no-op, different bytes under a stored version a conflict the maker resolves by raising the
// version), and the latest version of a pack is the one boards draw with.
// ──────────────────────────────────────────────
import { createHash } from "node:crypto";
import type { BoardPack } from "@marinara-engine/shared";
import { and, eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { gameBoardPacks } from "../../db/schema/index.js";
import { now } from "../../utils/id-generator.js";

export interface GameBoardPackRow {
  id: string;
  packId: string;
  version: number;
  name: string;
  tiles: number;
  sha256: string;
  definition: string;
  createdAt: string;
}

export class BoardPackVersionConflictError extends Error {
  constructor(packId: string, version: number) {
    super(`Version ${version} of ${packId} is already stored with different art. Save it as a new version.`);
  }
}

export function createGameBoardPacksStorage(db: DB) {
  const rowsOf = async (packId: string) =>
    (await db.select().from(gameBoardPacks).where(eq(gameBoardPacks.packId, packId))) as GameBoardPackRow[];
  return {
    /** The latest version of every pack. */
    async latest(): Promise<GameBoardPackRow[]> {
      const newest = new Map<string, GameBoardPackRow>();
      for (const row of (await db.select().from(gameBoardPacks)) as GameBoardPackRow[]) {
        const seen = newest.get(row.packId);
        if (!seen || row.version > seen.version) newest.set(row.packId, row);
      }
      return [...newest.values()].sort((a, b) => a.name.localeCompare(b.name) || a.packId.localeCompare(b.packId));
    },

    async latestOf(packId: string): Promise<GameBoardPackRow | null> {
      return (await rowsOf(packId)).reduce<GameBoardPackRow | null>(
        (best, row) => (!best || row.version > best.version ? row : best),
        null,
      );
    },

    /** Store one version of a checked pack, its text kept as given. */
    async put(pack: BoardPack, definition: string): Promise<{ status: "added" | "unchanged"; row: GameBoardPackRow }> {
      const sha256 = createHash("sha256").update(definition, "utf8").digest("hex");
      return db.transaction(async (tx) => {
        const rows = (await tx
          .select()
          .from(gameBoardPacks)
          .where(
            and(eq(gameBoardPacks.packId, pack.id), eq(gameBoardPacks.version, pack.version)),
          )) as GameBoardPackRow[];
        const existing = rows[0];
        if (existing) {
          if (existing.sha256 !== sha256) throw new BoardPackVersionConflictError(pack.id, pack.version);
          return { status: "unchanged" as const, row: existing };
        }
        const row: GameBoardPackRow = {
          id: `${pack.id}@${pack.version}`,
          packId: pack.id,
          version: pack.version,
          name: pack.name,
          tiles: Object.keys(pack.tiles).length,
          sha256,
          definition,
          createdAt: now(),
        };
        await tx.insert(gameBoardPacks).values(row);
        return { status: "added" as const, row };
      });
    },

    /** Forget every version of a pack, and say how many went. */
    async removeAll(packId: string): Promise<number> {
      return db.transaction(async (tx) => {
        const rows = (await tx
          .select()
          .from(gameBoardPacks)
          .where(eq(gameBoardPacks.packId, packId))) as GameBoardPackRow[];
        if (rows.length) await tx.delete(gameBoardPacks).where(eq(gameBoardPacks.packId, packId));
        return rows.length;
      });
    },
  };
}
