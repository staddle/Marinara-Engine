/**
 * Inside buildings (worldgen W13).
 *
 *   - Every building in every starter world's towns has rooms that hold together: walls round them, the
 *     way out in the main room's bottom wall, furniture only on the floor and never on a doorway, every
 *     room and everyone's spot reachable from the way in, a bed for each person who lives there and a
 *     spot for each person who works there (up to the most a building seats).
 *   - The same building gives the same rooms, and the rooms are pinned: a change to how they lay out must
 *     bump WORLD_INTERIOR_VERSION (rooms are laid out when asked for, not kept in a world's snapshot).
 *   - A part of town (a quarter, a district, a neighbourhood) has no rooms.
 *   - What a building is furnished as follows its trade, tags and name, across settings.
 *   - A tavern's people keep it in the evening; at dusk the rest of the town is in the square, a tavern
 *     or home; by day and at night nothing changed.
 *   - The rooms come through their route, and a walk's next turn tells the Game Master what is inside, in
 *     the setting's words.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_INTERIOR_VERSION,
  WORLD_STARTER_KITS,
  WORLD_TILE_IDS,
  WORLD_FURNITURE,
  checkWorldBrief,
  compileGameWorld,
  createConnectionSchema,
  layOutInterior,
  parseWorldKit,
  worldBuildingHasRooms,
  worldInterior,
  worldInteriorPeopleAt,
  worldInteriorUse,
  worldInteriorWords,
  worldTown,
  worldTownWhere,
  worldEditsEmpty,
  worldEditsVersioned,
  worldEditsSchema,
  worldInteriorEditIssues,
  WORLD_HAND_ROOM_MAX,
  type GameWorld,
  type WorldInterior,
  type WorldTown,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-interiors-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");

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

/** Checks one building's rooms hold together; returns nothing, throws on the first fault. */
function checkRooms(town: WorldTown, interior: WorldInterior, label: string): void {
  const { width, height, ground } = interior;
  assert.equal(ground.length, width * height, `${label}: the rooms fill the building`);
  const at = (x: number, y: number) => ground[y * width + x];
  for (let x = 0; x < width; x++) {
    assert.ok(at(x, 0) === "#", `${label}: walled along the top`);
    assert.ok(at(x, height - 1) === "#" || at(x, height - 1) === "D", `${label}: walled along the bottom`);
  }
  for (let y = 0; y < height; y++) assert.ok(at(0, y) === "#" && at(width - 1, y) === "#", `${label}: walled sides`);
  assert.equal(at(interior.door.x, interior.door.y), "D", `${label}: the way out is marked`);
  assert.equal(interior.door.y, height - 1, `${label}: the way out is in the bottom wall`);
  assert.equal([...ground].filter((c) => c === "D").length, 1, `${label}: one way out`);
  const main = interior.rooms[0]!;
  assert.equal(main.use, "main");
  assert.ok(interior.door.x >= main.x && interior.door.x < main.x + main.w, `${label}: out of the main room`);
  const pieces = new Map<number, string>();
  for (const piece of interior.furniture) {
    assert.ok(WORLD_FURNITURE.includes(piece.kind), `${label}: a known piece`);
    assert.equal(at(piece.x, piece.y), ".", `${label}: ${piece.kind} on the floor`);
    const cell = piece.y * width + piece.x;
    assert.ok(!pieces.has(cell), `${label}: two pieces in one place`);
    pieces.set(cell, piece.kind);
  }
  // Reachable from the step inside the way out, over floor nothing stands on.
  const seen = new Set<number>();
  const queue = [(interior.door.y - 1) * width + interior.door.x];
  assert.ok(!pieces.has(queue[0]!), `${label}: the way in is clear`);
  while (queue.length) {
    const cell = queue.pop()!;
    if (seen.has(cell)) continue;
    seen.add(cell);
    const [x, y] = [cell % width, Math.floor(cell / width)];
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      const next = ny * width + nx;
      const c = at(nx, ny);
      if ((c === "." || c === "d") && !pieces.has(next)) queue.push(next);
    }
  }
  const reachable = (x: number, y: number) =>
    seen.has(y * width + x) ||
    [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ].some(([nx, ny]) => seen.has(ny! * width + nx!));
  for (const room of interior.rooms) {
    let any = false;
    for (let y = room.y; y < room.y + room.h && !any; y++)
      for (let x = room.x; x < room.x + room.w && !any; x++) any = seen.has(y * width + x);
    assert.ok(any, `${label}: the ${room.use} room is reachable`);
  }
  for (const [id, seat] of Object.entries(interior.seats)) {
    assert.equal(at(seat.x, seat.y), ".", `${label}: ${id}'s spot is on the floor`);
    const on = pieces.get(seat.y * width + seat.x);
    assert.ok(on === undefined || on === "bed", `${label}: ${id} stands on nothing but a bed`);
    assert.ok(reachable(seat.x, seat.y), `${label}: ${id}'s spot is reachable`);
  }
  // Each resident has a bed and each worker a spot, up to the most a building seats (eight of each).
  const building = town.buildings.find((each) => each.id === interior.buildingId)!;
  const residents = building.people.filter((id) => town.homeOf[id] === building.id).slice(0, 8);
  for (const id of residents) {
    const seat = interior.seats[id];
    assert.ok(seat, `${label}: ${id} has a bed`);
    assert.equal(pieces.get(seat.y * width + seat.x), "bed", `${label}: ${id} sleeps in a bed`);
  }
  const workers = building.people
    .filter((id) => town.workOf[id] === building.id || (town.homeOf[id] !== building.id && building.kind !== "home"))
    .slice(0, 8);
  for (const id of workers) assert.ok(interior.seats[id], `${label}: ${id} has a spot`);
}

