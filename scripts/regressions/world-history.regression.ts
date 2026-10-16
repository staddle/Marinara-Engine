/**
 * World history (worldgen W3): the world engine run from the founding to "now".
 *
 *   - It explains the world the compile laid out: every settlement is founded and grows to the size it
 *     has now, every group is founded no earlier than its seat, and the same inputs give the same
 *     history, byte for byte (a committed fingerprint).
 *   - It uses only the kinds of change the world allows; a severe change only follows its build-up;
 *     the brief's dated events are fixed points; the brief's allies and rivals are how the groups get
 *     on now; no big world ends with one group keeping most of it; leaders are distinct people.
 *   - The Game Master is told the notable past, who keeps the place it is in and its past, and can ask
 *     for more with a history tag answered on its next turn.
 *   - The lore reading lists dated events, kept exactly by the brief, which also asks the model for a
 *     few events of the kinds the world has.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  WORLD_BUILD_UP,
  WORLD_STARTER_KITS,
  applyWorldHistoryTags,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  worldHistory,
  worldHistoryAnswerText,
  worldOverviewPromptText,
  worldPlacePast,
  worldWhereYouAreText,
  type GameWorld,
  type WorldKit,
} from "../../packages/shared/src/index.js";

const kits = WORLD_STARTER_KITS.map((input) => {
  const parsed = parseWorldKit(input);
  assert.ok(parsed.ok);
  return parsed.kit;
});

/** A world with four groups, each a rival of the one before, seated at the biggest places. */
function rivalWorld(kit: WorldKit, seed: number, extra: Record<string, unknown> = {}): GameWorld {
  const kinds = kit.groupKinds.map((kind) => kind.id);
  const plain = checkWorldBrief(kit, { briefVersion: 1, premise: "x" });
  assert.ok(plain.ok);
  const layout = compileGameWorld({ kit, seed, grounding: "expand", brief: plain.brief });
  const big = layout.places.filter((place) => place.rank !== undefined).sort((a, b) => b.rank! - a.rank!);
  const checked = checkWorldBrief(kit, {
    briefVersion: 1,
    premise: "x",
    places: big.slice(0, 4).map((place) => ({ name: place.name, layer: place.layer })),
    groups: [0, 1, 2, 3].map((index) => ({
      name: `Group ${index}`,
      kind: kinds[index % kinds.length],
      seat: big[index % big.length]!.name,
      rivals: index ? [`Group ${index - 1}`] : [],
    })),
    ...extra,
  });
  assert.ok(checked.ok, checked.ok ? "" : checked.issues.join("; "));
  const inputs = { kit, seed, grounding: "expand" as const, brief: checked.brief };
  return { ...inputs, world: compileGameWorld(inputs) };
}

