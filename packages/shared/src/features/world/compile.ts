// ──────────────────────────────────────────────
// The world compile (worldgen W1): a pure function of the seed, the setting kit and the brief. It lays
// out the ground, the tree of places down to the settlements, each settlement's size, prosperity and
// tags, and the links between them with their travel times. The same inputs give the same world, byte
// for byte, on the server and in the browser. Every part draws from its own stream, keyed by a field
// path (`seed|places|<layer>`), so changing one part of the generator never reshuffles another; a
// change to what any stream draws is a new generator version, because a world pins the version it was
// made with.
// ──────────────────────────────────────────────
import { mulberry32 } from "../tactical-combat/rng.js";
import type { WorldBrief, WorldBriefPlace } from "../../schemas/world-brief.schema.js";
import { worldBriefDeepestLayer } from "../../schemas/world-brief.schema.js";
import type { WorldKit } from "../../schemas/world-kit.schema.js";
import { worldKitArtFamily } from "./art-family.js";

export const WORLD_GENERATOR_VERSION = 2;
/** The generator versions this Engine makes again from a recipe exactly as they were made: 2 adds sites
 *  (caves, ruins, crypts a few steps out of the settlements; design-game-overworld-sites.md), 1 has none.
 *  A recipe of a version it reads stays editable and sharable as a recipe. */
export const WORLD_GENERATOR_VERSIONS_READ: readonly number[] = Object.freeze([1, 2]);
export function worldGeneratorReads(version: unknown): boolean {
  return typeof version === "number" && WORLD_GENERATOR_VERSIONS_READ.includes(version);
}

export const WORLD_PROSPERITIES = Object.freeze(["struggling", "modest", "thriving"] as const);
export type WorldProsperity = (typeof WORLD_PROSPERITIES)[number];

export interface WorldPlace {
  id: string;
  name: string;
  /** The kit layer it is in, and how deep that layer is (0 is outermost). */
  layer: string;
  depth: number;
  parentId: string | null;
  /** A ground cell, for every place compiled with a position. */
  at: { x: number; y: number };
  /** The kit culture its people mostly are. */
  culture: string;
  /** Settlements only: the kit size id and its rank on the ladder (0 is smallest). */
  size?: string;
  rank?: number;
  prosperity?: WorldProsperity;
  tags: string[];
  note?: string;
  lore?: string[];
  /** True for a place the brief named; false for one the compile drew. */
  named: boolean;
  /** The names it went by before a hand edit renamed it, still read as it (worldgen W9c). */
  aliases?: string[];
  /** A place added by hand, in the world's edit layer, rather than compiled. */
  byHand?: true;
}

export interface WorldLink {
  from: string;
  to: string;
  /** The kit travel way that makes the trip. */
  way: string;
  /** The trip's length in the kit's days. */
  days: number;
}

export interface CompiledWorld {
  generatorVersion: number;
  seed: number;
  width: number;
  height: number;
  /** The kit terrain ids, and the ground as one character per cell (an index into them, base 36). */
  terrain: string[];
  ground: string;
  places: WorldPlace[];
  links: WorldLink[];
  /** Where the party starts: a settlement, or the place inside one the brief starts it in. */
  startId: string;
}

export interface WorldCompileInput {
  seed: number;
  kit: WorldKit;
  brief?: WorldBrief | null;
  /** Strict grounding: the brief's places and no more than the tree needs to hold them (a player
   *  who wants nothing invented beside their lore). Otherwise the scale fills the world around them. */
  strict?: boolean;
  /** The generator version to make it as (a recipe's own); the latest when left out. */
  generatorVersion?: number;
}

// ── Field-path streams ──

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A random stream of its own for one part of the world, keyed by the seed and a field path. */
export function worldStream(seed: number, ...path: Array<string | number>): () => number {
  return mulberry32(fnv1a(`${seed >>> 0}|${path.join("|")}`));
}

const pick = <T>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)]!;
const between = (low: number, high: number, random: () => number) => low + Math.floor(random() * (high - low + 1));

// ── Scale ──

