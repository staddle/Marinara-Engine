// ──────────────────────────────────────────────
// Sites on the overworld (design-game-overworld-sites.md): a cave, a mine, a crypt, a ruin or any place
// with a map made for it, out in the world rather than in a town. A site is worked out from the world,
// never stored: a place with its own cell that is not a settlement, not in one and holds none, and is one
// to go into, with a cell of its own out of its settlement's (a cave a few steps out of a village). Trips to
// and from a site leave the world's ways on foot at its settlement (or, in none, the nearest).
// ──────────────────────────────────────────────
import { worldKitArtFamily } from "./art-family.js";
import { WORLD_DAYS_PER_CELL, type WorldLink, type WorldPlace } from "./compile.js";
import { dungeonSetForPlace, readGameDungeonTags } from "./dungeon-map.js";
import { worldSettlementOf } from "./engine.js";
import { worldPlaceByName, type GameWorld } from "./game-world.js";
import type { WorldPresent } from "./ledger.js";
import { worldOverworldHere, worldRoute, type WorldRoute } from "./overworld.js";
import { worldPlaceMap, worldSiteLock } from "./place-maps.js";
import type { StoryScript } from "./story.js";

const sitesOfGame = new WeakMap<GameWorld, WorldPlace[]>();

/** The world's sites, in the world's order. */
export function worldSites(game: GameWorld): WorldPlace[] {
  let found = sitesOfGame.get(game);
  if (!found) {
    const places = game.world.places;
    const byId = new Map(places.map((place) => [place.id, place]));
    // The places that hold a settlement (a realm, a province, a system): never a site.
    const holding = new Set<string>();
    for (const settlement of places.filter((place) => place.rank !== undefined))
      for (let up = byId.get(settlement.parentId ?? ""); up; up = byId.get(up.parentId ?? "")) holding.add(up.id);
    const family = worldKitArtFamily(game.kit);
    const byName = game.world.generatorVersion >= 2;
    found = places.filter((place) => {
      if (place.rank !== undefined || holding.has(place.id)) return false;
      // Out of its settlement's own cell (a cave a few steps out of a village), or in no settlement.
      const settlement = worldSettlementOf(game, place.id);
      if (settlement && settlement.at.x === place.at.x && settlement.at.y === place.at.y) return false;
      // A map made by hand makes a site in any world; a name alone only from generator 2, the one that
      // made sites, so a version 1 world's towns keep every building they had.
      if (worldPlaceMap(game, place.id) !== null) return true;
      return byName && dungeonSetForPlace(place, family) !== null;
    });
    sitesOfGame.set(game, found);
  }
  return found;
}

/** Whether a place is one of the world's sites. */
export function worldIsSite(game: GameWorld, placeId: string | undefined): boolean {
  return placeId !== undefined && worldSites(game).some((site) => site.id === placeId);
}

/** The settlement a site's trips leave the world's ways at: its own, else the nearest by a straight line
 *  (ties to the one the world lists first). */
export function worldSiteAnchor(game: GameWorld, site: WorldPlace): WorldPlace | undefined {
  const own = worldSettlementOf(game, site.id);
  if (own) return own;
  const away = (other: WorldPlace) => Math.hypot(other.at.x - site.at.x, other.at.y - site.at.y);
  return game.world.places
    .filter((place) => place.rank !== undefined)
    .reduce<WorldPlace | undefined>((best, place) => (!best || away(place) < away(best) ? place : best), undefined);
}

/** A leg off the world's ways, on foot: the straight line's cells at the kit's first way over open ground. */
function offRoad(game: GameWorld, from: WorldPlace, to: WorldPlace): WorldLink {
  const way = game.kit.travel.find((each) => (each.crosses ?? "open") === "open") ?? game.kit.travel[0]!;
  const cells = Math.hypot(from.at.x - to.at.x, from.at.y - to.at.y);
  const days = Math.round(((cells * WORLD_DAYS_PER_CELL[game.kit.scale]) / (way.speed ?? 1)) * 100) / 100;
  return { from: from.id, to: to.id, way: way.id, days: Math.max(0.01, days) };
}

/** A trip on the overworld between two settlements or sites: off the road from a site to its settlement,
 *  the world's ways between settlements, off the road to a site. Null when it is no trip (the same spot,
 *  or no way joins them). */
