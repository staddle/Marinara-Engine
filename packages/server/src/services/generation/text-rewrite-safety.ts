function hasHtmlOrXmlTag(text: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(text);
}

function hasFencedBlock(text: string): boolean {
  return /```/.test(text);
}

export function textRewriteDropsProtectedMarkup(original: string | null | undefined, edited: string): boolean {
  if (!original) return false;

  const originalHasTags = hasHtmlOrXmlTag(original);
  const originalHasFences = hasFencedBlock(original);
  if (!originalHasTags && !originalHasFences) return false;

  return (originalHasTags && !hasHtmlOrXmlTag(edited)) || (originalHasFences && !hasFencedBlock(edited));
}

/** World, place and story tags: the Engine's record of what a reply did (worldgen W4, W10). */
const ENGINE_TAG = /\[(?:world|place|story):[^[\]]*\]/gi;
const engineTags = (text: string) => (text.match(ENGINE_TAG) ?? []).sort().join("\n");

/** The scenes a game reply shows as written (worldgen W10), as kept on the message. */
export function storyScenesOf(extra: unknown): string[] {
  const scenes = (parseStoredExtra(extra) as { worldShownScenes?: unknown }).worldShownScenes;
  return Array.isArray(scenes) ? scenes.filter((scene): scene is string => typeof scene === "string") : [];
}

function parseStoredExtra(extra: unknown): Record<string, unknown> {
  if (extra && typeof extra === "object") return extra as Record<string, unknown>;
  if (typeof extra !== "string") return {};
  try {
    const parsed = JSON.parse(extra);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * True when a rewrite changes what the Engine wrote into a game reply: any world, place or story tag
 * (taken away, added, doubled or altered: the ledgers are read from them), or a scene shown as written,
 * which the player must see as written.
 */
export function textRewriteChangesEngineText(
  original: string | null | undefined,
  edited: string,
  scenes: readonly string[] = [],
): boolean {
  if (!original) return false;
  if (engineTags(original) !== engineTags(edited)) return true;
  return scenes.some((scene) => original.includes(scene) && !edited.includes(scene));
}
