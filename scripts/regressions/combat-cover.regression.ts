/**
 * Cover by degrees (combat C6a-2): one corner-line test for every fight, and what the Engine's own
 * fights make of it.
 *
 *   - `coverTier` is the DMG's optional grid rule: no sight is total cover; from the striker's best
 *     corner, three or four lines through a wall or a mountain are three-quarters, and any line
 *     through one, through low cover or through a screen (a creature) is half. Low cover alone is
 *     never more than half, and the two end cells are never between them.
 *   - Native fights: half cover is 15 off the hit chance and three-quarters 30, the evasion scale
 *     terrain uses, and the target's own ground and the cover between do not add up. The forecast
 *     reads the attacker where it would strike from, and an area hit reads cover from where it lands.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyAction,
  coverTier,
  createTacticalCombat,
  decideTacticalAction,
  forecastAttack,
  forecastTacticalAttack,
  type Combatant,
  type TacticalGrid,
  type TacticalTerrain,
} from "../../packages/shared/src/index.js";

const board = (width: number, height: number, paint: Record<string, TacticalTerrain> = {}): TacticalGrid => ({
  width,
  height,
  tiles: Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => paint[`${x},${y}`] ?? ("plains" as TacticalTerrain)),
  ),
});
const from = { x: 0, y: 0 };
const to = { x: 4, y: 2 };

// ── The test itself ──
{
  assert.equal(coverTier(board(7, 5), from, to), "none", "nothing between them");
  assert.equal(coverTier(board(7, 5, { "2,1": "wall" }), from, to), "total", "a wall on the line of sight");
  assert.equal(coverTier(board(7, 5, { "4,1": "wall" }), from, to), "half", "a wall beside the target");
  assert.equal(coverTier(board(7, 5, { "2,2": "wall", "3,1": "wall" }), from, to), "three-quarters");
  assert.equal(coverTier(board(7, 5, { "2,1": "forest" }), from, to), "half", "trees between them");
  assert.equal(
    coverTier(board(7, 5, { "4,2": "forest" }), from, to),
    "none",
    "what the target stands on is not between",
  );
  assert.equal(coverTier(board(7, 5), from, to, new Set(["2,1"])), "half", "somebody standing between them");
  // Low cover never adds up to more than half, however much of it there is.
  const thicket: Record<string, TacticalTerrain> = {};
  for (let x = 1; x < 4; x++) for (let y = 0; y < 3; y++) thicket[`${x},${y}`] = "forest";
  assert.equal(coverTier(board(7, 5, thicket), from, to), "half", "a whole wood between them is still half");
  // A terrain word this Engine does not know is seen across and is no cover, rather than a crash.
  assert.equal(coverTier(board(5, 1, { "2,0": "lava" as TacticalTerrain }), from, { x: 4, y: 0 }), "none");
  // Neighbours: nothing is between them, even with walls all round.
  assert.equal(coverTier(board(3, 3, { "1,0": "wall", "0,1": "wall" }), from, { x: 1, y: 1 }), "none");
}

// ── The Engine's own fights ──
const unit = (id: string, side: Combatant["side"] = "player"): Combatant => ({
  id,
  name: id,
  side,
  hp: 500,
  maxHp: 500,
  attack: 30,
  defense: 0,
  speed: 10,
  level: 1,
  mp: 60,
  maxMp: 60,
});
const arena = (paint: Record<string, TacticalTerrain>) => {
  const s = createTacticalCombat([unit("archer")], [unit("foe", "enemy"), unit("other", "enemy")], {
    seed: 8,
    difficulty: "normal",
  });
  s.grid = board(9, 5, paint);
  Object.assign(
    s.units.find((u) => u.id === "archer")!,
    { x: 0, y: 0, attackRange: { min: 1, max: 6 } },
  );
  Object.assign(
    s.units.find((u) => u.id === "foe")!,
    { x: 4, y: 2 },
  );
  Object.assign(
    s.units.find((u) => u.id === "other")!,
    { x: 8, y: 4 },
  );
  return s;
};
{
  const chance = (paint: Record<string, TacticalTerrain>) => forecastAttack(arena(paint), "archer", "foe").hitChance;
  const open = chance({});
  assert.equal(chance({ "4,1": "wall" }), open - 15, "half cover takes 15 off");
  assert.equal(chance({ "2,2": "wall", "3,1": "wall" }), open - 30, "three-quarters takes 30 off");
  // The better of the ground and the cover counts, never both.
  assert.equal(chance({ "4,2": "forest" }), open - 15, "trees underfoot");
  assert.equal(chance({ "4,2": "forest", "4,1": "wall" }), open - 15, "trees underfoot and a wall beside");
  // An area's forecast reads cover from where it lands, as its roll does: trees between the caster and
  // the foe it is aimed at take nothing off, though they do off a plain shot.
  const wooded = arena({ "2,1": "forest" });
  const blast = { name: "Blast", mpCost: 5, power: 20, type: "attack" as const, range: 6, areaRadius: 2 };
  assert.equal(forecastAttack(wooded, "archer", "foe").hitChance, open - 15, "a shot through the trees");
  assert.equal(forecastAttack(wooded, "archer", "foe", blast).hitChance, open, "a blast landing on it");
  // A forecast from another cell reads the cover from there: right beside the foe, nothing is between.
  const walled = arena({ "4,1": "wall" });
  const [archer, foe] = ["archer", "foe"].map((id) => walled.units.find((u) => u.id === id)!);
  assert.equal(forecastTacticalAttack(walled, archer!, foe!, { x: 0, y: 0 }).hitChance, open - 15);
  assert.equal(forecastTacticalAttack(walled, archer!, foe!, { x: 3, y: 2 }).hitChance, open, "from beside it");
  // A blast reads cover from where it lands: a second foe beside where it lands, half hidden from the
  // caster by a wall but with nothing between it and the blast, is struck every time.
  const struck = (seed: number) => {
    const fight = arena({ "5,2": "wall" });
    fight.seed = seed;
    const archer = fight.units.find((u) => u.id === "archer")!;
    archer.skills = [{ name: "Blast", mpCost: 5, power: 20, type: "attack", range: 7, areaRadius: 2 }];
    // Fast enough that only cover can make it miss: 100 in the open, 85 behind half cover.
    archer.speed = 20;
    Object.assign(
      fight.units.find((u) => u.id === "other")!,
      { x: 5, y: 3 },
    );
    const done = applyAction(fight, { type: "skill", unitId: "archer", skillName: "Blast", targetId: "foe" });
    assert.ok(done.ok, done.ok ? "" : done.error);
    const about = done.events.filter((event) => "targetId" in event && event.targetId === "other");
    return about.length > 0 && !done.events.some((event) => event.kind === "miss" && / other /.test(event.text));
  };
  assert.equal(coverTier(board(9, 5, { "5,2": "wall" }), from, { x: 5, y: 3 }), "half", "the caster sees it covered");
  assert.ok(
    Array.from({ length: 30 }, (_, seed) => struck(seed)).every(Boolean),
    "the blast never misses it for cover it does not have from where it lands",
  );
}

// The plain AI weighs the counter it risks from the tile it would shoot from: of the cells three away
// from the hero, it takes the one a wall half hides from the hero's answer, though its own shot from
// there is as open as from any other.
{
  const fight = arena({ "3,1": "wall" });
  const hero = fight.units.find((u) => u.id === "archer")!;
  Object.assign(hero, { x: 4, y: 2, attackRange: { min: 1, max: 3 } });
  const shooter = fight.units.find((u) => u.id === "foe")!;
  Object.assign(shooter, { x: 5, y: 0, movement: 4, attackRange: { min: 3, max: 3 }, tactics: undefined, skills: [] });
  Object.assign(
    fight.units.find((u) => u.id === "other")!,
    { hp: 0 },
  );
  assert.equal(coverTier(fight.grid, { x: 3, y: 0 }, hero), "none", "its shot from there is open");
  assert.equal(coverTier(fight.grid, hero, { x: 3, y: 0 }), "half", "the answer to it is not");
  const choice = decideTacticalAction(fight, shooter, () => 0);
  assert.deepEqual(choice.type === "attack" ? choice.to : choice, { x: 3, y: 0 }, JSON.stringify(choice));
}

// ── Install gate: 1.74 ──
{
  const dataDir = mkdtempSync(join(tmpdir(), "marinara-cover-"));
  process.env.DATA_DIR = dataDir;
  process.env.MARINARA_DATA_DIR = dataDir;
  try {
    const { getCapabilityPackageInstallIssue } =
      await import("../../packages/server/src/services/capability-packages/package-manager.service.js");
    const manifest = (minor: number) => ({
      schemaVersion: 2,
      capabilityApi: { major: 1, minor },
      builtAgainst: { engineVersion: "2.4.6", engineCommit: "0".repeat(40) },
      id: "ruleset-cover",
      name: "Cover",
      version: "0.1.0",
      description: "A packaged ruleset with cover by degrees.",
      engine: { min: "2.4.6", maxExclusive: "4.0.0" },
      kind: ["ruleset"],
      entrypoints: {},
      contributions: { assets: { paths: ["ruleset.json"] } },
      files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
      permissions: [],
      restartRequired: false,
    });
    const fiveE = readFileSync(
      fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
      "utf8",
    );
    const doc = (edit: (doc: Record<string, any>) => void) => {
      const parsed = JSON.parse(fiveE) as Record<string, any>;
      edit(parsed);
      return parsed;
    };
    const issue = (minor: number, document: Record<string, any>) =>
      getCapabilityPackageInstallIssue(manifest(minor) as never, document);
    const gate = /grades cover .* or has a save that ignores cover requires .*capabilityApi 1\.74/;
    assert.equal(
      issue(
        68,
        doc(() => {}),
      ),
      null,
      "half cover alone is what 1.28 already read",
    );
    for (const key of ["threeQuarters", "saves", "creatures"]) {
      const graded = doc(
        (d) => (d.combat.cover[key] = { threeQuarters: 5, saves: ["dex_save"], creatures: true }[key]),
      );
      assert.match(issue(72, graded) ?? "", gate, key);
      assert.equal(issue(74, graded), null, key);
    }
    // A creature's action whose save ignores cover (the example's creatures carry two such saves).
    const coverless = doc((d) => {
      const action = d.catalogs
        .flatMap((catalog: { entries?: Array<Record<string, any>> }) => catalog.entries ?? [])
        .flatMap((one: Record<string, any>) => one.creature?.actions ?? [])
        .find((one: Record<string, any>) => one.save);
      action.save.ignoresCover = true;
    });
    assert.match(issue(72, coverless) ?? "", gate, "a save that ignores cover");
    assert.equal(issue(74, coverless), null);
    // And an entry's own save, as a spell's.
    const spell = doc((d) => {
      const feat = d.catalogs.find((catalog: { id: string }) => catalog.id === "feats").entries[0];
      feat.mechanics = { ...feat.mechanics, save: { save: "dex_save", onSuccess: "negates", ignoresCover: true } };
    });
    assert.match(issue(72, spell) ?? "", gate, "an entry's save that ignores cover");
    // And an item's use, as a scroll of that spell.
    const scroll = doc((d) => {
      const feat = d.catalogs.find((catalog: { id: string }) => catalog.id === "feats").entries[0];
      feat.item = { use: { save: { save: "dex_save", onSuccess: "negates", ignoresCover: true } } };
    });
    assert.match(issue(72, scroll) ?? "", gate, "an item use's save that ignores cover");
    // And height, 1.75 (combat C6b).
    const high = doc((d) => (d.combat.elevation = { levelHeight: 5 }));
    assert.match(issue(74, high) ?? "", /what a board's height does requires .*capabilityApi 1\.75/);
    assert.equal(issue(75, high), null);
    // And the action economy conditions change, 1.76 (combat C6d): any of the new condition keys, or a
    // budget of no count.
    const economyGate = /change the action economy, or with a budget of no count, requires .*capabilityApi 1\.76/;
    const slowed = doc((d) => d.combat.conditions.push({ condition: "prone", attacksPerTurn: 1 }));
    assert.match(issue(75, slowed) ?? "", economyGate);
    assert.equal(issue(76, slowed), null);
    const spare = doc((d) => d.combat.economy.budgets.push({ id: "spare", label: "Spare", per: "turn", count: 0 }));
    assert.match(issue(75, spare) ?? "", economyGate);
    // And sheet migrations, 1.77 (C6e-0).
    const migrating = doc((d) => {
      d.sheet.version = 2;
      d.sheet.migrations = [{ from: 1, steps: [{ rename: "field", from: "experience", to: "xp" }] }];
    });
    assert.match(issue(76, migrating) ?? "", /says how older sheets read on it requires .*capabilityApi 1\.77/);
    assert.equal(issue(77, migrating), null);
    // And a rest that shares a pool group's fraction, 1.77 (C6e).
    const sharing = doc((d) => {
      d.rests[0].restore.push({ poolGroup: "slots", by: { fractionOfMax: 0.5 }, shared: true });
    });
    assert.match(issue(76, sharing) ?? "", /shares a pool group's fraction requires .*capabilityApi 1\.77/);
    assert.equal(issue(77, sharing), null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log("Combat cover: corner lines grade cover, and the Engine's own fights take it off the hit chance.");