// ── Every kit, several seeds: the history explains the world and keeps the world's rules ──
let wars = 0;
let woes = 0;
for (const kit of kits) {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const game = rivalWorld(kit, seed);
    const history = worldHistory(game);
    assert.deepEqual(worldHistory({ ...game }), history, "the same history twice");
    const what = `${kit.id}/${seed}`;
    const settlements = game.world.places.filter((place) => place.rank !== undefined);
    const foundedAt = new Map<string, number>();
    for (const place of settlements) {
      const founding = history.events.filter(
        (event) => event.kind === "founding" && event.places[0] === place.id && /was founded, /.test(event.text),
      );
      assert.equal(founding.length, 1, `${what}: ${place.name} is founded once`);
      foundedAt.set(place.id, founding[0]!.yearsAgo);
      const growth = history.events.filter((event) => event.places[0] === place.id && / grew into /.test(event.text));
      assert.equal(growth.length, place.rank, `${what}: ${place.name} grows to its size now`);
      assert.ok(
        growth.every((event) => event.yearsAgo <= founding[0]!.yearsAgo),
        `${what}: it grows after its founding`,
      );
      assert.ok(growth.at(-1) === undefined || growth.at(-1)!.text.endsWith(`${kit.sizes[place.rank!]!.label}.`));
    }
    for (const group of game.brief.groups) {
      const founding = history.events.find((event) => event.kind === "founding" && event.groups[0] === group.name)!;
      const seat = game.world.places.find((place) => place.name === group.seat)!;
      assert.ok(founding.yearsAgo <= foundedAt.get(seat.id)!, `${what}: ${group.name} is founded after its seat`);
    }
    // Only the kinds this world has.
    for (const event of history.events) {
      if (event.kind !== "founding" && !event.fixed)
        assert.ok(kit.change.kinds[event.kind].on, `${what}: ${event.kind}`);
      assert.ok(event.yearsAgo >= 1 && (event.fixed || event.yearsAgo <= history.span));
    }
    // Severe change only after its build-up.
    for (const [index, event] of history.events.entries()) {
      if (!event.severe || event.fixed) continue;
      const earlier = history.events.slice(0, index);
      if (/went to war/.test(event.text)) {
        wars++;
        const tension = earlier.findLast(
          (each) =>
            each.brewing && each.kind === "conflict" && event.groups.every((group) => each.groups.includes(group)),
        );
        assert.ok(tension && tension.yearsAgo - event.yearsAgo >= WORLD_BUILD_UP.conflict, `${what}: ${event.text}`);
      }
      if (/^(Famine|Plague) struck/.test(event.text)) {
        woes++;
        const warning = earlier.findLast(
          (each) => each.brewing && each.kind === "catastrophe" && each.places[0] === event.places[0],
        );
        assert.ok(warning && warning.yearsAgo - event.yearsAgo >= WORLD_BUILD_UP.catastrophe, `${what}: ${event.text}`);
      }
    }
    // The brief's rivals are rivals now; no big world ends kept by one group; leaders are distinct.
    for (const group of game.brief.groups) {
      for (const rival of group.rivals) {
        const key = group.name < rival ? `${group.name}|${rival}` : `${rival}|${group.name}`;
        assert.ok(history.relations[key]! <= -40, `${what}: ${key} ${history.relations[key]}`);
      }
    }
    if (settlements.length >= 8) {
      const held = Object.values(history.keepers).reduce<Record<string, number>>(
        (counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }),
        {},
      );
      assert.ok(
        Object.values(held).every((count) => count <= settlements.length * 0.6),
        `${what}: ${JSON.stringify(held)}`,
      );
    }
    const leaderNames = Object.values(history.leaders)
      .map((leader) => leader.name)
      .filter(Boolean);
    assert.equal(new Set(leaderNames).size, leaderNames.length, `${what}: leaders are distinct people`);
    assert.ok(history.lost.length <= Math.floor(settlements.length / 6));
  }
}
assert.ok(wars > 20 && woes > 5, `wars ${wars} and catastrophes ${woes} happen in turbulent worlds`);

// A gentle world never escalates: modern day has no crime, conflict or catastrophe, ever.
{
  const modern = kits.find((kit) => kit.id === "modern_day")!;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const history = worldHistory(rivalWorld(modern, seed));
    assert.ok(!history.events.some((event) => ["crime", "conflict", "catastrophe"].includes(event.kind)));
  }
}

