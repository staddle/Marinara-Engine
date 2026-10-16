/**
 * A living world (worldgen W5): the world engine keeps stepping in play.
 *
 *   - Time passes by the Game Master's word (`[world: days=]`, 1 to 365), and the world steps a week at a
 *     time; the same replies always give the same world (a committed fingerprint), and a still world
 *     never steps.
 *   - Only the kinds of change the world has, and never a catastrophe on its own; a war only after a
 *     season of tension; never a change resolved where the party is, which instead is a hook told to
 *     the Game Master; holds stop a pending war on the two grounds only.
 *   - Narrated events are refused when their kind is off, move the place a severe one happens in, and
 *     are news; news reaches the party after the days the ways take, as a rumour from far away.
 *   - The party's deeds push as far as its renown reaches.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  WORLD_PLAY_BUILD_UP,
  WORLD_STARTER_KITS,
  WORLD_STEP_DAYS,
  applyWorldTags,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  readWorldLedger,
  worldLedgerInstructions,
  worldNewsHere,
  worldPresent,
  worldRenown,
  worldRenownWord,
  worldSettlementOf,
  worldTravelDays,
  worldWhereYouAreText,
  type GameWorld,
  type WorldKit,
} from "../../packages/shared/src/index.js";

const kits = WORLD_STARTER_KITS.map((input) => {
  const parsed = parseWorldKit(input);
  assert.ok(parsed.ok);
  return parsed.kit;
});
const kitById = (id: string) => kits.find((kit) => kit.id === id)!;

/** A world with four groups, each a rival of the one before, seated at the biggest places. */
function rivalWorld(kit: WorldKit, seed: number): GameWorld {
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
      kind: kit.groupKinds[index % kit.groupKinds.length]!.id,
      seat: big[index % big.length]!.name,
      rivals: index ? [`Group ${index - 1}`] : [],
    })),
    peopleNames: kit.cultures.map((culture) => ({
      culture: culture.id,
      given: ["Ama", "Tobin", "Hesk", "Mira", "Oswin", "Bryn"],
      family: ["Holt", "Drey", "Marrow"],
      order: "given-family",
    })),
  });
  assert.ok(checked.ok, checked.ok ? "" : checked.issues.join("; "));
  const inputs = { kit, seed, grounding: "expand" as const, brief: checked.brief };
  return { ...inputs, world: compileGameWorld(inputs) };
}

/** Each reply answered against the ones before it, as a game's turns are. */
function play(game: GameWorld, said: string[], before: string[] = []): string[] {
  const replies = [...before];
  for (const reply of said) replies.push(applyWorldTags(reply, game, readWorldLedger(replies)));
  return replies;
}
const weeks = (count: number) => Array.from({ length: count }, () => `[world: days="${WORLD_STEP_DAYS}"]`);
const presentOf = (game: GameWorld, replies: string[]) => worldPresent(game, readWorldLedger(replies));

// ── Time passes by the Game Master's word ──
{
  const game = rivalWorld(kitById("high_fantasy"), 1);
  const said = play(game, ['[world: days="10"] [world: days="0"] [world: days="soon"] [world: days="900"]']).at(-1)!;
  assert.ok(said.includes('[world: days="10" result="ok"]'), said);
  assert.ok(said.includes('[world: days="0" result="refused" reason="unreadable"]'), said);
  assert.ok(said.includes('[world: days="soon" result="refused" reason="unreadable"]'), said);
  assert.ok(said.includes('[world: days="365" result="ok"]'), "a long skip is capped at a year");
  assert.equal(presentOf(game, [said]).day, 375);
  // Nothing passes, nothing steps.
  assert.deepEqual(presentOf(game, []).news, []);
}