try {
  // ── Every building of every starter world, laid out ──
  const pinned = createHash("sha256");
  let buildings = 0;
  for (const kit of WORLD_STARTER_KITS) {
    const game = gameOf(kit.id, 31);
    for (const settlement of game.world.places.filter((place) => place.rank !== undefined)) {
      const town = worldTown(game, settlement.id)!;
      for (const building of town.buildings) {
        const label = `${kit.id} ${settlement.name} ${building.id}`;
        const interior = layOutInterior(game, town, building);
        assert.deepEqual(layOutInterior(game, town, building), interior, `${label}: the same rooms each time`);
        checkRooms(town, interior, label);
        pinned.update(JSON.stringify(interior));
        buildings++;
        // A part of town has none; every other building has these rooms.
        const rooms = worldInterior(game, town, building.id);
        if (worldBuildingHasRooms(game, building)) assert.deepEqual(rooms, interior, label);
        else assert.equal(rooms, null, `${label}: a part of town has no rooms`);
      }
    }
  }
  assert.ok(buildings > 500, "many buildings checked");
  assert.equal(
    `${WORLD_INTERIOR_VERSION}:${pinned.digest("hex").slice(0, 16)}`,
    "1:8cb23466b308b9b9",
    "the rooms changed: bump WORLD_INTERIOR_VERSION and pin the new digest",
  );

  // ── Parts of town have no rooms; a story's tavern does ──
  const modern = gameOf("modern_day", 31);
  const city = modern.world.places.find(
    (place) => place.rank !== undefined && worldTown(modern, place.id)!.buildings.some((b) => b.kind === "place"),
  )!;
  const modernTown = worldTown(modern, city.id)!;
  const neighbourhood = modernTown.buildings.find((building) => building.kind === "place")!;
  assert.equal(worldInterior(modern, modernTown, neighbourhood.id), null, "a neighbourhood has no rooms");
  assert.equal(neighbourhood.use, undefined, "and no use, so the evening never takes anyone there");
  const named = (name: string) =>
    worldBuildingHasRooms(modern, {
      id: "x",
      kind: "place",
      x: 0,
      y: 0,
      w: 4,
      h: 3,
      door: { x: 0, y: 0 },
      people: [],
      name,
    });
  assert.equal(named("The Old Quarter"), false, "a story's quarter has no rooms");
  assert.equal(named("The Harbour Inn"), true, "a story's inn has");
  assert.equal(named("Mother Agatha's"), true, "a plain name has");

  // ── A place's tags decide what it is furnished as, and the evening follows ──
  {
    const parsedCyber = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "cyberpunk")!);
    assert.ok(parsedCyber.ok);
    const briefed = checkWorldBrief(parsedCyber.kit, { briefVersion: 1, premise: "x" });
    assert.ok(briefed.ok);
    const base = { kit: parsedCyber.kit, seed: 5, grounding: "expand" as const, brief: briefed.brief };
    const stack = compileGameWorld(base).places.find((place) => (place.rank ?? 0) >= 2)!;
    // A building with a plain name; only its tag says it is a club.
    const edits = {
      editsVersion: 1 as const,
      added: [
        { id: "e1", name: "The Neon Lotus", layer: "building", parentId: stack.id, at: stack.at, tags: ["club"] },
      ],
    };
    const cyber: GameWorld = { ...base, edits, world: compileGameWorld({ ...base, edits }) };
    const cyberTown = worldTown(cyber, stack.id)!;
    const club = cyberTown.buildings.find((building) => building.placeId === "e1")!;
    assert.equal(worldInteriorUse({ kind: "place", name: club.name }), "hall", "(its name alone says nothing)");
    assert.equal(club.use, "tavern", "its tag makes it a tavern");
    assert.equal(worldInterior(cyber, cyberTown, club.id)!.use, "tavern");
    const keeper = club.people.find((id) => cyberTown.workOf[id] === club.id)!;
    assert.ok(keeper, "(someone keeps it)");
    assert.equal(worldTownWhere(cyberTown, keeper, 19), club.id, "its keepers keep it in the evening");
  }

  // ── Furnished for what it is, across settings ──
  const use = (role: string, tags: string[] = []) => worldInteriorUse({ kind: "work", role }, tags);
  const expected: Array<[string, string]> = [
    ["innkeeper", "tavern"],
    ["teahouse keeper", "tavern"],
    ["bartender", "tavern"],
    ["noodle cook", "tavern"],
    ["capsule hotel clerk", "tavern"],
    ["priest", "worship"],
    ["monk", "worship"],
    ["priest of an order", "worship"],
    ["physician", "clinic"],
    ["herbalist", "clinic"],
    ["ripperdoc", "clinic"],
    ["medic", "clinic"],
    ["constable", "guard"],
    ["security guard", "guard"],
    ["frontier marshal", "guard"],
    ["police officer", "guard"],
    ["scholar", "study"],
    ["researcher", "study"],
    ["librarian", "study"],
    ["smith", "workshop"],
    ["blacksmith", "workshop"],
    ["mechanic", "workshop"],
    ["engineer", "workshop"],
    ["merchant", "shop"],
    ["street vendor", "shop"],
    ["shopkeeper", "shop"],
    ["shop clerk", "shop"],
    ["sect disciple", "training"],
    ["farmer", "store"],
    ["fisher", "store"],
    ["miner", "store"],
    ["scavenger", "store"],
    ["bard", "workroom"],
  ];
  for (const [role, kind] of expected) assert.equal(use(role), kind, `${role} works in a ${kind}`);
  // Accents do not hide a word: a café is a tavern.
  assert.equal(use("café owner"), "tavern");
  assert.equal(worldInteriorUse({ kind: "place", name: "Café Noir" }), "tavern");
  // Whole words only: a barber is no bar, an inner court no inn, the Forgotten no forge.
  assert.equal(use("barber"), "shop");
  assert.equal(use("inner court steward"), "workroom");
  assert.equal(worldInteriorUse({ kind: "place", name: "The Forgotten Hall" }), "hall");
  // Tags speak first: a place tagged an inn is a tavern whatever its name.
  assert.equal(worldInteriorUse({ kind: "place", name: "The Golden Goose Smithy" }, ["inn"]), "tavern");
  assert.equal(worldInteriorUse({ kind: "home" }), "home");
  assert.equal(worldInteriorUse({ kind: "landmark" }), "hall");

  // ── The tiles ──
  for (const id of ["in_floor", "in_wall", "in_door", ...WORLD_FURNITURE.map((kind) => `in_${kind}`)])
    assert.ok((WORLD_TILE_IDS as readonly string[]).includes(id), `${id} is a world tile`);

  // ── The evening ──
  const fantasy = gameOf("wuxia_xianxia", 31);
  let tavernTown: WorldTown | undefined;
  for (const place of fantasy.world.places.filter((each) => each.rank !== undefined)) {
    const town = worldTown(fantasy, place.id)!;
    if (town.buildings.some((b) => b.kind !== "home" && worldInteriorUse(b) === "tavern")) tavernTown = town;
  }
  assert.ok(tavernTown, "a town with a tavern");
  const tavern = tavernTown.buildings.find((b) => b.kind !== "home" && worldInteriorUse(b) === "tavern")!;
  const keeper = tavern.people.find((id) => tavernTown!.workOf[id] === tavern.id);
  if (keeper) {
    for (const hour of [11, 15, 19, 23])
      assert.equal(worldTownWhere(tavernTown, keeper, hour), tavern.id, `kept at ${hour}`);
    assert.equal(worldTownWhere(tavernTown, keeper, 3), tavernTown.homeOf[keeper] ?? "square", "home after midnight");
  }
  const evening = new Map<string, number>();
  for (const person of tavernTown.people) {
    if (tavernTown.workOf[person.id] === tavern.id) continue;
    const where = worldTownWhere(tavernTown, person.id, 19);
    const kind =
      where === "square"
        ? "square"
        : where === tavern.id
          ? "tavern"
          : where === tavernTown.homeOf[person.id]
            ? "home"
            : "other";
    evening.set(kind, (evening.get(kind) ?? 0) + 1);
    assert.equal(
      worldTownWhere(tavernTown, person.id, 10),
      tavernTown.workOf[person.id] ?? "square",
      "by day unchanged",
    );
    assert.equal(
      worldTownWhere(tavernTown, person.id, 23),
      tavernTown.homeOf[person.id] ?? "square",
      "at night unchanged",
    );
  }
  assert.equal(evening.get("other") ?? 0, 0, "nobody anywhere else at dusk");
  assert.ok(
    (evening.get("square") ?? 0) > 0 && (evening.get("tavern") ?? 0) > 0 && (evening.get("home") ?? 0) > 0,
    "all three at dusk",
  );
  // The tavern's rooms hold its evening crowd's keepers, and its words are the setting's.
  const tavernRooms = worldInterior(fantasy, tavernTown, tavern.id)!;
  if (keeper) assert.ok(worldInteriorPeopleAt(tavernTown, tavernRooms, 19).some((each) => each.person.id === keeper));
  const homeRooms = worldInterior(
    fantasy,
    tavernTown,
    tavernTown.buildings.find((b) => b.kind === "home" && b.people.length)!.id,
  )!;
  assert.match(
    worldInteriorWords(homeRooms, "wuxia"),
    /^Inside, if the party is let in: .*a brazier/u,
    "a wuxia home's brazier",
  );
  assert.match(worldInteriorWords(homeRooms), /a hearth/u);
  const asleep = worldInteriorPeopleAt(tavernTown, homeRooms, 2);
  assert.ok(asleep.length > 0 && asleep.every((each) => each.asleep), "asleep at home at night");
  // Awake at home in the evening: beside their bed, not on it.
  for (const building of tavernTown.buildings.filter((each) => each.kind === "home" && each.people.length)) {
    const homeInside = worldInterior(fantasy, tavernTown, building.id)!;
    for (const { at, asleep: sleeping } of worldInteriorPeopleAt(tavernTown, homeInside, 19)) {
      assert.ok(!sleeping);
      const bed = homeInside.furniture.some((piece) => piece.kind === "bed" && piece.x === at.x && piece.y === at.y);
      const free = homeInside.furniture.filter((piece) => piece.kind === "bed").length < 8;
      if (free) assert.ok(!bed, `${building.id}: awake, beside the bed`);
    }
  }
  // ── Rooms drawn by hand (W13c): walls, floor and doorways painted, furniture anywhere ──
  {
    const home = tavernTown.buildings.find(
      (each) => each.kind === "home" && each.people.filter((id) => tavernTown.homeOf[id] === each.id).length >= 2,
    )!;
    const laid = layOutInterior(fantasy, tavernTown, home);
    // Two rooms joined by a doorway; the way out under the front room.
    const drawn = ["#########", "#...#...#", "#...d...#", "#...#...#", "#...#...#", "##D######"].join("");
    const handEdit = (over: Record<string, unknown> = {}) => ({
      settlement: tavernTown.settlementId,
      building: home.id,
      width: 9,
      height: 6,
      use: laid.use,
      ground: drawn,
      furniture: [
        { x: 6, y: 1, kind: "bed" as const },
        { x: 6, y: 4, kind: "bed" as const },
        { x: 1, y: 1, kind: "table" as const },
        { x: 3, y: 3, kind: "hearth" as const },
      ],
      ...over,
    });
    const withRooms = (entry: Record<string, unknown>) => {
      const edits = worldEditsSchema.parse({ editsVersion: 2, interiors: [entry] });
      return { game: { ...fantasy, edits } as GameWorld, edits };
    };
    const { game: handGame, edits: handEdits } = withRooms(handEdit());
    assert.deepEqual(
      worldInteriorEditIssues(handGame, handEdits, () => tavernTown),
      [],
      "drawn rooms pass",
    );
    const rooms = worldInterior(handGame, tavernTown, home.id)!;
    assert.equal(rooms.ground, drawn, "the drawn rooms, in place of the laid-out ones");
    assert.deepEqual(rooms.door, { x: 2, y: 5 });
    assert.deepEqual(
      rooms.rooms.map((room) => room.use),
      ["main", "sleep"],
      "split at the doorway: the front room, and the room with the beds",
    );
    // Everyone who lives there has a place: the beds in turn, the rest on open floor near the way in.
    const residents = home.people.filter((id) => tavernTown.homeOf[id] === home.id).slice(0, 8);
    const seatCells = residents.map((id) => {
      const seat = rooms.seats[id];
      assert.ok(seat, `${id} has a place in the drawn rooms`);
      const c = rooms.ground[seat!.y * 9 + seat!.x];
      assert.ok(c === ".", `${id} stands on the floor`);
      return seat!.y * 9 + seat!.x;
    });
    assert.equal(new Set(seatCells).size, seatCells.length, "no two people on one cell");
    assert.deepEqual(rooms.seats[residents[0]!], { x: 6, y: 1 }, "the first resident in the first bed");
    assert.match(worldInteriorWords(rooms), /a front room with a table and a hearth and a room to sleep in with beds/u);
    // Asleep at night in the drawn rooms' beds.
    assert.ok(worldInteriorPeopleAt(tavernTown, rooms, 2).some((each) => each.asleep));
    // Saved as editsVersion 2 (an older Engine refuses it); without drawn rooms, 1.
    assert.equal(worldEditsVersioned({ editsVersion: 1, interiors: [handEdit()] } as never).editsVersion, 2);
    assert.equal(worldEditsVersioned({ editsVersion: 2, interiors: [] } as never).editsVersion, 1);
    // What is wrong with a drawing, said plainly; a drawing that fails falls back to the laid-out rooms.
    const issuesOf = (over: Record<string, unknown>) => {
      const { game, edits } = withRooms(handEdit(over));
      return { issues: worldInteriorEditIssues(game, edits, () => tavernTown).join(" "), game };
    };
    const swap = (at: number, c: string) => drawn.slice(0, at) + c + drawn.slice(at + 1);
    for (const [over, words, label] of [
      [
        { ground: ["##D######", "#...#...#", "#...d...#", "#...#...#", "#...#...#", "#########"].join("") },
        /way out is in the bottom wall/u,
        "the way out in the top wall",
      ],
      [{ ground: swap(9 * 3, ".") }, /open at column 1, row 4/u, "an open edge"],
      [{ ground: swap(9 * 1 + 1, "d") }, /doorway at column 2, row 2/u, "a doorway into a wall"],
      [
        { furniture: [{ x: 0, y: 0, kind: "bed" }] },
        /bed at column 1, row 1 is not on the floor/u,
        "furniture on a wall",
      ],
      [{ furniture: [{ x: 2, y: 4, kind: "crate" }] }, /stands in the way in/u, "furniture in the way in"],
      [{ furniture: [{ x: 4, y: 2, kind: "crate" }] }, /not on the floor/u, "furniture in a doorway"],
      [
        {
          furniture: [
            { x: 5, y: 2, kind: "crate" },
            { x: 6, y: 1, kind: "bed" },
          ],
        },
        /cut off/u,
        "the doorway blocked from inside",
      ],
      [
        { width: WORLD_HAND_ROOM_MAX + 1, ground: "#".repeat((WORLD_HAND_ROOM_MAX + 1) * 6) },
        /at most 32/u,
        "too wide",
      ],
      [{ ground: drawn.slice(0, 50) }, /not 9 by 6/u, "a drawing that does not fill"],
    ] as const) {
      const { issues, game } = issuesOf(over as Record<string, unknown>);
      assert.match(issues, words, label);
      assert.equal(
        worldInterior(game, tavernTown, home.id)!.ground,
        laid.ground,
        `${label}: the laid-out rooms instead`,
      );
    }
    // Drawn for another kind of building (its id came to name another): kept, not applied, not refused.
    const other = issuesOf({ use: laid.use === "home" ? "tavern" : "home" });
    assert.equal(other.issues, "", "drawn for another kind of building: no complaint");
    assert.equal(worldInterior(other.game, tavernTown, home.id)!.ground, laid.ground, "and not applied");
  }
  // The schedule reads each building's own use (from its place's tags too): a building made a tavern
  // keeps its people there in the evening.
  const retagged = structuredClone(tavernTown);
  const workshop = retagged.buildings.find(
    (each) => each.kind === "work" && each.use !== "tavern" && each.people.length,
  );
  if (workshop) {
    workshop.use = "tavern";
    const worker = workshop.people.find((id) => retagged.workOf[id] === workshop.id)!;
    assert.equal(worldTownWhere(retagged, worker, 19), workshop.id, "its use, not its words");
  }

  // ── Through the routes, with a stand-in model ──
  const replies: string[] = [];
  const prompts: string[] = [];
  const standIn = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    prompts.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: replies.shift() ?? "" } }],
      }),
    );
  });
  await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
  const address = standIn.address();
  assert.ok(address && typeof address !== "string");
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  await app.register(generateRoutes, { prefix: "/api/generate" });
  try {
    const game = fantasy;
    const settlement = game.world.places.find((place) => place.id === tavernTown.settlementId)!;
    const connection = await createConnectionsStorage(db).create(
      createConnectionSchema.parse({
        name: "Stand-in",
        provider: "custom",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "stand-in",
        apiKey: "sk-stand-in",
      }),
    );
    const chats = createChatsStorage(db);
    const chat = await chats.create({ name: "Rooms", mode: "game", characterIds: [], connectionId: connection!.id });
    const chatId = chat.id;
    await chats.patchMetadata(chatId, {
      gameId: `rooms-${chatId}`,
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameWorldKit: game.kit,
      gameWorld: { seed: game.seed, generatorVersion: WORLD_GENERATOR_VERSION, grounding: "expand", brief: game.brief },
      gameTime: { day: 1, hour: 10, minute: 0 },
    });
    const rooms = (building: string) =>
      app.inject({ method: "GET", url: `/api/game/${chatId}/town/interior?building=${encodeURIComponent(building)}` });
    await chats.createMessage({
      chatId,
      role: "assistant",
      content: `The gate. [place: name="${settlement.name}" result="ok"]`,
    });
    const got = await rooms(tavern.id);
    assert.equal(got.statusCode, 200, got.body);
    assert.deepEqual(got.json().interior, tavernRooms, "the route's rooms are the building's");
    assert.equal((await rooms("nowhere")).statusCode, 404, "no such building");
    assert.equal((await rooms("square")).statusCode, 404, "the square has no rooms");

    // Walk to the tavern: the next turn tells the Game Master what is inside, in the setting's words.
    const walked = await app.inject({
      method: "POST",
      url: `/api/game/${chatId}/town/visit`,
      payload: { to: tavern.id },
    });
    assert.equal(walked.statusCode, 200, walked.body);
    replies.push("Steam and chatter.");
    prompts.length = 0;
    const response = await app.inject({
      method: "POST",
      url: "/api/generate/",
      payload: { chatId, userMessage: "We step in.", streaming: false },
    });
    assert.equal(response.statusCode, 200, response.body);
    const said = prompts.join("\n");
    assert.ok(
      said.includes(JSON.stringify(worldInteriorWords(tavernRooms, "wuxia")).slice(1, -1)),
      "told what is inside",
    );
    assert.match(said, /That time is counted already/);

    // ── Rooms furnished by hand (W13b), through the world editor's routes ──
    const editor = (building: string, place = settlement.id) =>
      app.inject({
        method: "GET",
        url: `/api/game/${chatId}/world/interior?settlement=${place}&building=${encodeURIComponent(building)}`,
      });
    const read = await editor(tavern.id);
    assert.equal(read.statusCode, 200, read.body);
    const laid = read.json().interior;
    assert.deepEqual(read.json().edit, null, "nothing furnished by hand yet");
    assert.deepEqual(
      { ...laid, seats: tavernRooms.seats },
      tavernRooms,
      "the editor's rooms are the building's as laid out (with no one placed)",
    );
    assert.ok(read.json().furniture.includes("bed"));
    assert.equal((await editor("nowhere")).statusCode, 404);
    assert.equal((await editor(tavern.id, "zz")).statusCode, 404);
    const save = (interiors: unknown[]) =>
      app.inject({
        method: "PUT",
        url: `/api/game/${chatId}/world/edits`,
        payload: { edits: { editsVersion: 1, interiors } },
      });
    const floor: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < laid.height; y++)
      for (let x = 0; x < laid.width; x++) if (laid.ground[y * laid.width + x] === ".") floor.push({ x, y });
    const entry = { x: laid.door.x, y: laid.door.y - 1 };
    const spot = floor.find((cell) => cell.y === 1 && (cell.x !== entry.x || cell.y !== entry.y))!;
    const sized = { settlement: settlement.id, building: tavern.id, width: laid.width, height: laid.height };
    // Furnished with a bed in the top row and a table beside it.
    const furniture = [
      { ...spot, kind: "bed" },
      { x: spot.x + 1, y: spot.y, kind: "table" },
    ];
    assert.ok(
      floor.some((cell) => cell.x === spot.x + 1 && cell.y === spot.y),
      "(room for the table)",
    );
    const saved = await save([{ ...sized, furniture }]);
    assert.equal(saved.statusCode, 200, saved.body);
    const meta = JSON.parse((await chats.getById(chatId))!.metadata as string);
    assert.deepEqual(meta.gameWorld.edits.interiors[0].furniture, furniture, "kept with the world's hand edits");
    assert.ok(
      !worldEditsEmpty({ editsVersion: 1, interiors: [{ ...sized, furniture: [] }] }),
      "a layer of rooms is no empty layer",
    );
    // The game's rooms are furnished as laid out by hand; whoever works there stands on open floor.
    const now = await rooms(tavern.id);
    assert.deepEqual(now.json().interior.furniture, furniture);
    for (const [id, seat] of Object.entries(now.json().interior.seats as Record<string, { x: number; y: number }>)) {
      const on = furniture.find((piece) => piece.x === seat.x && piece.y === seat.y);
      assert.ok(!on || on.kind === "bed", `${id} stands on open floor or lies in a bed`);
      assert.equal(laid.ground[seat.y * laid.width + seat.x], ".", `${id} is on the floor`);
    }
    assert.deepEqual((await editor(tavern.id)).json().edit.furniture, furniture, "the editor reads it back");
    // Refused, with the reason: off the floor, in the way in, two in one place, walling off a room, the
    // wrong size, no such building, a part of town, furnished twice.
    const refused = async (interiors: unknown[], pattern: RegExp, label: string) => {
      const answer = await save(interiors);
      assert.equal(answer.statusCode, 400, `${label}: ${answer.body}`);
      assert.match(answer.json().error, pattern, label);
    };
    await refused([{ ...sized, furniture: [{ x: 0, y: 0, kind: "crate" }] }], /not on the floor/, "on a wall");
    await refused([{ ...sized, furniture: [{ ...entry, kind: "crate" }] }], /stands in the way in/, "in the way in");
    await refused(
      [
        {
          ...sized,
          furniture: [
            { ...spot, kind: "crate" },
            { ...spot, kind: "barrel" },
          ],
        },
      ],
      /two pieces stand/,
      "two in one place",
    );
    const wall = floor
      .filter((cell) => cell.y === entry.y - 1 && (cell.x !== entry.x || true))
      .map((cell) => ({ ...cell, kind: "crate" }));
    await refused([{ ...sized, furniture: wall }], /walls off/, "a row of crates across the room");
    // Furnished for rooms of another size, or another kind of building (an id that now names another):
    // kept, never blocking a save, and not applied.
    for (const stale of [
      { ...sized, width: laid.width + 1, furniture: [{ ...spot, kind: "crate" }] },
      { ...sized, use: "worship", furniture: [{ ...spot, kind: "crate" }] },
    ]) {
      const kept = await save([stale]);
      assert.equal(kept.statusCode, 200, kept.body);
      assert.deepEqual((await rooms(tavern.id)).json().interior, tavernRooms, "not applied");
    }
    // Furnished for the rooms as they are: applied.
    assert.equal((await save([{ ...sized, use: laid.use, furniture }])).statusCode, 200);
    assert.deepEqual((await rooms(tavern.id)).json().interior.furniture, furniture);
    await refused([{ ...sized, building: "nowhere", furniture: [] }], /No building "nowhere"/, "no such building");
    await refused(
      [
        { ...sized, furniture },
        { ...sized, furniture: [] },
      ],
      /furnished twice/,
      "furnished twice",
    );
    // Cleared: the rooms are as laid out again.
    assert.equal((await save([])).statusCode, 200);
    assert.deepEqual((await rooms(tavern.id)).json().interior, tavernRooms, "back as laid out");
  } finally {
    await app.close();
    await closeDB();
    await new Promise<void>((resolve) => standIn.close(() => resolve()));
  }

  console.log("World interiors: every building's rooms hold together, are pinned, and are told to the Game Master.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
