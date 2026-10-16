/**
 * Story events on map cells (map editor item 4, design-pf-map-events.md draft 2):
 *
 *   - A step event names a cell of a settlement's town or of a place's hand-made map; the story's check
 *     refuses a cell the party cannot walk onto: outside, not reached from the square or the map's entry,
 *     on a free lot (the story may build there), or of a place with no hand-made map.
 *   - It trips when this turn's walk went over its cell (the end cell included), under its conditions:
 *     once, or each turn the walk goes over it when it repeats, at most once a turn. A cell of another
 *     town or map with the same numbers is not it.
 *   - Hand edits that take a step cell away are refused on save, naming the event.
 */
import assert from "node:assert/strict";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  checkStoryScript,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  storyStepIssue,
  storyTurn,
  worldEditsVersioned,
  worldPlaceMap,
  worldTown,
  worldTownReach,
  type GameWorld,
  type StoryScriptInput,
  type StoryTurnWorld,
  type WorldEdits,
} from "../../packages/shared/src/index.js";

const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
assert.ok(parsed.ok);
const kit = parsed.kit;
const settlementLayer = kit.layers.find((layer) => layer.settlements)!;
const checked = checkWorldBrief(kit, {
  briefVersion: 1,
  premise: "A river kingdom",
  places: [
    { name: "Ashford", layer: settlementLayer.id, size: kit.sizes.at(-1)!.id, tags: [] },
    { name: "Millbrook", layer: settlementLayer.id, size: kit.sizes[0]!.id, tags: [] },
  ],
  groups: [{ name: "The Red Hand", kind: kit.groupKinds[0]!.id, seat: "Ashford" }],
  peopleNames: kit.cultures.map((culture) => ({
    culture: culture.id,
    given: ["Ama", "Tobin", "Hesk", "Mira", "Elara", "Oswin", "Bryn", "Cato", "Tamsin", "Wren", "Edda", "Fenn"],
    family: ["Arnwald", "Fennick", "Holt", "Marrow", "Voss", "Drey", "Callow"],
  })),
});
assert.ok(checked.ok, JSON.stringify(checked));
const inputs = {
  kit,
  seed: 31,
  generatorVersion: WORLD_GENERATOR_VERSION,
  grounding: "expand" as const,
  brief: checked.brief,
};
const base: GameWorld = { ...inputs, world: compileGameWorld(inputs) };
const ashford = base.world.places.find((place) => place.name === "Ashford")!;
const millbrook = base.world.places.find((place) => place.name === "Millbrook")!;
// A place that is not a settlement, given a map by hand: walled, floor inside, a wall across the middle
// with no gap on its right part, so the cells right of it are floor the entry cannot reach.
const site =
  base.world.places.find((place) => place.rank === undefined && place.parentId === ashford.id) ??
  base.world.places.find(
    (place) => place.rank === undefined && !base.world.places.some((each) => each.parentId === place.id),
  )!;
assert.ok(site, "a place that is not a settlement");
const [W, H] = [10, 8];
const ground = Array.from({ length: W * H }, (_, cell) => {
  const [x, y] = [cell % W, Math.floor(cell / W)];
  if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return "#";
  if (x === 6) return "#"; // a wall down the map: the cells right of it are cut off
  return ".";
}).join("");
const edits: WorldEdits = worldEditsVersioned({
  editsVersion: 1,
  maps: [{ id: "m1", place: site.id, width: W, height: H, ground, entry: { x: 2, y: 6 } }],
});
const game: GameWorld = { ...base, edits, world: compileGameWorld({ ...base, edits }) };
assert.ok(worldPlaceMap(game, site.id), "the site has its map");

// A town cell the walk from the square reaches, one it does not, and one on a free lot.
const town = worldTown(game, ashford.id)!;
const reach = worldTownReach(town);
const cellOf = (at: number) => ({ x: at % town.width, y: Math.floor(at / town.width) });
const onLot = (x: number, y: number) =>
  town.lots.some((lot) => x >= lot.x && y >= lot.y && x < lot.x + lot.w && y < lot.y + lot.h);
const street = cellOf([...reach].find((at) => !onLot(at % town.width, Math.floor(at / town.width)))!);
const building = town.buildings[0]!;
const freeLot = town.lots.find(
  (lot) =>
    !town.buildings.some(
      (each) => each.x < lot.x + lot.w && lot.x < each.x + each.w && each.y < lot.y + lot.h && lot.y < each.y + each.h,
    ) && reach.has(lot.y * town.width + lot.x),
);

