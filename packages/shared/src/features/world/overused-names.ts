// ──────────────────────────────────────────────
// Names models reach for again and again (worldgen W2), the reason seeded names exist at all: invented
// fantasy favourites and a few stock full names. A world's name lists leave them out, so its people are
// named from the culture's own data instead. Only invented names and stock pairings: never a real
// person, and never a name common in a real culture on its own (a "Chen" or a "Marcus" is a real name;
// "Marcus Chen" as everybody's go-to is the cliché).
// ──────────────────────────────────────────────

export const WORLD_OVERUSED_NAMES: readonly string[] = Object.freeze([
  "Elara",
  "Lyra",
  "Kael",
  "Seraphina",
  "Thorne",
  "Voss",
  "Lysandra",
  "Eldric",
  "Aldric",
  "Caelum",
  "Elowen",
  "Kaelen",
  "Zephyr",
  "Elara Voss",
  "Marcus Chen",
  "Sarah Chen",
  "Elena Vasquez",
  "Kira Nakamura",
  "Rowan Ashford",
]);

const overused = new Set(WORLD_OVERUSED_NAMES.map((name) => name.toLowerCase()));

/** Whether a name (or any word of it) is one models overuse. */
export function isOverusedName(name: string): boolean {
  const key = name.trim().replace(/\s+/g, " ").toLowerCase();
  if (overused.has(key)) return true;
  // A one-word entry ("Elara") is overused inside any name; a full name ("Marcus Chen") only whole.
  return key.split(" ").some((word) => overused.has(word));
}
