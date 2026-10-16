/**
 * Resilient Sphere (Capability API 1.314).
 *
 *   - A condition's `sealed`: nobody else aims at its holder or catches them in an area, nothing from
 *     anybody else harms, heals or puts a condition on them (auras included), nothing of theirs reaches
 *     anybody else, and nobody strikes at them as they move.
 *   - `rolls`: their own movement is none, but spending the budget rolls them a share of their speed.
 *   - `lifted`: somebody next to them picks them up, and they go where that one walks until put down.
 *   - `brokenBy`: Disintegrate may be aimed at the one inside, and ends the sphere and its
 *     concentration instead of harming them.
 *   - Mechanics `targetsUpTo`: aimed only at creatures that size or smaller.
 *   - Import refusals, and the install gate.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  advanceRulesetTurn,
  applyRulesetCombatChoice,
  rulesetActiveConditions,
  createRulesetEncounter,
  parseRulesetDefinition,
  rowsFromCatalogEntry,
  RULESET_MOVE_OPTION,
  rulesetCombatant,
  rulesetCombatOptions,
  rulesetMovementAllowance,
  rulesetOptionTargets,
  rulesetSheetBuildSchema,
  supportedCapabilityApi,
  type RulesetCatalogEntry,
  type RulesetCombatChoice,
  type RulesetCombatEvent,
  type RulesetCombatStep,
  type RulesetDefinition,
  type RulesetEncounterState,
  type RulesetStatBlock,
  type RulesetSheetItem,
} from "../../packages/shared/src/index.js";
import { rulesetThreateningEnemies } from "../../packages/shared/src/features/ruleset-combat/grid.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-sphere-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

try {
  assert.ok(supportedCapabilityApi.minor >= 309);
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const spell = (id: string, label: string, level: number, mechanics: Record<string, unknown>) =>
    ({
      id,
      label,
      rows: [{ list: "spells", values: { name: label, level, prepared: true } }],
      mechanics: { cost: [{ pool: `slots_${level}`, amount: 1 }], ...mechanics },
    }) as unknown as RulesetCatalogEntry;
  const sphere = spell("sphere", "Resilient Sphere", 4, {
    kind: "debuff",
    targets: "any",
    range: 30,
    concentration: true,
    targetsUpTo: "large",
    save: { save: "dex_save", onSuccess: "negates" },
    applies: [{ condition: "sphered", duration: { rounds: 10 } }],
  });
  const disintegrate = spell("disintegrate", "Disintegrate", 5, {
    kind: "attack",
    range: 60,
    amount: { flat: 40 },
    damageType: "force",
    save: { save: "dex_save", onSuccess: "negates" },
  });
  const bolt = spell("bolt", "Bolt", 1, { kind: "attack", range: 60, autoHit: true, amount: { flat: 7 } });
  const blast = spell("blast", "Blast", 1, {
    kind: "attack",
    range: 60,
    amount: { flat: 9 },
    damageType: "fire",
    save: { save: "dex_save", onSuccess: "half" },
    area: { shape: "burst", size: 15 },
  });
  const mend = spell("mend", "Mend", 1, { kind: "heal", targets: "any", range: 60, amount: { flat: 5 } });
  const smoke = spell("smoke", "Smoke", 2, {
    kind: "utility",
    range: 120,
    area: { shape: "burst", size: 10 },
    zone: { rounds: 10, triggers: [], inside: { conditions: ["scorched"] } },
  });
  const snare = spell("snare", "Snare", 1, {
    kind: "debuff",
    range: 120,
    autoHit: true,
    area: { shape: "burst", size: 5 },
    applies: [{ condition: "scorched", duration: { rounds: 10 } }],
    zone: { rounds: 10, triggers: ["enter"] },
  });
  const spells = [sphere, disintegrate, bolt, blast, mend, smoke, snare];
  const sealed = {
    rolls: { budget: "action", share: 0.5 },
    lifted: { budget: "action" },
    brokenBy: ["spells/disintegrate"],
  };
  const document = (edit: (doc: Record<string, any>) => void = () => {}): Record<string, any> => {
    const doc = JSON.parse(fiveEText) as Record<string, any>;
    doc.sheet.live.conditions.push(
      { id: "sphered", label: "Sphere" },
      { id: "nimbus", label: "Nimbus" },
      { id: "scorched", label: "Scorched" },
    );
    doc.combat.conditions.push(
      { condition: "sphered", effects: [], sealed: structuredClone(sealed) },
      { condition: "nimbus", effects: [], auras: [{ distance: 30, side: "enemies", conditions: ["scorched"] }] },
      { condition: "scorched", effects: [], harms: { at: "turn-start", flat: 10, type: "radiant" } },
    );
    doc.combat.sizes = {
      order: ["small", "medium", "large", "huge"].map((id) => ({ id, label: id })),
      default: "medium",
    };
    doc.catalogs.push({ id: "spells", label: "Spells", feeds: ["spells"], entries: structuredClone(spells) });
    edit(doc);
    return doc;
  };
  const parsed = (doc: unknown): RulesetDefinition => {
    const result = parseRulesetDefinition(doc);
    assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
    return result.definition;
  };
  const refused = (doc: unknown, pattern: RegExp) => {
    const result = parseRulesetDefinition(doc);
    assert.equal(result.ok, false, `should be refused: ${pattern}`);
    if (!result.ok) assert.match(result.issues.join("; "), pattern);
  };
  const definition = parsed(document());
  const combat = definition.combat!;
  const of = <T extends RulesetCombatEvent["type"]>(events: RulesetCombatEvent[], type: T) =>
    events.filter((one): one is Extract<RulesetCombatEvent, { type: T }> => one.type === type);
  let d20 = 1;
  const roll = (sides: number) => (sides === 20 ? d20 : 1);
  const fields: Record<string, number> = { level: 11, ac: 12, speed: 30, hp_max: 60 };
  for (let level = 1; level <= 5; level++) fields[`slots_max_${level}`] = 4;
  const build = rulesetSheetBuildSchema.parse({
    abilities: { str: 10, dex: 10, con: 14, int: 16, wis: 10, cha: 10 },
    fields: { ...fields, spellcasting_ability: "int" },
    lists: { spells: spells.flatMap((entry) => rowsFromCatalogEntry("spells", entry).map((row) => row.row)) },
  });
  const foe = (id: string, size = "medium") => ({
    id,
    name: id.toUpperCase(),
    side: "enemy" as const,
    block: {
      health: 100,
      defense: 5,
      initiativeModifier: 0,
      speed: 30,
      size,
      actions: [
        { id: "claw", name: "Claw", budget: "action", toHit: 4, reach: 5, damage: { count: 0, sides: 0, flat: 1 } },
      ],
    } as unknown as RulesetStatBlock,
  });
  const fight = (items?: RulesetSheetItem[]): RulesetEncounterState => {
    const state = createRulesetEncounter({
      definition,
      seed: 1,
      roller: () => 10,
      combatants: [
        { id: "mage", name: "Mage", side: "party", build, live: {}, catalogs: { spells }, ...(items ? { items } : {}) },
        { id: "ally", name: "Ally", side: "party", build, live: {}, catalogs: { spells } },
        foe("a"),
        foe("b"),
        foe("giant", "huge"),
      ],
      board: {
        grid: { width: 20, height: 9, tiles: Array.from({ length: 9 }, () => Array(20).fill("plains")) } as never,
        placements: {
          mage: { x: 2, y: 2 },
          ally: { x: 2, y: 4 },
          a: { x: 6, y: 2 },
          b: { x: 7, y: 2 },
          giant: { x: 12, y: 5 },
        },
      },
    });
    state.order = ["mage", "ally", "a", "b", "giant"];
    state.turn = 0;
    return state;
  };
  const optionsOf = (state: RulesetEncounterState, actorId: string) => {
    state.turn = state.order.indexOf(actorId);
    const actor = rulesetCombatant(state, actorId)!;
    for (const key of Object.keys(actor.budgets)) actor.budgets[key] = 9;
    return rulesetCombatOptions(definition, state, actorId);
  };
  const optionOf = (state: RulesetEncounterState, actorId: string, label: string) => {
    const found = optionsOf(state, actorId).find((one) => one.label === label);
    assert.ok(found, `no ${label} for ${actorId}: ${optionsOf(state, actorId).map((one) => one.label)}`);
    return found;
  };
  const act = (state: RulesetEncounterState, choice: RulesetCombatChoice): RulesetCombatStep => {
    optionsOf(state, choice.actorId);
    const step = applyRulesetCombatChoice(definition, state, choice, roll);
    assert.equal(of(step.events, "refused").length, 0, JSON.stringify(of(step.events, "refused")));
    return step;
  };
  const cast = (state: RulesetEncounterState, actorId: string, label: string, targetIds: string[]) =>
    act(state, { actorId, optionId: optionOf(state, actorId, label).id, targetIds });
  const targetsOf = (state: RulesetEncounterState, actorId: string, label: string) =>
    rulesetOptionTargets(definition, state, actorId, optionOf(state, actorId, label));
  const health = (state: RulesetEncounterState, id: string) => {
    const one = rulesetCombatant(state, id)!;
    return one.health?.value ?? Number(one.sheet?.live?.pools?.hp?.current ?? NaN);
  };
  const sphered = (state: RulesetEncounterState, id: string) =>
    rulesetCombatant(state, id)!.tracked.some((one) => one.condition === "sphered");

  // ── Large or smaller ──
  {
    const state = fight();
    const giant = rulesetCombatant(state, "giant")!;
    giant.x = 4;
    giant.y = 5;
    assert.deepEqual(targetsOf(state, "mage", "Resilient Sphere").sort(), ["a", "ally", "b", "mage"]);
    assert.ok(targetsOf(state, "mage", "Bolt").includes("giant"), "the size limit is the sphere's own");
    giant.size = "large";
    assert.ok(targetsOf(state, "mage", "Resilient Sphere").includes("giant"), "Large still fits");
    // A scroll of it holds to the same size (1.317).
    const scroll = (upTo?: string): RulesetSheetItem => ({
      name: "Sphere Scroll",
      quantity: 1,
      worn: false,
      item: {
        category: "gear",
        use: {
          kind: "debuff",
          budget: "action",
          targets: "any",
          range: 30,
          saveDifficulty: 15,
          save: { save: "dex_save", onSuccess: "negates" },
          applies: [{ condition: "sphered", duration: { rounds: 10 } }],
          consumes: true,
          ...(upTo ? { targetsUpTo: upTo } : {}),
        },
      } as never,
    });
    const read = fight([scroll("large")]);
    const huge = rulesetCombatant(read, "giant")!;
    huge.x = 4;
    huge.y = 5;
    assert.ok(!targetsOf(read, "mage", "Sphere Scroll").includes("giant"), "not a Huge giant");
    assert.ok(targetsOf(read, "mage", "Sphere Scroll").includes("a"));
    const any = fight([scroll()]);
    rulesetCombatant(any, "giant")!.x = 4;
    rulesetCombatant(any, "giant")!.y = 5;
    assert.ok(targetsOf(any, "mage", "Sphere Scroll").includes("giant"), "a use with no limit reaches it");
  }

  // ── Nothing gets in or out ──
  const shut = () => cast(fight(), "mage", "Resilient Sphere", ["a"]).state;
  {
    const state = shut();
    assert.ok(sphered(state, "a"));
    assert.equal(rulesetCombatant(state, "mage")!.concentrating?.label, "Resilient Sphere");
    // Nobody aims at the one inside, friend or foe, harm or heal.
    assert.ok(!targetsOf(state, "mage", "Bolt").includes("a"));
    assert.ok(!targetsOf(state, "mage", "Mend").includes("a"));
    assert.ok(targetsOf(state, "mage", "Bolt").includes("b"));
    // Nor does the one inside reach anybody.
    assert.deepEqual(targetsOf(state, "a", "Claw"), [], "a claw stays inside");
    // An area passes it by.
    const burst = act(state, {
      actorId: "mage",
      optionId: optionOf(state, "mage", "Blast").id,
      targetIds: [],
      at: { x: 6, y: 2 },
    });
    assert.equal(health(burst.state, "a"), 100, "inside, untouched");
    assert.ok(health(burst.state, "b") < 100, "outside, burned");
    assert.ok(!of(burst.events, "save").some((one) => one.actorId === "a"), "nor asked to save");
  }

  // ── What reaches without being aimed: an aura, and its harm ──
  {
    const aura = (inside: boolean) => {
      const state = fight();
      if (inside) {
        const step = cast(state, "mage", "Resilient Sphere", ["mage"]);
        Object.assign(state, step.state);
      }
      const next = structuredClone(state);
      rulesetCombatant(next, "b")!.tracked.push({ condition: "nimbus", rounds: null } as never);
      rulesetCombatant(next, "b")!.x = 3;
      next.turn = next.order.indexOf("giant");
      return advanceRulesetTurn(definition, next, roll);
    };
    const open = aura(false);
    assert.ok(
      rulesetCombatant(open.state, "mage")!.tracked.some((one) => one.condition === "scorched"),
      "outside, caught",
    );
    const closed = aura(true);
    assert.ok(sphered(closed.state, "mage"));
    assert.ok(
      !rulesetCombatant(closed.state, "mage")!.tracked.some((one) => one.condition === "scorched"),
      "inside, the aura never lands",
    );
    // Harm already on them from somebody outside does nothing: only outside does it burn.
    const harmed = shut();
    for (const id of ["a", "b"]) {
      rulesetCombatant(harmed, id)!.tracked.push({ condition: "scorched", rounds: null, source: "mage" } as never);
    }
    harmed.turn = harmed.order.indexOf("ally");
    const intoA = advanceRulesetTurn(definition, harmed, roll);
    assert.equal(intoA.state.order[intoA.state.turn], "a");
    assert.equal(health(intoA.state, "a"), 100, "no harm through the sphere");
    const intoB = advanceRulesetTurn(definition, intoA.state, roll);
    assert.equal(intoB.state.order[intoB.state.turn], "b");
    assert.equal(health(intoB.state, "b"), 90, "outside, it burns");
    // A lasting area laid over it puts nothing on it.
    const smoked = act(shut(), {
      actorId: "mage",
      optionId: optionOf(shut(), "mage", "Smoke").id,
      targetIds: [],
      at: { x: 6, y: 2 },
    });
    const zoneTurn = structuredClone(smoked.state);
    zoneTurn.turn = zoneTurn.order.indexOf("ally");
    const inZone = advanceRulesetTurn(definition, advanceRulesetTurn(definition, zoneTurn, roll).state, roll);
    const scorched = (id: string) =>
      rulesetActiveConditions(definition, combat, rulesetCombatant(inZone.state, id)!, inZone.state).some(
        (one) => one.condition === "scorched",
      );
    assert.equal(scorched("a"), false, "the zone stays outside");
    assert.equal(scorched("b"), true, "and catches who is not shut in");
  }

  // ── Shut in, still its own ──
  {
    const state = cast(fight(), "mage", "Resilient Sphere", ["mage"]).state;
    assert.deepEqual(targetsOf(state, "mage", "Mend"), ["mage"], "only itself");
    const mended = cast(state, "mage", "Mend", ["mage"]);
    assert.ok(sphered(mended.state, "mage"), "its own spell breaks nothing");
    // A lasting area it lays outside catches nobody out there.
    const laid = act(mended.state, {
      actorId: "mage",
      optionId: optionOf(mended.state, "mage", "Smoke").id,
      targetIds: [],
      at: { x: 7, y: 2 },
    });
    assert.ok(
      !rulesetActiveConditions(definition, combat, rulesetCombatant(laid.state, "b")!, laid.state).some(
        (one) => one.condition === "scorched",
      ),
      "nothing of its own gets out",
    );
    const own = act(mended.state, {
      actorId: "mage",
      optionId: optionOf(mended.state, "mage", "Smoke").id,
      targetIds: [],
      at: { x: 2, y: 2 },
    });
    assert.ok(
      rulesetActiveConditions(definition, combat, rulesetCombatant(own.state, "mage")!, own.state).some(
        (one) => one.condition === "scorched",
      ),
      "its own, inside, is its own",
    );
    assert.equal(of(mended.events, "heal")[0]?.amount !== undefined, true);
  }

  // ── Nobody strikes as it rolls past ──
  {
    const state = fight();
    rulesetCombatant(state, "ally")!.x = 6;
    rulesetCombatant(state, "ally")!.y = 3;
    rulesetCombatant(state, "a")!.budgets.reaction = 1;
    assert.ok(
      rulesetThreateningEnemies(definition, combat, state, rulesetCombatant(state, "ally")!).some(
        (one) => one.combatant.id === "a",
      ),
    );
    const step = cast(state, "mage", "Resilient Sphere", ["ally"]);
    assert.deepEqual(
      rulesetThreateningEnemies(definition, combat, step.state, rulesetCombatant(step.state, "ally")!).map(
        (one) => one.combatant.id,
      ),
      [],
      "nobody reaches into the sphere",
    );
  }

  // ── Rolling it ──
  {
    const state = shut();
    const a = rulesetCombatant(state, "a")!;
    assert.equal(rulesetMovementAllowance(definition, combat, a, state), 0, "it does not walk");
    a.movementLeft = 0;
    const rolled = act(state, { actorId: "a", optionId: optionOf(state, "a", "Roll Sphere").id, targetIds: [] });
    assert.equal(rulesetCombatant(rolled.state, "a")!.movementLeft, 3, "half of 6 cells");
    assert.equal(rulesetCombatant(rolled.state, "a")!.budgets.action, 8, "an action spent");
    assert.deepEqual(of(rolled.events, "sphere")[0], { type: "sphere", actorId: "a", how: "rolled", cells: 3 });
    const moved = act(rolled.state, { actorId: "a", optionId: RULESET_MOVE_OPTION, targetIds: [], to: { x: 6, y: 5 } });
    assert.deepEqual(
      { x: rulesetCombatant(moved.state, "a")!.x, y: rulesetCombatant(moved.state, "a")!.y },
      { x: 6, y: 5 },
    );
    // Rolled into a snare laid outside, nothing of it gets in; walked into, it catches.
    const snared = act(rolled.state, {
      actorId: "mage",
      optionId: optionOf(rolled.state, "mage", "Snare").id,
      targetIds: [],
      at: { x: 6, y: 4 },
    });
    const into = act(snared.state, { actorId: "a", optionId: RULESET_MOVE_OPTION, targetIds: [], to: { x: 6, y: 4 } });
    assert.deepEqual(
      { x: rulesetCombatant(into.state, "a")!.x, y: rulesetCombatant(into.state, "a")!.y },
      { x: 6, y: 4 },
    );
    assert.ok(
      !rulesetCombatant(into.state, "a")!.tracked.some((one) => one.condition === "scorched"),
      "the snare stays out",
    );
    rulesetCombatant(snared.state, "b")!.movementLeft = 6;
    const walkedIn = act(snared.state, {
      actorId: "b",
      optionId: RULESET_MOVE_OPTION,
      targetIds: [],
      to: { x: 6, y: 4 },
    });
    assert.ok(
      rulesetCombatant(walkedIn.state, "b")!.tracked.some((one) => one.condition === "scorched"),
      "outside, it catches",
    );
    // The menu without the sphere offers no roll.
    assert.ok(!optionsOf(fight(), "a").some((one) => one.rollsSealed));
    // Nor one whose sphere does not roll.
    const still = parsed(
      document((doc) => {
        delete doc.combat.conditions.find((one: { condition: string }) => one.condition === "sphered").sealed.rolls;
      }),
    );
    const stuck = shut();
    stuck.turn = stuck.order.indexOf("a");
    assert.ok(!rulesetCombatOptions(still, stuck, "a").some((one) => one.rollsSealed), "no rolls, no rolling");
  }

  // ── Carrying it ──
  {
    const state = shut();
    assert.ok(!optionsOf(state, "mage").some((one) => one.lifts), "too far to pick up");
    rulesetCombatant(state, "mage")!.x = 5;
    const lift = optionOf(state, "mage", "Pick up A");
    assert.equal(lift.budget, "action");
    const lifted = act(state, { actorId: "mage", optionId: lift.id, targetIds: [] });
    assert.equal(rulesetCombatant(lifted.state, "a")!.carriedBy, "mage");
    rulesetCombatant(lifted.state, "ally")!.x = 6;
    rulesetCombatant(lifted.state, "ally")!.y = 3;
    assert.ok(!optionsOf(lifted.state, "ally").some((one) => one.lifts && !one.lifts.down), "already carried");
    rulesetCombatant(lifted.state, "mage")!.movementLeft = 6;
    const walked = act(lifted.state, {
      actorId: "mage",
      optionId: RULESET_MOVE_OPTION,
      targetIds: [],
      to: { x: 2, y: 2 },
    });
    const a = rulesetCombatant(walked.state, "a")!;
    const path = of(walked.events, "move")[0]!.path;
    assert.ok(path.length >= 2);
    assert.deepEqual({ x: a.x, y: a.y }, path.at(-2), "a step behind its bearer");
    const down = optionOf(walked.state, "mage", "Put down A");
    assert.equal(down.budget, undefined, "putting it down is free");
    const put = act(walked.state, { actorId: "mage", optionId: down.id, targetIds: [] });
    assert.equal(rulesetCombatant(put.state, "a")!.carriedBy, undefined);
    rulesetCombatant(put.state, "mage")!.movementLeft = 6;
    const away = act(put.state, { actorId: "mage", optionId: RULESET_MOVE_OPTION, targetIds: [], to: { x: 2, y: 6 } });
    assert.deepEqual(
      { x: rulesetCombatant(away.state, "a")!.x, y: rulesetCombatant(away.state, "a")!.y },
      { x: a.x, y: a.y },
    );
    // Out of the sphere, nobody is carrying it.
    const ended = act(walked.state, {
      actorId: "mage",
      optionId: optionOf(walked.state, "mage", "Disintegrate").id,
      targetIds: ["a"],
    });
    assert.equal(rulesetCombatant(ended.state, "a")!.carriedBy, undefined);
  }

  // ── Disintegrate breaks it ──
  {
    const state = shut();
    assert.ok(targetsOf(state, "ally", "Disintegrate").includes("a"), "it may be aimed at the sphere");
    const broken = cast(state, "ally", "Disintegrate", ["a"]);
    assert.equal(sphered(broken.state, "a"), false);
    assert.equal(health(broken.state, "a"), 100, "nothing inside is harmed");
    assert.equal(rulesetCombatant(broken.state, "mage")!.concentrating, null, "the spell is over");
    assert.ok(of(broken.events, "condition").some((one) => one.condition === "sphered" && one.reason === "dispelled"));
    // Without the sphere, Disintegrate does what it does.
    const plain = cast(fight(), "ally", "Disintegrate", ["a"]);
    assert.equal(health(plain.state, "a"), 60);
  }

  // ── Refusals ──
  refused(
    document((doc) => {
      doc.combat.conditions.find((one: { condition: string }) => one.condition === "sphered").sealed.rolls.budget =
        "nope";
    }),
    /Unknown budget "nope"/,
  );
  refused(
    document((doc) => {
      doc.combat.conditions.find((one: { condition: string }) => one.condition === "sphered").sealed.lifted.budget =
        "nope";
    }),
    /Unknown budget "nope"/,
  );
  refused(
    document((doc) => {
      doc.combat.conditions.find((one: { condition: string }) => one.condition === "sphered").sealed.brokenBy = [
        "nowhere/disintegrate",
      ];
    }),
    /Unknown catalog "nowhere"/,
  );
  refused(
    document((doc) => {
      doc.catalogs.at(-1).entries[0].mechanics.targetsUpTo = "colossal";
    }),
    /Unknown size "colossal"/,
  );
  refused(
    document((doc) => {
      delete doc.combat.sizes;
    }),
    /"targetsUpTo" reads combat.sizes/,
  );
  refused(
    document((doc) => {
      doc.catalogs.at(-1).entries[0].mechanics.targets = "self";
    }),
    /"targetsUpTo" is on an entry pointed at a creature/,
  );

  // ── The gate ──
  {
    const manifest = (minor: number) => ({
      schemaVersion: 2,
      capabilityApi: { major: 1, minor },
      id: "fivee",
      name: "5e",
      version: "1.0.0",
      kind: ["ruleset"],
      entrypoints: {},
      contributions: { assets: { paths: ["ruleset.json"] } },
      files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
      permissions: [],
      restartRequired: false,
    });
    const gate =
      "A ruleset with a condition that shuts its holder away from everybody else, or an entry aimed only at creatures up to a size, requires schemaVersion 2 and capabilityApi 1.314 or newer";
    const onlySize = document((doc) => {
      delete doc.combat.conditions.find((one: { condition: string }) => one.condition === "sphered").sealed;
    });
    const onlySeal = document((doc) => {
      delete doc.catalogs.at(-1).entries[0].mechanics.targetsUpTo;
    });
    const neither = document((doc) => {
      delete doc.combat.conditions.find((one: { condition: string }) => one.condition === "sphered").sealed;
      delete doc.catalogs.at(-1).entries[0].mechanics.targetsUpTo;
    });
    for (const doc of [document(), onlySize, onlySeal]) {
      assert.equal(getCapabilityPackageInstallIssue(manifest(313) as never, doc), gate);
      assert.notEqual(getCapabilityPackageInstallIssue(manifest(314) as never, doc), gate);
    }
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(313) as never, neither), gate, "nothing new, no gate");
  }

  console.log(
    "Sphere: nothing reaches in or out (aim, areas, auras, harm, opportunity strikes), rolled at half speed, carried by whoever picks it up, broken by Disintegrate with its concentration; Large or smaller; refusals; gated at 1.314.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
