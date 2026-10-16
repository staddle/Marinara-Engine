// ──────────────────────────────────────────────
// Maps made by hand for places (map editor Phase 3): a cave, a crypt, a station deck or any place with a
// map of its own, kept in the world's hand edits (`edits.maps`). When a place has one, entering it opens
// this map instead of a generated one; Game Mode walks it as it walks a dungeon map. A map is cells of wall,
// floor and liquid, the cell the party steps in at, a pack's props laid about it (drawn only), and spots
// where people stand by the hour.
// ──────────────────────────────────────────────
import { WORLD_MAP_MAX, type WORLD_SITE_LOCKS, type WorldEdits } from "./edits.js";
import type { GameWorld } from "./game-world.js";
import { worldCast } from "./people.js";

export type WorldPlaceMap = NonNullable<WorldEdits["maps"]>[number];

/** The hand-made map of a place, if it has one. */
export function worldPlaceMap(game: GameWorld, placeId: string): WorldPlaceMap | null {
  return game.edits?.maps?.find((map) => map.place === placeId) ?? null;
}

/** The floor cells a walk reaches from a map's entry, four ways (walls and liquid stop it; props never do). */
export function worldPlaceMapReach(map: Pick<WorldPlaceMap, "width" | "height" | "ground" | "entry">): Set<number> {
  const { width, height, ground, entry } = map;
  const start = entry.y * width + entry.x;
  const reached = new Set<number>();
  if (ground[start] !== ".") return reached;
  reached.add(start);
  const queue = [start];
  while (queue.length) {
    const cell = queue.shift()!;
    const [x, y] = [cell % width, Math.floor(cell / width)];
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (reached.has(next) || ground[next] !== ".") continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

/** The spots of a map whose people stand there at an hour (all day when a spot names no hours). */
export function worldPlaceMapSpotsAt(map: WorldPlaceMap, hour: number): NonNullable<WorldPlaceMap["spots"]> {
  return (map.spots ?? []).filter((spot) => {
    const [from, to] = [spot.from ?? 0, spot.to ?? 24];
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
  });
}

/**
 * Why a layer's maps of places do not fit its world, or nothing: each on a place of the world (not a
 * settlement, whose town is its map), one map a place, its ground filling it and walled all round, its
 * entry on floor, every floor cell reachable from the entry, its props and spots on reachable floor (a
 * spot's people people of the world), within the size and count limits. `game` is the world these edits
 * make.
 */
export function worldMapEditIssues(game: GameWorld, edits: WorldEdits): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  const places = new Set<string>();
  for (const map of edits.maps ?? []) {
    const label = `Map ${map.id}`;
    const place = game.world.places.find((each) => each.id === map.place);
    if (ids.has(map.id)) issues.push(`${label}: two maps are called ${map.id}.`);
    ids.add(map.id);
    if (!place) {
      issues.push(`${label}: no place "${map.place}".`);
      continue;
    }
    const name = `${label} (${place.name})`;
    if (place.rank !== undefined) issues.push(`${name}: a settlement's map is its town.`);
    if (places.has(place.id)) issues.push(`${name}: ${place.name} has two maps.`);
    places.add(place.id);
    const { width, height, ground } = map;
    if (width > WORLD_MAP_MAX.width || height > WORLD_MAP_MAX.height)
      issues.push(`${name}: at most ${WORLD_MAP_MAX.width} by ${WORLD_MAP_MAX.height} cells.`);
    if (ground.length !== width * height) {
      issues.push(`${name}: its ground has ${ground.length} cells; ${width} by ${height} is ${width * height}.`);
      continue;
    }
    const where = (x: number, y: number) => `column ${x + 1}, row ${y + 1}`;
    for (let x = 0; x < width; x++)
      for (const y of [0, height - 1])
        if (ground[y * width + x] !== "#") {
          issues.push(`${name}: its edge is open at ${where(x, y)}; a map is walled all round.`);
          x = width;
          break;
        }
    for (let y = 0; y < height; y++)
      for (const x of [0, width - 1])
        if (ground[y * width + x] !== "#") {
          issues.push(`${name}: its edge is open at ${where(x, y)}; a map is walled all round.`);
          y = height;
          break;
        }
    const inside = (cell: { x: number; y: number }) => cell.x < width && cell.y < height;
    if (!inside(map.entry) || ground[map.entry.y * width + map.entry.x] !== ".") {
      issues.push(`${name}: the party steps in on a wall or liquid at ${where(map.entry.x, map.entry.y)}.`);
      continue;
    }
    const reached = worldPlaceMapReach(map);
    let cut = 0;
    for (let cell = 0; cell < ground.length; cell++) if (ground[cell] === "." && !reached.has(cell)) cut++;
    if (cut)
      issues.push(`${name}: ${cut} floor cell${cut === 1 ? "" : "s"} can't be reached from where the party steps in.`);
    const used = new Set<number>();
    for (const prop of map.props ?? []) {
      const cell = prop.y * width + prop.x;
      if (!inside(prop) || ground[cell] !== ".")
        issues.push(`${name}: a prop at ${where(prop.x, prop.y)} is not on floor.`);
      else if (prop.x === map.entry.x && prop.y === map.entry.y)
        issues.push(`${name}: a prop stands where the party steps in.`);
      else if (used.has(cell)) issues.push(`${name}: two props share ${where(prop.x, prop.y)}.`);
      used.add(cell);
    }
    const spotIds = new Set<string>();
    const spotCells = new Set<number>();
    for (const spot of map.spots ?? []) {
      const cell = spot.y * width + spot.x;
      if (spotIds.has(spot.id)) issues.push(`${name}: two spots are called ${spot.id}.`);
      spotIds.add(spot.id);
      if (!inside(spot) || !reached.has(cell))
        issues.push(`${name}: the spot "${spot.name}" is not on floor the party can reach.`);
      else if (spotCells.has(cell)) issues.push(`${name}: two spots share ${where(spot.x, spot.y)}.`);
      spotCells.add(cell);
      if (spot.from !== undefined && spot.to !== undefined && spot.from === spot.to)
        issues.push(`${name}: the spot "${spot.name}" has no hours (from ${spot.from} to ${spot.to}).`);
      for (const person of spot.people ?? []) {
        const home = person.replace(/-e?\d+$/, "");
        if (!worldCast(game, home).some((each) => each.id === person))
          issues.push(`${name}: the spot "${spot.name}" names nobody "${person}".`);
      }
    }
  }
  return issues;
}

/** A site's lock as its creator set it, or null when it is left to the game (sealed when the story names
 *  it, else open). */
export function worldSiteLock(game: GameWorld, placeId: string): (typeof WORLD_SITE_LOCKS)[number] | null {
  return game.edits?.sites?.find((site) => site.place === placeId)?.lock ?? null;
}

/** Why a layer's sites' locks do not fit its world, or nothing: each on a place of the world that is not a
 *  settlement (a town is never locked), one lock a place. `game` is the world these edits make. */
export function worldSiteEditIssues(game: GameWorld, edits: WorldEdits): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const site of edits.sites ?? []) {
    const place = game.world.places.find((each) => each.id === site.place);
    if (!place) issues.push(`No place "${site.place}" to lock.`);
    else if (place.rank !== undefined) issues.push(`${place.name} is a settlement: a town is never locked.`);
    else if (seen.has(site.place)) issues.push(`${place.name} is locked twice.`);
    seen.add(site.place);
  }
  return issues;
}
