/**
 * World places (worldgen W1): the compile of a world's ground, places and links.
 *
 *   - Every starter kit, at every scale, compiles to a world that is whole: one tree of places down to
 *     the settlements, every settlement sized on the kit's ladder and reachable from every other, and
 *     nothing named outside the kit's own words.
 *   - The same seed, kit and brief give the same world, byte for byte (a committed fingerprint), and
 *     each part draws from its own stream: names never move the ground or the places.
 *   - A brief's places are the world's: their names, layers, parents, sizes, tags, lore and the
 *     starting place. A reference the kit does not have is dropped with a note; a brief that is not
 *     one is refused with the reasons. Strict grounding makes nothing beside them.
 *   - A stored world reads back as the same world; one made by another generator version, or whose
 *     brief broke, is no world. A place tag naming a world place takes the world's size (on a
 *     market's own ladder when there is one), and the Game Master is told where the party is.
 *   - The model writes the brief around the lore's places, which it keeps exactly, and reads the lore
 *     for them in batches; a new game stores a world only when it holds together.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_SCALES,
  WORLD_STARTER_KITS,
  applyGamePlaceTags,
  checkWorldBrief,
  compileWorld,
  worldSites,
  createConnectionSchema,
  createLorebookEntrySchema,
  createLorebookSchema,
  gameWorldFromMetadata,
  lastGamePlace,
  parseWorldKit,
  worldKitReworded,
  worldKitSize,
  worldPlaceForTag,
  worldWhereYouAreText,
  type CompiledWorld,
  type WorldKit,
} from "../../packages/shared/src/index.js";

const kits = WORLD_STARTER_KITS.map((input) => {
  const parsed = parseWorldKit(input);
  assert.ok(parsed.ok);
  return parsed.kit;
});
const byId = new Map(kits.map((kit) => [kit.id, kit]));
const fantasy = byId.get("high_fantasy")!;

/** Everything a compiled world must be, whatever the kit, scale or seed. */
function assertWhole(world: CompiledWorld, kit: WorldKit, what: string) {
  const settlementsDepth = kit.layers.findIndex((layer) => layer.settlements);
  assert.equal(world.generatorVersion, WORLD_GENERATOR_VERSION);
  assert.equal(world.ground.length, world.width * world.height, `${what}: the ground covers the map`);
  assert.deepEqual(
    world.terrain,
    (kit.terrain ?? [{ id: kit.layers[0]!.id }]).map((entry) => entry.id),
  );
  assert.ok(
    [...world.ground].every((cell) => parseInt(cell, 36) < world.terrain.length),
    `${what}: ground classes`,
  );
  const ids = new Set(world.places.map((place) => place.id));
  assert.equal(ids.size, world.places.length, `${what}: ids are unique`);
  const names = new Set(world.places.map((place) => place.name.toLowerCase()));
  assert.equal(names.size, world.places.length, `${what}: names are unique`);
  const byPlace = new Map(world.places.map((place) => [place.id, place]));
  for (const place of world.places) {
    assert.equal(kit.layers[place.depth]!.id, place.layer, `${what}: ${place.name} is in its layer`);
    if (place.depth === 0) assert.equal(place.parentId, null);
    else
      assert.equal(
        byPlace.get(place.parentId!)?.depth,
        place.depth - 1,
        `${what}: ${place.name} lies in the layer above`,
      );
    assert.ok(place.at.x >= 0 && place.at.x < world.width && place.at.y >= 0 && place.at.y < world.height);
    assert.ok(kit.cultures.some((culture) => culture.id === place.culture));
    for (const tag of place.tags)
      assert.ok(
        kit.placeTags.some((each) => each.id === tag),
        `${what}: tag ${tag}`,
      );
    if (place.depth === settlementsDepth) {
      assert.equal(kit.sizes[place.rank!]?.id, place.size, `${what}: ${place.name} is sized on the ladder`);
      assert.ok(["struggling", "modest", "thriving"].includes(place.prosperity!));
    } else {
      assert.equal(place.size, undefined);
    }
  }
  // Every parent above the settlements has a child, so no region is empty.
  for (const place of world.places) {
    if (place.depth < settlementsDepth) {
      assert.ok(
        world.places.some((child) => child.parentId === place.id),
        `${what}: ${place.name} has places in it`,
      );
    }
  }
  const settlements = world.places.filter((place) => place.depth === settlementsDepth);
  assert.ok(settlements.length >= 1);
  const start = byPlace.get(world.startId)!;
  const startSettlement = start.depth > settlementsDepth ? byPlace.get(start.parentId!)! : start;
  assert.equal(startSettlement.depth, settlementsDepth, `${what}: the party starts in a settlement or a place in one`);
  // Connected: every settlement is reachable from the first.
  const reach = new Set([settlements[0]!.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const link of world.links) {
      for (const [a, b] of [
        [link.from, link.to],
        [link.to, link.from],
      ] as const) {
        if (reach.has(a) && !reach.has(b)) {
          reach.add(b);
          grew = true;
        }
      }
    }
  }
  assert.equal(reach.size, settlements.length, `${what}: every settlement can be reached`);
  for (const link of world.links) {
    assert.ok(
      kit.travel.some((way) => way.id === link.way),
      `${what}: way ${link.way}`,
    );
    const [from, to] = [byPlace.get(link.from)!, byPlace.get(link.to)!];
    assert.ok(link.days > 0 || (from.at.x === to.at.x && from.at.y === to.at.y), `${what}: a trip takes time`);
    assert.equal(byPlace.get(link.from)?.depth, settlementsDepth);
  }
  // Settlements stand on open ground (every starter kit's regions have some).
  for (const place of settlements) {
    const cell = place.at.y * world.width + place.at.x;
    const kind = (kit.terrain ?? [{ kind: "open" }])[parseInt(world.ground[cell]!, 36)]!.kind;
    assert.equal(kind, "open", `${what}: ${place.name} stands on ${kind}`);
  }
  return settlements;
}

