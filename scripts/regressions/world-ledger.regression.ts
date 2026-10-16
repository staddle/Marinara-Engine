/**
 * The world's ledger (worldgen W4): what the story does to the world.
 *
 *   - A world tag is answered in place: a deed of a kind the world allows, on places and groups it has
 *     (as the world spells them), is ok; an unknown deed, place or group, a kind the world has off, a
 *     place or group that already exists, or a gone group is refused, whatever result the model wrote.
 *   - The ledger is the answered tags in the replies, so a reply taken back takes its deeds back; the
 *     present world is the history with the ledger folded over it: standing, prosperity, ruins,
 *     keepers, leaders, gone groups, and the places and groups the story added.
 *   - A place the story added is a place the place tag knows, sized by the settlement it is in.
 *   - The Game Master is told how to write deeds (only the ones its world allows), and each turn the
 *     present: the place's state, keeper and leader, what the party did there, and what has changed.
 */
import assert from "node:assert/strict";

import {
  WORLD_DEED_KINDS,
  WORLD_STARTER_KITS,
  applyWorldHistoryTags,
  applyWorldTags,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  readReputationTags,
  readWorldLedger,
  worldHistory,
  worldLedgerInstructions,
  worldOverviewPromptText,
  worldPlaceForTag,
  worldPresent,
  stripReputationTags,
  worldStandingWord,
  worldWhereYouAreText,
  type GameWorld,
  type WorldKit,
} from "../../packages/shared/src/index.js";

const kitById = (id: string): WorldKit => {
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((kit) => kit.id === id)!);
  assert.ok(parsed.ok);
  return parsed.kit;
};

/** A world with two groups seated at its two biggest places. */
function twoGroups(kit: WorldKit, seed: number): GameWorld {
  const plain = checkWorldBrief(kit, { briefVersion: 1, premise: "x" });
  assert.ok(plain.ok);
  const layout = compileGameWorld({ kit, seed, grounding: "expand", brief: plain.brief });
  const big = layout.places.filter((place) => place.rank !== undefined).sort((a, b) => b.rank! - a.rank!);
  const checked = checkWorldBrief(kit, {
    briefVersion: 1,
    premise: "x",
    places: big.slice(0, 2).map((place) => ({ name: place.name, layer: place.layer })),
    groups: [
      { name: "The Wardens", kind: kit.groupKinds[0]!.id, seat: big[0]!.name },
      { name: "The Ferrymen", kind: kit.groupKinds[1]!.id, seat: big[1]!.name },
    ],
  });
  assert.ok(checked.ok, checked.ok ? "" : checked.issues.join("; "));
  const inputs = { kit, seed, grounding: "expand" as const, brief: checked.brief };
  return { ...inputs, world: compileGameWorld(inputs) };
}

const fantasy = twoGroups(kitById("high_fantasy"), 7);
const big = fantasy.world.places.filter((place) => place.rank !== undefined).sort((a, b) => b.rank! - a.rank!);
const [capital, second] = [big[0]!, big[1]!];
const answer = (game: GameWorld, content: string, before: string[] = []) =>
  applyWorldTags(content, game, readWorldLedger(before));