// ── Every kit, several seeds: the world lives by its own rules, the same way every time ──
const fingerprint = createHash("sha256");
let wars = 0;
for (const kit of kits) {
  for (const seed of [1, 2, 3, 4]) {
    const game = rivalWorld(kit, seed);
    const replies = play(game, weeks(104));
    const present = presentOf(game, replies);
    const what = `${kit.id}/${seed}`;
    assert.deepEqual(presentOf(game, [...replies]), present, `${what}: the same replies, the same world`);
    assert.equal(present.day, 104 * WORLD_STEP_DAYS);
    for (const news of present.news) {
      assert.ok(kit.change.kinds[news.kind].on, `${what}: ${news.kind} is a kind the world has`);
      assert.notEqual(news.kind, "catastrophe", `${what}: the engine never rolls a catastrophe in play`);
    }
    // A war only after a season of tension between the same two groups.
    for (const war of present.news.filter((news) => news.severe)) {
      wars += 1;
      const [winner, loser] = war.text.split(" came to blows")[0]!.split(" and ");
      const warning = present.news.find(
        (news) => news.brewing && news.text.includes(winner!) && news.text.includes(loser!) && news.day <= war.day,
      );
      assert.ok(warning, `${what}: a war is warned of`);
      assert.ok(war.day - warning.day >= WORLD_PLAY_BUILD_UP * WORLD_STEP_DAYS, `${what}: a season of tension first`);
    }
    fingerprint.update(
      JSON.stringify([
        what,
        present.news,
        present.pending,
        present.keepers,
        present.relations,
        present.leaders,
        present.fortune,
      ]),
    );
  }
}
assert.ok(wars > 0, "turbulent worlds do come to blows");
assert.equal(
  fingerprint.digest("hex"),
  "76d3890fe3101c812ca0add938acc563c2ae038b401f44ae941845110bdedc55",
  "the living world is deterministic; regenerate this only for an intended engine change (and bump the generator version)",
);

// ── A still world never steps; a gentle world stays gentle ──
{
  const still = rivalWorld(
    { ...kitById("high_fantasy"), change: { ...kitById("high_fantasy").change, pace: "still" } },
    1,
  );
  const stillYear = presentOf(still, play(still, weeks(52)));
  const stillStart = presentOf(still, []);
  assert.deepEqual(stillYear.news, [], "a still world has no off-screen change");
  assert.deepEqual(
    [stillYear.fortune, stillYear.relations, stillYear.leaders, stillYear.keepers],
    [stillStart.fortune, stillStart.relations, stillStart.leaders, stillStart.keepers],
    "nothing in it moves on its own",
  );
  const modern = rivalWorld(kitById("modern_day"), 2);
  const present = presentOf(modern, play(modern, weeks(104)));
  assert.ok(present.news.length > 0, "a gentle world still lives");
  assert.ok(!present.news.some((news) => ["crime", "conflict"].includes(news.kind)), "and stays gentle");
}

// ── Each kind the world does not have never happens, even in the most restless world ──
for (const kind of ["everyday", "lives", "fortunes", "rivalry", "leadership", "crime", "conflict"] as const) {
  const base = kitById("post_apocalyptic");
  const kit: WorldKit = {
    ...base,
    change: { pace: "quick", kinds: { ...base.change.kinds, [kind]: { ...base.change.kinds[kind], on: false } } },
  };
  let others = 0;
  for (const seed of [1, 2, 3]) {
    const present = presentOf(rivalWorld(kit, seed), play(rivalWorld(kit, seed), weeks(104)));
    assert.ok(!present.news.some((news) => news.kind === kind), `${kind} off, seed ${seed}`);
    others += present.news.length;
  }
  assert.ok(others > 0, `${kind} off: the other kinds still happen`);
}

// ── Heads grow older in their tenure as time passes, so one who leads long enough can step down ──
{
  const game = rivalWorld(kitById("high_fantasy"), 2);
  const start = presentOf(game, []);
  const year = presentOf(game, play(game, weeks(52)));
  for (const [group, leader] of Object.entries(start.leaders)) {
    if (year.leaders[group]!.name !== leader.name) continue;
    assert.ok(Math.abs(year.leaders[group]!.sinceYearsAgo - (leader.sinceYearsAgo + (52 * 7) / 365)) < 1e-9, group);
  }
  // Over a long reign of play, heads do change, in a world that has leadership.
  const turbulent = rivalWorld(
    { ...kitById("high_fantasy"), change: { ...kitById("high_fantasy").change, pace: "quick" } },
    2,
  );
  const crowned = play(turbulent, ['[world: deed="crown" group="Group 0" who="Ama Holt"]']);
  const reign = presentOf(
    turbulent,
    play(
      turbulent,
      Array.from({ length: 30 }, () => '[world: days="365"]'),
      crowned,
    ),
  );
  assert.notEqual(reign.leaders["Group 0"]!.name, "Ama Holt", "a head crowned in play steps down after a long tenure");
}