const GROUND_SIZE = {
  site: [24, 16],
  town: [32, 24],
  region: [48, 32],
  realm: [64, 44],
  world: [96, 64],
  sector: [48, 32],
} as const;
/** How many settlements a world of each scale has, at least and at most. */
const SETTLEMENTS = {
  site: [1, 1],
  town: [1, 4],
  region: [8, 14],
  realm: [20, 36],
  world: [48, 80],
  sector: [24, 40],
} as const;
/** The days one ground cell takes at walking pace (speed 1). */
export const WORLD_DAYS_PER_CELL = {
  site: 1 / 96,
  town: 1 / 24,
  region: 1 / 4,
  realm: 1 / 2,
  world: 1,
  sector: 2,
} as const;

// ── The ground ──

function valueNoise(seed: number, label: string, width: number, height: number): Float64Array {
  const out = new Float64Array(width * height);
  let amplitude = 1;
  let total = 0;
  for (let octave = 0; octave < 4; octave++) {
    const step = Math.max(2, Math.round(Math.max(width, height) / (3 * 2 ** octave)));
    const columns = Math.ceil(width / step) + 2;
    const rows = Math.ceil(height / step) + 2;
    const random = worldStream(seed, "ground", label, octave);
    const lattice = Array.from({ length: columns * rows }, () => random());
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const gx = x / step;
        const gy = y / step;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = gx - x0;
        const fy = gy - y0;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        const at = (cx: number, cy: number) => lattice[cy * columns + cx]!;
        const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
        const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
        out[y * width + x] = out[y * width + x]! + (top * (1 - sy) + bottom * sy) * amplitude;
      }
    }
    total += amplitude;
    amplitude /= 2;
  }
  for (let index = 0; index < out.length; index++) out[index]! /= total;
  return out;
}

/** Cells sorted by a value, lowest first, ties by position, so the order never depends on the engine. */
const byValue = (values: Float64Array, cells: number[]) =>
  [...cells].sort((left, right) => values[left]! - values[right]! || left - right);

/** Splits cells among classes by share: in order of a value, so each class is one stretch of it. */
function shareOut(
  cells: number[],
  values: Float64Array,
  classes: Array<{ index: number; share: number }>,
  out: Uint8Array,
) {
  if (classes.length === 0 || cells.length === 0) return;
  const sorted = byValue(values, cells);
  const total = classes.reduce((sum, entry) => sum + entry.share, 0);
  let start = 0;
  let running = 0;
  classes.forEach((entry, position) => {
    running += entry.share;
    const end = position === classes.length - 1 ? sorted.length : Math.round((running / total) * sorted.length);
    for (let index = start; index < end; index++) out[sorted[index]!] = entry.index;
    start = end;
  });
}

/** The kit's ground classes, in the order a world's ground indexes them: one open class when the kit
 *  names none. */
export function worldTerrainEntries(kit: WorldKit) {
  return kit.terrain ?? [{ id: kit.layers[0]!.id, label: kit.layers[0]!.label, kind: "open" as const, share: 1 }];
}

function compileGround(seed: number, kit: WorldKit, width: number, height: number) {
  const terrain = worldTerrainEntries(kit);
  const elevation = valueNoise(seed, "elevation", width, height);
  const moisture = valueNoise(seed, "moisture", width, height);
  const classes = terrain.map((entry, index) => ({ index, share: entry.share, kind: entry.kind }));
  const total = classes.reduce((sum, entry) => sum + entry.share, 0);
  const shareOf = (kind: string) =>
    classes.filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + entry.share, 0);
  const all = Array.from({ length: width * height }, (_, index) => index);
  const sorted = byValue(elevation, all);
  const waterCount = Math.round((shareOf("water") / total) * sorted.length);
  const barrierCount = Math.round((shareOf("barrier") / total) * sorted.length);
  const kinds = new Uint8Array(width * height);
  // Low ground is water, high ground is the barrier, and the rest is open, split by how wet it is.
  shareOut(
    sorted.slice(0, waterCount),
    moisture,
    classes.filter((entry) => entry.kind === "water"),
    kinds,
  );
  shareOut(
    sorted.slice(sorted.length - barrierCount),
    moisture,
    classes.filter((entry) => entry.kind === "barrier"),
    kinds,
  );
  shareOut(
    sorted.slice(waterCount, sorted.length - barrierCount),
    moisture,
    classes.filter((entry) => entry.kind === "open"),
    kinds,
  );
  return { terrain, kinds };
}

