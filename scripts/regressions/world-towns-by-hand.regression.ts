/**
 * Towns laid out by hand (worldgen W9h).
 *
 *   - A town's hand layout lives in the world's hand edits: buildings moved between the town's lots (to a
 *     free one, or swapped with the building on it), and its ground painted (street, square, open ground,
 *     a tree, a well), never over a building or the street before its door.
 *   - A moved building keeps its id, its people and who lives and works there; its door is its new lot's,
 *     so a walk across town is timed from there. Buildings never overlap, and every door is on a street.
 *   - A layout is checked when it is saved (each refusal says why), applied as far as it fits when it is
 *     read, and left out on its own when a world file brings one that does not fit. The story's places
 *     still find their lots.
 *   - Editors read a town without its own layout, with its lots, for a game's world and a library one.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  readWorldFile,
  readWorldLedger,
  worldEditsEmpty,
  worldEditsSchema,
  worldFile,
  worldPresent,
  worldTown,
  worldTownEditIssues,
  worldTownMinutes,
  type GameWorld,
  type WorldEdits,
  type WorldTown,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-towns-by-hand-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";

const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
assert.ok(parsed.ok);
const kit = parsed.kit;
const settlementLayer = kit.layers.find((layer) => layer.settlements)!;
const checked = checkWorldBrief(kit, {
  briefVersion: 1,
  premise: "A river kingdom",
  places: [{ name: "Ashford", layer: settlementLayer.id, size: kit.sizes.at(-1)!.id, tags: [], start: true }],
  peopleNames: kit.cultures.map((culture) => ({
    culture: culture.id,
    given: ["Ama", "Tobin", "Hesk", "Mira", "Oswin", "Bryn", "Calla", "Doran"],
    family: ["Holt", "Drey", "Marrow", "Vane"],
  })),
});
assert.ok(checked.ok, JSON.stringify(checked));
const stored = {
  seed: 31,
  generatorVersion: WORLD_GENERATOR_VERSION,
  grounding: "expand" as const,
  brief: checked.brief,
};
const inputs = { kit, ...stored };
const game: GameWorld = { ...inputs, world: compileGameWorld(inputs) };
const ashford = game.world.places.find((place) => place.name === "Ashford")!;
const province = game.world.places.find((place) => place.id === ashford.parentId)!;
const withEdits = (edits: WorldEdits): GameWorld => ({
  ...inputs,
  edits,
  world: compileGameWorld({ ...inputs, edits }),
});
const layer = (town: Record<string, unknown>): WorldEdits =>
  worldEditsSchema.parse({ editsVersion: 1, towns: [{ settlement: ashford.id, ...town }] });

const asMade = worldTown(game, ashford.id)!;
assert.ok(asMade.buildings.length > 6 && asMade.lots.length > asMade.buildings.length, "a town with room");
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const sameRect = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
/** Buildings never overlap, each stands on one of the town's lots, every door is on a street or the square. */
const wellLaidOut = (town: WorldTown) => {
  town.buildings.forEach((building, index) => {
    assert.ok(
      town.lots.some((lot) => sameRect(lot, building)),
      `${building.id} stands on a lot`,
    );
    for (const other of town.buildings.slice(index + 1)) assert.ok(!overlaps(building, other), building.id);
    assert.match(town.ground[building.door.y * town.width + building.door.x]!, /[sq]/, `${building.id}'s door`);
  });
};
wellLaidOut(asMade);
const free = asMade.lots.filter((lot) => asMade.buildings.every((building) => !overlaps(building, lot)));
assert.ok(free.length > 0, "free lots");
const [first, second] = asMade.buildings.filter((building) => building.kind === "home");
assert.ok(first && second);