// Each kind stands on its own: wars with no rivalry, crime with nothing else lowering a place.
{
  const only = (kinds: string[]) => {
    const base = kits.find((kit) => kit.id === "post_apocalyptic")!;
    const kit = parseWorldKit({
      ...structuredClone(WORLD_STARTER_KITS.find((each) => each.id === "post_apocalyptic")!),
      change: {
        pace: base.change.pace,
        kinds: Object.fromEntries(
          Object.entries(base.change.kinds).map(([id, kind]) => [id, { ...kind, on: kinds.includes(id) }]),
        ),
      },
    });
    assert.ok(kit.ok);
    return kit.kit;
  };
  const warOnly = only(["conflict"]);
  const crimeOnly = only(["crime"]);
  const events = (kit: WorldKit) =>
    [1, 2, 3, 4, 5, 6, 7, 8].flatMap((seed) => worldHistory(rivalWorld(kit, seed)).events);
  assert.ok(
    events(warOnly).some((event) => /went to war/.test(event.text)),
    "conflict without rivalry",
  );
  assert.ok(!events(warOnly).some((event) => event.kind === "rivalry"));
  assert.ok(
    events(crimeOnly).some((event) => event.kind === "crime"),
    "crime without fortunes",
  );
}

// ── Fixed points, and the fingerprint ──
const fantasy = kits.find((kit) => kit.id === "high_fantasy")!;
{
  const sample = rivalWorld(fantasy, 7);
  const placeName = sample.brief.places[1]!.name;
  const game = rivalWorld(fantasy, 7, {
    events: [
      { yearsAgo: 30, kind: "catastrophe", text: "The great flood drowned the lower town.", places: [placeName] },
      { yearsAgo: 900, kind: "catastrophe", text: "The Sundering broke the old realm.", places: [placeName] },
      {
        yearsAgo: 40,
        kind: "conflict",
        text: "Group 3 took the second city by storm.",
        places: [placeName],
        groups: ["Group 3"],
        lore: ["entry-1"],
      },
    ],
  });
  const history = worldHistory(game);
  const flood = history.events.find((event) => event.text === "The great flood drowned the lower town.")!;
  assert.ok(flood.fixed && flood.yearsAgo === 30 && flood.severe);
  const place = game.world.places.find((each) => each.name === placeName)!;
  assert.deepEqual(flood.places, [place.id]);
  assert.ok(
    worldPlacePast(history, place).some((event) => event.fixed),
    "a place's past keeps its fixed points",
  );
  // An event older than the history the engine runs is kept, first of all.
  assert.equal(history.events[0]!.text, "The Sundering broke the old realm.");
  assert.ok(history.events[0]!.fixed && history.events[0]!.yearsAgo === 900 && history.events[0]!.severe);
  // A war the lore records is never undone by one the engine draws over the same place.
  assert.ok(
    !history.events.some((event) => !event.fixed && /went to war/.test(event.text) && event.places.includes(place.id)),
  );

  const fingerprint = createHash("sha256").update(JSON.stringify(history)).digest("hex");
  assert.equal(
    fingerprint,
    "386249b45a7d63b983559cffd5fc19db38fbef1b5dba4bcc09469f236fe05171",
    "the committed history",
  );

  // A model's event of a kind the world does not have is left out; the lore's stays.
  const modern = kits.find((kit) => kit.id === "modern_day")!;
  const checked = checkWorldBrief(modern, {
    briefVersion: 1,
    premise: "x",
    events: [
      { yearsAgo: 5, kind: "conflict", text: "A war broke out." },
      { yearsAgo: 9, kind: "catastrophe", text: "The flood of the old mill.", lore: ["entry-2"] },
      { yearsAgo: 3, kind: "everyday", text: "The summer fair began.", places: ["Nowhere"] },
    ],
  });
  assert.ok(checked.ok);
  assert.deepEqual(
    checked.brief.events.map((event) => event.text),
    ["The flood of the old mill.", "The summer fair began."],
  );
  assert.ok(
    checked.repairs.some((note) =>
      /An event of a kind this world does not have was left out: "A war broke out."/.test(note),
    ),
  );
  assert.ok(checked.repairs.some((note) => /a place or group that is not in the brief was left out/.test(note)));
}