// ── A group brought back under a gone group's name is one group, stepped once a week ──
{
  // Only conflict on, so the one thing moving how groups get on in a week is the drift itself.
  const base = kitById("post_apocalyptic");
  const kit: WorldKit = {
    ...base,
    change: {
      pace: "quick",
      kinds: Object.fromEntries(
        Object.entries(base.change.kinds).map(([id, kind]) => [id, { ...kind, on: id === "conflict" }]),
      ) as WorldKit["change"]["kinds"],
    },
  };
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const game = rivalWorld(kit, seed);
    const revived = play(game, [
      '[world: deed="destroy" group="Group 0"] [world: fact="group" name="Group 0" kind="' +
        kit.groupKinds[0]!.id +
        '"]',
    ]);
    const before = presentOf(game, revived);
    assert.deepEqual(before.gone, []);
    const after = presentOf(game, play(game, weeks(1), revived));
    for (const [key, value] of Object.entries(after.relations)) {
      if (!key.includes("Group 0")) continue;
      // One week's drift at a quick pace moves a pair at most 3 either way, and rivals 0.9 more apart.
      const moved = value - (before.relations[key] ?? 0) * 0.99;
      assert.ok(moved >= -3.9 - 1e-9 && moved <= 3 + 1e-9, `seed ${seed} ${key}: moved ${moved}`);
    }
  }
}

// ── The scene comes first: nothing resolved where the party is ──
for (const seed of [1, 2, 3, 4, 5, 6]) {
  const game = rivalWorld(kitById("cyberpunk"), seed);
  const seat = game.world.places.find((place) => place.name === game.brief.groups[1]!.seat)!;
  const home = worldSettlementOf(game, seat.id)!;
  const replies = play(game, [`[place: name="${seat.name}" result="ok"]`, ...weeks(104)]);
  const present = presentOf(game, replies);
  const before = presentOf(game, replies.slice(0, 1));
  assert.equal(present.keepers[home.id], before.keepers[home.id], `${seed}: no war takes the party's place`);
  assert.equal(present.fortune[home.id], before.fortune[home.id], `${seed}: its fortunes wait for the party`);
  assert.equal(present.leaders[game.brief.groups[1]!.name]?.name, before.leaders[game.brief.groups[1]!.name]?.name);
  for (const news of present.news) {
    if (news.placeId !== home.id) continue;
    assert.ok(["lives", "rivalry", "conflict"].includes(news.kind) && !news.severe, `${seed}: ${news.text}`);
  }
}
{
  // A war ripe over the party's place is told as a hook, with its id.
  const game = rivalWorld(kitById("cyberpunk"), 1);
  const present = presentOf(game, play(game, weeks(1)));
  const home = worldSettlementOf(game, game.world.startId)!;
  present.keepers[home.id] = "Group 0";
  present.pending.push({ id: "p9", groups: ["Group 0", "Group 1"], sinceStep: -WORLD_PLAY_BUILD_UP });
  const told = worldWhereYouAreText(game, { place: home, present });
  assert.ok(told.includes("- About to happen here [p9]: Group 0 and Group 1 are close to fighting over it."), told);
  // A war not yet ripe is brewing, not about to happen.
  const fresh = structuredClone(present);
  fresh.pending[fresh.pending.length - 1]!.sinceStep = 0;
  assert.ok(!worldWhereYouAreText(game, { place: home, present: fresh }).includes("About to happen here"));
  present.pending[present.pending.length - 1]!.held = "no-agency";
  assert.ok(
    worldWhereYouAreText(game, { place: home, present }).includes(
      "- Brewing [p9]: tension between Group 0 and Group 1",
    ),
    "a held war is not a hook",
  );
}

