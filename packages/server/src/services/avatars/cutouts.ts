// ──────────────────────────────────────────────
// Avatar agents: a picture without a background
// ──────────────────────────────────────────────
// The sprite sent to Tripo for a 3D model (generation/tripo-vrm.ts) is cleaned here first. A picture that
// already has a see-through background is used as it is (hasSpriteTransparency, the matte cleanup's own
// test). Any other is cleaned by the sprite background cleanup (removeSpriteBackgroundPng) with the
// configured engine: the built-in cleaner for a flat background, the AI remover (backgroundremover) when it
// is installed and the background isn't flat, or always when the AI remover is the configured engine. When
// the AI remover is missing or fails, the built-in cleaner is used, as on Lite and Termux.
// 2D avatars never clean the owner's sprites: they show them as they are, and faces without a background
// come from sprite generation (the 2D Avatars page opens the sprite generator).
import { logger } from "../../lib/logger.js";
import { hasSpriteTransparency, removeSpriteBackgroundPng } from "../image/sprite-background.service.js";

/** The sprite cleanup's default strength (POST /api/sprites/cleanup). */
const CLEANUP_STRENGTH = 35;

let cleanupQueue: Promise<unknown> = Promise.resolve();

/** A cleaned picture; `fallback` when the built-in cleaner made it because the AI remover was wanted but is
 *  missing or failed. */
async function cleanPicture(png: Buffer): Promise<{ png: Buffer; fallback: boolean }> {
  try {
    const cleaned = await removeSpriteBackgroundPng(png, CLEANUP_STRENGTH);
    return { png: cleaned.buffer, fallback: cleaned.fallback === true };
  } catch (error) {
    // Only an AI remover set as the engine throws (missing or failed); the built-in cleaner still works.
    logger.warn(error, "[avatars] The background remover failed; using the built-in cleaner");
    return { png: (await removeSpriteBackgroundPng(png, CLEANUP_STRENGTH, "builtin")).buffer, fallback: true };
  }
}

/** A cut-out of a picture, the same size: the picture itself when its background is already see-through.
 *  Cleanups run one at a time, so several jobs never start many AI remover processes at once.
 *  ponytail: one line for the whole server, first come first served, and Cancel lets a running cleanup
 *  finish. Upgrade: pass the job's signal and skip a cancelled job's cleanup. */
export async function avatarCutout(png: Buffer): Promise<{ png: Buffer; cleaned: boolean; fallback: boolean }> {
  if (await hasSpriteTransparency(png)) return { png, cleaned: false, fallback: false };
  const run = cleanupQueue.then(() => cleanPicture(png));
  cleanupQueue = run.catch(() => undefined);
  return { ...(await run), cleaned: true };
}