// ── Every kit at every scale, three seeds each ──
for (const kit of kits) {
  for (const scale of WORLD_SCALES) {
    for (const seed of [1, 4242, 0xdeadbeef]) {
      const scaled = { ...kit, scale };
      const world = compileWorld({ seed, kit: scaled });
      const settlements = assertWhole(world, scaled, `${kit.id}/${scale}/${seed}`);
      const range = { site: [1, 1], town: [1, 4], region: [8, 14], realm: [20, 36], world: [48, 80], sector: [24, 40] }[
        scale
      ];
      assert.ok(
        settlements.length >= range[0]! && settlements.length <= Math.max(range[1]!, 1),
        `${kit.id}/${scale}: ${settlements.length} settlements`,
      );
      assert.ok(world.places.length <= 5000, "inside the World Maps cap");
      assert.deepEqual(compileWorld({ seed, kit: scaled }), world, `${kit.id}/${scale}/${seed}: the same world twice`);
    }
  }
}

// ── The ground's shares, and the ways and times of travel ──
{
  const ways = new Set<string>();
  for (const seed of [1, 4242, 0xdeadbeef]) {
    const world = compileWorld({ seed, kit: fantasy });
    // Each class of ground covers its share of the map (rounded to whole cells).
    const total = fantasy.terrain!.reduce((sum, entry) => sum + entry.share, 0);
    fantasy.terrain!.forEach((entry, index) => {
      const cells = [...world.ground].filter((cell) => parseInt(cell, 36) === index).length;
      assert.ok(
        Math.abs(cells / world.ground.length - entry.share / total) < 0.02,
        `${entry.label}: ${cells} of ${world.ground.length}`,
      );
    });
    for (const link of world.links) {
      ways.add(link.way);
      // A trip takes its length over the way's speed, in the scale's days per cell.
      const from = world.places.find((place) => place.id === link.from)!;
      const to = world.places.find((place) => place.id === link.to)!;
      const speed = fantasy.travel.find((way) => way.id === link.way)!.speed!;
      const days = Math.round(((Math.hypot(from.at.x - to.at.x, from.at.y - to.at.y) * 0.5) / speed) * 100) / 100;
      assert.equal(link.days, days, `${from.name} to ${to.name}`);
    }
  }
  // Over open ground the fastest open way, over water a boat, over the mountains a pass.
  assert.ok(ways.has("road") && ways.has("sea_lane") && ways.has("mountain_pass"), [...ways].join(", "));
}