// ── Answered in place ──
{
  const said = answer(
    fantasy,
    [
      '[world: deed="help" group="the wardens" note="mended the dikes"]',
      '[world: deed="destroy" group="Nobody"]',
      '[world: deed="fly" group="The Wardens"]',
      `[world: deed="improve" place="${capital.name.toUpperCase()}"]`,
      '[world: deed="improve" place="Atlantis"]',
      '[world: deed="befriend" group="The Wardens" with="the wardens"]',
      '[world: deed="crown" group="The Ferrymen"]',
      // The model's own result never counts.
      '[world: deed="fall" place="Atlantis" result="ok"]',
    ].join(" "),
  );
  assert.ok(said.includes('[world: deed="help" group="The Wardens" note="mended the dikes" result="ok"]'), said);
  assert.ok(said.includes('[world: deed="destroy" group="Nobody" result="refused" reason="unknown-group"]'), said);
  assert.ok(said.includes('[world: deed="fly" group="The Wardens" result="refused" reason="unreadable"]'), said);
  assert.ok(said.includes(`[world: deed="improve" place="${capital.name}" result="ok"]`), said);
  assert.ok(said.includes('[world: deed="improve" place="Atlantis" result="refused" reason="unknown-place"]'), said);
  assert.ok(
    said.includes('with="the wardens" result="refused" reason="unknown-group"]'),
    "a group befriends no one but another",
  );
  assert.ok(
    said.includes('[world: deed="crown" group="The Ferrymen" result="refused" reason="unreadable"]'),
    "crown needs who",
  );
  assert.ok(said.includes('[world: deed="fall" place="Atlantis" result="refused" reason="unknown-place"]'), said);
  assert.deepEqual(
    readWorldLedger([said]).map((entry) => entry.deed),
    ["help", "improve"],
    "only the answered ok tags are the ledger",
  );
  // A name written with stray spaces is still the world's.
  assert.ok(
    answer(fantasy, '[world: deed="help" group="The  Wardens"]').includes('group="The Wardens" result="ok"'),
    "spaces collapse",
  );
  // Quotes and line breaks in a note never break the tag the Engine writes back.
  const noted = answer(fantasy, '[world: deed="hinder" group="The Ferrymen" note=\'cut "their"\n ropes\']');
  assert.deepEqual(
    readWorldLedger([noted]),
    [{ deed: "hinder", group: "The Ferrymen", note: "cut their ropes" }],
    noted,
  );
  // A group or place already in the world is not brought in again, nor a group seated nowhere it has.
  const facts = answer(
    fantasy,
    '[world: fact="group" name="the wardens" kind="guild"] [world: fact="group" name="The Moths" kind="guild" seat="Atlantis"]',
  );
  assert.ok(facts.includes('name="the wardens" kind="guild" result="refused" reason="exists"]'), facts);
  assert.ok(facts.includes('seat="Atlantis" result="refused" reason="unknown-place"]'), facts);
}

// ── A kind the world has off is refused, and never offered ──
{
  const modern = twoGroups(kitById("modern_day"), 3);
  const town = modern.world.places.find((place) => place.rank !== undefined)!;
  for (const deed of ["damage", "take", "destroy", "fall"] as const) {
    const said = answer(modern, `[world: deed="${deed}" group="The Wardens" place="${town.name}"]`);
    assert.ok(said.includes('result="refused" reason="kind-off"'), `${deed}: ${said}`);
  }
  for (const deed of ["help", "hinder", "ally", "betray", "improve"] as const) {
    const said = answer(modern, `[world: deed="${deed}" group="The Wardens" place="${town.name}"]`);
    assert.ok(said.includes('result="ok"'), `${deed}: ${said}`);
  }
  const told = worldLedgerInstructions(modern);
  for (const deed of ["damage", "take", "destroy", "fall"]) assert.ok(!told.includes(deed), `${deed} is not offered`);
  for (const deed of ["help", "befriend", "crown", "improve"]) assert.ok(told.includes(deed), `${deed} is offered`);
  assert.ok(worldOverviewPromptText(modern).includes(told), "the overview carries the instructions");
  // Each deed's kind is one the schema knows.
  for (const kind of Object.values(WORLD_DEED_KINDS)) assert.ok(kind in modern.kit.change.kinds);
}

