// ──────────────────────────────────────────────
// The overworld (worldgen W8): the world's ground as the pixel overworld draws it, and walks along the
// world's ways. What each kind of ground looks like, the settlement the party sets out from, the
// cheapest route between two settlements, and the walk a game has pending until its next turn tells
// the Game Master. The overworld runs on the game's clock as Pixelforge's world does: real time passes
// while it is in front, and a walk passes its days.
// ──────────────────────────────────────────────
import { z } from "zod";
import type { WORLD_TERRAIN_KINDS } from "../../schemas/world-kit.schema.js";
import type { CompiledWorld, WorldLink, WorldPlace } from "./compile.js";
import { worldSettlementOf } from "./engine.js";
import { worldPlaceByName, worldTripDays, type GameWorld } from "./game-world.js";
import { WORLD_DAYS_CAP, worldAddedPlace, type WorldPresent } from "./ledger.js";

/** Real seconds per game minute while the overworld is in front (Pixelforge's clock). */
export const OVERWORLD_SECONDS_PER_GAME_MINUTE = 5;

/** What a stretch of ground looks like on the overworld, whatever the setting calls it. */
export const WORLD_GROUND_LOOKS = Object.freeze([
  "grass",
  "plains",
  "farmland",
  "forest",
  "hills",
  "marsh",
  "paddies",
  "bamboo",
  "scrub",
  "desert",
  "snow",
  "suburb",
  "city",
  "industry",
  "slums",
  "wasteland",
  "ruins",
  "dead_forest",
  "space",
  "nebula",
  "asteroids",
  "sea",
  "lake",
  "toxic_water",
  "mountains",
  "craters",
  "gravity_well",
  // More forests (user, 2026-10-05: "Cold regions will need coniferous forests at least"): an image pack
  // without one draws the forest instead (WORLD_GROUND_LOOK_FALLBACK).
  "conifer_forest",
  "autumn_forest",
  "jungle",
] as const);
export type WorldGroundLook = (typeof WORLD_GROUND_LOOKS)[number];

/** Fringes (user, 2026-10-05, the hard cell lines where forests and fields meet the grass): an image pack's
 *  `fringe_<look>` is a block of sixteen masks, four cells by four in the edge tiles' order, through which the
 *  look's own ground spills past its cells' edges onto the ground beside it. Drawn in this order, so taller
 *  ground (forests, mountains) overhangs lower ground (fields, sand). */
export const WORLD_FRINGE_ORDER: readonly WorldGroundLook[] = Object.freeze([
  "sea",
  "lake",
  "toxic_water",
  "space",
  "nebula",
  "gravity_well",
  "asteroids",
  "desert",
  "snow",
  "wasteland",
  "scrub",
  "plains",
  "grass",
  "farmland",
  "paddies",
  "marsh",
  "craters",
  "ruins",
  "suburb",
  "slums",
  "industry",
  "city",
  "hills",
  "dead_forest",
  "bamboo",
  "autumn_forest",
  "forest",
  "conifer_forest",
  "jungle",
  "mountains",
]);

/** Seasons, for drawing only (user, 2026-10-05: "seasonal variants for foliage"). Game Mode keeps no
 *  calendar beyond the game's day count (a kit's calendar names months but gives them no length), so a season
 *  is WORLD_SEASON_DAYS days, the first day of a game the first day of spring. */
export const WORLD_SEASONS = Object.freeze(["spring", "summer", "autumn", "winter"] as const);
export type WorldSeason = (typeof WORLD_SEASONS)[number];
export const WORLD_SEASON_DAYS = 90;

/** The season of a game day (1 is the first). */
export function worldSeason(day: number): WorldSeason {
  const index = Math.floor((Math.max(1, Math.floor(day)) - 1) / WORLD_SEASON_DAYS) % WORLD_SEASONS.length;
  return WORLD_SEASONS[index]!;
}

/** The look a pack without its own tile for a look draws instead. */
export const WORLD_GROUND_LOOK_FALLBACK: Readonly<Partial<Record<WorldGroundLook, WorldGroundLook>>> = Object.freeze({
  conifer_forest: "forest",
  autumn_forest: "forest",
  jungle: "forest",
});

type WorldTerrainKind = (typeof WORLD_TERRAIN_KINDS)[number];