// ── Few big places, many small ──
{
  const world = compileWorld({ seed: 7, kit: fantasy });
  const ranks = world.places.filter((place) => place.rank !== undefined).map((place) => place.rank!);
  const top = fantasy.sizes.length - 1;
  assert.equal(ranks.filter((rank) => rank === top).length, 1, "one capital in a realm");
  assert.ok(ranks.filter((rank) => rank === 0).length > ranks.filter((rank) => rank === top - 1).length);
  // A world of one town is town-sized, and holds the layer inside it.
  const modern = byId.get("modern_day")!;
  const town = compileWorld({ seed: 7, kit: modern });
  const settlementsDepth = modern.layers.findIndex((layer) => layer.settlements);
  const main = town.places.filter((place) => place.depth === settlementsDepth).sort((a, b) => b.rank! - a.rank!)[0]!;
  assert.ok(main.rank! <= Math.floor((modern.sizes.length - 1) / 2), "a town world's biggest place is no metropolis");
  // (Its sites, generator 2, are beside any of its settlements: the neighborhoods are the rest.)
  const sites = new Set(
    worldSites({
      kit: modern,
      seed: 7,
      grounding: "expand",
      brief: { briefVersion: 1, premise: "" } as never,
      world: town,
    }).map((place) => place.id),
  );
  const inside = town.places.filter((place) => place.depth === settlementsDepth + 1 && !sites.has(place.id));
  assert.ok(inside.length >= 4 && inside.every((place) => place.parentId === main.id), "its neighborhoods");
  // A place the brief puts in another of the town world's settlements goes there.
  const twoTowns = checkWorldBrief(modern, {
    briefVersion: 1,
    premise: "Two towns on one bay.",
    places: [
      { name: "Northfield", layer: "city", size: "town" },
      { name: "Bayside", layer: "city", size: "small_town" },
      { name: "Pier Street", layer: "neighborhood", parent: "Bayside" },
    ],
  });
  assert.ok(twoTowns.ok);
  const bay = compileWorld({ seed: 7, kit: modern, brief: twoTowns.brief });
  assertWhole(bay, modern, "two towns");
  const pier = bay.places.find((place) => place.name === "Pier Street")!;
  assert.equal(bay.places.find((place) => place.id === pier.parentId)?.name, "Bayside");
  // The brief can start the party in one of them.
  const harbourBrief = checkWorldBrief(modern, {
    briefVersion: 1,
    premise: "A summer by the harbour.",
    places: [{ name: "Harbour Row", layer: "neighborhood", start: true }],
  });
  assert.ok(harbourBrief.ok);
  const harbourTown = compileWorld({ seed: 7, kit: modern, brief: harbourBrief.brief });
  assertWhole(harbourTown, modern, "a start inside the town");
  assert.equal(harbourTown.places.find((place) => place.id === harbourTown.startId)?.name, "Harbour Row");
  // A place inside the town is at the town's size when the Game Master says the party is there.
  const townGame = {
    kit: modern,
    seed: 7,
    grounding: "expand" as const,
    brief: { briefVersion: 1 as const, premise: "x", places: [], placeNames: [] },
    world: town,
  };
  assert.deepEqual(worldPlaceForTag(townGame, inside[0]!.name), { name: inside[0]!.name, size: main.size });
}

// ── A kit written before worlds (no ground, plain ways) still makes a world ──
{
  const plain = parseWorldKit({
    ...structuredClone(WORLD_STARTER_KITS[0]!),
    terrain: undefined,
    travel: [{ id: "road", label: "road" }],
  });
  assert.ok(plain.ok);
  const world = compileWorld({ seed: 3, kit: plain.kit });
  assertWhole(world, plain.kit, "plain kit");
  assert.deepEqual(world.terrain, ["realm"], "its ground is named for its outermost layer");
  assert.ok(world.links.every((link) => link.way === "road"));
}

