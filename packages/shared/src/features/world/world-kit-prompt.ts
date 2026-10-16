// ──────────────────────────────────────────────
// What the Game Master is told of a game's setting kit (worldgen W0): the words the world is
// written in, and which kinds of change it allows. A kind the world has turned off is never
// introduced as a background event or an escalation; a scene can still hold a quarrel, but the
// world does not escalate it (worldgen plan section 7).
// ──────────────────────────────────────────────
import { WORLD_CHANGE_KINDS, type WorldKit } from "../../schemas/world-kit.schema.js";

const PACE_WORDS = {
  still: "nothing changes off-screen",
  slow: "a slow pace",
  steady: "a steady pace",
  quick: "a quick pace",
} as const;

const words = (entries: ReadonlyArray<{ label: string }>) => entries.map((entry) => entry.label).join(", ");

/** The world block of the Game Master's prompt, in the kit's own words. */
export function worldKitPromptText(kit: WorldKit): string {
  const settlements = kit.layers.find((layer) => layer.settlements)!;
  const calendar = [
    `a year is called "${kit.calendar.year}" and a day "${kit.calendar.day}"`,
    kit.calendar.months?.length ? `the months are ${kit.calendar.months.join(", ")}` : "",
    kit.calendar.era ? `years are counted by ${kit.calendar.era}` : "",
  ].filter(Boolean);
  const on = WORLD_CHANGE_KINDS.filter((kind) => kit.change.kinds[kind].on).map((kind) => kit.change.kinds[kind].label);
  const off = WORLD_CHANGE_KINDS.filter((kind) => !kit.change.kinds[kind].on).map(
    (kind) => kit.change.kinds[kind].label,
  );
  const lines = [
    `<world>`,
    `The kind of setting: ${kit.label}. Use its own words for places, groups, travel and time:`,
    `- Places, outermost first: ${words(kit.layers)}. A ${settlements.label} is, from smallest: ${words(kit.sizes)}.`,
    `- Groups: ${words(kit.groupKinds)}.`,
    ...(kit.placeTags.length ? [`- What a place may be known for: ${words(kit.placeTags)}.`] : []),
    `- Travel: ${words(kit.travel)}.`,
    `- Time: ${calendar.join("; ")}.`,
    ...kit.cultures.map((culture) => `- Names (${culture.label}): ${culture.naming}`),
    kit.change.pace === "still" || on.length === 0
      ? `- The world beyond the scene does not change on its own.`
      : `- The world changes in the background at ${PACE_WORDS[kit.change.pace]}: ${on.join("; ")}.`,
  ];
  if (off.length > 0) {
    lines.push(
      `- This world does not have ${off.join("; ")}. Never bring them in as background events or let a scene escalate into them; a quarrel can stay a quarrel.`,
    );
  }
  lines.push(`</world>`);
  return lines.join("\n");
}
