// ──────────────────────────────────────────────
// A world's people (worldgen W2): who lives in each place, drawn by the seed rather than written by the
// model, so a game's people are as varied as their cultures' names and never the same few names models
// reach for. Each has a stable id and a small sheet (role, culture, where they come from, three traits,
// how they look), so two people who share a name are told apart, and what the Game Master writes back
// about one lands on the right one. A place's people are drawn only when asked for (when the party is
// there), from the place's own stream, so they are the same people on every read.
// ──────────────────────────────────────────────
import type { WorldKit } from "../../schemas/world-kit.schema.js";
import type { GameNpc } from "../../types/game.js";
import { worldStream, type WorldPlace } from "./compile.js";
import { worldPlaceNamed } from "./edits.js";
import type { GameWorld } from "./game-world.js";

/** The words a kit's people are drawn in when the kit leaves them out. Plain, setting-neutral words. */
export const WORLD_PEOPLE_DEFAULTS = Object.freeze({
  roles: [
    { label: "farmer" },
    { label: "trader" },
    { label: "crafter" },
    { label: "guard" },
    { label: "healer" },
    { label: "elder" },
    { label: "traveller" },
    { label: "labourer" },
  ] as ReadonlyArray<{ label: string; tags?: string[] }>,
  hair: ["dark hair", "light hair", "grey hair", "short hair", "long hair"],
  marks: ["a scar", "a limp", "freckles", "a loud laugh", "a tired look"],
  ages: ["young", "in their prime", "middle-aged", "old"],
  builds: ["slight", "wiry", "stocky", "broad-shouldered", "tall and thin", "heavyset", "short"],
  temperaments: [
    "kind",
    "gruff",
    "cheerful",
    "wary",
    "proud",
    "shy",
    "hot-tempered",
    "patient",
    "curious",
    "sly",
    "earnest",
    "weary",
  ],
  values: [
    "family",
    "faith",
    "money",
    "honour",
    "freedom",
    "learning",
    "duty",
    "comfort",
    "tradition",
    "ambition",
    "friendship",
    "justice",
  ],
  speech: [
    "soft-spoken",
    "blunt",
    "long-winded",
    "formal",
    "full of jokes",
    "a person of few words",
    "quick and nervous",
    "warm and slow",
  ],
});

export interface WorldPerson {
  /** Stable: the place's id and their place among its people. */
  id: string;
  name: string;
  /** False when no name list could name them, and they go by their role until the story names them. */
  named: boolean;
  placeId: string;
  /** The kit culture they are of, and the place they or their family came from when that is not here. */
  culture: string;
  origin?: string;
  role: string;
  /** One of the brief's groups seated here, when they belong to it. */
  group?: string;
  temperament: string;
  value: string;
  speech: string;
  age: string;
  build: string;
  hair: string;
  mark: string;
}

function peopleWords(kit: WorldKit) {
  const own = kit.people;
  return {
    roles: own?.roles ?? WORLD_PEOPLE_DEFAULTS.roles,
    hair: own?.hair ?? WORLD_PEOPLE_DEFAULTS.hair,
    marks: own?.marks ?? WORLD_PEOPLE_DEFAULTS.marks,
    ages: own?.ages ?? WORLD_PEOPLE_DEFAULTS.ages,
    builds: own?.builds ?? WORLD_PEOPLE_DEFAULTS.builds,
    temperaments: own?.temperaments ?? WORLD_PEOPLE_DEFAULTS.temperaments,
    values: own?.values ?? WORLD_PEOPLE_DEFAULTS.values,
    speech: own?.speech ?? WORLD_PEOPLE_DEFAULTS.speech,
  };
}

const pick = <T>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)]!;

/** Scripts written without spaces between words, where a name runs straight into the next word. */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** A full name drawn from a culture's name lists, in its own order. Names in a script without spaces
 *  are written together (林子墨), as their people write them. */
export function worldFullName(
  names: { given: readonly string[]; family: readonly string[]; order: "given-family" | "family-given" | "given" },
  random: () => number,
): string {
  const given = pick(names.given, random);
  const family = names.order !== "given" && names.family.length ? pick(names.family, random) : "";
  if (!family) return given;
  const gap = UNSPACED_SCRIPT.test(given) && UNSPACED_SCRIPT.test(family) ? "" : " ";
  return names.order === "family-given" ? `${family}${gap}${given}` : `${given}${gap}${family}`;
}

function weighted<T>(items: ReadonlyArray<{ item: T; weight: number }>, random: () => number): T {
  const total = items.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = random() * total;
  for (const entry of items) {
    roll -= entry.weight;
    if (roll < 0) return entry.item;
  }
  return items.at(-1)!.item;
}

/** How many people a place has: more the bigger its settlement. */
export function worldCastSize(place: WorldPlace, settlement: WorldPlace): number {
  return place === settlement ? 3 + 3 * (settlement.rank ?? 0) : 2 + (settlement.rank ?? 0);
}

/**
 * The people of one place: a settlement, or a place inside one (its own, fewer). A place above the
 * settlements (a province, a system) has no people of its own. Names are unique within the place.
 */