// ── The brief ──
const brief = {
  briefVersion: 1,
  premise: "The old king is dying and the river provinces quarrel over the succession.",
  places: [
    {
      name: "Thornmere",
      layer: "settlement",
      parent: "The Fenlands",
      size: "city",
      tags: ["port", "market"],
      note: "A river port of tall houses.",
      lore: ["entry-1"],
    },
    { name: "The Fenlands", layer: "province", parent: "Aldmark", note: "Marsh and reed." },
    { name: "Aldmark", layer: "realm" },
    { name: "Hollin", layer: "settlement", parent: "Aldmark", start: true },
    { name: "Grey Watch", layer: "settlement", size: "hamlet", tags: ["keep"] },
  ],
  placeNames: [{ culture: fantasy.cultures[0]!.id, names: ["Ashby", "Wending", "Thornmere", "Calder", "Ravel"] }],
};
{
  const checked = checkWorldBrief(fantasy, brief);
  assert.ok(checked.ok);
  assert.deepEqual(checked.repairs, []);
  const world = compileWorld({ seed: 20261001, kit: fantasy, brief: checked.brief });
  assertWhole(world, fantasy, "brief");
  const named = new Map(world.places.map((place) => [place.name, place]));
  const thornmere = named.get("Thornmere")!;
  const fenlands = named.get("The Fenlands")!;
  assert.equal(thornmere.parentId, fenlands.id, "a place lies in the place the brief names");
  assert.equal(fenlands.parentId, named.get("Aldmark")!.id);
  assert.equal(thornmere.size, "city");
  assert.deepEqual(thornmere.tags, ["port", "market"]);
  assert.deepEqual(thornmere.lore, ["entry-1"]);
  assert.equal(thornmere.note, "A river port of tall houses.");
  assert.equal(thornmere.named, true);
  assert.ok(
    world.places.some((place) => !place.named && place.depth === 2),
    "drawn settlements are not named by the brief",
  );
  assert.equal(named.get("Grey Watch")!.size, "hamlet");
  // A place whose parent is more than one layer out lies in a province of it.
  const hollin = named.get("Hollin")!;
  assert.equal(world.places.find((place) => place.id === hollin.parentId)?.parentId, named.get("Aldmark")!.id);
  assert.equal(world.startId, hollin.id, "the party starts where the brief says");
  // Drawn places take the culture's names, never one the brief already used.
  assert.ok(named.has("Ashby") && named.has("Wending") && named.has("Calder") && named.has("Ravel"));
  assert.equal(world.places.filter((place) => place.name === "Thornmere").length, 1);

  // Byte for byte: this world is committed. A change to the compile that moves it is a new
  // generator version (worlds in play pin theirs), and this fingerprint moves with it.
  // Version 1 is made exactly as it was (games in play on it are made again from their recipes), and
  // version 2 is version 1 with its sites after it.
  const versionOne = compileWorld({ seed: 20261001, kit: fantasy, brief: checked.brief, generatorVersion: 1 });
  const fingerprint = createHash("sha256").update(JSON.stringify(versionOne)).digest("hex");
  assert.equal(
    fingerprint,
    "10fe126f207278d79e6aaa3b6ae9150c6e433e545477013a1774c11116db6787",
    "the committed world of generator version 1",
  );
  assert.deepEqual(
    { ...world, generatorVersion: 1, places: world.places.slice(0, versionOne.places.length) },
    versionOne,
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(world)).digest("hex"),
    "a309b82f166d841222f19220d5c0bffd3693933f6b7e1e5ed5152f8381e72888",
    "the committed world of generator version 2",
  );

  // Names never move the ground or the places.
  const renamed = compileWorld({
    seed: 20261001,
    kit: fantasy,
    brief: { ...checked.brief, placeNames: [{ culture: fantasy.cultures[0]!.id, names: ["Other"] }] },
  });
  assert.equal(renamed.ground, world.ground);
  assert.deepEqual(
    renamed.places.map((place) => [place.id, place.at, place.size, place.parentId]),
    world.places.map((place) => [place.id, place.at, place.size, place.parentId]),
  );
  // Another seed is another world, on other ground.
  assert.notEqual(compileWorld({ seed: 20261002, kit: fantasy, brief: checked.brief }).ground, world.ground);
}

// ── Retyped kit words keep what a world refers to ──
{
  const travel = fantasy.travel;
  // A rename in place keeps the id and what the way carries; a kept word keeps its entry; a new word
  // gets a new id, never one already taken.
  const retyped = worldKitReworded(travel, ["highway", "river", "sea lane", "mountain pass", "forest track"]);
  assert.deepEqual(retyped[0], { ...travel[0], label: "highway" });
  assert.equal(retyped[1], travel[1]);
  const added = worldKitReworded(retyped, ["highway", "river", "sea lane", "mountain pass", "forest track", "road"]);
  assert.deepEqual(added[5], { id: "road_2", label: "road" }, "a new word never takes an id in use");
  assert.equal(new Set(added.map((way) => way.id)).size, added.length);
  assert.deepEqual(
    worldKitReworded(travel, ["river"]).map((way) => way.id),
    ["river"],
    "a word taken out is gone",
  );
  // So renaming the settlements layer never costs a brief its places.
  const renamed = parseWorldKit({
    ...structuredClone(WORLD_STARTER_KITS[0]!),
    layers: worldKitReworded(fantasy.layers, ["realm", "province", "burgh", "quarter"]),
  });
  assert.ok(renamed.ok);
  const checked = checkWorldBrief(renamed.kit, brief);
  assert.ok(checked.ok);
  assert.deepEqual(checked.repairs, []);
}

