/**
 * Towns laid out freely and maps of places (map editor Phases 2 and 3; the schema Game Mode builds on).
 *
 *   - A building is placed anywhere free in its town (not only on a lot), its door on the side chosen; a
 *     placement on the street, the square, the town's edge, another building or before another door is
 *     refused and said. Placing a building drops its move.
 *   - A town's ground takes fields, paths, water, bridges and hedges; a bridge crosses water; a door's cell
 *     may be paved and nothing else; a layout using any of these leaves every door reachable from the square.
 *   - Decorations lie anywhere clear and come out in the town; on a building, before a door or doubled up
 *     they are refused.
 *   - A layer using any of this is editsVersion 3 and the world snapshot is version 3 (older ones read).
 *   - A map made by hand for a place (not a settlement): walled all round, entered on floor, every floor cell
 *     reachable, props and spots on floor, a spot's people people of the world, one map a place; spots say
 *     who stands where by the hour. Too big a map is refused by the schema.
 *   - A site (a place outside any town) is locked by hand hidden, sealed or open; a settlement, no place or
 *     a place locked twice is refused; a layer with locks is editsVersion 3.
 */
import assert from "node:assert/strict";

import {
  WORLD_IMAGE_ONLY_TILE_IDS,
  WORLD_MAP_MAX,
  WORLD_SNAPSHOT_VERSION,
  WORLD_STARTER_KITS,
  WORLD_TILE_IDS,
  WORLD_TOWN_PROPS,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  readWorldSnapshot,
  worldCast,
  worldEditsSchema,
  worldEditsVersioned,
  worldMapEditIssues,
  worldPlaceMap,
  worldPlaceMapSpotsAt,
  worldSiteLock,
  worldSnapshot,
  worldTown,
  worldTownDoorCell,
  worldTownReach,
  worldTownEditIssues,
  type GameWorld,
  type WorldEdits,
} from "../../packages/shared/src/index.js";

const gameOf = (id: string, seed: number): GameWorld => {
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === id)!);
  assert.ok(parsed.ok);
  const kit = parsed.kit;
  const checked = checkWorldBrief(kit, {
    briefVersion: 1,
    premise: "x",
    peopleNames: kit.cultures.map((culture) => ({
      culture: culture.id,
      given: ["Ama", "Tobin", "Hesk", "Mira", "Oswin", "Bryn", "Calla", "Doran"],
      family: ["Holt", "Drey", "Marrow", "Vane"],
      order: "given-family" as const,
    })),
  });
  assert.ok(checked.ok);
  const inputs = { kit, seed, grounding: "expand" as const, brief: checked.brief };
  return { ...inputs, world: compileGameWorld(inputs) };
};
const withEdits = (game: GameWorld, edits: WorldEdits): GameWorld => {
  const next = { ...game, edits };
  return { ...next, world: compileGameWorld(next) };
};
const layer = (towns: WorldEdits["towns"], maps?: WorldEdits["maps"]): WorldEdits =>
  worldEditsVersioned({ editsVersion: 1, towns, ...(maps ? { maps } : {}) });
const has = (issues: string[], pattern: RegExp, label: string) =>
  assert.ok(
    issues.some((issue) => pattern.test(issue)),
    `${label}: ${JSON.stringify(issues)}`,
  );

const game = gameOf("high_fantasy", 21);
const city = game.world.places
  .filter((place) => place.rank !== undefined)
  .reduce((best, place) => (place.rank! > best.rank! ? place : best));
const town = worldTown(game, city.id, undefined, { byHand: false })!;
const { width } = town;
const groundOf = (paint: Record<number, string>) => [...town.ground].map((_, cell) => paint[cell] ?? ".").join("");

