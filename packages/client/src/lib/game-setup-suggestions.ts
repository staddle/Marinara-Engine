// ──────────────────────────────────────────────
// The setup wizard's setting and goal suggestions (worldgen W6g): two of each per starter setting,
// rotated across settings so that no one kind of world is the default idea, and led by the setting
// kit the player picked. Each is a localization key under `game.setup.suggestions.`.
// ──────────────────────────────────────────────

/** The starter settings with suggestions, in rotation order. */
export const SUGGESTION_SETTINGS = Object.freeze([
  "high_fantasy",
  "wuxia_xianxia",
  "modern_day",
  "modern_supernatural",
  "the_1920s",
  "cyberpunk",
  "space_opera",
  "post_apocalyptic",
] as const);

/** The genre chip each starter setting stands for. */
export const SETTING_GENRE: Readonly<Record<string, string>> = Object.freeze({
  high_fantasy: "Fantasy",
  wuxia_xianxia: "Wuxia",
  modern_day: "Modern",
  modern_supernatural: "Modern",
  the_1920s: "Historical",
  cyberpunk: "Cyberpunk",
  space_opera: "Sci-Fi",
  post_apocalyptic: "Post-Apocalyptic",
});

export type SuggestionKind = "setting" | "goal";

const key = (setting: string, kind: SuggestionKind, which: number) =>
  `game.setup.suggestions.${setting}.${kind}${which}`;

/** The suggestions to show: the picked starter setting's own two and one from another setting, or one
 *  from each of three settings. `offset` is the rotation, drawn when the wizard opens. */
export function setupSuggestionKeys(kind: SuggestionKind, kitId: string | null | undefined, offset: number): string[] {
  const settings = SUGGESTION_SETTINGS;
  const own = settings.findIndex((setting) => setting === kitId);
  if (own >= 0) {
    const other = settings[(own + 1 + (offset % (settings.length - 1))) % settings.length]!;
    return [key(settings[own]!, kind, 1), key(settings[own]!, kind, 2), key(other, kind, 1 + (offset % 2))];
  }
  // Each pass through the settings offers their other idea.
  return [0, 1, 2].map((step) => {
    const at = offset + step;
    return key(settings[at % settings.length]!, kind, 1 + (Math.floor(at / settings.length) % 2));
  });
}

/** Every suggestion of a kind, so the learned options never repeat one. */
export function allSetupSuggestionKeys(kind: SuggestionKind): string[] {
  return SUGGESTION_SETTINGS.flatMap((setting) => [key(setting, kind, 1), key(setting, kind, 2)]);
}