// ── A name two cultures' lists share is still drawn once ──
{
  const shared = checkWorldBrief(fantasy, {
    briefVersion: 1,
    premise: "x",
    placeNames: fantasy.cultures.map((culture) => ({ culture: culture.id, names: ["Calder"] })),
  });
  assert.ok(shared.ok);
  const world = compileWorld({ seed: 11, kit: fantasy, brief: shared.brief });
  assertWhole(world, fantasy, "shared names");
  assert.equal(world.places.filter((place) => place.name === "Calder").length, 1);
}

// ── A brief is read against its kit ──
{
  const repaired = checkWorldBrief(fantasy, {
    ...brief,
    places: [
      ...brief.places,
      { name: "Nowhere", layer: "galaxy" },
      { name: "thornmere", layer: "settlement" },
      { name: "Kettle", layer: "settlement", tags: ["port", "spaceport"], size: "megacity" },
      { name: "Second Start", layer: "settlement", start: true },
      { name: "Lost", layer: "settlement", parent: "Atlantis" },
      { name: "Upside", layer: "province", parent: "Thornmere" },
      { name: "Sized Province", layer: "province", size: "city" },
    ],
    placeNames: [...brief.placeNames, { culture: "martians", names: ["Zork"] }],
  });
  assert.ok(repaired.ok);
  const notes = repaired.repairs.join("\n");
  for (const pattern of [
    /Nowhere: left out, "galaxy" is not a layer/,
    /thornmere: left out, the name is already used/,
    /Kettle: a tag the kit does not have was left out/,
    /Kettle: its size was left out/,
    /Second Start: only the first starting place is kept/,
    /Lost: "Atlantis" is not a place it can lie in/,
    /Upside: "Thornmere" is not a place it can lie in/,
    /Sized Province: its size was left out, since only a settlement has one/,
    /placeNames: "martians" is not one of the kit's cultures/,
  ]) {
    assert.match(notes, pattern);
  }
  const kettle = repaired.brief.places.find((place) => place.name === "Kettle")!;
  assert.deepEqual(kettle.tags, ["port"]);
  assert.equal(kettle.size, undefined);
  assert.equal(
    repaired.brief.placeNames[0]!.names.includes("Thornmere"),
    false,
    "a brief place's name is not drawn again",
  );
  assertWhole(compileWorld({ seed: 5, kit: fantasy, brief: repaired.brief }), fantasy, "repaired brief");

  for (const [input, pattern] of [
    [{ ...brief, briefVersion: 2 }, /briefVersion/],
    [{ ...brief, premise: "Two\nlines" }, /premise: Text cannot contain line breaks/],
    [{ ...brief, places: [{ name: "[x]", layer: "realm" }] }, /places\.0\.name: Text cannot contain square brackets/],
    [{ ...brief, extra: 1 }, /Unrecognized key/],
    [
      {
        ...brief,
        placeNames: [0, 1, 2].map((group) => ({
          culture: fantasy.cultures[0]!.id,
          names: Array.from({ length: 160 }, (_, n) => `Name ${group}-${n}`),
        })),
      },
      /At most 400 place names in all/,
    ],
  ] as const) {
    const refused = checkWorldBrief(fantasy, input);
    assert.equal(refused.ok, false);
    if (!refused.ok)
      assert.ok(
        refused.issues.some((issue) => pattern.test(issue)),
        refused.issues.join("; "),
      );
  }
}

// ── Strict grounding: the lore's places and no more ──
{
  const checked = checkWorldBrief(fantasy, brief);
  assert.ok(checked.ok);
  const strict = compileWorld({ seed: 9, kit: fantasy, brief: checked.brief, strict: true });
  assertWhole(strict, fantasy, "strict");
  assert.deepEqual(
    strict.places.map((place) => place.name).sort(),
    ["Aldmark", "Grey Watch", "Hollin", "The Fenlands", "Thornmere"],
    "nothing is invented beside the brief's places",
  );
}