// ── The present: the history with the ledger folded over it ──
{
  const history = worldHistory(fantasy);
  const replies = [
    answer(fantasy, '[world: deed="help" group="The Wardens"] [world: deed="help" group="The Wardens"]'),
  ];
  replies.push(
    answer(
      fantasy,
      [
        `[world: deed="take" place="${second.name}" group="The Wardens" note="at dawn"]`,
        '[world: deed="crown" group="The Ferrymen" who="Old Mags"]',
        `[world: deed="improve" place="${capital.name}"]`,
        `[world: deed="improve" place="${capital.name}"]`,
        `[world: deed="improve" place="${capital.name}"]`,
        `[world: deed="befriend" group="The Wardens" with="The Ferrymen"]`,
        '[world: deed="betray" group="The Ferrymen"]',
      ].join(" "),
      replies,
    ),
  );
  const present = worldPresent(fantasy, readWorldLedger(replies));
  // A deed pushes as far as the party's renown reaches (worldgen W5): half at first, rising with each.
  const reach = (renown: number) => 0.5 + 1.5 * Math.min(1, renown / 20);
  assert.equal(present.standing["The Wardens"], Math.round(15 * reach(0)) + Math.round(15 * reach(1)));
  assert.equal(present.renown, 9);
  for (const [value, word] of [
    [100, "trusted"],
    [50, "trusted"],
    [49, "on good terms"],
    [15, "on good terms"],
    [14, "neither"],
    [-14, "neither"],
    [-15, "on bad terms"],
    [-49, "on bad terms"],
    [-50, "enemies"],
    [-100, "enemies"],
  ] as const) {
    assert.equal(worldStandingWord(value), word, `${value}`);
  }
  assert.equal(worldStandingWord(present.standing["The Wardens"]!), "on good terms");
  assert.equal(worldStandingWord(present.standing["The Ferrymen"]!), "enemies");
  assert.equal(present.keepers[second.id], "The Wardens");
  assert.deepEqual(present.leaders["The Ferrymen"], { name: "Old Mags", sinceYearsAgo: 0 });
  assert.equal(present.prosperity[capital.id], "thriving", "prosperity steps and stops at the top");
  const pair = "The Ferrymen|The Wardens";
  assert.equal(present.relations[pair], Math.min(100, (history.relations[pair] ?? 0) + Math.round(25 * reach(7))));
  assert.deepEqual(present.done[second.id], ["The Wardens took it (at dawn)."]);
  // The history is untouched: the seed never overwrites what the story did, nor the story the seed.
  assert.notEqual(worldHistory(fantasy).leaders["The Ferrymen"]?.name, "Old Mags");

  // A reply taken back (a swipe, a regeneration, a deleted message) takes its deeds back with it.
  const takenBack = worldPresent(fantasy, readWorldLedger(replies.slice(0, 1)));
  assert.equal(takenBack.keepers[second.id], history.keepers[second.id]);
  assert.equal(takenBack.standing["The Ferrymen"], undefined);

  // The Game Master is told it: the place's state, keeper and leader, the party's standing, and what changed.
  const there = worldWhereYouAreText(fantasy, { place: second, present });
  assert.ok(there.includes("- Kept by The Wardens"), there);
  assert.ok(there.includes("the party is on good terms with them."), there);
  assert.ok(there.includes("- Since play began: The Wardens took it (at dawn)."), there);
  assert.ok(there.includes("- Since play began: The Ferrymen is now led by Old Mags."), there);
  assert.ok(!there.includes("The Wardens is now led"), "a leader the story did not change is not news");
  assert.ok(there.includes("- The party's standing: The Ferrymen (enemies), The Wardens (on good terms)."), there);
  const home = worldWhereYouAreText(fantasy, { place: capital, present });
  assert.ok(home.includes(`The party is in ${capital.name} (`) && home.includes(", thriving)"), home);
  assert.ok(!worldWhereYouAreText(fantasy, { place: second }).includes("Since play began"), "no ledger, no changes");
  // A group the party has helped and hindered alike is neither, and not listed.
  const even = worldPresent(
    fantasy,
    readWorldLedger([
      answer(fantasy, '[world: deed="help" group="The Ferrymen"] [world: deed="hinder" group="The Ferrymen"]'),
    ]),
  );
  assert.equal(worldStandingWord(even.standing["The Ferrymen"]!), "neither");
  assert.ok(
    !worldWhereYouAreText(fantasy, { place: capital, present: even }).includes("standing"),
    "neither is not news",
  );
}