// ── A fold is the world's alone: what a caller does to it never leaks into the next fold ──
{
  const game = rivalWorld(kitById("high_fantasy"), 1);
  const replies = play(game, weeks(8));
  presentOf(game, replies);
  // A second read is the cached one: what the caller does to it stays with the caller.
  const once = presentOf(game, replies);
  once.keepers = {};
  once.news.length = 0;
  const again = presentOf(game, replies);
  assert.ok(Object.keys(again.keepers).length > 0 && again.news.length > 0, "the cached fold is untouched");
}

// ── Holds, on the two grounds only ──
{
  // A brewing war that, let be, comes to blows within two years.
  const warBetween = (game: GameWorld, replies: string[], groups: [string, string], after: number) =>
    presentOf(game, replies).news.some(
      (news) => news.severe && news.day > after && groups.every((group) => news.text.includes(group)),
    );
  let found: { game: GameWorld; replies: string[]; id: string; groups: [string, string] } | undefined;
  for (let seed = 1; seed < 60 && !found; seed++) {
    const game = rivalWorld(kitById("post_apocalyptic"), seed);
    const replies = play(game, weeks(30));
    const pending = presentOf(game, replies).pending[0];
    if (pending && warBetween(game, play(game, weeks(104), replies), pending.groups, 30 * WORLD_STEP_DAYS)) {
      found = { game, replies, id: pending.id, groups: pending.groups };
    }
  }
  assert.ok(found, "a turbulent world brews a war that comes");
  const { game, replies, id, groups } = found;
  const said = play(
    game,
    [
      `[world: hold="nope" ground="no-sense"] [world: hold="${id}" ground="dramatic"] [world: release="${id}"] [world: hold="${id.toUpperCase()}" ground="no-sense" note="it would make no sense"] [world: hold="${id}" ground="no-agency"]`,
    ],
    replies,
  ).at(-1)!;
  assert.ok(said.includes('[world: hold="nope" ground="no-sense" result="refused" reason="unknown-pending"]'), said);
  assert.ok(said.includes(`ground="dramatic" result="refused" reason="unreadable"]`), said);
  assert.ok(said.includes(`[world: release="${id}" result="refused" reason="not-held"]`), said);
  assert.ok(said.includes(`[world: hold="${id}" ground="no-sense" note="it would make no sense" result="ok"]`), said);
  assert.ok(said.includes(`[world: hold="${id}" ground="no-agency" result="refused" reason="held"]`), said);
  // Held, the war that would have come never does; let go, it is pending again.
  assert.ok(!warBetween(game, play(game, weeks(104), [...replies, said]), groups, 30 * WORLD_STEP_DAYS), "held");
  const released = play(game, [`[world: release="${id}"]`], [...replies, said]);
  assert.ok(released.at(-1)!.includes('result="ok"'), released.at(-1));
  assert.equal(presentOf(game, released).pending.find((each) => each.id === id)?.held, undefined);
  // Destroying one side ends the war it was brewing.
  const destroyed = play(game, [`[world: deed="destroy" group="${groups[0]}"]`], replies);
  assert.ok(!presentOf(game, destroyed).pending.some((each) => each.groups.includes(groups[0])));
}