// By the words in a terrain's id, which stays when the player rewords its label; the first match wins.
const LOOK_WORDS: Record<WorldTerrainKind, Array<[RegExp, WorldGroundLook]>> = {
  water: [
    [/toxic|acid|poison|sludge/, "toxic_water"],
    [/lake|pond|river|loch|lagoon|canal/, "lake"],
  ],
  barrier: [
    [/crater/, "craters"],
    [/gravity|singularity|black_hole|well/, "gravity_well"],
  ],
  open: [
    [/nebula/, "nebula"],
    [/asteroid|debris|belt/, "asteroids"],
    [/space|void|vacuum|orbit/, "space"],
    [/dead/, "dead_forest"],
    [/bamboo/, "bamboo"],
    [/padd|rice/, "paddies"],
    [/ruin|rubble/, "ruins"],
    [/waste|blight|ash/, "wasteland"],
    [/slum|shanty/, "slums"],
    [/industr|factory|dock/, "industry"],
    [/suburb|residential|village/, "suburb"],
    [/sprawl|city|urban|core|downtown|corporate|district/, "city"],
    [/farm|field|orchard|vineyard|pasture/, "farmland"],
    [/prairie|plain|steppe|savanna|meadow/, "plains"],
    [/taiga|conifer|pine|spruce|boreal|fir\b|firs/, "conifer_forest"],
    [/jungle|rainforest|tropic/, "jungle"],
    [/autumn|maple|birch/, "autumn_forest"],
    [/forest|wood|grove/, "forest"],
    [/hill|highland|moor|upland/, "hills"],
    [/marsh|swamp|bog|fen|wetland/, "marsh"],
    [/scrub|brush|heath|badland/, "scrub"],
    [/desert|dune|sand/, "desert"],
    [/snow|tundra|ice|glacier|frost/, "snow"],
  ],
};
const LOOK_BY_KIND = { open: "grass", water: "sea", barrier: "mountains" } as const;

/** What a kit terrain looks like: by the words in its id, else by its kind. */
export function worldTerrainLook(terrain: { id: string; kind: WorldTerrainKind }): WorldGroundLook {
  const byWords = LOOK_WORDS[terrain.kind].find(([words]) => words.test(terrain.id));
  return byWords ? byWords[1] : LOOK_BY_KIND[terrain.kind];
}

/** The look of each of the world's ground classes, in the order the ground string indexes them. */
export function worldGroundLooks(game: GameWorld): WorldGroundLook[] {
  return game.world.terrain.map((id) =>
    worldTerrainLook(game.kit.terrain?.find((entry) => entry.id === id) ?? { id, kind: "open" }),
  );
}

/** The ground class index of each cell, row by row. */
export function worldGroundCells(world: CompiledWorld): Uint8Array {
  return Uint8Array.from(world.ground, (cell) => parseInt(cell, 36));
}

// ── Where the party is ──

/** The settlement the party sets out from: the settlement the place is or is in, or, for a place
 *  above the settlements (a province, a system), the settlement within it nearest its middle. */
export function worldSetOutFrom(game: GameWorld, placeId: string | undefined): WorldPlace | undefined {
  const settlement = worldSettlementOf(game, placeId);
  const place = game.world.places.find((each) => each.id === placeId);
  if (settlement || !place) return settlement;
  const within = (other: WorldPlace) => {
    for (let up: WorldPlace | undefined = other; up; up = game.world.places.find((each) => each.id === up!.parentId)) {
      if (up.id === place.id) return true;
    }
    return false;
  };
  const away = (other: WorldPlace) => Math.hypot(other.at.x - place.at.x, other.at.y - place.at.y);
  return game.world.places
    .filter((other) => other.rank !== undefined && within(other))
    .reduce<WorldPlace | undefined>((best, other) => (!best || away(other) < away(best) ? other : best), undefined);
}

/** Where the party is on the overworld: the settlement of the place in force (the world's own place by
 *  that name, or a place the story added, in the place it was added in), else of where the world starts
 *  the party. A place the world does not list leaves the party where the world starts it. */
export function worldOverworldHere(
  game: GameWorld,
  present: WorldPresent,
  name: string | undefined,
): WorldPlace | undefined {
  const place = name ? (worldPlaceByName(game.world, name) ?? worldAddedPlace(game, present, name)?.within) : undefined;
  return worldSetOutFrom(game, place?.id ?? game.world.startId);
}

// ── Routes ──

export interface WorldRoute {
  /** The settlements on the way, from the first to the last. */
  path: string[];
  legs: WorldLink[];
  days: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The cheapest way between two settlements along the world's links, by days (ties to the settlement
 *  the world lists first), or null when none joins them or they are the same. */