export function worldCast(game: GameWorld, placeId: string): WorldPerson[] {
  // A world read from its snapshot (W11) keeps its people as they were made.
  if (game.frozen) return (game.frozen.casts[placeId] ?? []).map((person) => ({ ...person }));
  const { kit, brief, world, seed, edits } = game;
  const byId = new Map(world.places.map((place) => [place.id, place]));
  const place = byId.get(placeId);
  if (!place) return [];
  const settlement = place.rank !== undefined ? place : place.parentId ? byId.get(place.parentId) : undefined;
  if (!settlement || settlement.rank === undefined) return [];

  const words = peopleWords(kit);
  const random = worldStream(seed, "cast", place.id);
  const placeTags = new Set([...place.tags, ...settlement.tags]);
  const roleWeights = words.roles.map((role) => ({
    item: role.label,
    weight: !role.tags?.length ? 1 : role.tags.some((tag) => placeTags.has(tag)) ? 4 : 0.15,
  }));
  // A seat names the place as the brief did, which a hand edit may since have renamed.
  const groupsHere = brief.groups.filter((group) => worldPlaceNamed([place, settlement], group.seat) !== undefined);
  const outerPlaces = world.places.filter((each) => each.depth <= 1 && each.size === undefined);

  const used = new Set<string>();
  const people: WorldPerson[] = [];
  const count = worldCastSize(place, settlement);
  for (let index = 0; index < count; index++) {
    // Most are of the place's own people; some came from elsewhere.
    const foreign = kit.cultures.length > 1 && random() < 0.2;
    const culture = foreign
      ? pick(
          kit.cultures.filter((each) => each.id !== place.culture),
          random,
        ).id
      : place.culture;
    const from = foreign ? outerPlaces.filter((each) => each.culture === culture) : [];
    const origin = from.length ? pick(from, random).name : undefined;
    const role = weighted(roleWeights, random);
    const names = brief.peopleNames.find((group) => group.culture === culture);
    let name = "";
    for (let attempt = 0; attempt < 12 && names?.given.length; attempt++) {
      const full = worldFullName(names, random);
      if (!used.has(full.toLowerCase())) {
        name = full;
        break;
      }
    }
    const named = name !== "";
    if (!named) {
      // ponytail: a world with no names for this culture calls them by their role; the brief's name
      // lists (or a kit's own syllables, later) replace this.
      let n = 1;
      name = role;
      while (used.has(name.toLowerCase())) name = `${role} ${++n}`;
    }
    used.add(name.toLowerCase());
    const group = groupsHere.length && random() < 0.35 ? pick(groupsHere, random).name : undefined;
    people.push({
      id: `${place.id}-${index + 1}`,
      name,
      named,
      placeId: place.id,
      culture,
      ...(origin ? { origin } : {}),
      role,
      ...(group ? { group } : {}),
      temperament: pick(words.temperaments, random),
      value: pick(words.values, random),
      speech: pick(words.speech, random),
      age: pick(words.ages, random),
      build: pick(words.builds, random),
      hair: pick(words.hair, random),
      mark: pick(words.marks, random),
    });
  }
  // The hand edits (W9c): people renamed, and people added, each drawn the rest of the way from their
  // own id so they read the same every time.
  for (const rename of edits?.people ?? []) {
    const person = people.find((each) => each.id === rename.id);
    if (person) Object.assign(person, { name: rename.name.trim(), named: true });
  }
  for (const added of edits?.addedPeople ?? []) {
    if (added.placeId !== place.id) continue;
    const drawn = worldStream(seed, "cast-by-hand", added.id);
    people.push({
      id: added.id,
      name: added.name.trim(),
      named: true,
      placeId: place.id,
      culture: place.culture,
      role: added.role?.trim() || weighted(roleWeights, drawn),
      temperament: pick(words.temperaments, drawn),
      value: pick(words.values, drawn),
      speech: pick(words.speech, drawn),
      age: pick(words.ages, drawn),
      build: pick(words.builds, drawn),
      hair: pick(words.hair, drawn),
      mark: pick(words.marks, drawn),
    });
  }
  return people;
}

/** One line telling a person apart: role, one trait, and how they look. */
export function worldPersonSheet(kit: WorldKit, person: WorldPerson): string {
  const culture = kit.cultures.find((each) => each.id === person.culture)?.label ?? person.culture;
  return [
    person.role,
    person.group ? `of ${person.group}` : "",
    `${person.temperament}, cares about ${person.value}, ${person.speech}`,
    `${person.age}, ${person.build}, ${person.hair}, ${person.mark}`,
    person.origin ? `${culture}, from ${person.origin}` : culture,
  ]
    .filter(Boolean)
    .join("; ");
}

/** A name standing on its own: between non-letters in a spaced script ("Ann" is not inside "Anne"),
 *  and anywhere in a script without spaces, where nothing marks where a word ends. */
const fullNameMatcher = (name: string) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return UNSPACED_SCRIPT.test(name)
    ? new RegExp(escaped, "iu")
    : new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu");
};

/** The people of these places a text names in full (a reply that brings them in), each name once.
 *  People the world could not name are never matched: their role is not a name. */
export function worldPeopleNamed(game: GameWorld, placeIds: readonly string[], text: string): WorldPerson[] {
  // One person per name: when two of these places each have someone of that name, the place listed
  // first (where the scene is now) is the one the reply means.
  const seen = new Set<string>();
  const named: WorldPerson[] = [];
  for (const placeId of placeIds) {
    for (const person of worldCast(game, placeId)) {
      const key = person.name.toLowerCase();
      if (!person.named || seen.has(key) || !fullNameMatcher(person.name).test(text)) continue;
      seen.add(key);
      named.push(person);
    }
  }
  return named;
}

/** A person the world drew, as the tracked NPC the game keeps once the party has met them. */
export function worldPersonNpc(game: GameWorld, person: WorldPerson): GameNpc {
  const place = game.world.places.find((each) => each.id === person.placeId);
  return {
    id: `world-${person.id}`,
    name: person.name,
    emoji: "👤",
    description: worldPersonSheet(game.kit, person),
    descriptionSource: "world",
    location: place?.name ?? "",
    reputation: 0,
    notes: [],
    worldId: person.id,
    role: person.role,
  };
}