// ── Narrated events, and news that travels ──
{
  // A still world, so only the narrated events are news.
  const fantasy = kitById("high_fantasy");
  const game = rivalWorld({ ...fantasy, change: { ...fantasy.change, pace: "still" } }, 3);
  const home = worldSettlementOf(game, game.world.startId)!;
  const travel = worldTravelDays(game, home.id);
  const far = game.world.places
    .filter((place) => place.rank !== undefined && (travel.get(place.id) ?? 0) > 10)
    .sort((a, b) => travel.get(a.id)! - travel.get(b.id)!)[0]!;
  const away = Math.ceil(travel.get(far.id)!);
  const said = play(game, [
    `[world: event="A storm flooded the lower town" kind="everyday" place="${far.name}"] [world: event="War!" kind="conflict" place="${far.name}"] [world: event="?" kind="weather"] [world: event="x" kind="crime" place="Atlantis"]`,
  ]).at(-1)!;
  assert.ok(said.includes('kind="everyday"') && said.includes(`place="${far.name}" result="ok"]`), said);
  assert.ok(said.includes('[world: event="?" kind="weather" result="refused" reason="unknown-kind"]'), said);
  assert.ok(said.includes('place="Atlantis" result="refused" reason="unknown-place"]'), said);
  const now = presentOf(game, [said]);
  assert.equal(now.fortune[far.id], Math.max(0, presentOf(game, []).fortune[far.id]! - 25), "a war moves its place");
  assert.equal(worldNewsHere(game, now, home.id).length, 0, "far news has not arrived yet");
  assert.equal(worldNewsHere(game, now, far.id).length, 2, "it is news where it happened at once");
  const later = presentOf(game, play(game, [`[world: days="${away}"]`], [said]));
  const heard = worldNewsHere(game, later, home.id);
  assert.deepEqual(
    heard.slice(0, 2).map((each) => [each.news.text, each.ago, each.rumour]),
    [
      ["War!", away, true],
      ["A storm flooded the lower town", away, true],
    ],
    "newest first, with how long ago, still a rumour from that far",
  );
  const told = worldWhereYouAreText(game, { place: home, present: later });
  assert.ok(told.includes(`- Word that has reached here, newest first:\n  - ${away} days ago, a rumour: War!`), told);
  // A world with conflict off refuses a narrated war.
  const modern = rivalWorld(kitById("modern_day"), 2);
  assert.ok(
    play(modern, ['[world: event="Riots" kind="conflict"]']).at(-1)!.includes('result="refused" reason="kind-off"'),
  );
}

// ── The party's word reaches as far as its renown ──
{
  const game = rivalWorld(kitById("high_fantasy"), 1);
  const first = presentOf(game, play(game, ['[world: deed="help" group="Group 0"]']));
  assert.equal(first.standing["Group 0"], 8, "a stranger's help counts for half");
  const famous = play(game, [
    Array.from({ length: 20 }, () => '[world: deed="improve" place="' + game.brief.places[0]!.name + '"]').join(" "),
  ]);
  const after = presentOf(game, play(game, ['[world: deed="help" group="Group 0"]'], famous));
  assert.equal(after.renown, 21);
  assert.equal(after.standing["Group 0"], 30, "a famous party's help counts double");
  for (const [renown, word] of [
    [0, "unknown"],
    [2, "unknown"],
    [3, "known locally"],
    [8, "known in the region"],
    [20, "famous"],
  ] as const) {
    assert.equal(worldRenownWord(renown), word);
  }
  assert.ok(
    worldWhereYouAreText(game, {
      place: game.world.places.find((place) => place.id === game.world.startId)!,
      present: after,
    }).includes("- The party is famous."),
  );
  // A place the party took for a group that trusts it counts for three deeds; lost, it counts for none.
  const place = game.brief.places[1]!.name;
  const holding = play(game, [
    '[world: deed="ally" group="Group 0"] [world: deed="ally" group="Group 0"] [world: deed="ally" group="Group 0"]',
    `[world: deed="take" place="${place}" group="Group 0"]`,
  ]);
  const held = presentOf(game, holding);
  assert.ok(held.standing["Group 0"]! >= 50, `${held.standing["Group 0"]}`);
  assert.equal(worldRenown(held), 4 + 3);
  const lost = presentOf(game, play(game, [`[world: deed="take" place="${place}" group="Group 1"]`], holding));
  assert.equal(worldRenown(lost), 5);
}

// ── The Game Master is told how ──
{
  const turbulent = worldLedgerInstructions(rivalWorld(kitById("high_fantasy"), 1));
  assert.ok(turbulent.includes('[world: days="N"]'));
  assert.ok(turbulent.includes('[world: hold="p1" ground="no-sense"]'));
  const gentle = worldLedgerInstructions(rivalWorld(kitById("modern_day"), 1));
  assert.ok(gentle.includes("kind one of everyday, lives, fortunes, rivalry, leadership."), gentle);
  assert.ok(!gentle.includes("hold="), "no war, nothing to hold");
}

console.log("world living: ok");