// ── What the Game Master is told, and asking for more ──
{
  // The notable past keeps the severe and fixed first, even when later changes of leadership abound.
  const { worldNotablePast } = await import("../../packages/shared/src/index.js");
  const made = (yearsAgo: number, extra: Record<string, unknown>) =>
    ({ yearsAgo, text: `${yearsAgo}`, places: ["p1"], groups: [], ...extra }) as never;
  const past = worldNotablePast(
    {
      span: 100,
      events: [
        made(90, { kind: "catastrophe", severe: true }),
        made(50, { kind: "leadership" }),
        made(40, { kind: "leadership" }),
        made(30, { kind: "leadership" }),
        made(20, { kind: "leadership" }),
        made(10, { kind: "leadership" }),
        made(5, { kind: "leadership" }),
      ],
      keepers: {},
      leaders: {},
      relations: {},
      lost: [],
    },
    5,
  );
  assert.deepEqual(
    past.map((event) => event.yearsAgo),
    [90, 30, 20, 10, 5],
  );
  const place = { id: "p1" } as never;
  const onePast = worldPlacePast(
    {
      span: 100,
      events: [made(90, { kind: "founding" }), made(9, { kind: "everyday" })],
      keepers: {},
      leaders: {},
      relations: {},
      lost: [],
    },
    place,
    1,
  );
  assert.deepEqual(
    onePast.map((event) => event.yearsAgo),
    [9],
    "a place's past of one is its latest",
  );
}
{
  const game = rivalWorld(fantasy, 3);
  const history = worldHistory(game);
  const overview = worldOverviewPromptText(game);
  assert.ok(overview.includes("- The past:\n  - "), overview);
  assert.ok(overview.includes('[history: place="Name"]'));
  const seat = game.world.places.find((place) => place.name === game.brief.groups[0]!.seat)!;
  if (history.leaders["Group 0"]?.name) assert.ok(overview.includes(`led by ${history.leaders["Group 0"]!.name}`));
  const where = worldWhereYouAreText(game, { place: seat });
  assert.ok(where.includes(`- Kept by ${history.keepers[seat.id]}`), where);
  assert.ok(where.includes("- Its past: ") && where.includes("was founded"), where);
  const other = game.world.places.find((place) => place.rank !== undefined && place.id !== seat.id)!;
  const reply = applyWorldHistoryTags(
    `Hm. [history: place="${other.name.toUpperCase()}"] [history: group="Nobody"] [history: group="group 1"]`,
    game,
  );
  assert.equal(
    reply,
    `Hm. [history: place="${other.name}" result="ok"] [history: group="Nobody" result="refused" reason="unknown"] [history: group="Group 1" result="ok"]`,
  );
  const answer = worldHistoryAnswerText(game, reply)!;
  assert.ok(
    answer.startsWith("<history_asked>\nThe past you asked for:\n") &&
      answer.includes(`- ${other.name}:`) &&
      answer.includes("- Group 1:"),
  );
  assert.equal(worldHistoryAnswerText(game, "No tags here."), undefined);
}