// ── A stored world, read back, and what the Game Master is told ──
const storedWorld = { seed: 20261001, generatorVersion: WORLD_GENERATOR_VERSION, grounding: "expand", brief };
{
  const meta = { gameWorldKit: fantasy, gameWorld: storedWorld };
  const game = gameWorldFromMetadata(meta)!;
  assert.ok(game, "a stored world reads back");
  assert.deepEqual(
    game.world,
    compileWorld({
      seed: 20261001,
      kit: fantasy,
      brief: checkWorldBrief(fantasy, brief).ok
        ? (checkWorldBrief(fantasy, brief) as { brief: never }).brief
        : undefined,
    }),
  );
  assert.equal(gameWorldFromMetadata({ gameWorld: storedWorld }), null, "no kit, no world");
  assert.equal(
    gameWorldFromMetadata({ ...meta, gameWorld: { ...storedWorld, generatorVersion: 99 } }),
    null,
    "another generator's world is not reshaped",
  );
  assert.equal(
    gameWorldFromMetadata({ ...meta, gameWorld: { ...storedWorld, brief: { ...brief, premise: "" } } }),
    null,
  );
  assert.equal(gameWorldFromMetadata({ gameWorldKit: fantasy }), null);

  // A place tag: a world name takes the world's size; another name keeps what was written.
  const thornmere = game.world.places.find((place) => place.name === "Thornmere")!;
  assert.deepEqual(worldPlaceForTag(game, "  THORNMERE "), { name: "Thornmere", size: "city" });
  assert.deepEqual(worldPlaceForTag(game, "The Fenlands"), { name: "The Fenlands" }, "a province has no size");
  assert.equal(worldPlaceForTag(game, "A farmhouse"), undefined);
  // On a market's ladder of three, a world city (rank 3 of 0..4) is the second place.
  assert.deepEqual(worldPlaceForTag(game, "Thornmere", [{ id: "hamlet" }, { id: "market" }, { id: "metropolis" }]), {
    name: "Thornmere",
    size: "market",
  });
  const answered = applyGamePlaceTags(
    'We arrive. [place: name="thornmere" size="hamlet"] Later, a farm. [place: name="Old farm" size="village"]',
    (word) => worldKitSize(fantasy, word),
    (name) => worldPlaceForTag(game, name),
  );
  assert.equal(
    answered.content,
    'We arrive. [place: name="Thornmere" size="city" result="ok"] Later, a farm. [place: name="Old farm" size="village" result="ok"]',
  );
  assert.deepEqual(lastGamePlace([answered.content]), { name: "Old farm", size: "village" });

  const where = worldWhereYouAreText(game, { place: thornmere, name: "Thornmere" });
  assert.match(
    where,
    /^<where_you_are>\nThe party is in Thornmere \(city, (struggling|modest|thriving)\), in The Fenlands \(province\), Aldmark \(realm\)\./,
  );
  assert.ok(where.includes("- Known for: port, market."));
  assert.ok(where.includes("- A river port of tall houses."));
  const routes = game.world.links.filter((link) => link.from === thornmere.id || link.to === thornmere.id);
  assert.ok(routes.length > 0 && where.includes("- From here: "));
  assert.ok(new RegExp(` by (${fantasy.travel.map((way) => way.label).join("|")})\\.`).test(where), where);
  assert.equal(
    worldWhereYouAreText(game, { name: "Old farm" }),
    "<where_you_are>\nThe party is at Old farm, which this world does not list.\n</where_you_are>",
  );
}

