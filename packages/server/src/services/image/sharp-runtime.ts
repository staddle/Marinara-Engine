import { logger } from "../../lib/logger.js";

// sharp is optional on platforms without native prebuilds (notably some
// Android/Termux installations). Keep one lazy loader so every image path gets
// the same cached failure and actionable error message.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SharpFn = any;

let sharpModule: SharpFn | null = null;
let sharpLoadError: Error | null = null;

export async function getSharp(): Promise<SharpFn> {
  if (sharpModule) return sharpModule;
  if (sharpLoadError) throw sharpLoadError;

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - optional native dependency
    const mod = await import("sharp");
    sharpModule = (mod.default ?? mod) as SharpFn;
    return sharpModule;
  } catch (error) {
    logger.warn(
      error instanceof Error ? error : new Error(String(error)),
      "[sprites] Image processing unavailable because sharp could not be loaded",
    );
    sharpLoadError = new Error(
      "Image processing is unavailable on this platform (native 'sharp' module could not be loaded). " +
        "Sprite generation and background removal are disabled.",
    );
    throw sharpLoadError;
  }
}

export type RgbColor = { red: number; green: number; blue: number };

export function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Files of sharp's prebuilt loader packages (@img/sharp-<platform>, @img/sharp-wasm32). */
const SHARP_LOADER_FILE = /[\\/]@img[\\/]sharp-[^\\/]+[\\/]/u;

/**
 * sharp's WebAssembly fallback finishes starting in an un-awaited async run(), so a
 * failure there (for example a missing @emnapi/runtime) rejects a promise no caller
 * holds. Image processing is optional, so that rejection must turn image processing
 * off, not end the session; every other unhandled rejection stays fatal.
 * ponytail: matches only sharp's own loader files; upgrade path: probe sharp in a child
 * process before the in-process import, which also frees the ~44 MB half-started heap.
 */
export function isSharpLoaderRejection(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  const { requireStack } = reason as { requireStack?: unknown };
  const origin = Array.isArray(requireStack)
    ? requireStack[0]
    : reason.stack?.split("\n").find((line) => line.trimStart().startsWith("at ") && !/\b(?:node|wasm):/u.test(line));
  return typeof origin === "string" && SHARP_LOADER_FILE.test(origin);
}
