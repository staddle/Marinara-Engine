/**
 * The atlas (worldgen W7): a game's world as the World Maps draft the maps package reviews and saves.
 *
 *   - Every world place is a location, in the world's tree and words, and a valid World Maps map: the
 *     schema reads it and the map's own checks find nothing wrong.
 *   - The world's ways are links both ways with their days in the setting's words; the party starts
 *     where the world starts it; a place keeps the lore it was read from.
 *   - The same world always gives the same map, and a map past World Maps' limits is cut, never broken.
 */
import assert from "node:assert/strict";

import {
  SPATIAL_CONTEXT_LIMITS,
  WORLD_STARTER_KITS,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  spatialContextDefinitionSchema,
  validateSpatialContextDefinition,
  worldSpatialDraft,
  type GameWorld,
} from "../../packages/shared/src/index.js";

const kitOf = (id: string) => {
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((kit) => kit.id === id)!);
  assert.ok(parsed.ok);
  return parsed.kit;
};

function gameOf(kitId: string, seed: number, brief: Record<string, unknown> = {}): GameWorld {
  const kit = kitOf(kitId);
  const checked = checkWorldBrief(kit, { briefVersion: 1, premise: "x", ...brief });
  assert.ok(checked.ok, checked.ok ? "" : checked.issues.join("; "));
  const inputs = { kit, seed, grounding: "expand" as const, brief: checked.brief };
  return { ...inputs, world: compileGameWorld(inputs) };
}

for (const kitId of ["high_fantasy", "modern_day", "space_opera", "wuxia_xianxia"]) {
  const game = gameOf(kitId, 7);
  const draft = worldSpatialDraft(game);
  const { definition } = draft;

  // A valid World Maps map, as the package would save it.
  assert.ok(spatialContextDefinitionSchema.safeParse(definition).success, `${kitId}: the schema reads it`);
  const checked = validateSpatialContextDefinition(definition);
  assert.deepEqual(
    checked.issues.map((issue) => issue.message),
    [],
    `${kitId}: no map issues`,
  );
  assert.ok(checked.valid);
  assert.equal(draft.operation, "create");
  assert.equal(draft.source, "game_setup");
  assert.equal(draft.generatedLocationCount, definition.locations.length);

  // Every place, in the world's tree and words.
  assert.equal(definition.locations.length, game.world.places.length, `${kitId}: one location per place`);
  const byId = new Map(definition.locations.map((location) => [location.id, location]));
  for (const place of game.world.places) {
    const location = byId.get(place.id);
    assert.ok(location, `${kitId}: ${place.name} is on the map by its world id`);
    assert.equal(location.name, place.name);
    assert.equal(location.parentId, place.parentId);
    const settlementDepth = game.kit.layers.findIndex((layer) => layer.settlements);
    assert.equal(
      location.kind,
      place.depth < settlementDepth ? "region" : place.depth === settlementDepth ? "settlement" : "place",
    );
    if (place.rank !== undefined) assert.equal(location.kind, "settlement", "a sized place is a settlement");
    assert.ok(location.placement && location.placement.x >= 0 && location.placement.x <= 100);
  }
  assert.equal(
    definition.startingLocationId,
    game.world.startId,
    `${kitId}: the party starts where the world starts it`,
  );

  // Each way once, both ways open, with its days in the setting's words.
  const linkCount = definition.locations.reduce((sum, location) => sum + location.links.length, 0);
  assert.equal(linkCount, game.world.links.length, `${kitId}: every way is a link`);
  const day = game.kit.calendar.day;
  for (const location of definition.locations) {
    for (const link of location.links) {
      assert.equal(link.bidirectional, true);
      assert.match(link.label ?? "", new RegExp(`(${day}|of a ${day}).* by `, "u"));
    }
  }

  // The same world, the same map.
  assert.deepEqual(worldSpatialDraft(gameOf(kitId, 7)), draft);
}

// Sizes say how big the map is, and settlements inside regions read their size in the kit's words.
{
  const game = gameOf("high_fantasy", 11);
  const settlement = worldSpatialDraft(game).definition.locations.find((location) => location.kind === "settlement")!;
  const sizes = game.kit.sizes.map((size) => size.label);
  assert.ok(sizes.some((size) => settlement.description.toLowerCase().includes(size.toLowerCase())));
  assert.match(settlement.description, /^An? /u);
}

// A place keeps the lore it was read from, each entry once, so its entries are live there.
{
  const kit = kitOf("high_fantasy");
  const game = gameOf("high_fantasy", 3, {
    places: [{ name: "Aldmark", layer: kit.layers[0]!.id, lore: ["entry-aldmark", "entry-aldmark"] }],
  });
  const aldmark = worldSpatialDraft(game).definition.locations.find((location) => location.name === "Aldmark")!;
  assert.deepEqual(aldmark.lorebookEntryIds, ["entry-aldmark"]);
}

// A place or group needs a name with more than spaces, or no map (or tag) could name it.
{
  const kit = kitOf("high_fantasy");
  assert.ok(
    !checkWorldBrief(kit, { briefVersion: 1, premise: "x", places: [{ name: "  ", layer: kit.layers[0]!.id }] }).ok,
  );
  assert.ok(
    !checkWorldBrief(kit, { briefVersion: 1, premise: "x", groups: [{ name: " ", kind: kit.groupKinds[0]!.id }] }).ok,
  );
}

// Past World Maps' limits, the map is cut from the smallest places, and stays valid.
{
  const game = gameOf("high_fantasy", 5);
  const many = {
    ...game,
    world: {
      ...game.world,
      places: [
        ...game.world.places,
        ...Array.from({ length: SPATIAL_CONTEXT_LIMITS.maxLocations }, (_, index) => ({
          ...game.world.places.find((place) => place.rank !== undefined)!,
          id: `extra${index}`,
          name: `Extra ${index}`,
          depth: 9,
          parentId: game.world.startId,
          rank: undefined,
          size: undefined,
        })),
      ],
    },
  } as GameWorld;
  const cut = worldSpatialDraft(many).definition;
  assert.equal(cut.locations.length, SPATIAL_CONTEXT_LIMITS.maxLocations);
  assert.ok(cut.locations.some((location) => location.id === game.world.startId));
  const checked = validateSpatialContextDefinition(cut);
  assert.ok(checked.valid, checked.issues.map((issue) => issue.message).join("; "));
}

console.log("World atlas: the world as a World Maps draft, valid, in its own words, the same every time.");
