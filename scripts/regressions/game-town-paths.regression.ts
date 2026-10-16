/**
 * Walks across town (map editor Phase 2, the Game Mode side): the shortest four-way way between two
 * spots' doors on the streets, the square and paths, else across open ground, never through a building,
 * a tree, a well, water or a hedge; the old L when a door is boxed in. The minutes are the way's
 * cells, and every starter world's towns are walked on their streets.
 */
import assert from "node:assert/strict";

import {
  WORLD_STARTER_KITS,
  WORLD_TOWN_CELLS_PER_MINUTE,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  worldTown,
  worldTownDoor,
  worldTownMinutes,
  worldTownPath,
  type GameWorld,
  type WorldTown,
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

const stepsOk = (start: { x: number; y: number }, path: Array<{ x: number; y: number }>, label: string) => {
  let at = start;
  for (const step of path) {
    assert.equal(Math.abs(step.x - at.x) + Math.abs(step.y - at.y), 1, `${label}: one cell a step`);
    at = step;
  }
};

// ── Every starter world's towns: on the streets, round the buildings ──
for (const kit of WORLD_STARTER_KITS) {
  const game = gameOf(kit.id, 31);
  for (const settlement of game.world.places.filter((place) => place.rank !== undefined)) {
    const town = worldTown(game, settlement.id)!;
    const label = `${kit.id} ${settlement.name}`;
    const standing = new Set<number>();
    for (const building of town.buildings)
      for (let y = building.y; y < building.y + building.h; y++)
        for (let x = building.x; x < building.x + building.w; x++) standing.add(y * town.width + x);
    for (const building of town.buildings) {
      const path = worldTownPath(town, "square", building.id)!;
      const [from, to] = [worldTownDoor(town, "square")!, building.door];
      assert.ok(path, `${label}: a way to ${building.id}`);
      stepsOk(from, path, label);
      assert.deepEqual(path.at(-1), to, `${label}: ends at the door`);
      assert.ok(
        path.length >= Math.abs(to.x - from.x) + Math.abs(to.y - from.y),
        `${label}: never shorter than straight`,
      );
      for (const cell of path.slice(0, -1)) {
        const index = cell.y * town.width + cell.x;
        assert.ok(!standing.has(index), `${label}: never through a building`);
        assert.match(town.ground[index]!, /[sqo]/u, `${label}: on the streets and the square`);
      }
      assert.equal(worldTownPath(town, building.id, "square")!.length, path.length, `${label}: as far back as there`);
      assert.equal(
        worldTownMinutes(town, "square", building.id),
        Math.max(1, Math.round(path.length / WORLD_TOWN_CELLS_PER_MINUTE)),
      );
    }
  }
}

// ── A town drawn by hand: round a building, round a tree, over a bridge, and the old L when boxed in ──
const townOf = (rows: string[], buildings: WorldTown["buildings"] = []): WorldTown => ({
  settlementId: "s1",
  width: rows[0]!.length,
  height: rows.length,
  ground: rows.join(""),
  square: { x: 0, y: 0, w: 1, h: 1 },
  buildings,
  homeOf: {},
  workOf: {},
  people: [],
  stalls: [],
  lots: [],
});
const house = (id: string, x: number, y: number, door: { x: number; y: number }) => ({
  id,
  kind: "home" as const,
  x,
  y,
  w: 1,
  h: 1,
  door,
  people: [],
});
// The square's middle is (0, 0); a house stands at (2, 0), its door at (4, 0).
const ring = townOf(["s....", "sssss"], [house("h1", 2, 0, { x: 4, y: 0 })]);
const roundIt = worldTownPath(ring, "square", "h1")!;
stepsOk({ x: 0, y: 0 }, roundIt, "ring");
assert.equal(roundIt.length, 6, "down, along the street and up: not across the open ground");
assert.ok(!roundIt.some((cell) => cell.x === 2 && cell.y === 0), "never through the house");
assert.equal(worldTownMinutes(ring, "square", "h1"), 2);

// A tree on the street: round it over the open ground.
const treed = townOf(["s....", "sstss", "....."], [house("h1", 2, 0, { x: 4, y: 0 })]);
const roundTree = worldTownPath(treed, "square", "h1")!;
stepsOk({ x: 0, y: 0 }, roundTree, "tree");
assert.ok(!roundTree.some((cell) => cell.x === 2 && cell.y === 1), "never through the tree");
assert.ok(!roundTree.some((cell) => cell.x === 2 && cell.y === 0), "nor the house");

// Water blocks, a bridge crosses it, a hedge blocks, a path is walked first.
const river = townOf(["s~ss", "s~ss", "sbss"], [house("h1", 3, 0, { x: 2, y: 0 })]);
const overBridge = worldTownPath(river, "square", "h1")!;
stepsOk({ x: 0, y: 0 }, overBridge, "river");
assert.ok(
  overBridge.some((cell) => cell.x === 1 && cell.y === 2),
  "over the bridge",
);
assert.ok(
  overBridge.every((cell) => river.ground[cell.y * 4 + cell.x] !== "~"),
  "never through water",
);
const hedged = townOf(["sphs", "sphs", "ssss", "s..."], [house("h1", 2, 3, { x: 3, y: 0 })]);
const roundHedge = worldTownPath(hedged, "square", "h1")!;
stepsOk({ x: 0, y: 0 }, roundHedge, "hedge");
assert.equal(roundHedge.length, 7);
assert.ok(
  roundHedge.every((cell) => hedged.ground[cell.y * 4 + cell.x] !== "h"),
  "never through a hedge",
);

// Off the streets, open ground is walked round water, never through it.
const pond = townOf(["sts", "s~s", "s.s", "..."], [house("h1", 1, 3, { x: 2, y: 0 })]);
const roundPond = worldTownPath(pond, "square", "h1")!;
stepsOk({ x: 0, y: 0 }, roundPond, "pond");
assert.equal(roundPond.length, 6, "round the pond, not across it");

// Boxed in: the old way, along the row then down the column.
const boxed = townOf(["sw...", "ww...", "....s"], [house("h1", 3, 0, { x: 4, y: 2 })]);
assert.deepEqual(
  worldTownPath(boxed, "square", "h1"),
  [
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 3, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 1 },
    { x: 4, y: 2 },
  ],
  "a door boxed in still has a way: the old L",
);
assert.deepEqual(worldTownPath(ring, "h1", "h1"), [], "already there");
assert.equal(worldTownPath(ring, "square", "nowhere"), null);
assert.equal(worldTownMinutes(ring, "square", "nowhere"), 1);

console.log("Town paths: on the streets, round buildings, trees, water and hedges, and the old L when boxed in.");
