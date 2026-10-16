// ──────────────────────────────────────────────
// Storage: creature packs (design-game-creature-art.md)
//
// The write side of `game_creature_packs`, as tile packs': a version is never rewritten (the same bytes
// again are a no-op, different bytes under a stored version a conflict the maker resolves by raising the
// version), and the latest version of a pack is the one fights draw with.
// ──────────────────────────────────────────────
import { createHash } from "node:crypto";
import type { CreaturePack } from "@marinara-engine/shared";
import { and, eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { gameCreaturePacks } from "../../db/schema/index.js";
import { now } from "../../utils/id-generator.js";

export interface GameCreaturePackRow {
  id: string;
  packId: string;
  version: number;
  name: string;
  creatures: number;
  sha256: string;
  definition: string;
  createdAt: string;
}

export class CreaturePackVersionConflictError extends Error {
  constructor(packId: string, version: number) {
    super(`Version ${version} of ${packId} is already stored with different art. Save it as a new version.`);
  }
}

export function createGameCreaturePacksStorage(db: DB) {
  const rowsOf = async (packId: string) =>
    (await db.select().from(gameCreaturePacks).where(eq(gameCreaturePacks.packId, packId))) as GameCreaturePackRow[];
  return {
    /** The latest version of every pack. */
    async latest(): Promise<GameCreaturePackRow[]> {
      const newest = new Map<string, GameCreaturePackRow>();
      for (const row of (await db.select().from(gameCreaturePacks)) as GameCreaturePackRow[]) {
        const seen = newest.get(row.packId);
        if (!seen || row.version > seen.version) newest.set(row.packId, row);
      }
      return [...newest.values()].sort((a, b) => a.name.localeCompare(b.name) || a.packId.localeCompare(b.packId));
    },

    async latestOf(packId: string): Promise<GameCreaturePackRow | null> {
      return (await rowsOf(packId)).reduce<GameCreaturePackRow | null>(
        (best, row) => (!best || row.version > best.version ? row : best),
        null,
      );
    },

    /** Store one version of a checked pack, its text kept as given. */
    async put(
      pack: CreaturePack,
      definition: string,
    ): Promise<{ status: "added" | "unchanged"; row: GameCreaturePackRow }> {
      const sha256 = createHash("sha256").update(definition, "utf8").digest("hex");
      return db.transaction(async (tx) => {
        const rows = (await tx
          .select()
          .from(gameCreaturePacks)
          .where(
            and(eq(gameCreaturePacks.packId, pack.id), eq(gameCreaturePacks.version, pack.version)),
          )) as GameCreaturePackRow[];
        const existing = rows[0];
        if (existing) {
          if (existing.sha256 !== sha256) throw new CreaturePackVersionConflictError(pack.id, pack.version);
          return { status: "unchanged" as const, row: existing };
        }
        const row: GameCreaturePackRow = {
          id: `${pack.id}@${pack.version}`,
          packId: pack.id,
          version: pack.version,
          name: pack.name,
          creatures: pack.creatures.length,
          sha256,
          definition,
          createdAt: now(),
        };
        await tx.insert(gameCreaturePacks).values(row);
        return { status: "added" as const, row };
      });
    },

    /** Forget every version of a pack, and say how many went. */
    async removeAll(packId: string): Promise<number> {
      return db.transaction(async (tx) => {
        const rows = (await tx
          .select()
          .from(gameCreaturePacks)
          .where(eq(gameCreaturePacks.packId, packId))) as GameCreaturePackRow[];
        if (rows.length) await tx.delete(gameCreaturePacks).where(eq(gameCreaturePacks.packId, packId));
        return rows.length;
      });
    },
  };
}