// ── A building placed on a free lot that is not its own, door south ──
const home = town.buildings.find((building) => building.kind === "home")!;
const freeLot = town.lots.find(
  (lot) =>
    lot.w === home.w &&
    lot.h === home.h &&
    lot.door.y === lot.y + lot.h &&
    lot.door.x === lot.x + 1 &&
    !town.buildings.some((b) => b.x < lot.x + lot.w && lot.x < b.x + b.w && b.y < lot.y + lot.h && lot.y < b.y + b.h),
);
assert.ok(freeLot, "a free lot to place a home on");
const placed = layer([{ settlement: city.id, place: [{ building: home.id, x: freeLot.x, y: freeLot.y }] }]);
assert.equal(placed.editsVersion, 3, "a placed building is editsVersion 3");
assert.deepEqual(worldTownEditIssues(game, placed), [], "placed on a free lot");
const after = worldTown(withEdits(game, placed), city.id)!;
const moved = after.buildings.find((building) => building.id === home.id)!;
assert.deepEqual([moved.x, moved.y], [freeLot.x, freeLot.y], "it stands where it was placed");
assert.deepEqual(moved.door, worldTownDoorCell(freeLot.x, freeLot.y, home.w, home.h, "s"), "door south");
assert.deepEqual(moved.door, freeLot.door, "a south door is where a lot's is");
assert.deepEqual(worldTownDoorCell(10, 10, 4, 3, "w"), { x: 9, y: 11 }, "a west door");
assert.deepEqual(worldTownDoorCell(10, 10, 4, 3, "e"), { x: 14, y: 11 }, "an east door");
// Placing a building drops its move: a move to nowhere is not checked once it is placed.
assert.deepEqual(
  worldTownEditIssues(
    game,
    layer([
      {
        settlement: city.id,
        moves: [{ building: home.id, x: 0, y: 0, w: 1 }],
        place: [{ building: home.id, x: freeLot.x, y: freeLot.y }],
      },
    ]),
  ),
  [],
  "the placement wins over the move",
);

// ── Placements refused ──
const streetCell = [...town.ground].findIndex(
  (c, cell) =>
    c === "s" && cell % width > 4 && cell % width < width - 8 && cell / width > 4 && cell / width < town.height - 6,
);
const refusedPlace = (x: number, y: number, pattern: RegExp, label: string, building = home.id) =>
  has(worldTownEditIssues(game, layer([{ settlement: city.id, place: [{ building, x, y }] }])), pattern, label);