export function worldTrip(game: GameWorld, fromId: string, toId: string): WorldRoute | null {
  if (fromId === toId) return null;
  const place = (id: string) => game.world.places.find((each) => each.id === id);
  const [from, to] = [place(fromId), place(toId)];
  if (!from || !to) return null;
  const [fromSite, toSite] = [worldIsSite(game, fromId), worldIsSite(game, toId)];
  if (!fromSite && !toSite) return worldRoute(game.world, fromId, toId);
  const fromAnchor = fromSite ? worldSiteAnchor(game, from) : from;
  const toAnchor = toSite ? worldSiteAnchor(game, to) : to;
  if (!fromAnchor || !toAnchor) return null;
  const path: string[] = [fromId];
  const legs: WorldLink[] = [];
  if (fromSite) {
    legs.push(offRoad(game, from, fromAnchor));
    path.push(fromAnchor.id);
  }
  if (fromAnchor.id !== toAnchor.id) {
    const between = worldRoute(game.world, fromAnchor.id, toAnchor.id);
    if (!between) return null;
    legs.push(...between.legs);
    path.push(...between.path.slice(1));
  }
  if (toSite) {
    legs.push(offRoad(game, toAnchor, to));
    path.push(toId);
  }
  // A settlement's trip to its own site never passes through the settlement twice.
  const days = Math.round(legs.reduce((sum, leg) => sum + leg.days, 0) * 100) / 100;
  return { path: path.filter((id, index) => index === 0 || id !== path[index - 1]), legs, days };
}

/** Where the party is on the overworld: a site, when the place in force is one; else as before, the
 *  settlement of the place in force (`worldOverworldHere`). */
export function worldOverworldSpot(
  game: GameWorld,
  present: WorldPresent,
  name: string | undefined,
): WorldPlace | undefined {
  // A place the story added is in a settlement, never a site: only the world's own places are.
  const place = name ? worldPlaceByName(game.world, name) : undefined;
  if (place && worldIsSite(game, place.id)) return place;
  return worldOverworldHere(game, present, name);
}

// ── Story locks (Alyssa, 2026-10-05: sites that matter to the storyline stay closed until the Game
// Master opens them) ──

/** How a site is closed: shown but sealed (no trip, no going in), or hidden from the overworld. */
export type WorldSiteLock = "sealed" | "hidden";

/** The sites the story script names (anywhere in it: an arrival, an event's or a flag's place). */
function storySiteIds(game: GameWorld, story: StoryScript | null | undefined): Set<string> {
  const sites = new Set(worldSites(game).map((site) => site.id));
  const named = new Set<string>();
  if (!story) return named;
  const walk = (value: unknown) => {
    if (typeof value === "string") {
      if (sites.has(value)) named.add(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(story);
  return named;
}

/** The sites still closed: those the story names, less those the Game Master has opened in the replies
 *  so far (`[map: reveal name="..."]`, or a `[map: name="..."]` that opened its map). Read from the replies,
 *  so a regenerated or deleted reply takes its opening with it. */
export function worldSiteLocks(
  game: GameWorld,
  story: StoryScript | null | undefined,
  replies: readonly string[],
): Map<string, WorldSiteLock> {
  const locks = new Map<string, WorldSiteLock>();
  // The creator's lock (Pixelforge's `edits.sites`) where there is one; else sealed when the story names it.
  const named = storySiteIds(game, story);
  for (const site of worldSites(game)) {
    const lock = worldSiteLock(game, site.id) ?? (named.has(site.id) ? "sealed" : "open");
    if (lock !== "open") locks.set(site.id, lock);
  }
  if (!locks.size) return locks;
  for (const reply of replies)
    for (const tag of readGameDungeonTags(reply)) {
      if (tag.leave) continue;
      const place = worldPlaceByName(game.world, tag.name);
      if (place) locks.delete(place.id);
    }
  return locks;
}

/** What the Game Master is told of the closed sites, or nothing. */
export function worldSiteLocksText(game: GameWorld, locks: ReadonlyMap<string, WorldSiteLock>): string {
  const names = [...locks.keys()].flatMap((id) => game.world.places.find((place) => place.id === id)?.name ?? []);
  if (!names.length) return "";
  return `Closed to the party until you reveal them with [map: reveal name="..."]: ${names.join(", ")}.`;
}