// ── The model's part: dated events from the lore, kept by the brief ──
{
  const { buildWorldBriefPrompt, mergeWorldCanon, readWrittenWorldBrief, buildWorldCanonPrompt } =
    await import("../../packages/server/src/services/game/world-brief-writer.js");
  const prompt = buildWorldBriefPrompt({
    kit: kits.find((kit) => kit.id === "modern_day")!,
    genre: "x",
    setting: "y",
    tone: "z",
  });
  assert.ok(
    prompt.system.includes('"kind" one of everyday, lives, fortunes, rivalry, leadership (only these'),
    prompt.system,
  );
  assert.ok(
    buildWorldCanonPrompt(fantasy, [{ id: "e", name: "n", content: "c" }]).system.includes(
      '"events" are the dated events the lore states',
    ),
  );
  const merged = mergeWorldCanon(
    fantasy,
    [
      {
        places: [{ name: "Thornmere", layer: "settlement", lore: ["a"] }],
        events: [
          {
            yearsAgo: 300,
            kind: "catastrophe",
            text: "The Sundering.",
            places: ["Thornmere", "Atlantis"],
            groups: ["The Old Order"],
            lore: ["a", "made-up"],
          },
          { yearsAgo: 300, kind: "catastrophe", text: "the sundering." },
          { yearsAgo: -3, kind: "war", text: "Not an event." },
        ],
      },
    ],
    new Set(["a"]),
  );
  assert.deepEqual(merged.events, [
    {
      yearsAgo: 300,
      kind: "catastrophe",
      text: "The Sundering.",
      places: ["Thornmere"],
      groups: ["The Old Order"],
      lore: ["a"],
    },
  ]);
  assert.ok(merged.repairs.some((note) => /An event the lore reading wrote was not one/.test(note)));
  // The brief keeps the lore's events exactly, and drops the model's copy of one.
  const read = readWrittenWorldBrief(
    fantasy,
    {
      premise: "x",
      places: [{ name: "Thornmere", layer: "settlement" }],
      groups: [{ name: "The Old Order", kind: "temple", seat: "Thornmere" }],
      events: [{ yearsAgo: 300, kind: "catastrophe", text: "the sundering.", places: ["Thornmere"] }],
    },
    merged.places,
    merged.events,
  );
  assert.ok(read.ok);
  if (read.ok) assert.deepEqual(read.brief.events, merged.events);
}

// ── The lore merged into a brief stays within the brief's limits, the lore's first ──
{
  const { withWorldCanon, WORLD_BRIEF_LIMITS } = await import("../../packages/shared/src/index.js");
  const lorePlaces = Array.from({ length: 50 }, (_, n) => ({ name: `Lore ${n}`, layer: "settlement", tags: [] }));
  const loreEvents = Array.from({ length: 25 }, (_, n) => ({
    yearsAgo: n + 1,
    kind: "everyday" as const,
    text: `Lore event ${n}.`,
    places: [],
    groups: [],
  }));
  const merged = withWorldCanon(
    {
      premise: "x",
      places: Array.from({ length: 30 }, (_, n) => ({ name: `Model ${n}`, layer: "settlement" })),
      events: Array.from({ length: 20 }, (_, n) => ({ yearsAgo: 1, kind: "everyday", text: `Model event ${n}.` })),
    },
    lorePlaces,
    loreEvents,
  ) as { places: Array<{ name: string }>; events: Array<{ text: string }> };
  assert.equal(merged.places.length, WORLD_BRIEF_LIMITS.places);
  assert.deepEqual(
    merged.places.slice(0, 50).map((place) => place.name),
    lorePlaces.map((place) => place.name),
  );
  assert.equal(merged.events.length, WORLD_BRIEF_LIMITS.events);
  assert.equal(merged.events[24]!.text, "Lore event 24.");
  assert.ok(checkWorldBrief(fantasy, { briefVersion: 1, ...merged }).ok, "a merged brief is still a brief");
}