// ── Moved to a free lot: the same building, its door the lot's, its walks timed from there ──
const target = free[free.length - 1]!;
const moved = worldTown(
  withEdits(layer({ moves: [{ building: first.id, x: target.x, y: target.y, w: target.w }] })),
  ashford.id,
)!;
const movedHome = moved.buildings.find((building) => building.id === first.id)!;
assert.deepEqual(
  { x: movedHome.x, y: movedHome.y, w: movedHome.w, h: movedHome.h, door: movedHome.door },
  { x: target.x, y: target.y, w: target.w, h: target.h, door: target.door },
);
assert.deepEqual(movedHome.people, first.people, "its people with it");
assert.deepEqual(moved.homeOf, asMade.homeOf);
const square = {
  x: asMade.square.x + Math.floor(asMade.square.w / 2),
  y: asMade.square.y + Math.floor(asMade.square.h / 2),
};
assert.equal(
  worldTownMinutes(moved, "square", first.id),
  Math.max(1, Math.round((Math.abs(target.door.x - square.x) + Math.abs(target.door.y - square.y)) / 4)),
);
wellLaidOut(moved);
assert.deepEqual(worldTown(withEdits(layer({ moves: [] })), ashford.id, undefined, { byHand: false }), asMade);

// ── Moved onto another building's lot: the two swap ──
const swapped = worldTown(
  withEdits(layer({ moves: [{ building: first.id, x: second.x, y: second.y, w: second.w }] })),
  ashford.id,
)!;
const [a, b] = [first.id, second.id].map((id) => swapped.buildings.find((building) => building.id === id)!);
assert.ok(sameRect(a!, second) && sameRect(b!, first));
assert.deepEqual([a!.door, b!.door], [second.door, first.door]);
wellLaidOut(swapped);

// ── The ground painted, never over a building or a door ──
const openCells = [...asMade.ground]
  .map((cell, index) => ({ cell, index }))
  .filter(
    ({ cell, index }) =>
      cell === "." &&
      asMade.buildings.every((building) => {
        const x = index % asMade.width;
        const y = Math.floor(index / asMade.width);
        return !overlaps(building, { x, y, w: 1, h: 1 });
      }),
  )
  .map(({ index }) => index);
const paint = (marks: Record<number, string>) =>
  Array.from({ length: asMade.ground.length }, (_, index) => marks[index] ?? ".").join("");
const [treeAt, wellAt, streetAt] = openCells;
const painted = worldTown(
  withEdits(layer({ ground: paint({ [treeAt!]: "t", [wellAt!]: "w", [streetAt!]: "s" }) })),
  ashford.id,
)!;
assert.deepEqual([painted.ground[treeAt!], painted.ground[wellAt!], painted.ground[streetAt!]], ["t", "w", "s"]);
assert.ok(
  [...painted.ground].every(
    (cell, index) => [treeAt, wellAt, streetAt].includes(index) || cell === asMade.ground[index],
  ),
  "and nothing else",
);
wellLaidOut(painted);

// ── A building moves again; swaps chain ──
const third = asMade.buildings.find(
  (building) => building.kind === "home" && building !== first && building !== second,
)!;
const byId = (town: WorldTown, id: string) => town.buildings.find((building) => building.id === id)!;
// The first to the free lot, then onto the second's lot: it ends there, the second where the first went.
const again = worldTown(
  withEdits(
    layer({
      moves: [
        { building: first.id, x: target.x, y: target.y, w: target.w },
        { building: first.id, x: second.x, y: second.y, w: second.w },
      ],
    }),
  ),
  ashford.id,
)!;
assert.ok(sameRect(byId(again, first.id), second) && sameRect(byId(again, second.id), target), "moved again");
wellLaidOut(again);
// The first onto the second's lot, then the second (now on the first's) onto the third's.
const chained = worldTown(
  withEdits(
    layer({
      moves: [
        { building: first.id, x: second.x, y: second.y, w: second.w },
        { building: second.id, x: third.x, y: third.y, w: third.w },
      ],
    }),
  ),
  ashford.id,
)!;
assert.ok(
  sameRect(byId(chained, first.id), second) &&
    sameRect(byId(chained, second.id), third) &&
    sameRect(byId(chained, third.id), first),
  "a chain of swaps",
);
wellLaidOut(chained);