// ── Places ──

interface Draft {
  depth: number;
  parent: number | null;
  brief?: WorldBriefPlace;
  name?: string;
  culture?: string;
  cell?: number;
  cells?: number[];
  size?: number;
  prosperity?: WorldProsperity;
  tags?: string[];
}

/** Picks well-spread cells: of a handful of candidates, the one furthest from those already taken. */
function spreadCells(
  candidates: number[],
  count: number,
  taken: number[],
  width: number,
  random: () => number,
): number[] {
  const chosen: number[] = [];
  if (candidates.length === 0) return chosen;
  const distance = (a: number, b: number) =>
    Math.hypot((a % width) - (b % width), Math.floor(a / width) - Math.floor(b / width));
  for (let index = 0; index < count; index++) {
    let best = -1;
    let bestDistance = -1;
    for (let attempt = 0; attempt < 12; attempt++) {
      const cell = pick(candidates, random);
      const near = [...taken, ...chosen].reduce((min, other) => Math.min(min, distance(cell, other)), Infinity);
      if (near > bestDistance) {
        best = cell;
        bestDistance = near;
      }
    }
    chosen.push(best);
  }
  return chosen;
}

/** Each cell to the nearest of the seeds (ties to the first), so a region is one patch of ground. */
function partition(cells: number[], seeds: number[], width: number): number[][] {
  const parts = seeds.map(() => [] as number[]);
  for (const cell of cells) {
    let best = 0;
    let bestDistance = Infinity;
    seeds.forEach((seedCell, index) => {
      const dx = (cell % width) - (seedCell % width);
      const dy = Math.floor(cell / width) - Math.floor(seedCell / width);
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    parts[best]!.push(cell);
  }
  return parts;
}

/** Shares `total` children out among `parents` (each at least one), by seeded weights. */
function shareChildren(parents: number, total: number, random: () => number): number[] {
  const counts = Array.from({ length: parents }, () => 1);
  const weights = counts.map(() => 0.5 + random());
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  let left = Math.max(0, total - parents);
  const extra = weights.map((weight) => Math.floor((weight / weightTotal) * left));
  extra.forEach((count, index) => (counts[index]! += count));
  left -= extra.reduce((sum, count) => sum + count, 0);
  for (let index = 0; left > 0; index = (index + 1) % parents, left--) counts[index]! += 1;
  return counts;
}

export function compileWorld({
  seed,
  kit,
  brief,
  strict = false,
  generatorVersion = WORLD_GENERATOR_VERSION,
}: WorldCompileInput): CompiledWorld {
  seed = seed >>> 0;
  const [width, height] = GROUND_SIZE[kit.scale];
  const { terrain, kinds } = compileGround(seed, kit, width, height);
  const kindOf = (cell: number) => terrain[kinds[cell]!]!.kind;
  const settlementsDepth = kit.layers.findIndex((layer) => layer.settlements);
  const deepest = worldBriefDeepestLayer(kit);
  const briefPlaces = brief?.places ?? [];
  const depthOfLayer = new Map(kit.layers.map((layer, index) => [layer.id, index]));
  const sizeIndex = new Map(kit.sizes.map((size, index) => [size.id, index]));

  // How many places each layer has: the brief's own, and at least what the scale asks for.
  const counts = worldStream(seed, "counts");
  const scaleSettlements = between(SETTLEMENTS[kit.scale][0], SETTLEMENTS[kit.scale][1], counts);
  const scaleTop = kit.scale === "world" ? between(3, 6, counts) : 1;
  const ownAt = (depth: number) => briefPlaces.filter((place) => depthOfLayer.get(place.layer) === depth).length;
  const settlementTarget = Math.max(strict ? 1 : scaleSettlements, ownAt(settlementsDepth));
  const topTarget = Math.max(1, strict ? ownAt(0) : scaleTop);
  const fanout = settlementsDepth > 0 ? (settlementTarget / topTarget) ** (1 / settlementsDepth) : 1;

  const drafts: Draft[] = [];
  const atDepth = (depth: number) =>
    drafts.map((draft, index) => ({ draft, index })).filter((entry) => entry.draft.depth === depth);
  const nameKey = (name: string) => name.toLowerCase();
  const briefIndex = new Map<string, number>();

  for (let depth = 0; depth <= Math.min(settlementsDepth, deepest); depth++) {
    const own = briefPlaces.filter((place) => depthOfLayer.get(place.layer) === depth);
    const target =
      depth === settlementsDepth
        ? settlementTarget
        : depth === 0
          ? topTarget
          : strict
            ? 0
            : Math.round(topTarget * fanout ** depth);
    const parents = depth === 0 ? [] : atDepth(depth - 1);
    const count = Math.max(target, own.length, parents.length);
    const random = worldStream(seed, "places", depth);
    // The brief's places first, each in its parent when it names one, then drawn places, so every
    // parent has at least one child and the rest are shared out by seeded weights.
    const parentOf = (place: WorldBriefPlace) => {
      if (!place.parent) return undefined;
      const parentIndex = briefIndex.get(nameKey(place.parent));
      // A parent more than one layer out is reached through one of its children at this layer's
      // parent depth; the compile keeps it simple and puts the place under the named place's first
      // child at that depth, or the named place itself when it is the layer just above.
      if (parentIndex === undefined) return undefined;
      let at = parentIndex;
      while (drafts[at]!.depth < depth - 1) {
        const child = drafts.findIndex((draft) => draft.parent === at);
        if (child < 0) break;
        at = child;
      }
      return drafts[at]!.depth === depth - 1 ? at : undefined;
    };
    const assigned: Array<{ parent: number | null; brief?: WorldBriefPlace }> = own.map((place) => ({
      parent: depth === 0 ? null : (parentOf(place) ?? null),
      brief: place,
    }));
    const drawn = count - own.length;
    if (depth === 0) {
      for (let index = 0; index < drawn; index++) assigned.push({ parent: null });
    } else {
      const children = new Map<number, number>();
      for (const entry of assigned)
        if (entry.parent !== null) children.set(entry.parent, (children.get(entry.parent) ?? 0) + 1);
      // Places the brief left without a parent are counted with the drawn ones.
      const unplaced = assigned.filter((entry) => entry.parent === null);
      const shares = shareChildren(parents.length, drawn + unplaced.length, random);
      const slots: number[] = [];
      parents.forEach(({ index }, position) => {
        const owed = Math.max(0, shares[position]! - (children.get(index) ?? 0));
        for (let n = 0; n < owed; n++) slots.push(index);
      });
      // Every parent with no child yet takes one of the slots first.
      const shuffled = slots
        .map((slot) => ({ slot, order: random() }))
        .sort((a, b) => a.order - b.order)
        .map((entry) => entry.slot);
      for (const entry of unplaced) entry.parent = shuffled.shift() ?? parents[0]!.index;
      for (const parentIndex of shuffled) assigned.push({ parent: parentIndex });
      for (const { index } of parents) {
        if (!assigned.some((entry) => entry.parent === index)) assigned.push({ parent: index });
      }
    }
    // Siblings are kept together, in the order of their parents.
    assigned.sort((left, right) => (left.parent ?? -1) - (right.parent ?? -1));
    for (const entry of assigned) {
      drafts.push({ depth, parent: entry.parent, ...(entry.brief ? { brief: entry.brief } : {}) });
      if (entry.brief) briefIndex.set(nameKey(entry.brief.name), drafts.length - 1);
    }
  }

  // ── Where everything is: nested patches of ground, and settlements on open ground ──
  const allCells = Array.from({ length: width * height }, (_, index) => index);
  for (let depth = 0; depth <= settlementsDepth; depth++) {
    const random = worldStream(seed, "positions", depth);
    const groups = new Map<number | null, number[]>();
    for (const { draft, index } of atDepth(depth))
      groups.set(draft.parent, [...(groups.get(draft.parent) ?? []), index]);
    const taken: number[] = [];
    for (const [parent, members] of groups) {
      const area = parent === null ? allCells : (drafts[parent]!.cells ?? allCells);
      const open = area.filter((cell) => kindOf(cell) === "open");
      const candidates = open.length > 0 ? open : area.length > 0 ? area : allCells;
      const cells = spreadCells(candidates, members.length, taken, width, random);
      taken.push(...cells);
      if (depth < settlementsDepth) {
        const parts = partition(area.length > 0 ? area : allCells, cells, width);
        members.forEach((member, position) => {
          drafts[member]!.cell = cells[position]!;
          drafts[member]!.cells = parts[position]!;
        });
      } else {
        members.forEach((member, position) => (drafts[member]!.cell = cells[position]!));
      }
    }
  }

  // ── Who lives where: one culture per top place, mostly kept by the layers inside it ──
  const cultures = kit.cultures.map((culture) => culture.id);
  for (let depth = 0; depth <= Math.min(settlementsDepth + 1, kit.layers.length - 1); depth++) {
    const random = worldStream(seed, "cultures", depth);
    atDepth(depth).forEach(({ draft }, position) => {
      if (draft.parent === null) draft.culture = position === 0 ? cultures[0]! : pick(cultures, random);
      else {
        const inherited = drafts[draft.parent]!.culture ?? cultures[0]!;
        draft.culture = depth === 1 && cultures.length > 1 && random() < 0.25 ? pick(cultures, random) : inherited;
      }
    });
  }

  // ── Settlements: size on the kit's ladder (few big, many small), prosperity, tags ──
  const settlements = atDepth(settlementsDepth);
  const ladder = kit.sizes.length;
  const top =
    kit.scale === "site" ? Math.min(1, ladder - 1) : kit.scale === "town" ? Math.floor((ladder - 1) / 2) : ladder - 1;
  {
    const random = worldStream(seed, "sizes");
    for (const { draft } of settlements) if (draft.brief?.size) draft.size = sizeIndex.get(draft.brief.size);
    const unsized = settlements
      .filter(({ draft }) => draft.size === undefined)
      .map((entry) => ({ ...entry, order: random() }))
      .sort((a, b) => a.order - b.order);
    // One top place for each outermost place, twice as many at each rank below, the rest smallest.
    let quota = Math.max(1, topTarget - settlements.filter(({ draft }) => draft.size === top).length);
    let rank = top;
    for (const { draft } of unsized) {
      while (quota <= 0 && rank > 0) {
        rank--;
        quota = Math.max(
          1,
          2 ** (top - rank) * topTarget - settlements.filter(({ draft: other }) => other.size === rank).length,
        );
      }
      draft.size = rank;
      quota--;
    }
  }
  {
    const random = worldStream(seed, "prosperity");
    for (const { draft } of settlements) {
      const roll = random();
      draft.prosperity = roll < 0.25 ? "struggling" : roll < 0.75 ? "modest" : "thriving";
    }
  }
  {
    const random = worldStream(seed, "tags");
    const kitTags = kit.placeTags.map((tag) => tag.id);
    for (const { draft } of settlements) {
      if (draft.brief?.tags.length) {
        draft.tags = [...draft.brief.tags];
        continue;
      }
      const roll = random();
      const count = kitTags.length === 0 ? 0 : roll < 0.3 ? 0 : roll < 0.8 ? 1 : 2;
      const tags = new Set<string>();
      while (tags.size < Math.min(count, kitTags.length)) tags.add(pick(kitTags, random));
      draft.tags = [...tags];
    }
  }

  // ── Inside the one town: the layer below the settlements, for a world of one site or town ──
  if (deepest > settlementsDepth) {
    const main = settlements.reduce(
      (best, entry) => ((entry.draft.size ?? 0) > (best.draft.size ?? 0) ? entry : best),
      settlements[0]!,
    );
    const random = worldStream(seed, "inside", main.index);
    const own = briefPlaces.filter((place) => depthOfLayer.get(place.layer) === deepest);
    const drawn = strict ? 0 : kit.scale === "site" ? between(3, 6, random) : between(4, 8, random);
    const count = Math.max(own.length, drawn);
    const near = (center: number) =>
      allCells.filter(
        (cell) =>
          Math.abs((cell % width) - (center % width)) <= 3 &&
          Math.abs(Math.floor(cell / width) - Math.floor(center / width)) <= 3,
      );
    const cells = spreadCells(near(main.draft.cell!), count, [], width, random);
    for (let index = 0; index < count; index++) {
      // A place the brief puts in one of the settlements goes there; every other is in the main one.
      const named = own[index]?.parent ? briefIndex.get(nameKey(own[index]!.parent!)) : undefined;
      const home = named !== undefined && drafts[named]!.depth === settlementsDepth ? named : main.index;
      const cell =
        home === main.index ? cells[index]! : spreadCells(near(drafts[home]!.cell!), 1, [], width, random)[0]!;
      drafts.push({
        depth: deepest,
        parent: home,
        ...(own[index] ? { brief: own[index] } : {}),
        cell,
        culture: drafts[home]!.culture,
        tags: own[index]?.tags ? [...own[index]!.tags] : [],
      });
      // So the party can start inside the town, where the brief says.
      if (own[index]) briefIndex.set(nameKey(own[index]!.name), drafts.length - 1);
    }
  }

  // ── Names: the brief's own, then each culture's pool, then the layer's word and a number ──
  {
    const used = new Set(briefPlaces.map((place) => nameKey(place.name)));
    const pools = new Map(
      (brief?.placeNames ?? []).map((group) => {
        const random = worldStream(seed, "names", group.culture);
        return [
          group.culture,
          group.names
            .map((name) => ({ name, order: random() }))
            .sort((a, b) => a.order - b.order)
            .map((entry) => entry.name),
        ];
      }),
    );
    const numbered = new Map<string, number>();
    for (const draft of drafts) {
      if (draft.brief) {
        draft.name = draft.brief.name;
        continue;
      }
      const pool = [pools.get(draft.culture ?? "") ?? [], ...pools.values()];
      let name: string | undefined;
      for (const names of pool) {
        while (names.length > 0 && !name) {
          const next = names.shift()!;
          if (!used.has(nameKey(next))) name = next;
        }
        if (name) break;
      }
      // ponytail: a world with no names to draw from numbers its places by their layer's word; W2's
      // seeded names from per-culture name data replace this.
      if (!name) {
        const layer = kit.layers[draft.depth]!;
        do {
          const n = (numbered.get(layer.id) ?? 0) + 1;
          numbered.set(layer.id, n);
          name = `${layer.label} ${n}`;
        } while (used.has(nameKey(name)));
      }
      used.add(nameKey(name));
      draft.name = name;
    }
  }

  const places: WorldPlace[] = drafts.map((draft, index) => {
    const cell = draft.cell ?? 0;
    const settlement = draft.depth === settlementsDepth;
    return {
      id: `p${index}`,
      name: draft.name!,
      layer: kit.layers[draft.depth]!.id,
      depth: draft.depth,
      parentId: draft.parent === null ? null : `p${draft.parent}`,
      at: { x: cell % width, y: Math.floor(cell / width) },
      culture: draft.culture ?? cultures[0]!,
      ...(settlement ? { size: kit.sizes[draft.size!]!.id, rank: draft.size!, prosperity: draft.prosperity! } : {}),
      tags: draft.tags ?? (draft.brief?.tags ? [...draft.brief.tags] : []),
      ...(draft.brief?.note ? { note: draft.brief.note } : {}),
      ...(draft.brief?.lore?.length ? { lore: [...draft.brief.lore] } : {}),
      named: Boolean(draft.brief),
    };
  });

  const links = compileLinks(
    kit,
    kinds,
    terrain,
    width,
    places.filter((place) => place.depth === settlementsDepth),
  );

  // Where the party starts: the brief's starting place (or the first settlement inside it), else the
  // biggest settlement of the first outermost place.
  const startBrief = briefPlaces.find((place) => place.start);
  const startDraft = startBrief ? briefIndex.get(nameKey(startBrief.name)) : undefined;
  const settlementIds = places.filter((place) => place.depth === settlementsDepth);
  const within = (place: WorldPlace, ancestorId: string): boolean => {
    for (
      let at: WorldPlace | undefined = place;
      at;
      at = at.parentId ? places[Number(at.parentId.slice(1))] : undefined
    ) {
      if (at.id === ancestorId) return true;
    }
    return false;
  };
  const startFrom =
    startDraft !== undefined
      ? (settlementIds.find((place) => within(place, `p${startDraft}`)) ?? places[startDraft])
      : undefined;
  const fallback = settlementIds.reduce(
    (best, place) => ((place.rank ?? 0) > (best.rank ?? 0) ? place : best),
    settlementIds[0]!,
  );

  // Generator 2: sites out of the settlements, after everything else, so the rest is made as before.
  // Never in a strict world, which holds the brief's places and nothing invented beside them.
  if (generatorVersion >= 2 && !strict)
    places.push(...compileSites(seed, kit, places, kindOf, width, height, settlementsDepth));

  return {
    generatorVersion,
    seed,
    width,
    height,
    terrain: terrain.map((entry) => entry.id),
    ground: Array.from(kinds, (index) => index.toString(36)).join(""),
    places,
    links,
    startId: (startFrom ?? fallback).id,
  };
}

// ── Sites (generator 2): caves, ruins and crypts a few steps out of the settlements ──

/** The word a site of each kind is named with, by the setting's art family. */
const SITE_WORDS: Record<string, Record<"cave" | "ruins" | "dungeon", string>> = {
  default: { cave: "Caves", ruins: "Ruins", dungeon: "Crypt" },
  modern: { cave: "Caves", ruins: "Ruins", dungeon: "Tunnels" },
  jazz_age: { cave: "Caves", ruins: "Ruins", dungeon: "Tunnels" },
  scifi: { cave: "Tunnels", ruins: "Derelict", dungeon: "Bunker" },
  wasteland: { cave: "Caves", ruins: "Ruins", dungeon: "Bunker" },
};

/** Up to two sites in each region (the layer the settlements are in), each beside one of its settlements:
 *  on open ground two to four cells out, in the layer inside the settlements, named after the settlement
 *  and what it is ("Hollin Caves"). The kinds are the setting's own scenes that are caves, ruins or
 *  dungeons, else all three. A kit with no layer inside its settlements has no sites. */
function compileSites(
  seed: number,
  kit: WorldKit,
  places: WorldPlace[],
  kindOf: (cell: number) => string,
  width: number,
  height: number,
  settlementsDepth: number,
): WorldPlace[] {
  const inner = kit.layers[settlementsDepth + 1];
  if (!inner) return [];
  const words = SITE_WORDS[worldKitArtFamily(kit) ?? ""] ?? SITE_WORDS.default!;
  const sceneKinds = [
    ...new Set(
      (kit.scenes ?? [])
        .map((scene) => scene.like)
        .filter(
          (like): like is "cave" | "ruins" | "dungeon" => like === "cave" || like === "ruins" || like === "dungeon",
        ),
    ),
  ];
  const kinds = sceneKinds.length ? sceneKinds : (["cave", "ruins", "dungeon"] as const);
  const settlements = places.filter((place) => place.depth === settlementsDepth);
  const taken = new Set(places.map((place) => place.at.y * width + place.at.x));
  const names = new Set(places.map((place) => place.name.toLowerCase()));
  const regions = new Map<string, WorldPlace[]>();
  for (const settlement of settlements) {
    const key = settlement.parentId ?? "";
    regions.set(key, [...(regions.get(key) ?? []), settlement]);
  }
  const sites: WorldPlace[] = [];
  for (const [region, members] of regions) {
    const random = worldStream(seed, "sites", region);
    const count = Math.min(members.length, between(1, 2, random));
    const order = [...members];
    for (let index = order.length - 1; index > 0; index--) {
      const other = Math.floor(random() * (index + 1));
      [order[index], order[other]] = [order[other]!, order[index]!];
    }
    const chosen = order.slice(0, count);
    for (const settlement of chosen) {
      const open: number[] = [];
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const [x, y] = [settlement.at.x + dx, settlement.at.y + dy];
          const far = Math.max(Math.abs(dx), Math.abs(dy));
          if (far < 2 || x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
          const cell = y * width + x;
          if (!taken.has(cell) && kindOf(cell) === "open") open.push(cell);
        }
      const kind = pick(kinds, random);
      const name = `${settlement.name} ${words[kind]}`;
      if (!open.length || names.has(name.toLowerCase())) continue;
      const cell = pick(open, random);
      taken.add(cell);
      names.add(name.toLowerCase());
      sites.push({
        id: `p${places.length + sites.length}`,
        name,
        layer: inner.id,
        depth: settlementsDepth + 1,
        parentId: settlement.id,
        at: { x: cell % width, y: Math.floor(cell / width) },
        culture: settlement.culture,
        // Named for what it is ("Ruins"), never tagged: a kit's tags are its own words.
        tags: [],
        named: false,
      });
    }
  }
  return sites;
}

// ── Links: a connected web over the settlements, each trip by the way that fits the ground ──

/** The ways between settlements: a connected web over them, each trip by the way that fits the ground.
 *  Exported for the edit layer, which lays them again when places move or the ground is painted. */
export function compileLinks(
  kit: WorldKit,
  kinds: Uint8Array,
  terrain: Array<{ kind: string }>,
  width: number,
  settlements: WorldPlace[],
): WorldLink[] {
  if (settlements.length < 2) return [];
  const distance = (a: WorldPlace, b: WorldPlace) => Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y);
  const pairs = new Set<string>();
  const edges: Array<[number, number]> = [];
  const add = (a: number, b: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (a === b || pairs.has(key)) return;
    pairs.add(key);
    edges.push(a < b ? [a, b] : [b, a]);
  };
  // A minimum spanning tree keeps every settlement reachable (Prim's, ties by order).
  const inTree = new Set<number>([0]);
  while (inTree.size < settlements.length) {
    let best: [number, number] | null = null;
    let bestDistance = Infinity;
    for (const a of inTree) {
      settlements.forEach((place, b) => {
        if (inTree.has(b)) return;
        const d = distance(settlements[a]!, place);
        if (d < bestDistance) {
          best = [a, b];
          bestDistance = d;
        }
      });
    }
    const [a, b] = best!;
    add(a, b);
    inTree.add(b);
  }
  // Then each settlement's nearest neighbour, so the web has loops rather than one long chain.
  settlements.forEach((place, a) => {
    let nearest = -1;
    let nearestDistance = Infinity;
    settlements.forEach((other, b) => {
      if (a === b) return;
      const d = distance(place, other);
      if (d < nearestDistance) {
        nearest = b;
        nearestDistance = d;
      }
    });
    if (nearest >= 0) add(a, nearest);
  });

  const ways = kit.travel.map((way) => ({ id: way.id, crosses: way.crosses ?? "open", speed: way.speed ?? 1 }));
  const first = (crosses: string) => ways.find((way) => way.crosses === crosses);
  const fastest = (crosses: string) =>
    ways
      .filter((way) => way.crosses === crosses)
      .reduce<(typeof ways)[number] | undefined>(
        (best, way) => (!best || way.speed > best.speed ? way : best),
        undefined,
      );
  const daysPerCell = WORLD_DAYS_PER_CELL[kit.scale];
  return edges
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
    .map(([a, b]) => {
      const from = settlements[a]!;
      const to = settlements[b]!;
      // What the straight line between them crosses decides the way: a barrier needs a way that
      // crosses anything (the kit's first), mostly water the fastest boat, otherwise the fastest way
      // over open ground.
      const steps = Math.max(1, Math.ceil(distance(from, to)));
      let water = 0;
      let barrier = false;
      for (let step = 0; step <= steps; step++) {
        const x = Math.round(from.at.x + ((to.at.x - from.at.x) * step) / steps);
        const y = Math.round(from.at.y + ((to.at.y - from.at.y) * step) / steps);
        const kind = terrain[kinds[y * width + x]!]!.kind;
        if (kind === "barrier") barrier = true;
        if (kind === "water") water++;
      }
      const overWater = water / (steps + 1) > 0.3;
      const way =
        (barrier ? first("any") : overWater ? (fastest("water") ?? first("any")) : fastest("open")) ??
        first("open") ??
        fastest("any") ??
        ways[0]!;
      const days = Math.round(((distance(from, to) * daysPerCell) / way.speed) * 100) / 100;
      return { from: from.id, to: to.id, way: way.id, days };
    });
}
