/**
 * Playing a story (worldgen W10b): one evaluation a turn, before the Game Master's reply.
 *
 *   - The Engine trips what it sees: the start, a turn, a day, an arrival (starting there, a place tag,
 *     a walk), a person named, a deed, a fight's outcome, flags. Once unless an event repeats, at most
 *     once a turn, in the script's order; a trip's flag changes can trip more the same turn.
 *   - A trip is recorded in the reply it happens before (its tag carries what it set and showed), its
 *     scenes are shown as written there, its world deeds answered with the reply's, and the Game Master
 *     is told what it asks and the scene to narrate, that very turn.
 *   - The Game Master's own story tags are answered in place: only what the script made its own; what
 *     it trips arrives at the start of the next reply. A regeneration tells the same turn again, once.
 *   - The player sees the objectives the story shows; a rewrite never changes what the Engine wrote.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  applyStoryTags,
  checkStoryScript,
  readToldLedger,
  refuseStoryTags,
  checkWorldBrief,
  compileGameWorld,
  createConnectionSchema,
  parseWorldKit,
  readStoryLedger,
  readWorldLedger,
  storyFightOutcome,
  storyObjectives,
  storyScriptPromptText,
  storyState,
  storyTurn,
  storyTurnPromptText,
  worldCast,
  type GameWorld,
  type StoryScript,
  type StoryScriptInput,
  type StoryTurnWorld,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-story-play-"));
process.env.DATA_DIR = dataDir;
// Lite mode: no background download of the local embedding model keeping the process alive after a turn.
process.env.MARINARA_LITE = "true";
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";

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
const stored = {
  seed: 31,
  generatorVersion: WORLD_GENERATOR_VERSION,
  grounding: "expand" as const,
  brief: checked.brief,
};
const game: GameWorld = { kit, ...stored, world: compileGameWorld({ kit, ...stored }) };
const ashford = game.world.places.find((place) => place.name === "Ashford")!;
const millbrook = game.world.places.find((place) => place.name === "Millbrook")!;
const startHere = game.world.places.find((place) => place.id === game.world.startId)!;
const away = [ashford, millbrook].find((place) => place.id !== startHere.id && startHere.parentId !== place.id)!;
const mayor = worldCast(game, ashford.id).find((person) => person.named)!;

const input: StoryScriptInput = {
  storyVersion: 1,
  flags: [
    { id: "trust", kind: "number", initial: 0, gm: true, note: "How far the town trusts the party" },
    { id: "arrived", kind: "bool", initial: false },
    {
      id: "key",
      kind: "bool",
      initial: false,
      quest: { title: "The mill key", text: "Find the mill key", hidden: true },
    },
    {
      id: "favours",
      kind: "number",
      initial: 0,
      quest: { title: "Favours", text: "Do the town three favours", goal: 3 },
    },
  ],
  directions: [
    { id: "wary", text: "The town is wary of strangers.", if: [{ flag: "trust", is: "<", value: 2 }] },
    { id: "warm", text: "The town greets the party warmly.", if: [{ flag: "trust", is: ">=", value: 2 }] },
  ],
  events: [
    { id: "opening", when: { on: "start" }, do: [{ tell: "Open on a rainy morning." }] },
    {
      id: "gates",
      when: { on: "arrive", place: away.id },
      do: [{ cutscene: "gates" }, { set: "arrived", value: true }, { show: "key" }],
    },
    {
      id: "welcome",
      when: { on: "flags" },
      if: [{ flag: "arrived", is: "=", value: true }],
      do: [{ add: "favours", amount: 1 }],
    },
    { id: "mayor", when: { on: "meet", person: mayor.id }, do: [{ add: "trust", amount: 1 }] },
    { id: "third", when: { on: "turn", turn: 5 }, do: [{ cutscene: "dusk" }] },
    { id: "won", when: { on: "fight", outcome: "victory" }, repeat: true, do: [{ add: "favours", amount: 1 }] },
    {
      id: "betrayal",
      when: { on: "gm" },
      gm: true,
      note: "The mayor turns on the party",
      if: [{ flag: "trust", is: ">=", value: 1 }],
      do: [
        { cutscene: "turn" },
        { cutscene: "dusk" },
        { tell: "The guards close in." },
        { world: { deed: "hinder", group: "The Red Hand" } },
      ],
    },
  ],
  cutscenes: [
    {
      id: "gates",
      kind: "pages",
      background: "backgrounds:generated:town-gates",
      pages: [
        { text: "The gates creak open." },
        { speaker: mayor.id, expression: "happy", text: "Welcome, travellers." },
        { speaker: "player", text: "We come in peace." },
      ],
    },
    { id: "dusk", kind: "beats", beats: ["Lamps are lit.", "A bell tolls."] },
    { id: "turn", kind: "pages", pages: [{ text: "The mayor's smile slips." }] },
  ],
};
const read = checkStoryScript(game, input);
assert.ok(read.ok, JSON.stringify(read));
const story: StoryScript = read.story;

const turnOf = (replies: string[], extra: Partial<StoryTurnWorld> = {}) => {
  return storyTurn(story, {
    game,
    replies,
    repliesBefore: replies.length,
    latest: replies.at(-1) ?? null,
    told: [],
    day: 0,
    fight: null,
    playerName: "Robin",
    ...extra,
  });
};

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { storyScenesOf, textRewriteChangesEngineText } =
  await import("../../packages/server/src/services/generation/text-rewrite-safety.js");
const { gameRepliesBefore } = await import("../../packages/server/src/services/game/game-market.service.js");

try {
  // ── The Engine's triggers ──
  const first = turnOf([]);
  assert.deepEqual(first.tripped, ["opening"], "the start, and nothing else yet");
  assert.deepEqual(first.tells, ["Open on a rainy morning."]);
  assert.match(first.prepend, /\[story: event="opening" by="engine" result="ok"\]/);
  assert.deepEqual(turnOf(["The rain."]).tripped, [], "the start only once");

  // Arriving (a place tag): the scene shown as written, its flags set, an objective shown, and the flags
  // event it trips the same turn.
  const arrival = [
    `[story: event="opening" by="engine" result="ok"] The rain.`,
    `[place: name="${away.name}" result="ok"] The road ends.`,
  ];
  const there = turnOf(arrival);
  assert.deepEqual(there.tripped, ["gates", "welcome"]);
  assert.match(there.prepend, /\[bg: backgrounds:generated:town-gates\]/);
  assert.ok(
    there.prepend.indexOf("[bg:") < there.prepend.indexOf("The gates creak open."),
    "the scene's background first",
  );
  assert.match(there.prepend, new RegExp(`\\[${mayor.name}\\] \\[main\\] \\[happy\\]: "Welcome, travellers\\."`));
  assert.match(there.prepend, /\[Robin\] \[main\] \[neutral\]: "We come in peace\."/, "the player, named");
  assert.match(there.prepend, /\[story: event="gates" set="arrived=true" show="key" by="engine" result="ok"\]/);
  assert.match(there.prepend, /\[story: event="welcome" set="favours=1" by="engine" result="ok"\]/);
  assert.equal(there.shown.length, 1);
  assert.deepEqual([there.state.flags.arrived, there.state.flags.favours, there.state.shown], [true, 1, ["key"]]);
  // Recorded, it never trips again; swiped away, it never happened.
  const afterArrival = [...arrival, `${there.prepend}They enter.`];
  // The mayor spoke in that scene, so the party has met them: that trips next, the arrival never again.
  const greeted = turnOf(afterArrival);
  assert.deepEqual(greeted.tripped, ["mayor"]);
  assert.deepEqual(turnOf([arrival[0]!]).tripped, [], "no arrival without its place tag");
  // Met in a reply, named in full.
  assert.deepEqual(turnOf(["The rain.", `${mayor.name} bows.`]).tripped, ["mayor"]);
  assert.deepEqual(turnOf(["The rain.", "Someone bows."]).tripped, []);

  // The fifth turn: a scene for the Game Master to narrate now.
  const settled = [...afterArrival, `${greeted.prepend}They talk.`];
  const fifth = turnOf(settled);
  assert.deepEqual(fifth.tripped, ["third"]);
  assert.deepEqual(fifth.beats, [["Lamps are lit.", "A bell tolls."]], "a scene to narrate now");
  // A fight won (it repeats), never a second trip a turn.
  const dusk = [...settled, `${fifth.prepend}Dusk.`];
  const fight = `*The battle is won.*\n\n[combat_result]\nOUTCOME: VICTORY (3 rounds)\n[/combat_result]`;
  assert.equal(storyFightOutcome(fight), "victory");
  assert.equal(storyFightOutcome("OUTCOME: VICTORY"), null, "only a combat recap says so");
  const won = turnOf(dusk, { fight: "victory" });
  assert.deepEqual(won.tripped, ["won"]);
  assert.deepEqual(turnOf([...dusk, `${won.prepend}x`], { fight: "victory" }).tripped, ["won"], "it repeats");
  assert.deepEqual(turnOf(dusk, { fight: "defeat" }).tripped, [], "only for its outcome");
  // A day and a deed trip on or after (and the deed only for its kind).
  const dated = checkStoryScript(game, {
    storyVersion: 1,
    events: [
      { id: "fifth", when: { on: "day", day: 5 }, do: [{ tell: "Day five." }] },
      { id: "helped", when: { on: "deed", deed: "help" }, repeat: true, do: [{ tell: "Helped." }] },
    ],
  });
  assert.ok(dated.ok);
  const datedTurn = (replies: string[], day: number) =>
    storyTurn(dated.story, {
      game,
      replies,
      repliesBefore: replies.length,
      latest: replies.at(-1) ?? null,
      told: [],
      day,
      fight: null,
    });
  assert.deepEqual(datedTurn([], 4).tripped, []);
  assert.deepEqual(datedTurn([], 9).tripped, ["fifth"], "a day passed over still counts");
  const help = `[world: deed="help" group="The Red Hand" result="ok"]`;
  assert.deepEqual(datedTurn([help], 0).tripped, ["helped"]);
  assert.deepEqual(datedTurn([help, `[story: event="helped" by="engine" result="ok"]`], 0).tripped, [], "once a deed");
  assert.deepEqual(
    datedTurn([help, `[story: event="helped" by="engine" result="ok"]`, help], 0).tripped,
    ["helped"],
    "and again for another",
  );
  assert.deepEqual(datedTurn([`[world: deed="hinder" group="The Red Hand" result="ok"]`], 0).tripped, []);
  // A repeating flags event happens when its conditions come true, not on every turn they stay true.
  const rising = checkStoryScript(game, {
    storyVersion: 1,
    flags: [{ id: "alarm", kind: "bool", initial: false, gm: true }],
    events: [
      {
        id: "bells",
        when: { on: "flags" },
        repeat: true,
        if: [{ flag: "alarm", is: "=", value: true }],
        do: [{ tell: "Bells." }],
      },
    ],
  });
  assert.ok(rising.ok);
  const bells = (replies: string[]) =>
    storyTurn(rising.story, {
      game,
      replies,
      repliesBefore: replies.length,
      latest: null,
      told: [],
      day: 0,
      fight: null,
    }).tripped;
  const raised = `[story: flag="alarm" set="alarm=true" result="ok"]`;
  const rang = `[story: event="bells" by="engine" result="ok"]`;
  const lowered = `[story: flag="alarm" set="alarm=false" result="ok"]`;
  assert.deepEqual(bells([]), [], "not while false");
  assert.deepEqual(bells([raised]), ["bells"]);
  assert.deepEqual(bells([raised, rang]), [], "not again while it stays true");
  assert.deepEqual(bells([raised, rang, "x"]), []);
  assert.deepEqual(bells([raised, rang, lowered, raised]), ["bells"], "again once it comes true again");

  // Arriving: by this turn's walk (its tags go before this reply), only while the party is there, and a
  // repeating arrival again only once the party has come back.
  const walked = turnOf(["The rain."], { told: readToldLedger(`[world: days="2"][place: name="${away.name}"]`) });
  assert.ok(walked.tripped.includes("gates"), "the walk's arrival, this very turn");
  const elsewhere = startHere.name;
  const comeAndGo = [`[place: name="${away.name}" result="ok"]`, `[place: name="${elsewhere}" result="ok"]`];
  const gated = checkStoryScript(game, {
    storyVersion: 1,
    flags: [{ id: "open", kind: "bool", initial: false, gm: true }],
    events: [
      {
        id: "once",
        when: { on: "arrive", place: away.id },
        if: [{ flag: "open", is: "=", value: true }],
        do: [{ tell: "In." }],
      },
      { id: "each", when: { on: "arrive", place: away.id }, repeat: true, do: [{ tell: "Again." }] },
    ],
  });
  assert.ok(gated.ok, JSON.stringify(gated));
  const arrive = (replies: string[], told = "") =>
    storyTurn(gated.story, {
      game,
      replies,
      repliesBefore: replies.length,
      latest: replies.at(-1) ?? null,
      told: readToldLedger(told),
      day: 0,
      fight: null,
    }).tripped;
  const opened = `[story: flag="open" set="open=true" result="ok"]`;
  assert.deepEqual(arrive([...comeAndGo, opened]), [], "the gates opened while the party was away: not there");
  assert.deepEqual(arrive([...comeAndGo, opened], `[place: name="${away.name}"]`), ["once", "each"], "back there");
  const been = [comeAndGo[0]!, `[story: event="each" by="engine" result="ok"]`];
  assert.deepEqual(arrive(been), [], "still there: not again");
  assert.deepEqual(arrive([...been, comeAndGo[1]!]), [], "gone");
  assert.deepEqual(arrive([...been, comeAndGo[1]!, comeAndGo[0]!]), ["each"], "come back: again");

  // A place the Game Master added inside the town is still the town: the party there is in it (a gated
  // arrival happens once the gates open), and stepping in is no new arrival.
  assert.deepEqual(
    storyTurn(gated.story, {
      game,
      replies: [comeAndGo[0]!, opened, `[place: name="The Gilded Gull" result="ok"]`],
      repliesBefore: 3,
      latest: null,
      told: [],
      added: [{ id: "a1", name: "The Gilded Gull", parentId: away.id }],
      day: 0,
      fight: null,
    }).tripped,
    ["once", "each"],
  );
  const tavern = [
    comeAndGo[0]!,
    `[story: event="each" by="engine" result="ok"]`,
    `[place: name="The Gilded Gull" result="ok"]`,
  ];
  assert.deepEqual(
    storyTurn(gated.story, {
      game,
      replies: tavern,
      repliesBefore: tavern.length,
      latest: tavern.at(-1)!,
      told: [],
      added: [{ id: "a1", name: "The Gilded Gull", parentId: away.id }],
      day: 0,
      fight: null,
    }).tripped,
    [],
  );
  // A repeating meet happens again only for a reply that names them again.
  const greeting = checkStoryScript(game, {
    storyVersion: 1,
    events: [{ id: "hi", when: { on: "meet", person: mayor.id }, repeat: true, do: [{ tell: "Hi." }] }],
  });
  assert.ok(greeting.ok);
  const greet = (replies: string[]) =>
    storyTurn(greeting.story, {
      game,
      replies,
      repliesBefore: replies.length,
      latest: replies.at(-1) ?? null,
      told: [],
      day: 0,
      fight: null,
    }).tripped;
  const said = `${mayor.name} nods.`;
  const greeted1 = `[story: event="hi" by="engine" result="ok"] The square.`;
  assert.deepEqual(greet([said]), ["hi"]);
  assert.deepEqual(greet([said, greeted1]), [], "not for the reply that already counted");
  assert.deepEqual(greet([said, greeted1, `Again, ${mayor.name}.`]), ["hi"], "again for a reply that names them");

  // A repeating event that would set itself off again is refused.
  const loops = checkStoryScript(game, {
    storyVersion: 1,
    events: [
      { id: "greet", when: { on: "meet", person: mayor.id }, repeat: true, do: [{ cutscene: "hello" }] },
      {
        id: "helped",
        when: { on: "deed", deed: "help" },
        repeat: true,
        do: [{ world: { deed: "help", group: "The Red Hand" } }],
      },
    ],
    cutscenes: [{ id: "hello", kind: "pages", pages: [{ speaker: mayor.id, text: "Hello again." }] }],
  });
  assert.ok(!loops.ok && /meet them again every turn/.test(loops.issues.join(" ")), JSON.stringify(loops));
  assert.ok(!loops.ok && /does the deed it waits for/.test(loops.issues.join(" ")));
  // A deed counts at its place by any name the place went by (a hand edit renamed it).
  const renamedGame: GameWorld = {
    ...game,
    edits: { editsVersion: 1, places: [{ id: ashford.id, name: "Newhaven" }] },
    world: compileGameWorld({
      kit,
      ...stored,
      edits: { editsVersion: 1, places: [{ id: ashford.id, name: "Newhaven" }] },
    }),
  };
  const atAshford = checkStoryScript(renamedGame, {
    storyVersion: 1,
    events: [{ id: "mended", when: { on: "deed", deed: "improve", place: ashford.id }, do: [{ tell: "Mended." }] }],
  });
  assert.ok(atAshford.ok);
  const improved = `[world: deed="improve" place="Ashford" result="ok"]`;
  assert.deepEqual(
    storyTurn(atAshford.story, {
      game: renamedGame,
      replies: [improved],
      repliesBefore: 1,
      latest: improved,
      told: [],
      day: 0,
      fight: null,
    }).tripped,
    ["mended"],
  );

  // ── The Game Master's own tags ──
  const state = storyState(story, readStoryLedger(dusk));
  const answered = applyStoryTags(
    [
      `[story: flag="trust" value="2"]`,
      `[story: event="betrayal"]`,
      `[story: event="betrayal"]`,
      `[story: event="gates"]`,
      `[story: event="nowhere"]`,
      `[story: flag="arrived" value="false"]`,
      `[story: flag="trust" value="lots"]`,
      `[story: event="mayor" by="engine" result="ok"]`,
    ].join(" "),
    story,
    game,
    state,
  );
  assert.match(answered, /\[story: flag="trust" set="trust=2" result="ok"\]/);
  assert.match(answered, /\[story: event="betrayal" result="ok"\]\[world: deed="hinder" group="The Red Hand"\]/);
  assert.match(answered, /\[story: event="betrayal" result="refused" reason="done"\]/, "once");
  assert.match(answered, /\[story: event="gates" result="refused" reason="not-yours"\]/);
  assert.match(answered, /\[story: event="nowhere" result="refused" reason="unknown-event"\]/);
  assert.match(answered, /\[story: flag="arrived" result="refused" reason="not-yours"\]/);
  assert.match(answered, /\[story: flag="trust" result="refused" reason="unreadable"\]/);
  assert.match(answered, /\[story: event="mayor" result="refused" reason="not-yours"\]/, "never the Engine's word");
  assert.match(
    applyStoryTags(`[story: event="betrayal"]`, story, game, storyState(story, [])),
    /reason="conditions"/,
    "its conditions first",
  );
  const spam = checkStoryScript(game, {
    storyVersion: 1,
    flags: [{ id: "n", kind: "number", initial: 0, gm: true }],
    events: [{ id: "shout", when: { on: "gm" }, gm: true, repeat: true, do: [{ add: "n", amount: 1 }] }],
  });
  assert.ok(spam.ok);
  const twice = applyStoryTags(
    `[story: event="shout"] [story: event="shout"]`,
    spam.story,
    game,
    storyState(spam.story, []),
  );
  assert.equal((twice.match(/result="ok"/g) ?? []).length, 1, "once a turn");
  assert.match(twice, /reason="this-turn"/);
  assert.match(
    applyStoryTags(`[story: event="shout"]`, spam.story, game, storyState(spam.story, []), ["shout"]),
    /reason="this-turn"/,
    "nor after the Engine tripped it this turn",
  );
  assert.match(
    applyStoryTags(
      `[story: flag="n" add="1e308"] [story: flag="n" add="1e308"]`,
      spam.story,
      game,
      storyState(spam.story, []),
    ),
    /set="n=1e\+308" result="ok"\] \[story: flag="n" result="refused" reason="unreadable"\]/,
    "never past a number a record can hold",
  );
  assert.equal(
    refuseStoryTags(`A. [story: event="x" set="favours=3" result="ok"] [story: flag="y" value="1"]`),
    `A. [story: event="x" result="refused" reason="no-story"] [story: flag="y" result="refused" reason="no-story"]`,
    "with no story, nothing a tag claims can count",
  );
  // What it tripped arrives at the start of the next reply: its scene and its ask, not its deed again.
  const next = turnOf([...dusk, answered]);
  assert.match(next.prepend, /The mayor's smile slips\./);
  assert.ok(!/deed="hinder"/.test(next.prepend));
  assert.deepEqual(next.tells, ["The guards close in."]);
  // Its beats were told with the moment (below), so they never come again after it.
  assert.deepEqual(next.beats, []);
  assert.ok(!/Narrate this scene now/.test(storyTurnPromptText(story, next)));
  assert.deepEqual(turnOf([...dusk, answered, "Later."]).tells, [], "and only then");

  // A gm event's beats: each scene once, and all of them kept to what a prompt can carry every turn.
  const long = Array.from({ length: 20 }, (_, n) => `${n} ${"a".repeat(590)}`);
  const beatsStory = (events: Array<{ id: string; scenes: string[]; engine?: true }>) =>
    checkStoryScript(game, {
      storyVersion: 1,
      events: events.map((event) => ({
        id: event.id,
        ...(event.engine ? { when: { on: "turn", turn: 2 } } : { when: { on: "gm" }, gm: true }),
        do: event.scenes.map((scene) => ({ cutscene: scene })),
      })),
      cutscenes: [{ id: "long", kind: "beats", beats: long }],
    });
  const once = beatsStory([{ id: "twice", scenes: ["long", "long"] }]);
  assert.ok(once.ok, "a scene used twice is counted once");
  assert.equal((storyScriptPromptText(once.story).match(/ {2}- 0 a/g) ?? []).length, 1, "and told once");
  const tooMany = beatsStory([
    { id: "one", scenes: ["long"] },
    { id: "two", scenes: ["long"] },
  ]);
  assert.ok(
    beatsStory([
      { id: "one", scenes: ["long"] },
      { id: "two", scenes: ["long"], engine: true },
    ]).ok,
    "an Engine event's beats are told only when it happens",
  );
  assert.ok(!tooMany.ok);
  assert.ok(
    tooMany.issues.includes(
      `The Game Master's own events have ${2 * long.join("").length} characters of beats, told on every turn; keep them to 16000.`,
    ),
    tooMany.issues.join("; "),
  );

  // ── What the Game Master and the player are told ──
  const script = storyScriptPromptText(story);
  assert.match(
    script,
    /- betrayal: The mayor turns on the party\n {2}When you mark it, narrate this with it, in your own words, beat by beat:\n {2}- Lamps are lit\.\n {2}- A bell tolls\./,
    "with the beats it narrates as it marks it",
  );
  assert.match(script, /- trust \(a number\): How far the town trusts the party/);
  assert.ok(!/gates|Welcome|arrived/.test(script), "nothing else of the script");
  const now = storyTurnPromptText(story, there);
  assert.match(now, /trust = 0/);
  assert.match(now, /The town is wary of strangers\./);
  assert.ok(!/greets the party warmly/.test(now), "only the directions in force");
  assert.match(now, /shown this scene as written/);
  // Its own moments it cannot mark now are named, never why: held back by their conditions, then done.
  assert.match(now, /\nStory moments you cannot mark now: betrayal\.$/);
  assert.match(storyTurnPromptText(story, next), /cannot mark now: betrayal\./, "done, and it does not repeat");
  const open = turnOf(dusk, { latest: null });
  assert.ok(open.state.flags.trust === 1 && !/cannot mark now/.test(storyTurnPromptText(story, open)));
  // Only the marking is closed: a gm moment the Engine trips this turn still has its beats told now.
  const both = checkStoryScript(game, {
    storyVersion: 1,
    // It repeats, so only being the Engine's this turn closes it.
    events: [{ id: "toll", when: { on: "turn", turn: 1 }, gm: true, repeat: true, do: [{ cutscene: "dusk" }] }],
    cutscenes: [{ id: "dusk", kind: "beats", beats: ["Lamps are lit."] }],
  });
  assert.ok(both.ok);
  const tolled = storyTurn(both.story, {
    game,
    replies: [],
    repliesBefore: 0,
    latest: null,
    told: [],
    day: 0,
    fight: null,
  });
  assert.deepEqual(tolled.tripped, ["toll"]);
  assert.equal(
    storyTurnPromptText(both.story, tolled),
    "Narrate this scene now, in your own words, beat by beat:\n- Lamps are lit.\nStory moments you cannot mark now: toll.",
  );
  assert.deepEqual(
    storyObjectives(story, storyState(story, [])).map((each) => each.title),
    ["Favours"],
    "a hidden objective waits to be shown",
  );
  const shownNow = storyObjectives(story, there.state);
  assert.deepEqual(
    shownNow.map((each) => [each.title, each.done, each.progress ?? null]),
    [
      ["The mill key", false, null],
      ["Favours", false, { at: 1, goal: 3 }],
    ],
  );

  // ── A rewrite never changes what the Engine wrote ──
  const written = `${there.prepend}They enter.`;
  assert.equal(textRewriteChangesEngineText(written, `${there.prepend}They walk in.`, there.shown), false);
  assert.equal(textRewriteChangesEngineText(written, written.replace("creak open", "swing wide"), there.shown), true);
  const tagged = `A. [world: days="2" result="ok"]`;
  assert.equal(textRewriteChangesEngineText(tagged, "A.", []), true, "nor drops a tag");
  assert.equal(
    textRewriteChangesEngineText(tagged, `${tagged} [world: days="2" result="ok"]`, []),
    true,
    "nor doubles one",
  );
  assert.equal(
    textRewriteChangesEngineText(tagged, `${tagged} [story: event="won" by="engine" result="ok"]`, []),
    true,
    "nor adds one",
  );
  assert.equal(
    textRewriteChangesEngineText(tagged, tagged.replace("A.", "Ah."), []),
    false,
    "the prose is the rewrite's",
  );
  assert.deepEqual(storyScenesOf(JSON.stringify({ worldShownScenes: ["x"] })), ["x"]);

  // A tag opener repeated without a closing "]" is read in one pass, not from every start to the end.
  for (const [name, read] of [
    ["applyStoryTags", (text: string) => applyStoryTags(text, story, game, storyState(story, []))],
    ["refuseStoryTags", refuseStoryTags],
    ["textRewriteChangesEngineText", (text: string) => textRewriteChangesEngineText(text, text, [])],
  ] as const) {
    const started = performance.now();
    read("[story:".repeat(40000));
    read("[world:".repeat(40000));
    read(`[story:${"a".repeat(40000)}]`);
    const took = performance.now() - started;
    assert.ok(took < 1000, `${name} read unclosed openers in ${Math.round(took)} ms`);
  }
  assert.match(
    refuseStoryTags(`${"[story:".repeat(100)} [story: flag="y" value="1"]`),
    /\[story: flag="y" result="refused" reason="no-story"\]/,
    "a tag after unclosed openers is still read",
  );

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
  standIn.unref();
  const address = standIn.address();
  assert.ok(address && typeof address !== "string");
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  await app.register(generateRoutes, { prefix: "/api/generate" });
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
    const chats = createChatsStorage(db);
    const chat = (await chats.create({ name: "Story", mode: "game", characterIds: [], connectionId: connection!.id }))!;
    const chatId = chat.id;
    await chats.patchMetadata(chatId, {
      gameId: `story-${chatId}`,
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameWorldKit: kit,
      gameWorld: stored,
      gameStory: story,
      gameTime: { day: 1, hour: 10, minute: 0 },
    });
    const turn = async (reply: string, extra: Record<string, unknown> = {}) => {
      replies.push(reply);
      prompts.length = 0;
      const response = await app.inject({
        method: "POST",
        url: "/api/generate/",
        payload: { chatId, userMessage: "We go on.", streaming: false, ...extra },
      });
      assert.equal(response.statusCode, 200, response.body);
    };
    const gmReplies = async () =>
      (await chats.listMessages(chatId)).filter((message: { role: string }) => message.role === "assistant");

    // The first turn: the start trips, and the Game Master is told what it asks, that turn.
    await turn("Rain on the roofs.");
    const prompt1 = prompts.join("\n");
    assert.match(prompt1, /Open on a rainy morning\./);
    assert.match(prompt1, /betrayal: The mayor turns on the party/, "its own events in the system prompt");
    assert.ok(!/Welcome, travellers/.test(prompt1), "never a scene before it happens");
    const reply1 = (await gmReplies()).at(-1)!;
    assert.match(reply1.content, /^\[story: event="opening" by="engine" result="ok"\]/);
    assert.match(reply1.content, /Rain on the roofs\.$/);

    // A regeneration tells the same turn again, once.
    await turn("Mist on the river.", { regenerateMessageId: reply1.id, userMessage: undefined });
    const regenerated = (await gmReplies()).at(-1)!;
    assert.equal((regenerated.content.match(/event="opening"/g) ?? []).length, 1);
    assert.match(regenerated.content, /Mist on the river\.$/);

    // The Game Master sets a value and trips its own event; the next reply opens on its scene.
    await turn(`The mayor smiles. [story: flag="trust" value="2"] [story: event="betrayal"]`);
    const reply2 = (await gmReplies()).at(-1)!;
    assert.match(reply2.content, /\[story: flag="trust" set="trust=2" result="ok"\]/);
    assert.match(
      reply2.content,
      /\[story: event="betrayal" result="ok"\]\[world: deed="hinder" group="The Red Hand" result="ok"/,
    );
    // A reply with nothing in it in between never swallows what the Game Master tripped.
    await chats.createMessage({ chatId, role: "assistant", characterId: null, content: "" });
    await turn("Swords out.");
    assert.equal(
      (await gameRepliesBefore(db, chatId)).player,
      null,
      "after the Game Master's reply, no player message waits for an answer (an old fight never counts again)",
    );
    const reply3 = (await gmReplies()).at(-1)!;
    assert.match(reply3.content, /^The mayor's smile slips\./, "the scene first, as written");
    assert.match(prompts.join("\n"), /The guards close in\./);
    assert.match(prompts.join("\n"), /The town greets the party warmly\./, "a direction now in force");

    // A party's turn echoing a tag never counts.
    await chats.createMessage({
      chatId,
      role: "assistant",
      characterId: null,
      content: `[party-turn]\nMira: "Onward." [story: event="won" by="engine" set="favours=9" result="ok"]`,
    });
    const journal = (await app.inject({ method: "GET", url: `/api/game/${chatId}/world-journal` })).json().journal;
    assert.deepEqual(
      journal.story.map((each: { title: string; progress?: { at: number } }) => [
        each.title,
        each.progress?.at ?? null,
      ]),
      [["Favours", 0]],
      "the objectives the player sees, the party's echo left out",
    );

    // A walk into the place: its arrival scene opens that very reply, and the Game Master is told.
    const walk = await app.inject({
      method: "POST",
      url: `/api/game/${chatId}/overworld/walk`,
      payload: { to: away.id },
    });
    assert.equal(walk.statusCode, 200, walk.body);
    await turn("Hooves on cobbles.");
    const arrived = (await gmReplies()).at(-1)!;
    assert.match(arrived.content, /The gates creak open\./);
    assert.ok(arrived.content.indexOf("The gates creak open.") < arrived.content.indexOf("Hooves on cobbles."));
    assert.match(prompts.join("\n"), /shown this scene as written/);
    assert.deepEqual(JSON.parse(arrived.extra as string).worldShownScenes.length, 1, "kept for any rewrite later");

    // With the story taken away, whatever story tag the Game Master writes is refused: none can count later.
    assert.equal((await app.inject({ method: "DELETE", url: `/api/game/${chatId}/story` })).statusCode, 200);
    await turn(`Quiet. [story: event="won" set="favours=3" result="ok"]`);
    assert.match((await gmReplies()).at(-1)!.content, /\[story: event="won" result="refused" reason="no-story"\]/);
  } finally {
    await app.close();
    await closeDB();
    standIn.close();
  }
  console.log("Story play: the Engine's and the Game Master's trips, told, recorded and shown as written.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