// ── Two lots can share a corner: the width says which ──
const starterWorld = (kitId: string, seed: number): GameWorld => {
  const starter = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === kitId)!);
  assert.ok(starter.ok);
  const checkedBrief = checkWorldBrief(starter.kit, { briefVersion: 1, premise: "x" });
  assert.ok(checkedBrief.ok);
  const here = { kit: starter.kit, seed, grounding: "expand" as const, brief: checkedBrief.brief };
  return { ...here, world: compileGameWorld(here) };
};
const sharing = (() => {
  for (const each of WORLD_STARTER_KITS) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const world = starterWorld(each.id, seed);
      for (const place of world.world.places.filter((one) => one.rank !== undefined)) {
        const town = worldTown(world, place.id)!;
        const pair = town.lots.find((lot, index) =>
          town.lots.some((other, at) => at !== index && other.x === lot.x && other.y === lot.y),
        );
        if (!pair) continue;
        const lots = town.lots.filter((lot) => lot.x === pair.x && lot.y === pair.y);
        // Whatever stands on the pair stands on one of them exactly, and can be moved off to a lot apart.
        const occupants = town.buildings.filter((building) => lots.some((lot) => overlaps(building, lot)));
        if (!occupants.every((building) => lots.some((lot) => sameRect(building, lot)))) continue;
        const away = town.lots.filter(
          (lot) =>
            town.buildings.every((building) => !overlaps(building, lot)) && lots.every((one) => !overlaps(one, lot)),
        );
        if (away.length < occupants.length) continue;
        return { world, town, settlement: place.id, lots, occupants, away };
      }
    }
  }
  return null;
})();
assert.ok(sharing, "two lots sharing a corner somewhere among the starter worlds");
{
  const { world, town, settlement, lots, occupants, away } = sharing;
  assert.equal(new Set(lots.map((lot) => lot.w)).size, lots.length, "told apart by their widths");
  const clear = occupants.map((building, index) => ({
    building: building.id,
    x: away[index]!.x,
    y: away[index]!.y,
    w: away[index]!.w,
  }));
  const mover = town.buildings.find((building) => !occupants.includes(building))!;
  for (const lot of lots) {
    const entry = { settlement, moves: [...clear, { building: mover.id, x: lot.x, y: lot.y, w: lot.w }] };
    const laid = worldTown(
      { ...world, edits: worldEditsSchema.parse({ editsVersion: 1, towns: [entry] }) },
      settlement,
    )!;
    assert.ok(sameRect(byId(laid, mover.id), lot), `the lot ${lot.w} wide`);
    wellLaidOut(laid);
  }
}

// ── Every starter world's towns, moved and painted at random, stay well laid out ──
{
  let state = 20261003;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  let layouts = 0;
  for (const each of WORLD_STARTER_KITS) {
    for (const seed of [7, 8]) {
      const world = starterWorld(each.id, seed);
      for (const place of world.world.places.filter((one) => one.rank !== undefined).slice(0, 4)) {
        const town = worldTown(world, place.id)!;
        const moves = Array.from({ length: 1 + Math.floor(random() * 12) }, () => {
          const lot = pick(town.lots);
          return { building: pick(town.buildings).id, x: lot.x, y: lot.y, w: lot.w };
        });
        const ground = Array.from({ length: town.ground.length }, () =>
          random() < 0.3 ? pick([..."sqotw"]) : ".",
        ).join("");
        const edits = worldEditsSchema.parse({ editsVersion: 1, towns: [{ settlement: place.id, moves, ground }] });
        const laid = worldTown({ ...world, edits }, place.id)!;
        wellLaidOut(laid);
        for (const building of laid.buildings)
          for (let y = building.y; y < building.y + building.h; y++)
            for (let x = building.x; x < building.x + building.w; x++)
              assert.equal(
                laid.ground[y * laid.width + x],
                town.ground[y * town.width + x],
                "under a roof, as laid out",
              );
        assert.deepEqual(worldTownEditIssues(world, edits), worldTownEditIssues(world, edits), "the same issues twice");
        layouts++;
      }
    }
  }
  assert.ok(layouts > 30, `${layouts} layouts`);
}