// ── Gone, fallen, and what the story brings in ──
{
  const replies = [
    answer(
      fantasy,
      [
        `[world: deed="destroy" group="The Ferrymen"]`,
        `[world: deed="help" group="The Ferrymen"]`,
        `[world: deed="fall" place="${second.name}" note="the river rose"]`,
        `[world: fact="place" name="The Sunken Shrine" in="${capital.name}"]`,
        `[world: fact="place" name="the sunken shrine" in="${capital.name}"]`,
        `[world: fact="place" name="The Crypt" in="The Sunken Shrine"]`,
        `[world: fact="place" name="Nowhere" in="Atlantis"]`,
        `[world: deed="damage" place="The Sunken Shrine"]`,
        `[world: fact="group" name="The Lantern Guild" kind="guild" seat="The Sunken Shrine"]`,
        `[world: fact="group" name="The Odd Lot" kind="spaceship"]`,
        `[world: deed="ally" group="The Lantern Guild"]`,
      ].join(" "),
    ),
  ];
  const said = replies[0]!;
  assert.ok(
    said.includes('[world: deed="help" group="The Ferrymen" result="refused" reason="unknown-group"]'),
    "a gone group is gone",
  );
  assert.ok(said.includes('name="the sunken shrine" in=') && said.includes('reason="exists"'), said);
  assert.ok(said.includes('[world: fact="place" name="The Crypt" in="The Sunken Shrine" result="ok"]'), said);
  assert.ok(
    said.includes('[world: fact="place" name="Nowhere" in="Atlantis" result="refused" reason="unknown-place"]'),
    said,
  );
  assert.ok(
    said.includes('[world: deed="damage" place="The Sunken Shrine" result="ok"]'),
    "a place added earlier in the reply counts",
  );
  assert.ok(said.includes('kind="spaceship" result="refused" reason="unknown-kind"]'), said);
  assert.ok(said.includes('[world: deed="ally" group="The Lantern Guild" result="ok"]'), said);

  const present = worldPresent(fantasy, readWorldLedger(replies));
  assert.deepEqual(present.gone, ["The Ferrymen"]);
  // A group brought back under a gone group's name is a group again.
  const back = answer(
    fantasy,
    '[world: fact="group" name="The Ferrymen" kind="guild"] [world: deed="help" group="the ferrymen"]',
    replies,
  );
  assert.ok(back.includes('[world: deed="help" group="The Ferrymen" result="ok"]'), back);
  assert.deepEqual(worldPresent(fantasy, readWorldLedger([...replies, back])).gone, []);
  assert.ok(!Object.values(present.keepers).includes("The Ferrymen"), "a gone group keeps nothing");
  assert.deepEqual(present.ruined, [second.id]);
  assert.deepEqual(
    present.places.map((place) => [place.name, place.parentId]),
    [
      ["The Sunken Shrine", capital.id],
      ["The Crypt", capital.id],
    ],
    "a place inside an added place is within the same world place",
  );

  // The place tag knows an added place, sized by the settlement it is in.
  assert.deepEqual(worldPlaceForTag(fantasy, "the crypt", undefined, present), {
    name: "The Crypt",
    size: capital.size,
  });
  assert.equal(worldPlaceForTag(fantasy, "The Crypt"), undefined, "not without the ledger");
  const ladder = [{ id: "small" }, { id: "big" }];
  assert.deepEqual(
    worldPlaceForTag(fantasy, "The Crypt", ladder, present),
    worldPlaceForTag(fantasy, capital.name, ladder) && {
      ...worldPlaceForTag(fantasy, capital.name, ladder)!,
      name: "The Crypt",
    },
  );

  const at = worldWhereYouAreText(fantasy, { name: "The Crypt", present });
  assert.ok(at.startsWith(`<where_you_are>\nThe party is in The Crypt, in ${capital.name} (`), at);
  assert.ok(at.includes("The Sunken Shrine, The Crypt."), at);
  assert.ok(!at.includes("damaged"), "what was done to the shrine is told at the shrine");
  assert.ok(
    worldWhereYouAreText(fantasy, { name: "The Sunken Shrine", present }).includes(
      "- Since play began: The party damaged it.",
    ),
  );
  assert.ok(at.includes("The Ferrymen is gone."), at);
  assert.ok(at.includes(`${second.name} lies in ruins.`), at);
  assert.ok(at.includes("The Lantern Guild (guild, at The Sunken Shrine) has come into the world."), at);
  assert.ok(at.includes("The Lantern Guild (on good terms)"), at);
  assert.ok(
    worldWhereYouAreText(fantasy, { place: second, present }).includes(", in ruins)"),
    "a fallen place is in ruins",
  );
  assert.ok(
    worldWhereYouAreText(fantasy, { name: "The Crypt" }).includes("which this world does not list"),
    "without the ledger it is a place the world does not list",
  );
}

// ── A tag opener repeated without a closing "]" is read in one pass ──
{
  const timed = <T>(label: string, run: () => T): T => {
    const started = performance.now();
    const value = run();
    const took = performance.now() - started;
    assert.ok(took < 1000, `${label} took ${Math.round(took)} ms`);
    return value;
  };
  const repeat = 40000;
  assert.equal(timed("ledger", () => readWorldLedger(["[world:" + "[place:".repeat(repeat)])).length, 0);
  timed("world tags", () => answer(fantasy, "[world:".repeat(repeat)));
  timed("history tags", () => applyWorldHistoryTags("[history:".repeat(repeat), fantasy));
  assert.equal(timed("reputation read", () => readReputationTags("[reputation:".repeat(repeat))).length, 0);
  timed("reputation strip", () => stripReputationTags("[reputation:".repeat(repeat)));
  // A tag after the unclosed openers is still read.
  assert.equal(
    readReputationTags("[reputation:".repeat(100) + '[reputation: npc="Mira" action="helped"]').length,
    1,
  );
}

console.log("world ledger: ok");