// ── The server: the model's part, and a new game storing its world ──
const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-places-"));
const previousDataDir = process.env.DATA_DIR;
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const replies: string[] = [];
const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "stand-in",
      model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: replies.shift() ?? "" } }],
    }),
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
const { buildGmSystemPrompt, buildSetupPrompt } = await import("../../packages/server/src/services/game/gm-prompts.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { errorHandler } = await import("../../packages/server/src/middleware/error-handler.js");
const db = await getDB();
const app = Fastify();
app.decorate("db", db);
app.setErrorHandler(errorHandler);
await app.register(gameRoutes, { prefix: "/api/game" });
try {
  const connection = await createConnectionsStorage(db).create(
    createConnectionSchema.parse({
      name: "Stand-in",
      provider: "custom",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "stand-in",
      apiKey: "sk-stand-in",
    }),
  );
  const canon = [
    { name: "Thornmere", layer: "settlement", size: "city", tags: ["port"], note: "A river port.", lore: ["entry-a"] },
  ];

  // The brief: written around the lore's place, which is put back exactly whatever the model wrote.
  {
    requests.length = 0;
    const { briefVersion: _, ...unversioned } = brief;
    // The model drifts the lore's place, and starts the party there: the place is put back, the start kept.
    const drifted = {
      ...unversioned,
      places: unversioned.places.map((place) =>
        place.name === "Thornmere" ? { ...place, size: "hamlet", start: true } : { ...place, start: undefined },
      ),
    };
    replies.push("Here it is!", JSON.stringify(drifted));
    const response = await app.inject({
      method: "POST",
      url: "/api/game/world-brief",
      payload: {
        connectionId: connection!.id,
        kit: fantasy,
        genre: "Fantasy",
        setting: "A river kingdom",
        tone: "Grim",
        canon,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const written = response.json();
    assert.equal(written.brief.briefVersion, 1);
    assert.deepEqual(
      written.brief.places.find((place: { name: string }) => place.name === "Thornmere"),
      { ...canon[0], tags: ["port"], start: true },
      "the lore's place is kept exactly, and the party starts there",
    );
    assert.equal(requests.length, 2, "a reply that is not JSON is sent back once");
    assert.ok(requests[0]!.messages[1]!.content.includes('"lore":["entry-a"]'), "the model is shown the lore's places");
    assert.ok(
      requests[0]!.messages[1]!.content.includes("settlement: settlement (the settlements, which have a size)"),
    );
    assert.ok(requests[1]!.messages[3]!.content.includes("brief: The reply was not JSON"));
    replies.length = 0;
    replies.push("not a brief", "still not a brief");
    const strict = await app.inject({
      method: "POST",
      url: "/api/game/world-brief",
      payload: {
        connectionId: connection!.id,
        kit: fantasy,
        genre: "Fantasy",
        setting: "x",
        tone: "y",
        canon,
        grounding: "strict",
      },
    });
    assert.ok(requests.at(-1)!.messages[0]!.content.includes("Add no places of your own"));
    assert.equal(strict.statusCode, 422, "two replies that are not a brief are refused");
  }

  // The lore: read in batches, each place linked to the entries that state it, only those read.
  {
    const lorebooks = createLorebooksStorage(db);
    const book = await lorebooks.create(createLorebookSchema.parse({ name: "Aldmark lore" }));
    const entry = (name: string, content: string, enabled = true) =>
      lorebooks.createEntry(
        createLorebookEntrySchema.parse({ lorebookId: book!.id, name, content, keys: [name], enabled }),
      );
    const port = await entry("Thornmere", "Thornmere is the great river port of the Fenlands. ".repeat(150));
    const keep = await entry("Grey Watch", "Grey Watch is a hamlet under an old keep. ".repeat(150));
    await entry("Hidden", "Never read.", false);
    requests.length = 0;
    replies.push(
      JSON.stringify({
        places: [{ name: "Thornmere", layer: "settlement", tags: ["port"], lore: [port!.id, "made-up"] }],
      }),
      JSON.stringify({
        places: [
          { name: "thornmere", layer: "settlement", size: "city", lore: [keep!.id] },
          { name: "Grey Watch", layer: "settlement", size: "hamlet", tags: ["keep"], lore: [keep!.id] },
        ],
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/game/world-canon",
      payload: { connectionId: connection!.id, kit: fantasy, lorebookIds: [book!.id] },
    });
    assert.equal(response.statusCode, 200, response.body);
    const read = response.json();
    assert.equal(requests.length, 2, "two batches");
    assert.ok(
      !requests.some((request) => request.messages[1]!.content.includes("Never read.")),
      "a disabled entry is never read",
    );
    assert.equal(read.entriesRead, 2);
    assert.deepEqual(read.places, [
      { name: "Thornmere", layer: "settlement", size: "city", tags: ["port"], lore: [port!.id, keep!.id] },
      { name: "Grey Watch", layer: "settlement", size: "hamlet", tags: ["keep"], lore: [keep!.id] },
    ]);
    const none = await app.inject({
      method: "POST",
      url: "/api/game/world-canon",
      payload: { connectionId: connection!.id, kit: fantasy, lorebookIds: [book!.id], entryIds: ["nothing"] },
    });
    assert.equal(none.statusCode, 400);
    // A lorebook switched off states nothing, even its entries that are on.
    const off = await lorebooks.create(createLorebookSchema.parse({ name: "Shelved lore", enabled: false }));
    await lorebooks.createEntry(
      createLorebookEntrySchema.parse({ lorebookId: off!.id, name: "Shelf", content: "Shelved.", keys: ["Shelf"] }),
    );
    const shelved = await app.inject({
      method: "POST",
      url: "/api/game/world-canon",
      payload: { connectionId: connection!.id, kit: fantasy, lorebookIds: [off!.id] },
    });
    assert.equal(shelved.statusCode, 400, "an off lorebook has no entries to read");
  }

  // A new game stores its world only when it holds together.
  {
    const baseConfig = {
      genre: "Fantasy",
      setting: "A river kingdom",
      tone: "Grim",
      difficulty: "normal",
      rating: "sfw",
      playerGoals: "",
      gmMode: "standalone",
      partyCharacterIds: [],
    };
    const create = (setupConfig: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/game/create", payload: { name: "Aldmark", setupConfig } });
    // Overworld games locked (MARINARA_OVERWORLD_GAMES off): a kit or a world is refused, a Classic game is not,
    // and the server says it is locked.
    const overworldBefore = process.env.MARINARA_OVERWORLD_GAMES;
    delete process.env.MARINARA_OVERWORLD_GAMES;
    try {
      assert.deepEqual((await app.inject({ method: "GET", url: "/api/game/overworld" })).json(), { enabled: false });
      for (const config of [
        { ...baseConfig, worldKit: fantasy, world: storedWorld },
        { ...baseConfig, worldKit: fantasy },
        { ...baseConfig, gameStyle: "overworld" },
        { ...baseConfig, world: storedWorld },
      ]) {
        const locked = await create(config);
        assert.equal(locked.statusCode, 403, locked.body);
        assert.equal(locked.json().code, "overworld_locked");
      }
      assert.equal((await create(baseConfig)).statusCode, 200, "a Classic game is made while Overworld is locked");
    } finally {
      process.env.MARINARA_OVERWORLD_GAMES = overworldBefore ?? "true";
    }
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/game/overworld" })).json(), { enabled: true });
    const made = await create({ ...baseConfig, worldKit: fantasy, world: storedWorld });
    assert.equal(made.statusCode, 200, made.body);
    const chosen = await create({ ...baseConfig, gameStyle: "overworld", worldKit: fantasy, world: storedWorld });
    assert.equal(chosen.statusCode, 200, `an Overworld game with its kit and world: ${chosen.body}`);
    const meta = JSON.parse(made.json().sessionChat.metadata);
    assert.equal(meta.gameWorld.seed, 20261001);
    assert.ok(gameWorldFromMetadata(meta), "the stored world reads back");
    for (const [config, code] of [
      [{ ...baseConfig, world: storedWorld }, "a world without a kit"],
      [{ ...baseConfig, gameStyle: "overworld" }, "an Overworld game without a kit or world"],
      [{ ...baseConfig, gameStyle: "overworld", worldKit: fantasy }, "an Overworld game without a world"],
      [{ ...baseConfig, worldKit: fantasy, world: { ...storedWorld, generatorVersion: 99 } }, "another generator"],
    ] as const) {
      const refused = await create(config);
      assert.equal(refused.statusCode, 400, `${code}: ${refused.body}`);
    }
    const repaired = await create({
      ...baseConfig,
      worldKit: fantasy,
      world: { ...storedWorld, brief: { ...brief, places: [...brief.places, { name: "Nowhere", layer: "galaxy" }] } },
    });
    assert.equal(repaired.statusCode, 200);
    const repairedMeta = JSON.parse(repaired.json().sessionChat.metadata);
    for (const stored of [
      repairedMeta.gameWorld,
      repairedMeta.gameSetupConfig.world,
      repairedMeta.gameInitialSetup.config.world,
    ]) {
      assert.ok(
        !stored.brief.places.some((place: { name: string }) => place.name === "Nowhere"),
        "what is stored, in every copy, is the brief as read",
      );
    }

    // The Game Master's system prompt and world setup carry the world's overview.
    const game = gameWorldFromMetadata(meta)!;
    const context = {
      gameActiveState: "exploration",
      storyArc: null,
      plotTwists: null,
      map: null,
      npcs: [],
      sessionSummaries: [],
      sessionNumber: 1,
      partyNames: [],
      playerName: "Player",
      gmCharacterCard: null,
      difficulty: "normal",
      genre: "Fantasy",
      setting: "A river kingdom",
      tone: "Grim",
    } as unknown as Parameters<typeof buildGmSystemPrompt>[0];
    const system = buildGmSystemPrompt({ ...context, world: game });
    assert.ok(system.includes("<world_places>") && system.includes("- Now: The old king is dying"));
    assert.ok(system.includes('[place: name="..."]'));
    assert.ok(!buildGmSystemPrompt(context).includes("<world_places>"));
    const setup = buildSetupPrompt({ world: game });
    assert.ok(
      setup.includes("<world_places>") && setup.includes("- Now: The old king is dying"),
      "setup is told the world",
    );
    assert.ok(setup.includes("The party starts in Hollin; the starting map is of that place."));
  }
} finally {
  await app.close();
  await closeDB();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
}

console.log(
  `World places: ${kits.length} kits at ${WORLD_SCALES.length} scales compile whole and the same twice, the brief's places hold, and the committed world is unchanged.`,
);
