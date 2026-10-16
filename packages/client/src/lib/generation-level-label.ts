/** Reasoning effort and verbosity levels with their own name in the catalog. */
const NAMED_LEVELS = new Set(["low", "medium", "high", "xhigh", "max", "maximum"]);

/**
 * A reasoning effort or verbosity level as people read it: "Low" for the "low" that is saved and sent. A level
 * without a name of its own (a provider's own label) keeps its text with a capital first letter.
 */
export function generationLevelLabel(level: string, t: (key: string) => string): string {
  return NAMED_LEVELS.has(level)
    ? t(`generationParameters.level.${level}`)
    : level.charAt(0).toUpperCase() + level.slice(1);
}
