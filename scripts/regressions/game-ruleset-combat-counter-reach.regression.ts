/**
 * An answer that reaches only so high (Capability API 1.116): 5e's Counterspell.
 *
 *   - `upTo: "paid"` on a `used` reaction that cancels stops what was paid no higher up its pool
 *     family than the answer was, outright and without a roll.
 *   - Above that, `above: { check, dc }` throws the fight's dice plus the check against `dc` plus the
 *     level: a success stops it, a failure lets it land. Without `above` nothing higher is stopped.
 *   - Paying the answer out of a higher pool raises how high it reaches.
 *   - A level is a pool's own `level` read off the sheet, or its place in its group; nothing paid is 0.
 *   - Import and the install gate (1.116).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyRulesetCombatChoice,
  createRulesetEncounter,
  parseRulesetDefinition,
  rowsFromCatalogEntry,
  rulesetCombatant,
  rulesetCombatOptions,
  rulesetPaidLevel,
  rulesetSheetBuildSchema,
  rulesetWindowOptions,
  type RulesetCatalogEntry,
  type RulesetCombatantInput,
  type RulesetCombatEvent,
  type RulesetCombatRoller,
  type RulesetDefinition,
  type RulesetEncounterState,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-counter-reach-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");

const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

try {
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const fiveE = (edit: (doc: Record<string, any>) => void = () => {}): Record<string, any> => {
    const doc = JSON.parse(fiveEText) as Record<string, any>;
    edit(doc);
    return doc;
  };
  const parsedOrThrow = (document: unknown, what: string): RulesetDefinition => {
    const parsed = parseRulesetDefinition(document);
    assert.ok(parsed.ok, `${what} must import cleanly: ${parsed.ok ? "" : parsed.issues.join("; ")}`);
    return parsed.definition;
  };
  const refused = (document: unknown, pattern: RegExp, what: string) => {
    const parsed = parseRulesetDefinition(document);
    assert.equal(parsed.ok, false, `${what}: the file should be refused`);
    if (parsed.ok) return;
    assert.ok(
      parsed.issues.some((issue) => pattern.test(issue)),
      `${what}: expected ${pattern}, got ${parsed.issues.join("; ")}`,
    );
  };
  const dice = (...faces: number[]): RulesetCombatRoller => {
    let index = 0;
    return (sides) => {
      assert.ok(index < faces.length, `the script ran out of dice (a d${sides} was asked for)`);
      return faces[index++]!;
    };
  };
  type EventOf<T extends RulesetCombatEvent["type"]> = Extract<RulesetCombatEvent, { type: T }>;
  const eventsOf = <T extends RulesetCombatEvent["type"]>(events: RulesetCombatEvent[], type: T): EventOf<T>[] =>
    events.filter((event): event is EventOf<T> => event.type === type);

  const counterReaction = (extra: Record<string, unknown> = {}) => ({
    on: "used",
    cancels: true,
    against: { catalogs: ["spells"] },
    upTo: "paid",
    above: { check: { abilityModFromField: "spellcasting_ability" }, dc: 10 },
    ...extra,
  });
  const spells = (reaction: Record<string, unknown> = counterReaction()): RulesetCatalogEntry[] =>
    [
      {
        id: "bolt",
        label: "Bolt",
        rows: [{ list: "spells", values: { name: "Bolt", level: 1, prepared: true } }],
        mechanics: {
          kind: "attack",
          autoHit: true,
          amount: { flat: 3 },
          damageType: "fire",
          cost: [{ pool: "slots_1", amount: 1 }],
          perCostStep: { flat: 1 },
        },
      },
      {
        id: "counter",
        label: "Counter",
        rows: [{ list: "spells", values: { name: "Counter", level: 3, prepared: true } }],
        mechanics: {
          kind: "utility",
          budget: "reaction",
          cost: [{ pool: "slots_3", amount: 1 }],
          reaction,
        },
      },
    ] as unknown as RulesetCatalogEntry[];
  const caster = (entries: RulesetCatalogEntry[], abilities: Record<string, number>) =>
    rulesetSheetBuildSchema.parse({
      abilities: { str: 8, con: 12, wis: 12, cha: 10, ...abilities },
      fields: {
        level: 9,
        ac: 12,
        speed: 30,
        hp_max: 40,
        spellcasting_ability: "int",
        slots_max_1: 4,
        slots_max_2: 3,
        slots_max_3: 3,
        slots_max_4: 3,
        slots_max_5: 1,
      },
      lists: { spells: entries.flatMap((entry) => rowsFromCatalogEntry("spells", entry).map((row) => row.row)) },
    });
  /** The mage first, and Corwin, who answers it: Int 18, so +4 on the check. */
  const fight = (definition: RulesetDefinition, entries = spells()): RulesetEncounterState =>
    createRulesetEncounter({
      definition,
      seed: 1,
      roller: () => 10,
      bestiary: { spells: entries },
      combatants: [
        {
          id: "mage",
          name: "Mage",
          side: "enemy",
          block: { sheet: caster(entries, { dex: 20, int: 16 }), actions: [] },
        } as RulesetCombatantInput,
        {
          id: "corwin",
          name: "Corwin",
          side: "party",
          build: caster(entries, { dex: 1, int: 18 }),
          live: {},
          catalogs: { spells: entries },
        },
      ],
    });
  const definition = parsedOrThrow(fiveE(), "the 5e example");
  const bolt = (state: RulesetEncounterState, payWith?: string) => {
    const option = rulesetCombatOptions(definition, state, "mage").find((entry) => entry.label === "Bolt");
    assert.ok(option, "the mage has its bolt");
    const held = applyRulesetCombatChoice(
      definition,
      state,
      { actorId: "mage", optionId: option.id, targetIds: ["corwin"], ...(payWith ? { payWith } : {}) },
      dice(),
    );
    assert.ok(held.state.window, JSON.stringify(held.events));
    return held;
  };
  const answer = (held: ReturnType<typeof bolt>, payWith: string | undefined, ...faces: number[]) => {
    const option = rulesetWindowOptions(definition, held.state, "corwin").find((entry) => entry.label === "Counter");
    assert.ok(option, "Corwin may answer");
    return applyRulesetCombatChoice(
      definition,
      held.state,
      {
        actorId: "corwin",
        optionId: option.id,
        targetIds: [],
        window: held.state.window!.id,
        ...(payWith ? { payWith } : {}),
      },
      dice(...faces),
    );
  };

  // ── Levels ──
  {
    const state = fight(definition);
    const mage = rulesetCombatant(state, "mage")!;
    const boltAction = mage.actions.find((action) => action.label === "Bolt")!;
    assert.equal(rulesetPaidLevel(definition, mage, boltAction), 1, "the first slot of the family");
    assert.equal(rulesetPaidLevel(definition, mage, boltAction, "slots_5"), 5);
    assert.equal(rulesetPaidLevel(definition, mage, { ...boltAction, use: undefined }), 0, "nothing paid");
    assert.equal(rulesetPaidLevel(definition, mage, boltAction, "pact_slots"), 1, "a group of one");
    const pact = parsedOrThrow(
      fiveE((doc) => {
        doc.sheet.live.pools.find((pool: { id: string }) => pool.id === "pact_slots").level = { const: 3 };
      }),
      "pact slots that say their level",
    );
    assert.equal(rulesetPaidLevel(pact, mage, boltAction, "pact_slots"), 3, "the pool's own level");
    assert.deepEqual(
      rulesetCombatant(state, "corwin")!.actions.find((action) => action.label === "Counter")!.reaction,
      {
        on: "used",
        at: "source",
        cancels: true,
        against: { catalogs: ["spells"] },
        upTo: "paid",
        above: { modifier: 4, dc: 10 },
      },
      "the check read off his sheet as the fight began",
    );
  }

  // ── Stopping what is low enough, outright ──
  {
    const stopped = answer(bolt(fight(definition)), undefined);
    assert.deepEqual(eventsOf(stopped.events, "counter"), [], "no roll for a first-level bolt");
    assert.equal(eventsOf(stopped.events, "cancelled").length, 1);
    assert.deepEqual(eventsOf(stopped.events, "damage"), []);
    // Paid out of the third slot exactly: still its own level.
    const third = answer(bolt(fight(definition), "slots_3"), undefined);
    assert.equal(eventsOf(third.events, "cancelled").length, 1);
    assert.deepEqual(eventsOf(third.events, "counter"), []);
  }

  // ── Above it, a check against 10 + the level ──
  {
    const held = bolt(fight(definition), "slots_5");
    const made = answer(held, undefined, 11);
    assert.deepEqual(eventsOf(made.events, "counter"), [
      {
        type: "counter",
        actorId: "corwin",
        targetId: "mage",
        label: "Bolt",
        level: 5,
        reach: 3,
        rolls: [11],
        kept: 11,
        modifier: 4,
        total: 15,
        difficulty: 15,
        success: true,
      },
    ]);
    assert.equal(eventsOf(made.events, "cancelled").length, 1, "meeting the number stops it");
    assert.deepEqual(eventsOf(made.events, "damage"), []);
    const missed = answer(bolt(fight(definition), "slots_5"), undefined, 10);
    const [counter] = eventsOf(missed.events, "counter");
    assert.deepEqual([counter?.total, counter?.difficulty, counter?.success], [14, 15, false]);
    assert.deepEqual(eventsOf(missed.events, "cancelled"), [], "one short lets it through");
    const [damage] = eventsOf(missed.events, "damage");
    assert.equal(damage?.targetId, "corwin", "and the bolt lands");
    assert.equal(damage?.amount, 7, "upcast four steps: 3 + 4");
    assert.ok(
      eventsOf(missed.events, "spend").some((spend) => spend.actorId === "corwin" && spend.pool === "slots_3"),
      "what the answer cost is spent either way",
    );
  }

  // ── Paying the answer higher raises how high it reaches ──
  {
    const raised = answer(bolt(fight(definition), "slots_5"), "slots_5");
    assert.deepEqual(eventsOf(raised.events, "counter"), [], "a fifth-level answer reaches a fifth-level bolt");
    assert.equal(eventsOf(raised.events, "cancelled").length, 1);
    const fourth = answer(bolt(fight(definition), "slots_5"), "slots_4", 11);
    assert.equal(eventsOf(fourth.events, "counter")[0]?.reach, 4);
    assert.equal(eventsOf(fourth.events, "counter")[0]?.difficulty, 15);
  }

  // ── Without a check, what is higher is not stopped ──
  {
    const entries = spells(counterReaction({ above: undefined }));
    const held = bolt(fight(definition, entries), "slots_4");
    const option = rulesetWindowOptions(definition, held.state, "corwin").find((entry) => entry.label === "Counter")!;
    const tried = applyRulesetCombatChoice(
      definition,
      held.state,
      { actorId: "corwin", optionId: option.id, targetIds: [], window: held.state.window!.id },
      dice(),
    );
    assert.deepEqual(eventsOf(tried.events, "counter"), [
      { type: "counter", actorId: "corwin", targetId: "mage", label: "Bolt", level: 4, reach: 3, success: false },
    ]);
    assert.deepEqual(eventsOf(tried.events, "cancelled"), []);
    assert.equal(eventsOf(tried.events, "damage").length, 1);
    // An answer with no `upTo` stops anything, as before.
    const plain = spells(counterReaction({ upTo: undefined, above: undefined }));
    const old = bolt(fight(definition, plain), "slots_5");
    const oldOption = rulesetWindowOptions(definition, old.state, "corwin").find((entry) => entry.label === "Counter")!;
    const stopped = applyRulesetCombatChoice(
      definition,
      old.state,
      { actorId: "corwin", optionId: oldOption.id, targetIds: [], window: old.state.window!.id },
      dice(),
    );
    assert.equal(eventsOf(stopped.events, "cancelled").length, 1);
  }

  // ── Import ──
  {
    const withCreatureCounter = (reaction: Record<string, unknown>) =>
      fiveE((doc) => {
        const creature = doc.catalogs
          .find((one: { id: string }) => one.id === "creatures")
          .entries.find((one: { id: string }) => one.id === "grave-piper").creature;
        creature.actions.push({ id: "hush", name: "Hush", budget: "reaction", reaction });
      });
    refused(withCreatureCounter({ on: "used", upTo: "paid" }), /"upTo" says how much/, "upTo without cancels");
    refused(
      withCreatureCounter({ on: "aimed", cancels: true, upTo: "paid" }),
      /"upTo" says how much/,
      "upTo on another moment",
    );
    refused(
      withCreatureCounter({ on: "used", cancels: true, above: { check: { const: 3 }, dc: 10 } }),
      /"above" is the check/,
      "above without upTo",
    );
    refused(
      withCreatureCounter({ on: "used", cancels: true, upTo: "paid", above: { check: { field: "level" }, dc: 10 } }),
      /writes its check as/,
      "a creature reading a sheet it has not got",
    );
    parsedOrThrow(
      withCreatureCounter({ on: "used", cancels: true, upTo: "paid", above: { check: { const: 3 }, dc: 10 } }),
      "a creature's own number",
    );
    refused(
      fiveE((doc) => {
        doc.sheet.live.pools.find((pool: { id: string }) => pool.id === "pact_slots").level = { field: "nothing" };
      }),
      /pact_slots|level|nothing/,
      "a pool level reading nothing",
    );
  }

  // ── The install gate: 1.116 ──
  {
    const manifest = (minor: number) => ({
      schemaVersion: 2,
      capabilityApi: { major: 1, minor },
      builtAgainst: { engineVersion: "2.4.6", engineCommit: "0".repeat(40) },
      id: "ruleset-counter",
      name: "Counter",
      version: "0.1.0",
      description: "A packaged ruleset whose counters reach only so high.",
      engine: { min: "2.4.6", maxExclusive: "4.0.0" },
      kind: ["ruleset"],
      entrypoints: {},
      contributions: { assets: { paths: ["ruleset.json"] } },
      files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
      permissions: [],
      restartRequired: false,
    });
    const gate = /stop only what was paid no higher.*capabilityApi 1\.116/;
    const issue = (minor: number, doc: Record<string, any>) =>
      getCapabilityPackageInstallIssue(manifest(minor) as any, doc);
    const withCounter = (doc: Record<string, any>) => {
      doc.catalogs.push({ id: "spells", label: "Spells", entries: spells() });
    };
    const withPoolLevel = (doc: Record<string, any>) => {
      doc.sheet.live.pools.find((pool: { id: string }) => pool.id === "pact_slots").level = { const: 3 };
    };
    for (const [what, edit] of [
      ["a counter", withCounter],
      ["a pool's level", withPoolLevel],
    ] as const) {
      assert.match(issue(115, fiveE(edit)) ?? "", gate, what);
      assert.doesNotMatch(issue(116, fiveE(edit)) ?? "", gate, what);
    }
    assert.doesNotMatch(issue(115, fiveE()) ?? "", gate, "the example as shipped asks nothing new");
  }

  console.log("Counter reach: stopped outright up to its own level, a check above it, gated at 1.116.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