// ── Every lot a building may be moved to is clear of the streets and the square ──
for (const lot of asMade.lots) {
  for (let y = lot.y; y < lot.y + lot.h; y++)
    for (let x = lot.x; x < lot.x + lot.w; x++)
      assert.equal(asMade.ground[y * asMade.width + x], ".", "a lot on open ground");
}

// ── A market's stalls are never painted over ──
{
  const marketBrief = checkWorldBrief(kit, {
    briefVersion: 1,
    premise: "A market town",
    places: [
      { name: "Marketon", layer: settlementLayer.id, size: kit.sizes.at(-1)!.id, tags: ["market"], start: true },
    ],
  });
  assert.ok(marketBrief.ok);
  const here = { kit, seed: 5, grounding: "expand" as const, brief: marketBrief.brief };
  const market: GameWorld = { ...here, world: compileGameWorld(here) };
  const marketon = market.world.places.find((place) => place.name === "Marketon")!;
  const town = worldTown(market, marketon.id)!;
  assert.ok(town.stalls.length > 0, "stalls in the square");
  const overStalls = Array.from({ length: town.ground.length }, (_, index) =>
    town.stalls.some((stall) => stall.y * town.width + stall.x === index) ? "t" : ".",
  ).join("");
  const entry = worldEditsSchema.parse({ editsVersion: 1, towns: [{ settlement: marketon.id, ground: overStalls }] });
  assert.match(worldTownEditIssues(market, entry)[0]!, /or a stall is painted over/);
  const laid = worldTown({ ...market, edits: entry }, marketon.id)!;
  for (const stall of town.stalls)
    assert.equal(laid.ground[stall.y * town.width + stall.x], town.ground[stall.y * town.width + stall.x], "a stall");
}

// ── Each refusal says why ──
const issues = (town: Record<string, unknown>) => worldTownEditIssues(game, layer(town));
const roof = first.y * asMade.width + first.x;
const door = first.door.y * asMade.width + first.door.x;
assert.deepEqual(issues({ moves: [{ building: first.id, x: target.x, y: target.y, w: target.w }] }), []);
assert.deepEqual(issues({ moves: [{ building: "h999", x: target.x, y: target.y, w: target.w }] }), [
  'Ashford: no building "h999" in town.',
]);
assert.deepEqual(issues({ moves: [{ building: first.id, x: 0, y: 0, w: 4 }] }), [
  "Ashford: no lot 4 wide at column 1, row 1.",
]);
const partly = asMade.lots.find((lot) =>
  asMade.buildings.some((building) => overlaps(building, lot) && !sameRect(building, lot)),
);
assert.ok(partly, "a lot partly under a building");
assert.match(issues({ moves: [{ building: first.id, x: partly.x, y: partly.y, w: partly.w }] })[0]!, /is partly under/);
assert.deepEqual(issues({ ground: "t" }), [
  `Ashford: the painted ground has 1 cell; the town has ${asMade.ground.length}.`,
]);
// The middle of the square (its well, where walks to it end) is never painted.
const middle =
  (asMade.square.y + Math.floor(asMade.square.h / 2)) * asMade.width +
  asMade.square.x +
  Math.floor(asMade.square.w / 2);
