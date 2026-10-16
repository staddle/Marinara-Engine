/**
 * Individual initiative for the Engine's own tactical fights (combat C6c).
 *
 *   - The order is rolled once from the fight's seed: the same fight always rolls the same order, and
 *     every unit is in it.
 *   - One unit acts at a time, in that order: a party unit out of turn is refused, End Turn ends only
 *     the turn of the unit whose turn it is, and everybody the player does not command takes their turn
 *     at once until it is a commanded unit's turn again.
 *   - A round ends when everybody has acted: it ticks once and the order starts again. The defeated are
 *     skipped. A guard lasts until its holder's own next turn, not the end of the round.
 *   - A fight by side (no order) is untouched, and the combat director follows the order too.
 */
import assert from "node:assert/strict";

import {
  applyTacticalTurn,
  createTacticalCombat,
  currentTacticalActor,
  rollTacticalInitiative,
  runInitiativeTurns,
  type Combatant,
  type TacticalCombatState,
  type TacticalGrid,
  type TacticalTerrain,
} from "../../packages/shared/src/index.js";
import { tickRound } from "../../packages/shared/src/features/tactical-combat/engine.js";
import {
  commandCombatDirector,
  createCombatDirector,
} from "../../packages/server/src/services/game/combat-director.service.js";

const unit = (id: string, side: Combatant["side"] = "player", speed = 10): Combatant => ({
  id,
  name: id,
  side,
  hp: 500,
  maxHp: 500,
  attack: 10,
  defense: 0,
  speed,
  level: 1,
  mp: 0,
  maxMp: 0,
});
const board = (width: number, height: number): TacticalGrid => ({
  width,
  height,
  tiles: Array.from({ length: height }, () => Array.from({ length: width }, () => "plains" as TacticalTerrain)),
});
/** A fight on a bare board with the order written down, everybody far apart so nobody reaches anybody. */
const fight = (order: string[], party = ["hero"], enemies = ["foe"]): TacticalCombatState => {
  const s = createTacticalCombat(
    party.map((id) => unit(id)),
    enemies.map((id) => unit(id, "enemy")),
    { seed: 5, difficulty: "normal", turnOrder: "initiative" },
  );
  s.grid = board(20, 3);
  s.units.forEach((u, index) => Object.assign(u, { x: index * 6, y: 1, movement: 1, attackRange: { min: 1, max: 1 } }));
  s.initiative = { order };
  return s;
};

// ── The order ──
{
  const units = createTacticalCombat([unit("hero"), unit("ally")], [unit("foe", "enemy"), unit("brute", "enemy")], {
    seed: 9,
    difficulty: "normal",
    turnOrder: "initiative",
  });
  assert.deepEqual([...units.initiative!.order].sort(), ["ally", "brute", "foe", "hero"], "everybody is in it");
  assert.deepEqual(rollTacticalInitiative(units.units, 9), units.initiative!.order, "the same seed rolls the same");
  const orders = new Set(Array.from({ length: 12 }, (_, seed) => rollTacticalInitiative(units.units, seed).join()));
  assert.ok(orders.size > 1, "and other seeds roll other orders");
  // A fight by side carries no order at all.
  const bySide = createTacticalCombat([unit("hero")], [unit("foe", "enemy")], { seed: 9, difficulty: "normal" });
  assert.equal(bySide.initiative, undefined);
  assert.equal(currentTacticalActor(bySide), undefined);
}

