import {
  ENEMY_DAMAGE_MULTIPLIERS,
  normalizeGameDifficulty,
  weatherDamageMultiplier,
  weatherHitPenalty,
  type CombatWeather,
  type CombatAttackTraits,
} from "../combat-conditions.js";
import { WORLD_DEFAULT_ELEMENTS, worldElementId, type WorldElementSet } from "../world/elements.js";
// ──────────────────────────────────────────────
// Tactical Combat — pure combat math
// ──────────────────────────────────────────────
// Stateless helpers: distance, terrain lookups, stat-derived movement / range,
// the element multiplier table (mirrors the classic element wheel, simplified
// to strong 1.5x / weak 0.5x per the plan), and the hit / crit / damage
// formulas. Kept separate from engine.ts so both the resolver and the forecast
// compute from the exact same primitives (forecast MUST match applyAction
// statistically).

import type { CombatStatusEffect } from "../../types/game.js";
import { CLASS_PROFILES } from "./classes.js";
import {
  TERRAIN_DATA,
  type TacticalCoord,
  type TacticalDifficulty,
  type TacticalGrid,
  type TacticalTerrain,
  type TacticalUnit,
} from "./types.js";

export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export function manhattan(a: TacticalCoord, b: TacticalCoord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function inBounds(grid: TacticalGrid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

export function terrainAt(grid: TacticalGrid, x: number, y: number): TacticalTerrain {
  if (!inBounds(grid, x, y)) return "wall";
  return grid.tiles[y]![x]!;
}

export function terrainInfoAt(grid: TacticalGrid, x: number, y: number) {
  return TERRAIN_DATA[terrainAt(grid, x, y)];
}

export function isImpassable(grid: TacticalGrid, x: number, y: number): boolean {
  return !!terrainInfoAt(grid, x, y).impassable || ((grid.walls?.[`${x},${y}`] ?? 0) & 1) === 1;
}

/** How high a cell stands (combat C6b): 0 to 3, and 0 on a flat board or off it. */
export function elevationAt(grid: TacticalGrid, x: number, y: number): number {
  return grid.elevation?.[y]?.[x] ?? 0;
}

/** What one step on foot from a cell into its neighbour adds for height (combat C6b): one to climb a
 *  level, nothing to come down one, and null, no way at all, for a step of two levels or more either way.
 *  Flying and teleporting take no notice of height. */
export function climbCost(grid: TacticalGrid, from: TacticalCoord, to: TacticalCoord): number | null {
  const rise = elevationAt(grid, to.x, to.y) - elevationAt(grid, from.x, from.y);
  if (Math.abs(rise) > 1) return null;
  return rise > 0 ? 1 : 0;
}

/** Whether a cell blocks sight (combat C6): a wall or a mountain. Off the board reads as solid; a terrain
 *  word this Engine does not know is seen across. */
export function blocksSight(grid: TacticalGrid, x: number, y: number): boolean {
  if (!inBounds(grid, x, y)) return true;
  const terrain = grid.tiles[y]?.[x];
  return (
    terrain === undefined || TERRAIN_DATA[terrain]?.blocksSight === true || ((grid.walls?.[`${x},${y}`] ?? 0) & 2) === 2
  );
}

/**
 * Whether one cell can see another (combat C6): the straight line of cells between them, the two ends
 * left out, with nothing on it that blocks sight. One test for every fight, the Engine's own and a
 * ruleset's, so a shot, a counter and an area agree.
 *
 * The line is walked by the same integer stepping a grid is drawn with, from a fixed end, so the two
 * cells always see each other or never do, whichever way round they are asked.
 */
export function hasLineOfSight(grid: TacticalGrid, a: TacticalCoord, b: TacticalCoord): boolean {
  const forward = a.x < b.x || (a.x === b.x && a.y <= b.y);
  const start = forward ? a : b;
  const end = forward ? b : a;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps <= 1) return true;
  // Ground higher than both ends is a ridge between them (combat C6b); both ends, so it stays symmetric.
  const ridge = Math.max(elevationAt(grid, a.x, a.y), elevationAt(grid, b.x, b.y));
  for (let step = 1; step < steps; step++) {
    const x = start.x + Math.round((dx * step) / steps);
    const y = start.y + Math.round((dy * step) / steps);
    if ((x === start.x && y === start.y) || (x === end.x && y === end.y)) continue;
    if (blocksSight(grid, x, y) || elevationAt(grid, x, y) > ridge) return false;
  }
  return true;
}

/** How much of a target the ground between it and a strike hides (combat C6a-2). */
export type CoverTier = "none" | "half" | "three-quarters" | "total";

/**
 * What one line from a grid point to another passes through the inside of, between the two end cells:
 * 2 for a cell that blocks sight, 1 for low cover (a cell with a defense bonus, or one `screens`
 * names), 0 for nothing. Along an edge or through a corner does not count. Cells span [x, x + 1] by
 * [y, y + 1]. Stepped from one grid line to the next, so it costs the length of the line.
 */
function lineCover(
  grid: TacticalGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ends: readonly [TacticalCoord, TacticalCoord],
  screens?: ReadonlySet<string>,
  /** Ground higher than this between the ends is a ridge, which blocks like a wall (combat C6b). */
  ridge = Infinity,
  /** Shooting down from higher ground over low cover, which then hides nothing. */
  fromAbove = false,
): 0 | 1 | 2 {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  let nextX = x0 + sx;
  let nextY = y0 + sy;
  let t = 0;
  let found: 0 | 1 = 0;
  while (t < 1 - 1e-9) {
    const tx = dx === 0 ? Infinity : (nextX - x0) / dx;
    const ty = dy === 0 ? Infinity : (nextY - y0) / dy;
    const step = Math.min(tx, ty, 1);
    // Between two grid lines the line is inside one cell, unless it runs along a grid line itself.
    const mx = x0 + dx * ((t + step) / 2);
    const my = y0 + dy * ((t + step) / 2);
    if (step - t > 1e-9 && Math.abs(mx - Math.round(mx)) > 1e-9 && Math.abs(my - Math.round(my)) > 1e-9) {
      const x = Math.floor(mx);
      const y = Math.floor(my);
      if (!ends.some((end) => end.x === x && end.y === y)) {
        if (blocksSight(grid, x, y) || elevationAt(grid, x, y) > ridge) return 2;
        const terrain = grid.tiles[y]?.[x];
        if (
          !fromAbove &&
          ((terrain !== undefined && (TERRAIN_DATA[terrain]?.defenseBonus ?? 0) > 0) || screens?.has(`${x},${y}`))
        )
          found = 1;
      }
    }
    if (tx <= step + 1e-9) nextX += sx;
    if (ty <= step + 1e-9) nextY += sy;
    t = step;
  }
  return found;
}

/**
 * The cover a target at `to` has against a strike from `from`, by what stands BETWEEN them (combat
 * C6a-2). It is the DMG's optional grid rule, not the SRD's, which leaves cover to the table:
 *
 * - no sight at all is total cover;
 * - otherwise, from the striker's best corner, one line to each corner of the target's cell. Three or
 *   four lines through a wall or a mountain are three-quarters cover; any line through one, or through
 *   low cover (a cell with a defense bonus, or a cell `screens` names, such as one a creature stands
 *   in), is half. Low cover alone never gives more than half.
 *
 * The two end cells are never between, so what the target stands on is the caller's to add.
 */
export function coverTier(
  grid: TacticalGrid,
  from: TacticalCoord,
  to: TacticalCoord,
  screens?: ReadonlySet<string>,
): CoverTier {
  if (!hasLineOfSight(grid, from, to)) return "total";
  // Neighbours share a corner, and nothing lies between that corner and the other cell.
  if (Math.abs(from.x - to.x) <= 1 && Math.abs(from.y - to.y) <= 1) return "none";
  const ends = [from, to] as const;
  const ridge = Math.max(elevationAt(grid, from.x, from.y), elevationAt(grid, to.x, to.y));
  const fromAbove = elevationAt(grid, from.x, from.y) > elevationAt(grid, to.x, to.y);
  let best = { solid: 5, low: 5 };
  for (let corner = 0; corner < 4 && best.solid + best.low > 0; corner++) {
    const cx = from.x + (corner & 1);
    const cy = from.y + (corner >> 1);
    let solid = 0;
    let low = 0;
    for (let other = 0; other < 4; other++) {
      const line = lineCover(grid, cx, cy, to.x + (other & 1), to.y + (other >> 1), ends, screens, ridge, fromAbove);
      if (line === 2) solid++;
      else if (line === 1) low++;
    }
    if (solid < best.solid || (solid === best.solid && low < best.low)) best = { solid, low };
  }
  return best.solid >= 3 ? "three-quarters" : best.solid + best.low > 0 ? "half" : "none";
}

/** What cover takes off a native hit chance, on the evasion scale terrain uses. Total cover never gets
 *  this far: a target out of sight is refused before anything is rolled. */
const COVER_AVOID: Record<CoverTier, number> = { none: 0, half: 15, "three-quarters": 30, total: 30 };

/** How far a strike from `from` carries toward `to`: its own range, and one more for a ranged one shot
 *  down from higher ground (combat C6b). */
export function reachFrom(grid: TacticalGrid, from: TacticalCoord, to: TacticalCoord, max: number): number {
  return max >= 2 && elevationAt(grid, from.x, from.y) > elevationAt(grid, to.x, to.y) ? max + 1 : max;
}

/** Whether a strike from `from` reaches `to`: within the range (from higher ground, one more for a ranged
 *  one) and in sight. */
export function inReach(grid: TacticalGrid, from: TacticalCoord, to: TacticalCoord, min: number, max: number): boolean {
  const distance = manhattan(from, to);
  return distance >= min && distance <= reachFrom(grid, from, to, max) && hasLineOfSight(grid, from, to);
}

/** Movement points per turn from speed (class moveBonus is applied at unit creation). */
export function deriveMovement(speed: number): number {
  return clamp(3 + Math.floor(speed / 10), 3, 6);
}

// ── Difficulty ──

/** Classic combat difficulty multipliers (combat.service.ts). Applied to ENEMY damage in tactical. */
export const DIFFICULTY_DAMAGE_MULT = ENEMY_DAMAGE_MULTIPLIERS;

// ── Elements ──
// Which element beats which comes from the game's element set (worldgen W6c): the classic wheel is
// Fire/Ice/Lightning as a rock-paper-scissors trio with Holy and Shadow strong against each other.
// Strong = 1.5x, weak (the reverse) = 0.5x, otherwise 1.0x.
export function elementMultiplier(
  attackElement?: string,
  defenderElement?: string,
  elements: WorldElementSet = WORLD_DEFAULT_ELEMENTS,
): number {
  const a = worldElementId(elements, attackElement);
  const d = worldElementId(elements, defenderElement);
  if (!a || !d || a === d) return 1;
  if (elements.beats[a]?.includes(d)) return 1.5;
  if (elements.beats[d]?.includes(a)) return 0.5;
  return 1;
}

// ── Status-effect derived stats ──

export function activeEffects(unit: TacticalUnit): CombatStatusEffect[] {
  return (unit.statusEffects ?? []).filter((e) => e.turnsLeft > 0);
}

function statModifier(unit: TacticalUnit, stat: CombatStatusEffect["stat"]): number {
  return activeEffects(unit)
    .filter((e) => e.stat === stat)
    .reduce((sum, e) => sum + e.modifier, 0);
}

export function effectiveAttack(unit: TacticalUnit): number {
  return Math.max(1, unit.attack + statModifier(unit, "attack"));
}

export function effectiveDefense(unit: TacticalUnit): number {
  return Math.max(0, unit.defense + statModifier(unit, "defense"));
}

export function effectiveSpeed(unit: TacticalUnit): number {
  return Math.max(0, unit.speed + statModifier(unit, "speed"));
}

// ── Hit / crit / damage ──

export function terrainAvoid(grid: TacticalGrid, unit: TacticalUnit): number {
  return terrainInfoAt(grid, unit.x, unit.y).avoidBonus;
}

/** 0–100 chance the attack lands. */
export function hitChance(
  grid: TacticalGrid,
  attacker: TacticalUnit,
  defender: TacticalUnit,
  weather?: CombatWeather,
  traits: CombatAttackTraits = attacker,
): number {
  // The ground under the defender and the cover between the two do not add up: the better one counts.
  // Striking down from higher ground adds 10 (combat C6b).
  const raw =
    80 +
    (effectiveSpeed(attacker) - effectiveSpeed(defender)) * 2 -
    Math.max(terrainAvoid(grid, defender), COVER_AVOID[coverTier(grid, attacker, defender)]) +
    (elevationAt(grid, attacker.x, attacker.y) > elevationAt(grid, defender.x, defender.y) ? 10 : 0) -
    (defender.defending ? 10 : 0);
  return clamp(clamp(Math.round(raw), 30, 100) - weatherHitPenalty(weather, traits), 5, 100);
}

/** 0–60 chance of a x2 critical. Adds the attacker's class crit bonus (absent class → fighter, +0). */
export function critChance(attacker: TacticalUnit, defender: TacticalUnit): number {
  const critBonus = CLASS_PROFILES[attacker.unitClass ?? "fighter"].critBonus;
  return clamp(Math.round(5 + Math.max(0, effectiveSpeed(attacker) - effectiveSpeed(defender)) + critBonus), 0, 60);
}

export interface DamageInputs {
  weather?: CombatWeather;
  /** The game's elements (worldgen W6c); the classic six when absent. */
  elements?: WorldElementSet;
  grid: TacticalGrid;
  attacker: TacticalUnit;
  defender: TacticalUnit;
  /** Damage roll in [0.9, 1.1]. Use 1.0 for expected/forecast. */
  roll: number;
  crit: boolean;
  difficulty: TacticalDifficulty;
  /** Skill power multiplier against the attack stat (basic attack = 1). */
  power?: number;
  /** Element carried by this strike (skill element overrides unit element). */
  element?: string;
}

/**
 * Damage for a single landed strike. Deterministic given inputs.
 * base = attack*power*roll, scaled by level difference (±50% cap), minus
 * defense*0.6 + terrainDef*2; then element, crit (x2), defending (halve), and
 * enemy-side difficulty multiplier. Floors to >= 1.
 */
export function computeDamage(inp: DamageInputs): number {
  const { grid, attacker, defender, roll, crit, difficulty } = inp;
  const power = inp.power ?? 1;
  const element = inp.element ?? attacker.element;

  const base = effectiveAttack(attacker) * power * roll;
  const levelScale = clamp(1 + (attacker.level - defender.level) * 0.05, 0.5, 1.5);
  const raw = base * levelScale;

  const defTile = terrainInfoAt(grid, defender.x, defender.y);
  const mitigation = effectiveDefense(defender) * 0.6 + defTile.defenseBonus * 2;

  let dmg = raw - mitigation;
  dmg *= elementMultiplier(element, defender.element, inp.elements);
  dmg *= weatherDamageMultiplier(inp.weather, element, inp.elements);
  if (crit) dmg *= 2;
  if (defender.defending) dmg *= 0.5;
  if (attacker.side === "enemy") dmg *= DIFFICULTY_DAMAGE_MULT[normalizeGameDifficulty(difficulty)];

  return Math.max(1, Math.floor(dmg));
}

/** Heal amount for a heal skill (mirrors classic resolveSkillAction heal math). */
export function computeHeal(caster: TacticalUnit, power: number): number {
  return Math.max(1, Math.floor((effectiveAttack(caster) + caster.level * 2) * Math.max(power, 0.5)));
}