assert.match(issues({ ground: paint({ [middle]: "t" }) })[0]!, /the middle of the square or a stall is painted over/);
assert.match(
  issues({ ground: paint({ [roof]: "t" }) })[0]!,
  /a building, the street before a door, the middle of the square or a stall is painted over/,
);
assert.match(issues({ ground: paint({ [door]: "o" }) })[0]!, /painted over at column \d+, row \d+/);
assert.deepEqual(
  worldTownEditIssues(game, worldEditsSchema.parse({ editsVersion: 1, towns: [{ settlement: province.id }] })),
  [`No settlement "${province.id}" to lay out.`],
);
assert.match(
  worldTownEditIssues(
    game,
    worldEditsSchema.parse({ editsVersion: 1, towns: [{ settlement: ashford.id }, { settlement: ashford.id }] }),
  ).join(" "),
  /laid out twice/,
);
assert.ok(!worldEditsSchema.safeParse({ editsVersion: 1, towns: [{ settlement: ashford.id, ground: "x" }] }).success);
assert.equal(worldEditsEmpty(layer({ ground: "" })), false, "a layer of a town alone is kept");
// A layout that no longer fits is applied as far as it does: the move, but not the paint on a roof.
const secondRoof = second.y * asMade.width + second.x;
const partlyFits = worldTown(
  withEdits(
    layer({
      moves: [{ building: first.id, x: target.x, y: target.y, w: target.w }],
      ground: paint({ [secondRoof]: "t", [treeAt!]: "t" }),
    }),
  ),
  ashford.id,
)!;
assert.ok(
  sameRect(
    partlyFits.buildings.find((building) => building.id === first.id)!,
    target,
  ),
);
assert.equal(partlyFits.ground[treeAt!], "t");
assert.equal(partlyFits.ground[secondRoof], asMade.ground[secondRoof], "never under a roof");

// ── The story's places still find their lots, the hand layout holding ──
const present = worldPresent(game, readWorldLedger([`[world: fact="place" name="The Gull" in="Ashford" result="ok"]`]));
const storied = worldTown(
  withEdits(layer({ moves: [{ building: first.id, x: target.x, y: target.y, w: target.w }] })),
  ashford.id,
  present,
)!;
assert.ok(
  storied.buildings.some((building) => building.name === "The Gull"),
  "the story's place is in town",
);
assert.ok(
  sameRect(
    storied.buildings.find((building) => building.id === first.id)!,
    target,
  ),
  "the move holds",
);
wellLaidOut(storied);
// Paint over where the story's place stands is never applied to it.
const gull = storied.buildings.find((building) => building.name === "The Gull")!;
const underGull: Record<number, string> = {};
for (let y = gull.y; y < gull.y + gull.h; y++)
  for (let x = gull.x; x < gull.x + gull.w; x++) underGull[y * asMade.width + x] = "t";
const storiedPainted = worldTown(withEdits(layer({ ground: paint(underGull) })), ashford.id, present)!;
assert.ok(
  Object.keys(underGull).every((cell) => storiedPainted.ground[Number(cell)] !== "t"),
  "the story's roof",
);

// ── A world file brings a layout that does not fit: it is left out, alone ──
const renamed = { id: ashford.id, name: "Ashford Keep" };
const unfitLayer = worldEditsSchema.parse({
  editsVersion: 1,
  places: [renamed],
  towns: [{ settlement: ashford.id, moves: [{ building: "h999", x: 1, y: 1, w: 4 }] }],
});
const unfitFile = readWorldFile(JSON.stringify(worldFile("Unfit", kit, { ...stored, edits: unfitLayer })));
assert.ok(unfitFile.ok);
assert.deepEqual(unfitFile.world.edits, { editsVersion: 1, places: [renamed] });
assert.match(
  unfitFile.notes[0]!,
  /A town laid out by hand does not fit it, so it was left out: Ashford Keep: no building "h999"/,
);

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { gameWorldsRoutes } = await import("../../packages/server/src/routes/game-worlds.routes.js");