// ── One at a time ──
{
  // The foe goes first and takes its turn at once; then it is the hero's.
  const started = runInitiativeTurns(fight(["foe", "hero"])).state;
  assert.equal(currentTacticalActor(started)?.id, "hero");
  assert.equal(started.phase, "player");
  assert.equal(started.units.find((u) => u.id === "foe")!.hasActed, true);
  assert.equal(started.round, 1);
  // The hero waits: the round ends, ticks once, and the foe goes again before it is the hero's turn.
  const next = applyTacticalTurn(started, { type: "wait", unitId: "hero" });
  assert.ok(next.ok, next.ok ? "" : next.error);
  assert.equal(next.state.round, 2, "one round, one tick");
  assert.equal(currentTacticalActor(next.state)?.id, "hero");
  assert.equal(next.state.units.find((u) => u.id === "foe")!.hasActed, true, "the foe has had its turn");
  assert.ok(next.events.some((event) => event.kind === "phase" && /Round 2/.test(event.text)));
  // Out of turn: with two commanded party units, the one whose turn it is not is refused.
  const two = runInitiativeTurns(fight(["ally", "hero", "foe"], ["hero", "ally"])).state;
  assert.equal(currentTacticalActor(two)?.id, "ally");
  const early = applyTacticalTurn(two, { type: "wait", unitId: "hero" });
  assert.ok(!early.ok && /It is ally's turn/.test(early.error), early.ok ? "accepted" : early.error);
  // End Turn ends only the turn of the unit whose turn it is.
  const ended = applyTacticalTurn(two, { type: "endTurn" });
  assert.ok(ended.ok, ended.ok ? "" : ended.error);
  assert.equal(currentTacticalActor(ended.state)?.id, "hero", "the next commanded unit's turn");
  assert.equal(ended.state.units.find((u) => u.id === "foe")!.hasActed, false, "the foe after them waits");
  // The defeated are skipped.
  const fallen = fight(["foe", "ghost", "hero"], ["hero", "ghost"]);
  fallen.units.find((u) => u.id === "ghost")!.hp = 0;
  assert.equal(currentTacticalActor(runInitiativeTurns(fallen).state)?.id, "hero");
}

// ── A guard lasts until its holder's own next turn ──
{
  const guarded = fight(["foe", "hero"]);
  guarded.units.find((u) => u.id === "hero")!.defending = true;
  tickRound(guarded, []);
  assert.equal(guarded.units.find((u) => u.id === "hero")!.defending, true, "past the round's end, by initiative");
  const started = runInitiativeTurns(guarded).state;
  assert.equal(started.units.find((u) => u.id === "hero")!.defending, false, "and down as its turn starts");
  const bySide = createTacticalCombat([unit("hero")], [unit("foe", "enemy")], { seed: 9, difficulty: "normal" });
  bySide.units.find((u) => u.id === "hero")!.defending = true;
  tickRound(bySide, []);
  assert.equal(bySide.units.find((u) => u.id === "hero")!.defending, false, "by side every guard drops with the round");
}

// ── The combat director follows the order ──
{
  const director = createCombatDirector({
    id: "enc-initiative",
    anchor: "anchor",
    party: [unit("hero"), unit("ally")],
    enemies: [unit("foe", "enemy"), unit("brute", "enemy")],
    style: "tactical",
    gm: false,
    difficulty: "normal",
    seed: 3,
    turnOrder: "initiative",
  });
  const units = director.tactical!.units;
  const acted = (id: string) => units.find((u) => u.id === id)!.hasActed;
  // Seed 3 rolls foe, ally, brute, hero: the foe has gone, and it is the ally's turn.
  assert.deepEqual(director.tactical!.initiative!.order, ["foe", "ally", "brute", "hero"]);
  assert.equal(director.actorId, "ally");
  assert.equal(director.stage, "action");
  assert.equal(acted("foe"), true);
  // Ending the ally's turn lets the brute go, then it is the hero's: never the whole party's end.
  commandCombatDirector(director, { type: "tactical", action: { type: "endTurn" } });
  assert.equal(director.actorId, "hero");
  assert.deepEqual([acted("brute"), acted("hero")], [true, false]);
  // The hero's end turns the round once; the foe goes again, and it is the ally's turn.
  commandCombatDirector(director, { type: "tactical", action: { type: "endTurn" } });
  assert.equal(director.tactical!.round, 2);
  assert.equal(director.actorId, "ally");
  assert.deepEqual([acted("foe"), acted("ally")], [true, false]);
}

// A unit whose turn comes while it cannot act (frozen) loses its guard all the same: the turn came.
{
  const director = createCombatDirector({
    id: "enc-frozen",
    anchor: "anchor",
    party: [unit("hero"), unit("ally")],
    enemies: [unit("foe", "enemy", 1)],
    style: "tactical",
    gm: false,
    difficulty: "normal",
    seed: 3,
    turnOrder: "initiative",
  });
  const ally = () => director.tactical!.units.find((u) => u.id === "ally")!;
  for (let step = 0; director.actorId !== "ally" && step < 6; step++)
    commandCombatDirector(director, { type: "tactical", action: { type: "wait", unitId: director.actorId! } });
  commandCombatDirector(director, { type: "tactical", action: { type: "defend", unitId: "ally" } });
  assert.equal(ally().defending, true);
  ally().statusEffects = [{ name: "frozen", stat: "speed", modifier: 0, turnsLeft: 3 }];
  for (let step = 0; director.tactical!.round < 3 && step < 12; step++)
    commandCombatDirector(director, { type: "tactical", action: { type: "wait", unitId: director.actorId! } });
  assert.equal(ally().statusEffects.length > 0, true, "still frozen");
  assert.equal(ally().defending, false, "the guard dropped at the turn it could not take");
}

console.log("Combat initiative: a seeded order, one unit at a time, rounds that tick once, in both fights.");