refusedPlace(streetCell % width, Math.floor(streetCell / width), /stands on the street or square/, "on the street");
refusedPlace(0, freeLot.y, /reaches the town's edge/, "at the edge");
const other = town.buildings.find((building) => building !== home && building.w === home.w)!;
refusedPlace(other.x, other.y, /overlaps|before the door/, "on another building");
refusedPlace(freeLot.x, freeLot.y, /no building "w999"/, "an unknown building", "w999");

// ── The new ground kinds ──
// Water all round a door's cell boxes the building in.
const door = home.door;
const ring: Record<number, string> = {};
for (const [dx, dy] of [
  [1, 0],
  [-1, 0],
  [0, 1],
]) {
  const cell = (door.y + dy) * width + door.x + dx;
  if (town.ground[cell] === "s" || town.ground[cell] === ".") ring[cell] = "~";
}
ring[door.y * width + door.x] = "p";
const boxed = layer([{ settlement: city.id, ground: groundOf(ring) }]);
assert.equal(boxed.editsVersion, 3, "water and paths are editsVersion 3");
has(
  worldTownEditIssues(game, boxed),
  new RegExp(`door of "${home.name ?? home.id}" can't be reached`),
  "boxed in by water",
);
// A bridge over nothing.
const open = town.ground.indexOf(".", town.ground.length / 2);
const bridgeLess = worldTownEditIssues(game, layer([{ settlement: city.id, ground: groundOf({ [open]: "b" }) }]));
has(bridgeLess, /bridge at .* crosses no water/, "a bridge needs water");
// A field on open ground away from every door is fine; a door's cell paved as a path is fine; a tree is not.
const fieldCell = town.ground
  .split("")
  .findIndex(
    (c, cell) =>
      c === "." &&
      !town.buildings.some(
        (b) =>
          (cell % width >= b.x - 1 &&
            cell % width <= b.x + b.w &&
            Math.floor(cell / width) >= b.y - 1 &&
            Math.floor(cell / width) <= b.y + b.h) ||
          (b.door.x === cell % width && b.door.y === Math.floor(cell / width)),
      ),
  );
assert.deepEqual(
  worldTownEditIssues(game, layer([{ settlement: city.id, ground: groundOf({ [fieldCell]: "f" }) }])),
  [],
  "a field",
);
assert.deepEqual(
  worldTownEditIssues(game, layer([{ settlement: city.id, ground: groundOf({ [door.y * width + door.x]: "p" }) }])),
  [],
  "a door paved as a path",
);
has(
  worldTownEditIssues(game, layer([{ settlement: city.id, ground: groundOf({ [door.y * width + door.x]: "t" }) }])),
  /painted over/,
  "a tree before a door",
);

// ── Decorations ──
const decoAt = { tile: WORLD_TOWN_PROPS[2]!, x: fieldCell % width, y: Math.floor(fieldCell / width) };
const decorated = layer([{ settlement: city.id, deco: [decoAt] }]);
assert.equal(decorated.editsVersion, 3);
assert.deepEqual(worldTownEditIssues(game, decorated), [], "a decoration on open ground");
assert.deepEqual(worldTown(withEdits(game, decorated), city.id)!.deco, [decoAt], "it is in the town");
has(
  worldTownEditIssues(game, layer([{ settlement: city.id, deco: [{ ...decoAt, x: home.x, y: home.y }] }])),
  /on a building or before its door/,
  "on a building",
);
has(
  worldTownEditIssues(game, layer([{ settlement: city.id, deco: [decoAt, decoAt] }])),
  /two decorations share/,
  "two on one cell",
);
assert.equal(worldEditsVersioned({ editsVersion: 3, towns: [{ settlement: city.id }] }).editsVersion, 1, "plain is 1");

// ── The snapshot keeps the decorations, at version 3; version 2 still reads ──
const decoratedGame = withEdits(game, decorated);
const snapshot = worldSnapshot(decoratedGame);
assert.equal(snapshot.snapshotVersion, 3);
assert.equal(WORLD_SNAPSHOT_VERSION, 3);
assert.deepEqual(snapshot.towns[city.id]!.deco, [decoAt], "the snapshot keeps them");
const read = readWorldSnapshot(JSON.parse(JSON.stringify(snapshot)));
assert.ok(read.ok, JSON.stringify(!read.ok && read.issues));
const older = readWorldSnapshot(JSON.parse(JSON.stringify({ ...worldSnapshot(game), snapshotVersion: 2 })));
assert.ok(older.ok, "a version 2 snapshot reads");
assert.ok(!readWorldSnapshot({ ...snapshot, snapshotVersion: 4 }).ok, "a version 4 snapshot is refused");

// ── Tile ids ──
for (const id of ["site", "bridge", "hedge", ...WORLD_TOWN_PROPS])
  assert.ok(
    WORLD_TILE_IDS.includes(id as never) && WORLD_IMAGE_ONLY_TILE_IDS.includes(id as never),
    `${id} is an image-only tile`,
  );

// ── Maps of places ──
// Someone from anywhere may stand on a map's spot (a town's smith visiting the mine).
const spotPlace = game.world.places.find((place) => worldCast(game, place.id).length)!;
const cave = game.world.places.find((place) => place.rank === undefined)!;
const someone = worldCast(game, spotPlace.id)[0]!;
// 8 by 6: walled, a room of floor with a pool in it.
const rows = ["########", "#......#", "#..~~..#", "#......#", "#......#", "########"];
const map = {
  id: "m1",
  place: cave.id,
  pack: "local/cave-ice",
  width: 8,
  height: 6,
  ground: rows.join(""),
  entry: { x: 1, y: 4 },
  props: [{ tile: "dn_prop5" as const, x: 6, y: 4 }],
  spots: [{ id: "s1", x: 2, y: 1, name: "By the pool", people: [someone.id], from: 8, to: 18 }],
};
const withMap = layer([], [map]);
assert.equal(withMap.editsVersion, 3, "a map is editsVersion 3");
assert.ok(worldEditsSchema.safeParse(withMap).success);
assert.deepEqual(worldTownEditIssues(game, withMap), [], "a good map");
assert.equal(worldPlaceMap(withEdits(game, withMap), cave.id)?.id, "m1", "the place has its map");
assert.equal(worldPlaceMapSpotsAt(map, 9).length, 1, "standing there by day");
assert.equal(worldPlaceMapSpotsAt(map, 20).length, 0, "not at night");
assert.equal(
  worldPlaceMapSpotsAt({ ...map, spots: [{ ...map.spots[0]!, from: 20, to: 4 }] }, 2).length,
  1,
  "night hours",
);
const refusedMap = (change: Partial<typeof map>, pattern: RegExp, label: string, maps = [{ ...map, ...change }]) =>
  has(worldMapEditIssues(game, layer([], maps)), pattern, label);
refusedMap({ place: city.id }, /a settlement's map is its town/, "on a settlement");
refusedMap({ place: "nowhere" }, /no place "nowhere"/, "on no place");
refusedMap(
  { ground: ["########", "#......#", "#..~~...", "#......#", "#......#", "########"].join("") },
  /edge is open/,
  "open at the edge",
);
refusedMap({ entry: { x: 3, y: 2 } }, /steps in on a wall or liquid/, "entered in the pool");
refusedMap(
  { ground: ["########", "#..#...#", "#..#...#", "####...#", "#......#", "########"].join(""), entry: { x: 5, y: 4 } },
  /can't be reached/,
  "a walled-off corner",
);
refusedMap({ props: [{ tile: "dn_prop1", x: 0, y: 0 }] }, /not on floor/, "a prop in the wall");
refusedMap({ spots: [{ ...map.spots[0]!, people: [`${spotPlace.id}-999`] }] }, /names nobody/, "a spot for nobody");
refusedMap({}, /has two maps/, "two maps of one place", [map, { ...map, id: "m2" }]);
assert.ok(
  !worldEditsSchema.safeParse(layer([], [{ ...map, width: WORLD_MAP_MAX.width + 1 }])).success,
  "too wide for the schema",
);

// ── Sites' locks ──
const locks = worldEditsVersioned({ editsVersion: 1, sites: [{ place: cave.id, lock: "hidden" }] });
assert.equal(locks.editsVersion, 3, "a lock is editsVersion 3");
assert.deepEqual(worldTownEditIssues(game, locks), [], "a site hidden");
assert.equal(worldSiteLock(withEdits(game, locks), cave.id), "hidden");
assert.equal(worldSiteLock(game, cave.id), null, "left to the game");
has(
  worldTownEditIssues(game, { editsVersion: 3, sites: [{ place: city.id, lock: "sealed" }] }),
  /a town is never locked/,
  "a settlement",
);
has(
  worldTownEditIssues(game, { editsVersion: 3, sites: [{ place: "nowhere", lock: "open" }] }),
  /No place/,
  "no place",
);
has(
  worldTownEditIssues(game, {
    editsVersion: 3,
    sites: [
      { place: cave.id, lock: "open" },
      { place: cave.id, lock: "sealed" },
    ],
  }),
  /locked twice/,
  "twice",
);
assert.ok(
  !worldEditsSchema.safeParse({ editsVersion: 3, sites: [{ place: cave.id, lock: "closed" }] }).success,
  "no such lock",
);

// ── The story's places on a town laid out by hand ──
// A place the story adds goes on the first free lot whose door a walk from the square reaches, and only if
// it cuts no door off: a lot walled round with hedges is passed over.
const storyPlace = (on: GameWorld) =>
  worldTown(on, city.id, {
    places: [{ id: "x1", name: "The Lantern House", parentId: city.id }],
  } as never)!.buildings.find((building) => building.id === "x1")!;
const usual = storyPlace(game);
const taken = town.lots.find((lot) => lot.x === usual.x && lot.y === usual.y)!;
assert.ok(taken, "the story's place stands on a free lot");
const hedged: Record<number, string> = {};
for (let y = taken.y - 1; y <= taken.door.y + 1; y++)
  for (let x = taken.x - 1; x <= taken.x + taken.w; x++) {
    const inside = x >= taken.x && x < taken.x + taken.w && y >= taken.y && y <= taken.door.y;
    if (inside || x < 0 || y < 0 || x >= width || y >= town.height) continue;
    if (".s".includes(town.ground[y * width + x]!)) hedged[y * width + x] = "h";
  }
const walled = layer([{ settlement: city.id, ground: groundOf(hedged) }]);
assert.deepEqual(worldTownEditIssues(game, walled), [], "hedges round a free lot cut no door off");
const elsewhere = storyPlace(withEdits(game, walled));
assert.ok(elsewhere, "the story's place still stands somewhere");
assert.notDeepEqual([elsewhere.x, elsewhere.y], [taken.x, taken.y], "never on the walled-off lot");
assert.ok(
  worldTownReach(worldTown(withEdits(game, walled), city.id)!).has(elsewhere.door.y * width + elsewhere.door.x),
  "its door is reached from the square",
);

console.log(
  "World free towns: buildings placed freely, new ground and decorations checked, maps of places and sites' locks kept.",
);
