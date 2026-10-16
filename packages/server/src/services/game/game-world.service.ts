// ──────────────────────────────────────────────
// Game: a chat's world (worldgen W1, W11)
//
// Every server reader of a game's world comes here. A world is its snapshot (W11) when the chat keeps
// one, read without the generator, so the game plays on in the same world after the generator changes;
// a world with no snapshot (made before W11, on a development build) is made from its recipe on every
// read, as before, and only while this Engine's generator made it.
// ──────────────────────────────────────────────
import { gameWorldFromMetadata, gameWorldFromSnapshot, worldSnapshot, type GameWorld } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { createGameWorldSnapshotsStorage } from "../storage/game-world-snapshots.storage.js";

const warned = new Set<string>();

/** A chat's game world, or null for a chat with no world (or one this Engine cannot read). */
export async function loadGameWorld(
  db: DB,
  chatId: string,
  metadata: Record<string, unknown> | null | undefined,
): Promise<GameWorld | null> {
  if (!metadata || metadata.gameWorld == null) return null;
  const snapshot = await createGameWorldSnapshotsStorage(db).get(chatId);
  if (snapshot) return gameWorldFromSnapshot(snapshot);
  if (!warned.has(chatId)) {
    warned.add(chatId);
    logger.warn("Game chat %s has a world with no snapshot; it is made from its recipe on every read", chatId);
  }
  return gameWorldFromMetadata(metadata);
}

/** Makes a chat's world from its recipe and keeps it as the chat's snapshot: when the game is made and
 *  whenever its edits are saved. Null when the recipe is not one this Engine's generator reads. */
export async function saveGameWorldSnapshot(
  db: DB,
  chatId: string,
  metadata: Record<string, unknown> | null | undefined,
): Promise<GameWorld | null> {
  const game = gameWorldFromMetadata(metadata);
  if (!game) return null;
  await createGameWorldSnapshotsStorage(db).put(chatId, worldSnapshot(game));
  return game;
}