try {
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  await app.register(gameWorldsRoutes, { prefix: "/api/game-worlds" });
  try {
    const chats = createChatsStorage(db);
    const chat = await chats.create({ name: "Towns", mode: "game", characterIds: [] });
    await chats.patchMetadata(chat.id, { gameWorldKit: kit, gameWorld: stored });
    const save = (towns: unknown[]) =>
      app.inject({
        method: "PUT",
        url: `/api/game/${chat.id}/world/edits`,
        payload: { edits: { editsVersion: 1, towns } },
      });
    const layout = {
      settlement: ashford.id,
      moves: [{ building: first.id, x: target.x, y: target.y, w: target.w }],
      ground: paint({ [treeAt!]: "t" }),
    };

    // Refused with the reason; saved; the play view lays the town out by hand.
    const refusedSave = await save([{ settlement: ashford.id, moves: [{ building: "h999", x: 1, y: 1, w: 4 }] }]);
    assert.equal(refusedSave.statusCode, 400);
    assert.match(refusedSave.json().error, /Ashford: no building "h999" in town/);
    assert.equal((await save([layout])).statusCode, 200);
    const played = (await app.inject({ method: "GET", url: `/api/game/${chat.id}/town` })).json().town as WorldTown;
    assert.ok(
      sameRect(
        played.buildings.find((building) => building.id === first.id)!,
        target,
      ),
    );
    assert.equal(played.ground[treeAt!], "t");

    // The editor's town: as laid out without its own layout, with its lots, and that layout.
    const forEditor = (
      await app.inject({ method: "GET", url: `/api/game/${chat.id}/world/town?settlement=${ashford.id}` })
    ).json();
    assert.deepEqual(forEditor.layout, layout);
    assert.deepEqual(forEditor.town.buildings, asMade.buildings);
    assert.deepEqual(forEditor.town.lots, asMade.lots);
    assert.equal(forEditor.town.people, undefined, "no townsfolk sent to the editor");
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/game/${chat.id}/world/town?settlement=${province.id}` }))
        .statusCode,
      404,
    );

    // It travels with the world: its file, and a library world made from it.
    const fileText = JSON.stringify(
      (await app.inject({ method: "GET", url: `/api/game/${chat.id}/world/file` })).json(),
    );
    const file = readWorldFile(fileText);
    assert.ok(file.ok && file.notes.length === 0, JSON.stringify(file));
    assert.deepEqual(file.world.edits?.towns, [layout]);
    const kept = await app.inject({ method: "POST", url: "/api/game-worlds/import", payload: { text: fileText } });
    assert.equal(kept.statusCode, 200, kept.body);
    const libraryTown = (
      await app.inject({
        method: "GET",
        url: `/api/game-worlds/${kept.json().world.id}/world/town?settlement=${ashford.id}`,
      })
    ).json();
    assert.deepEqual(libraryTown.layout, layout);
    // A library world's rooms (worldgen W13b) open in a room editor as a game's do.
    const home = libraryTown.town.buildings.find((building: { kind: string }) => building.kind === "home");
    const libraryRooms = await app.inject({
      method: "GET",
      url: `/api/game-worlds/${kept.json().world.id}/world/interior?settlement=${ashford.id}&building=${home.id}`,
    });
    assert.equal(libraryRooms.statusCode, 200, libraryRooms.body);
    assert.equal(libraryRooms.json().interior.use, "home");
    assert.equal(libraryRooms.json().edit, null);
    assert.deepEqual([libraryTown.town.lots, libraryTown.town.buildings], [asMade.lots, asMade.buildings]);
    const libraryRefused = await app.inject({
      method: "PUT",
      url: `/api/game-worlds/${kept.json().world.id}/world/edits`,
      payload: { edits: { editsVersion: 1, towns: [{ settlement: ashford.id, ground: "t" }] } },
    });
    assert.equal(libraryRefused.statusCode, 400);
    assert.match(libraryRefused.json().error, /the painted ground has 1 cell;/);

    // A new game is set up with a town laid out that does not fit: refused, with the reason.
    const setUp = await app.inject({
      method: "POST",
      url: "/api/game/create",
      payload: {
        name: "Unfit town",
        setupConfig: {
          genre: "Fantasy",
          setting: "A river kingdom",
          tone: "Grim",
          difficulty: "normal",
          rating: "sfw",
          playerGoals: "",
          gmMode: "standalone",
          partyCharacterIds: [],
          worldKit: kit,
          world: { ...stored, edits: { editsVersion: 1, towns: [{ settlement: ashford.id, ground: "t" }] } },
        },
      },
    });
    assert.equal(setUp.statusCode, 400, setUp.body);
    assert.match(setUp.body, /the painted ground has 1 cell/);
  } finally {
    await app.close();
    await closeDB();
  }
  console.log("Towns by hand: buildings moved and swapped, ground painted, checked, kept with the world.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