// ── The rules, each proved where it bites ──
{
  const turbulent = (kinds: Partial<Record<string, boolean>>, scale = "world") => {
    const source = structuredClone(WORLD_STARTER_KITS.find((each) => each.id === "post_apocalyptic")!);
    const parsed = parseWorldKit({
      ...source,
      scale,
      change: {
        pace: "quick",
        kinds: Object.fromEntries(
          Object.entries(source.change.kinds).map(([id, kind]) => [id, { ...kind, on: kinds[id] ?? true }]),
        ),
      },
    });
    assert.ok(parsed.ok);
    return parsed.kit;
  };
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // A kind the world does not have never happens, even in the most restless world, over two centuries.
  for (const kind of ["crime", "catastrophe", "conflict"]) {
    const kit = turbulent({ [kind]: false });
    for (const seed of seeds) {
      const history = worldHistory(rivalWorld(kit, seed));
      assert.ok(!history.events.some((event) => event.kind === kind), `${kind} off, seed ${seed}`);
    }
  }
  // Leaders are distinct people, and a head is always named while a free name is left: a drawn name
  // another head has is drawn again, never shared and never given up on at once.
  const short = turbulent({});
  for (const seed of seeds) {
    const game = rivalWorld(short, seed, {
      peopleNames: short.cultures.map((culture) => ({
        culture: culture.id,
        given: ["Ama", "Tobin", "Hesk", "Mira", "Oswin", "Bryn"],
        family: ["Holt", "Drey", "Marrow"],
        order: "given-family",
      })),
    });
    const history = worldHistory(game);
    const names = Object.values(history.leaders).map((leader) => leader.name);
    assert.ok(names.every(Boolean), `seed ${seed}: every head is named (${names.join(", ")})`);
    assert.equal(new Set(names).size, names.length, `seed ${seed}: ${names.join(", ")}`);
    assert.ok(
      !history.events.some((event) => / chose a new head\.$/.test(event.text)),
      `seed ${seed}: no head goes unnamed`,
    );
  }
  // A war the lore records is never undone: whoever it gave the place to keeps it.
  for (const seed of seeds) {
    const sample = rivalWorld(short, seed);
    const placeName = sample.brief.places[1]!.name;
    const game = rivalWorld(short, seed, {
      events: [
        {
          yearsAgo: 150,
          kind: "conflict",
          text: "Group 3 took it by storm.",
          places: [placeName],
          groups: ["Group 3"],
        },
      ],
    });
    const place = game.world.places.find((each) => each.name === placeName)!;
    const history = worldHistory(game);
    assert.equal(history.keepers[place.id], "Group 3", `seed ${seed}: the lore's winner keeps it`);
    assert.ok(
      !history.events.some(
        (event) => !event.fixed && /went to war/.test(event.text) && event.places.includes(place.id),
      ),
      `seed ${seed}`,
    );
  }
  // A group holding most of the world draws rivals: its ties sour far faster than others'. Small
  // worlds, where one seated group can keep most of the places, show it.
  const town = turbulent({}, "town");
  let greedy = 0;
  let others = 0;
  let worlds = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const sample = rivalWorld(town, seed);
    // One seated group keeps everything near its seat; the others have no seat and keep nothing.
    const game = rivalWorld(town, seed, {
      places: [sample.brief.places[0]!],
      groups: [0, 1, 2, 3].map((index) => ({
        name: `Group ${index}`,
        kind: town.groupKinds[index]!.id,
        ...(index === 0 ? { seat: sample.brief.places[0]!.name } : {}),
      })),
    });
    const history = worldHistory(game);
    const held = Object.values(history.keepers).filter((keeper) => keeper === "Group 0").length;
    const settlements = game.world.places.filter((place) => place.rank !== undefined).length;
    if (held <= settlements * 0.4) continue;
    worlds += 1;
    for (const [key, value] of Object.entries(history.relations)) {
      if (key.includes("Group 0")) greedy += value / 3;
      else others += value / 3;
    }
  }
  assert.ok(worlds >= 10, `${worlds} worlds with a group holding most of it`);
  assert.ok(greedy / worlds < others / worlds - 25, `greedy ${greedy / worlds} vs others ${others / worlds}`);
}

// Only what the Engine answered is carried: an unanswered or refused ask is not.
{
  const game = rivalWorld(fantasy, 3);
  const real = game.world.places.find((place) => place.rank !== undefined)!.name;
  assert.equal(worldHistoryAnswerText(game, `[history: place="${real}"]`), undefined, "unanswered");
  assert.equal(
    worldHistoryAnswerText(game, `[history: place="${real}" result="refused" reason="unknown"]`),
    undefined,
    "refused",
  );
}

console.log(
  `World history: ${kits.length} kits explain their worlds, keep their rules (${wars} wars and ${woes} catastrophes, each after its build-up), pass their fixed points, and answer the Game Master.`,
);
