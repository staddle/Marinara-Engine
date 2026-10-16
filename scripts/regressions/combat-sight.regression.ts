/**
 * Line of sight on the combat board (combat C6a): one sight test for every fight.
 *
 *   - Symmetric on any board, and only a wall or a mountain blocks it: water, woods and ruins are seen
 *     across, and neighbours always see each other.
 *   - The Engine's own fights: a ranged attack, a skill, a support skill and an item need sight; a
 *     target behind a wall is not offered, a counter needs sight back, and an area spreads only as far
 *     as it sees from where it lands. The AI never picks a target it cannot see.
 *   - Ruleset fights: sight crosses water now, a line area carries on across water and stops at a wall.
 */
import assert from "node:assert/strict";

import {
  applyAction,
  createTacticalCombat,
  decideTacticalAction,
  getTargetsInRange,
  hasLineOfSight,
  rulesetAreaCells,
  rulesetLineOfSight,
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

// ── The test itself ──
{
  // Symmetric on boards of every terrain, seeded.
  let state = 20261004;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const kinds: TacticalTerrain[] = ["plains", "plains", "forest", "ruin", "water", "mountain", "wall"];
  for (let round = 0; round < 40; round++) {
    const grid = board(12, 8);
    for (const row of grid.tiles)
      for (let x = 0; x < row.length; x++) row[x] = kinds[Math.floor(random() * kinds.length)]!;
    for (let pair = 0; pair < 60; pair++) {
      const a = { x: Math.floor(random() * 12), y: Math.floor(random() * 8) };
      const b = { x: Math.floor(random() * 12), y: Math.floor(random() * 8) };
      assert.equal(hasLineOfSight(grid, a, b), hasLineOfSight(grid, b, a), `symmetric ${JSON.stringify([a, b])}`);
      if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1) assert.ok(hasLineOfSight(grid, a, b), "neighbours");
    }
  }
  const across = (terrain: TacticalTerrain) =>
    hasLineOfSight(board(5, 1, { "2,0": terrain }), { x: 0, y: 0 }, { x: 4, y: 0 });
  assert.deepEqual(
    (["plains", "forest", "ruin", "water", "mountain", "wall"] as TacticalTerrain[]).map(across),
    [true, true, true, true, false, false],
    "only a wall or a mountain blocks sight",
  );
  // Two walls meeting at a corner do not block the diagonal between them.
  const corner = board(3, 3, { "1,0": "wall", "0,1": "wall" });
  assert.ok(hasLineOfSight(corner, { x: 0, y: 0 }, { x: 1, y: 1 }), "a diagonal neighbour past two walls");
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
  const s = createTacticalCombat(
    [
      {
        ...unit("archer"),
        skills: [
          { name: "Bolt", mpCost: 5, power: 20, type: "attack", range: 5 },
          { name: "Mend", mpCost: 5, power: 20, type: "heal", range: 5 },
          { name: "Blast", mpCost: 5, power: 20, type: "attack", range: 5, areaRadius: 2 },
        ],
      } as Combatant,
      unit("friend"),
    ],
    [unit("foe", "enemy"), unit("other", "enemy")],
    { seed: 8, difficulty: "normal" },
  );
  s.grid = board(9, 5, paint);
  Object.assign(
    s.units.find((u) => u.id === "archer")!,
    { x: 1, y: 2, attackRange: { min: 1, max: 5 }, movement: 0 },
  );
  Object.assign(
    s.units.find((u) => u.id === "friend")!,
    { x: 1, y: 0 },
  );
  Object.assign(
    s.units.find((u) => u.id === "foe")!,
    { x: 5, y: 2, attackRange: { min: 1, max: 5 } },
  );
  Object.assign(
    s.units.find((u) => u.id === "other")!,
    { x: 7, y: 4 },
  );
  return s;
};
{
  const open = arena({});
  assert.ok(getTargetsInRange(open, "archer").includes("foe"), "an open shot is offered");
  const walled = arena({ "3,2": "wall" });
  assert.ok(!getTargetsInRange(walled, "archer").includes("foe"), "a target behind a wall is not offered");
  const refused = (action: Parameters<typeof applyAction>[1]) => {
    const result = applyAction(walled, action);
    return result.ok ? "" : result.error;
  };
  assert.match(refused({ type: "attack", unitId: "archer", targetId: "foe" }), /out of sight/);
  assert.match(refused({ type: "skill", unitId: "archer", skillName: "Bolt", targetId: "foe" }), /out of sight/);
  const watered = arena({ "3,2": "water" });
  assert.ok(applyAction(watered, { type: "attack", unitId: "archer", targetId: "foe" }).ok, "a shot across water");
  // A support skill needs sight of its ally too.
  const hidden = arena({ "1,1": "wall" });
  const mend = applyAction(hidden, { type: "skill", unitId: "archer", skillName: "Mend", targetId: "friend" });
  assert.ok(!mend.ok && /out of sight/.test(mend.error), "a heal through a wall");
  const potion = applyAction(hidden, { type: "item", unitId: "archer", itemName: "Potion", targetId: "friend" });
  assert.ok(!potion.ok && /out of sight/.test(potion.error), "an item through a wall");
  // A unit aiming at itself is where it walks to: a heal on itself after walking round a wall.
  const walker = arena({ "2,2": "wall" });
  Object.assign(
    walker.units.find((u) => u.id === "archer")!,
    { movement: 4 },
  );
  const selfMend = applyAction(walker, {
    type: "skill",
    unitId: "archer",
    skillName: "Mend",
    targetId: "archer",
    to: { x: 3, y: 2 },
  });
  assert.ok(selfMend.ok, selfMend.ok ? "" : selfMend.error);
  // An area spreads only as far as it sees from where it lands: the second foe two cells past the first
  // is caught in the open and sheltered by a wall between them.
  const blastHits = (paint: Record<string, TacticalTerrain>) => {
    const fight = arena(paint);
    Object.assign(
      fight.units.find((u) => u.id === "other")!,
      { x: 7, y: 2 },
    );
    const done = applyAction(fight, { type: "skill", unitId: "archer", skillName: "Blast", targetId: "foe" });
    assert.ok(done.ok, done.ok ? "" : done.error);
    return new Set(
      done.events.flatMap((event) => ("targetId" in event && event.targetId ? [String(event.targetId)] : [])),
    );
  };
  assert.ok(blastHits({}).has("other"), "the blast reaches the second foe in the open");
  const sheltered = blastHits({ "6,2": "wall" });
  assert.ok(sheltered.has("foe") && !sheltered.has("other"), "a wall shelters it");
  // The AI never shoots what it cannot see: it shoots in the open, and not through a wall.
  const aiChoice = (paint: Record<string, TacticalTerrain>) => {
    const fight = arena(paint);
    // The plain AI, which shoots the best target it reaches (a tactics profile may weigh holding back).
    Object.assign(
      fight.units.find((u) => u.id === "foe")!,
      {
        movement: 0,
        hasMoved: true,
        skills: [],
        tactics: undefined,
      },
    );
    // A melee archer cannot shoot back, so the choice is the shot's alone.
    Object.assign(
      fight.units.find((u) => u.id === "archer")!,
      { attackRange: { min: 1, max: 1 } },
    );
    return decideTacticalAction(
      fight,
      fight.units.find((u) => u.id === "foe")!,
    );
  };
  const openShot = aiChoice({});
  assert.ok(openShot.type === "attack" && openShot.targetId === "archer", JSON.stringify(openShot));
  const blocked = aiChoice({ "3,2": "wall" });
  assert.ok(!(blocked.type === "attack" && blocked.targetId === "archer"), JSON.stringify(blocked));
  // The plain AI heals only an ally it sees.
  const healer = (paint: Record<string, TacticalTerrain>) => {
    const fight = arena(paint);
    const foe = fight.units.find((u) => u.id === "foe")!;
    Object.assign(foe, {
      tactics: undefined,
      skills: [{ name: "Mend", mpCost: 5, power: 20, type: "heal", range: 2 }],
    });
    Object.assign(
      fight.units.find((u) => u.id === "other")!,
      { x: 5, y: 4, hp: 50 },
    );
    return decideTacticalAction(fight, foe, () => 0);
  };
  assert.deepEqual(
    [healer({}), healer({ "5,3": "wall" })].map((choice) => choice.type === "skill" && choice.targetId === "other"),
    [true, false],
    "a heal in the open, none through a wall",
  );
  // An archer with a wall between it and its only foe walks round it rather than waiting for ever.
  const column: Record<string, TacticalTerrain> = {};
  for (let y = 0; y < 4; y++) column[`4,${y}`] = "wall";
  const stuck = arena(column);
  const shooter = stuck.units.find((u) => u.id === "foe")!;
  // One step a turn, so no cell it reaches this turn sees round the wall: it heads for the gap.
  Object.assign(shooter, { x: 3, y: 2, movement: 1, attackRange: { min: 2, max: 3 }, tactics: undefined, skills: [] });
  for (const id of ["archer", "friend", "other"]) {
    const other = stuck.units.find((u) => u.id === id)!;
    if (id === "archer") Object.assign(other, { side: "party", x: 5, y: 2 });
    else Object.assign(other, { hp: 0 });
  }
  const step = decideTacticalAction(stuck, shooter, () => 0.1);
  assert.ok(step.type === "wait" && step.to !== undefined, `walks round: ${JSON.stringify(step)}`);
}

// ── Ruleset fights ──
{
  const river = board(7, 1, { "3,0": "water" });
  assert.ok(rulesetLineOfSight(river, { x: 0, y: 0 }, { x: 6, y: 0 }), "seen across water");
  const line = rulesetAreaCells("line", 6, { x: 0, y: 0 }, { x: 6, y: 0 }, river);
  assert.deepEqual(
    line.map((cell) => cell.x),
    [1, 2, 4, 5, 6],
    "a line carries on across water, where nobody stands",
  );
  const walled = board(7, 1, { "3,0": "wall" });
  assert.deepEqual(
    rulesetAreaCells("line", 6, { x: 0, y: 0 }, { x: 6, y: 0 }, walled).map((cell) => cell.x),
    [1, 2],
    "and stops at a wall",
  );
}

console.log("Combat sight: one symmetric test; walls and mountains block, water does not, in every fight.");
