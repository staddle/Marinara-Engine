// ──────────────────────────────────────────────
// Storage: tile packs (worldgen W9a)
//
// The write side of `game_tile_packs`. A version is never rewritten: saving the SAME bytes again is a
// no-op, and different bytes under a version already stored are a conflict the maker resolves by
// raising the version. The latest version of a pack is the one the overworld draws with.
// ──────────────────────────────────────────────
import { createHash } from "node:crypto";
import type { TilePack } from "@marinara-engine/shared";
import { and, eq } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { gameTilePacks } from "../../db/schema/index.js";
import { now } from "../../utils/id-generator.js";

export interface GameTilePackRow {
  id: string;
  packId: string;
  version: number;
  family: string;
  name: string;
  sha256: string;
  definition: string;
  createdAt: string;
}

export class TilePackVersionConflictError extends Error {
  constructor(packId: string, version: number) {
    super(`Version ${version} of ${packId} is already stored with different tiles. Save it as a new version.`);
  }
}

export class TilePackVersionTooOldError extends Error {
  constructor(packId: string, version: number) {
    super(
      `Version ${version} of ${packId} is older than the ${IMAGE_PACK_VERSIONS_KEPT} versions kept. Save it as a new version.`,
    );
  }
}

/** The newest versions of an image pack kept (older ones are dropped as a new one is saved). */
export const IMAGE_PACK_VERSIONS_KEPT = 8;

export function createGameTilePacksStorage(db: DB) {
  const all = async () => (await db.select().from(gameTilePacks)) as GameTilePackRow[];
  return {
    /** The latest version of every pack. */
    async latest(): Promise<GameTilePackRow[]> {
      const newest = new Map<string, GameTilePackRow>();
      for (const row of await all()) {
        const seen = newest.get(row.packId);
        if (!seen || row.version > seen.version) newest.set(row.packId, row);
      }
      return [...newest.values()].sort((a, b) => a.name.localeCompare(b.name) || a.packId.localeCompare(b.packId));
    },

    async latestOf(packId: string): Promise<GameTilePackRow | null> {
      const rows = (await db.select().from(gameTilePacks).where(eq(gameTilePacks.packId, packId))) as GameTilePackRow[];
      return rows.reduce<GameTilePackRow | null>(
        (best, row) => (!best || row.version > best.version ? row : best),
        null,
      );
    },

    /** Store one version of a checked pack, its text kept as given. */
    async put(pack: TilePack, definition: string): Promise<{ status: "added" | "unchanged"; row: GameTilePackRow }> {
      const sha256 = createHash("sha256").update(definition, "utf8").digest("hex");
      return db.transaction(async (tx) => {
        const rows = (await tx
          .select()
          .from(gameTilePacks)
          .where(and(eq(gameTilePacks.packId, pack.id), eq(gameTilePacks.version, pack.version)))) as GameTilePackRow[];
        const existing = rows[0];
        // An image pack keeps its newest versions only, so one older than all of them would be dropped as
        // soon as it was kept: refused instead.
        if (!existing && pack.tilePackVersion === 2) {
          const newer = (
            (await tx.select().from(gameTilePacks).where(eq(gameTilePacks.packId, pack.id))) as GameTilePackRow[]
          ).filter((row) => row.version > pack.version);
          if (newer.length >= IMAGE_PACK_VERSIONS_KEPT) throw new TilePackVersionTooOldError(pack.id, pack.version);
        }
        if (existing) {
          if (existing.sha256 !== sha256) throw new TilePackVersionConflictError(pack.id, pack.version);
          return { status: "unchanged" as const, row: existing };
        }
        const row: GameTilePackRow = {
          id: `${pack.id}@${pack.version}`,
          packId: pack.id,
          version: pack.version,
          family: pack.family,
          name: pack.name,
          sha256,
          definition,
          createdAt: now(),
        };
        await tx.insert(gameTilePacks).values(row);
        // An image pack keeps its newest versions only: each can be megabytes, and every row stays in
        // memory and in every backup.
        if (pack.tilePackVersion === 2) {
          const versions = (await tx
            .select()
            .from(gameTilePacks)
            .where(eq(gameTilePacks.packId, pack.id))) as GameTilePackRow[];
          const dropped = versions.sort((a, b) => b.version - a.version).slice(IMAGE_PACK_VERSIONS_KEPT);
          for (const old of dropped) await tx.delete(gameTilePacks).where(eq(gameTilePacks.id, old.id));
        }
        return { status: "added" as const, row };
      });
    },

    /** Forget every version of a pack, and say how many went. */
    async removeAll(packId: string): Promise<number> {
      return db.transaction(async (tx) => {
        const rows = (await tx
          .select()
          .from(gameTilePacks)
          .where(eq(gameTilePacks.packId, packId))) as GameTilePackRow[];
        if (rows.length) await tx.delete(gameTilePacks).where(eq(gameTilePacks.packId, packId));
        return rows.length;
      });
    },
  };
}
