// ──────────────────────────────────────────────
// The atlas (worldgen W7): a game's world as a World Maps draft, the same draft the maps package
// reviews and saves when a model writes one. One location per world place, in the world's own tree and
// words; the world's ways as links with their days; the party's start. Nothing beyond the world.
// ──────────────────────────────────────────────
import type {
  GenerateSpatialMapDraftResponse,
  SpatialLocation,
  SpatialLocationKind,
} from "../../types/spatial-context.js";
import { SPATIAL_CONTEXT_LIMITS } from "../../utils/spatial-context.js";
import { worldTripDays, type GameWorld } from "./game-world.js";
import type { WorldPlace } from "./compile.js";

/** How far from the edge of its parent's map a place is drawn, out of 100. */
const MARGIN = 10;

const labelOf = (entries: ReadonlyArray<{ id: string; label: string }>, id: string | undefined) =>
  entries.find((entry) => entry.id === id)?.label ?? id ?? "";

/** "A town", "An outpost". */
const aWord = (word: string) => `${/^[aeiou]/i.test(word) ? "An" : "A"} ${word}`;

/** The places of one parent, spread over its map by where they lie in the world. */
function placements(siblings: WorldPlace[]): Map<string, { x: number; y: number }> {
  const xs = siblings.map((place) => place.at.x);
  const ys = siblings.map((place) => place.at.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = (value: number, min: number, max: number) =>
    max === min ? 50 : Math.round(MARGIN + ((value - min) / (max - min)) * (100 - 2 * MARGIN));
  return new Map(
    siblings.map((place) => [place.id, { x: scale(place.at.x, minX, maxX), y: scale(place.at.y, minY, maxY) }]),
  );
}

/** The world as a World Maps draft for a new game. */
export function worldSpatialDraft(game: GameWorld): GenerateSpatialMapDraftResponse {
  const { world, kit } = game;
  // The compile lists a world layer by layer, outermost first, so a world past the map's limit keeps its
  // shape and loses its smallest places, and every kept place keeps its parent. (A kit has at most eight
  // layers, well inside the map's depth.)
  const places = world.places.slice(0, SPATIAL_CONTEXT_LIMITS.maxLocations);
  const kept = new Set(places.map((place) => place.id));
  const settlementDepth = kit.layers.findIndex((layer) => layer.settlements);
  const kindOf = (place: WorldPlace): SpatialLocationKind =>
    place.depth < settlementDepth ? "region" : place.depth === settlementDepth ? "settlement" : "place";

  const byParent = new Map<string | null, WorldPlace[]>();
  for (const place of places) {
    const parent = place.parentId && kept.has(place.parentId) ? place.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), place]);
  }
  const placed = new Map<string, { x: number; y: number }>();
  for (const siblings of byParent.values()) for (const [id, at] of placements(siblings)) placed.set(id, at);

  // Each way once, from the place it starts at, and both ways open: the shortest trips first.
  const links = new Map<string, SpatialLocation["links"]>();
  for (const link of [...world.links].sort((a, b) => a.days - b.days)) {
    if (!kept.has(link.from) || !kept.has(link.to)) continue;
    const from = links.get(link.from) ?? [];
    if (from.length >= SPATIAL_CONTEXT_LIMITS.maxLinksPerLocation) continue;
    from.push({
      targetId: link.to,
      label: `${worldTripDays(kit, link.days)} by ${labelOf(kit.travel, link.way)}`.slice(
        0,
        SPATIAL_CONTEXT_LIMITS.maxLinkLabelLength,
      ),
      bidirectional: true,
      state: "available",
    });
    links.set(link.from, from);
  }

  const locations: SpatialLocation[] = places.map((place) => {
    const parent = place.parentId && kept.has(place.parentId) ? place.parentId : null;
    const siblings = byParent.get(parent) ?? [];
    const description = [
      `${aWord(place.size ? labelOf(kit.sizes, place.size) : labelOf(kit.layers, place.layer))}.`,
      place.tags.length ? `Known for: ${place.tags.map((tag) => labelOf(kit.placeTags, tag)).join(", ")}.` : "",
      place.note ?? "",
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, SPATIAL_CONTEXT_LIMITS.maxDescriptionLength);
    return {
      // The world's own ids (`p0`, `p1`...), which World Maps' id rule always accepts.
      id: place.id,
      parentId: parent,
      name: place.name.slice(0, SPATIAL_CONTEXT_LIMITS.maxNameLength),
      kind: kindOf(place),
      description,
      lorebookEntryIds: [...new Set(place.lore ?? [])].slice(0, SPATIAL_CONTEXT_LIMITS.maxLorebookEntryIdsPerLocation),
      childPresentation: "map",
      placement: placed.get(place.id),
      links: links.get(place.id) ?? [],
      status: "active",
      sortOrder: siblings.indexOf(place),
    };
  });
  const count = locations.length;
  return {
    definition: {
      schemaVersion: 1,
      ownerMode: "game",
      enabled: true,
      locations,
      // Where the world starts the party; were it ever cut, a settlement rather than a whole region.
      startingLocationId: kept.has(world.startId)
        ? world.startId
        : ((locations.find((location) => location.kind === "settlement") ?? locations[0])?.id ?? null),
      revision: 0,
    },
    operation: "create",
    size: count <= 30 ? "small" : count <= 120 ? "medium" : "large",
    source: "game_setup",
    generatedLocationCount: count,
  };
}
