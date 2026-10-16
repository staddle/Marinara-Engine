// Professor Mari's agent runtime: "classic" is the original JSON-frame loop and the default and fallback;
// "pi" runs the same workspace tools through the pi SDK with native tool calls (trial, server-authoritative).
// The value lives in app_settings under MARI_RUNTIME_SETTINGS_KEY and is written only by the validated
// PUT /api/professor-mari/workspace/runtime route. Global only, read fresh on every Mari run.
export const MARI_RUNTIME_SETTINGS_KEY = "mari-runtime";

export const MARI_RUNTIMES = ["classic", "pi"] as const;

export type MariRuntime = (typeof MARI_RUNTIMES)[number];

export const DEFAULT_MARI_RUNTIME: MariRuntime = "classic";

export function isMariRuntime(value: unknown): value is MariRuntime {
  return typeof value === "string" && (MARI_RUNTIMES as readonly string[]).includes(value);
}