// ── The check ──
assert.equal(storyStepIssue(game, { place: ashford.id, ...street }), null, "a street cell");
assert.match(
  storyStepIssue(game, { place: ashford.id, x: building.x, y: building.y })!,
  /not ground a walk from the square reaches/,
);
assert.match(storyStepIssue(game, { place: ashford.id, x: town.width, y: 0 })!, /is outside Ashford/);
assert.ok(freeLot, "a free lot to test");
assert.match(storyStepIssue(game, { place: ashford.id, x: freeLot!.x, y: freeLot!.y })!, /free lot/);
assert.equal(storyStepIssue(game, { place: site.id, x: 2, y: 3 }), null, "a floor cell of the hand-made map");
assert.match(storyStepIssue(game, { place: site.id, x: 8, y: 3 })!, /not floor a walk from its entry reaches/);
assert.match(storyStepIssue(game, { place: site.id, x: 6, y: 3 })!, /not floor/, "a wall");
assert.match(storyStepIssue(game, { place: site.id, x: W, y: 1 })!, /outside/);
assert.match(storyStepIssue(base, { place: site.id, x: 2, y: 3 })!, /no map made by hand/, "no hand-made map");
assert.match(storyStepIssue(game, { place: "nowhere", x: 0, y: 0 })!, /no place "nowhere"/);

const script = (events: StoryScriptInput["events"]): StoryScriptInput => ({
  storyVersion: 1,
  flags: [
    { id: "lit", kind: "bool", initial: false },
    { id: "visits", kind: "number", initial: 0 },
  ],
  events,
  cutscenes: [{ id: "glow", kind: "beats", beats: ["A lantern flickers on."] }],
});
const refused = checkStoryScript(
  game,
  script([{ id: "bad", when: { on: "step", place: site.id, x: 8, y: 3 }, do: [{ set: "lit", value: true }] }]),
);
assert.ok(
  !refused.ok && refused.issues.some((issue) => /Event "bad": column 9, row 4 of .* is not floor/.test(issue)),
  JSON.stringify(refused),
);

// ── Tripping ──
const read = checkStoryScript(
  game,
  script([
    {
      id: "lantern",
      when: { on: "step", place: site.id, x: 2, y: 3 },
      do: [{ set: "lit", value: true }, { cutscene: "glow" }],
    },
    {
      id: "gate",
      when: { on: "step", place: ashford.id, ...street },
      repeat: true,
      do: [{ add: "visits", amount: 1 }],
    },
    {
      id: "after",
      when: { on: "step", place: site.id, x: 2, y: 3 },
      if: [{ flag: "lit", is: "=", value: true }],
      do: [{ tell: "The lantern is already lit." }],
    },
  ]),
);
assert.ok(read.ok, JSON.stringify(read));
const story = read.story;
const turnOf = (replies: string[], steps: StoryTurnWorld["steps"]) =>
  storyTurn(story, {
    game,
    replies,
    repliesBefore: replies.length,
    latest: replies.at(-1) ?? null,
    told: [],
    day: 0,
    fight: null,
    steps,
  });

assert.deepEqual(turnOf([], []).tripped, [], "no walk, nothing");
assert.deepEqual(turnOf([], [{ place: millbrook.id, ...street }]).tripped, [], "the same numbers in another town");
assert.deepEqual(turnOf([], [{ place: site.id, x: 3, y: 3 }]).tripped, [], "a cell beside it");
const first = turnOf(
  [],
  [
    { place: site.id, x: 2, y: 5 },
    { place: site.id, x: 2, y: 4 },
    { place: site.id, x: 2, y: 3 },
  ],
);
// Walked over (the end cell): the lantern lights; its flag makes "after" hold, so it trips the same turn.
assert.deepEqual(first.tripped, ["lantern", "after"]);
const reply1 = `${first.prepend}\n\nThe party walks in.`;
assert.deepEqual(turnOf([reply1], [{ place: site.id, x: 2, y: 3 }]).tripped, [], "once each, unless it repeats");

// The repeating gate: each turn whose walk goes over it, at most once a turn, even passed twice.
const gate1 = turnOf(
  [],
  [
    { place: ashford.id, ...street },
    { place: ashford.id, ...street },
  ],
);
assert.deepEqual(gate1.tripped, ["gate"]);
const gate2 = turnOf([`${gate1.prepend}\n\nOn.`], [{ place: ashford.id, ...street }]);
assert.deepEqual(gate2.tripped, ["gate"], "again on a later walk");
assert.deepEqual(turnOf([`${gate1.prepend}\n\nOn.`], []).tripped, [], "not on a turn with no walk over it");

// Hand edits that take the cell away are refused on save, naming the event (as any edits that break the story).
const { editsStoryRefusal } = await import("../../packages/server/src/services/game/world-editor.service.js");
assert.equal(editsStoryRefusal(base, edits, story), null, "the edits it was written for");
const noMap = editsStoryRefusal(base, worldEditsVersioned({ editsVersion: 1 }), story);
assert.ok(noMap && /Event "lantern": .* has no map made by hand/.test(noMap.issues.join(" ")), JSON.stringify(noMap));

console.log(
  "Story steps: an event on a town's or a hand-made map's cell is checked, and trips when a walk goes over it.",
);