export function worldRoute(world: CompiledWorld, fromId: string, toId: string): WorldRoute | null {
  if (fromId === toId) return null;
  const order = new Map(world.places.map((place, index) => [place.id, index]));
  if (!order.has(fromId) || !order.has(toId)) return null;
  const next = new Map<string, Array<{ to: string; link: WorldLink }>>();
  for (const link of world.links) {
    next.set(link.from, [...(next.get(link.from) ?? []), { to: link.to, link }]);
    next.set(link.to, [...(next.get(link.to) ?? []), { to: link.from, link }]);
  }
  const days = new Map<string, number>([[fromId, 0]]);
  const back = new Map<string, { from: string; link: WorldLink }>();
  const done = new Set<string>();
  for (;;) {
    let at: string | undefined;
    for (const [id, cost] of days) {
      if (done.has(id)) continue;
      const best = at === undefined ? Infinity : days.get(at)!;
      if (cost < best || (cost === best && order.get(id)! < order.get(at!)!)) at = id;
    }
    if (at === undefined) return null;
    if (at === toId) break;
    done.add(at);
    for (const { to, link } of next.get(at) ?? []) {
      const cost = days.get(at)! + link.days;
      if (cost < (days.get(to) ?? Infinity)) {
        days.set(to, cost);
        back.set(to, { from: at, link });
      }
    }
  }
  const path = [toId];
  const legs: WorldLink[] = [];
  for (let at = toId; at !== fromId;) {
    const step = back.get(at)!;
    path.unshift(step.from);
    legs.unshift(step.link);
    at = step.from;
  }
  return { path, legs, days: round2(days.get(toId)!) };
}

// ── The walk a turn tells ──

export const worldWalkSchema = z
  .object({
    id: z.string().min(1).max(64),
    from: z.string().min(1).max(16),
    to: z.string().min(1).max(16),
    days: z.number().min(0).max(1_000_000),
    /** The kit travel ways it took. */
    ways: z.array(z.string().min(1).max(64)).max(32),
  })
  .strict();
export type WorldWalk = z.infer<typeof worldWalkSchema>;

/** The walk a game has pending, or null. */
export function worldWalkFromMetadata(metadata: Record<string, unknown> | null | undefined): WorldWalk | null {
  const parsed = worldWalkSchema.safeParse(metadata?.gameWorldWalk);
  return parsed.success ? parsed.data : null;
}

/** A walk, or the pending one taken further (it keeps where it set out from). */
export function worldWalkJoined(pending: WorldWalk | null, route: WorldRoute, id: string): WorldWalk {
  const ways = [...(pending?.ways ?? []), ...route.legs.map((leg) => leg.way)];
  return {
    id,
    from: pending?.from ?? route.path[0]!,
    to: route.path.at(-1)!,
    days: round2((pending?.days ?? 0) + route.days),
    ways: [...new Set(ways)].slice(0, 32),
  };
}

/** What the Game Master is told of the walk its turn tells. */
export function worldWalkText(game: GameWorld, walk: WorldWalk): string {
  const { kit, world } = game;
  const name = (id: string) => world.places.find((place) => place.id === id)?.name ?? id;
  const ways = walk.ways.map((id) => kit.travel.find((way) => way.id === id)?.label ?? id).join(" and ");
  const trip = `${worldTripDays(kit, walk.days)}${ways ? ` by ${ways}` : ""}`;
  return walk.from === walk.to
    ? `On the overworld, the party has travelled out from ${name(walk.from)} and back (${trip}). That time is counted already: tell how the trip went and what the party finds back in ${name(walk.to)}, and do not record those days again.`
    : `On the overworld, the party has travelled from ${name(walk.from)} to ${name(walk.to)} (${trip}). That time is counted already: tell the end of the journey and the arrival in ${name(walk.to)}, and do not record those days again.`;
}

/** The tags a reply that tells a walk carries, answered with it, so the world steps by the walk's whole
 *  days and the party is where it walked. */
export function worldWalkTags(game: GameWorld, walk: WorldWalk): string {
  const to = game.world.places.find((place) => place.id === walk.to);
  const tags: string[] = [];
  for (let days = Math.round(walk.days); days > 0; days -= WORLD_DAYS_CAP) {
    tags.push(`[world: days="${Math.min(WORLD_DAYS_CAP, days)}"]`);
  }
  if (to) tags.push(`[place: name="${to.name}"]`);
  return tags.join("");
}
