// ──────────────────────────────────────────────
// The world engine in play (worldgen W5): a week of the world's own business at a time, on the world
// as the story has left it. The rules are the history's (W3) at a week's grain: fortunes and how groups
// get on drift and are pulled back toward the middle, heads step down, trouble finds places on hard
// times, and tension that has brewed for a season can become a war over a place. Only the kinds of
// change the world has, scaled by its pace. It never resolves a change where the party is (that is a
// hook for the scene) and never touches the party. Its dice come from the seed and the step, and the
// state the story has built so far, so the same replies always give the same world.
// ──────────────────────────────────────────────
import type { WorldChangeKind } from "../../schemas/world-kit.schema.js";
import { worldStream, type WorldPlace } from "./compile.js";
import { worldPlaceNamed } from "./edits.js";
import { worldPreEdit, type GameWorld } from "./game-world.js";
import { worldFullName } from "./people.js";

/** Days in one step of the world in play. */
export const WORLD_STEP_DAYS = 7;
/** Steps of tension before a war can break out in play: a season. */
export const WORLD_PLAY_BUILD_UP = 13;
const PLAY_DENSITY = { still: 0, slow: 0.5, steady: 1, quick: 1.5 } as const;

/** Something that happened in the world, as news that travels from where it happened. */
export interface WorldNews {
  /** The day of play it happened (0 is the day play began). */
  day: number;
  kind: WorldChangeKind;
  text: string;
  /** Where it happened, a settlement; none for news that is everywhere at once. */
  placeId?: string;
  severe?: true;
  /** A warning of something building, not yet happened, and the pending outcome it warns of. */
  brewing?: true;
  pending?: string;
}

/** A severe outcome the engine has building: a war between two groups. */
export interface WorldPending {
  id: string;
  groups: [string, string];
  /** The step its tension began. */
  sinceStep: number;
  /** The Game Master's hold, on one of the two grounds. */
  held?: "no-sense" | "no-agency";
}

/** What the engine reads and writes, the part of the present it owns. */
export interface WorldEngineState {
  day: number;
  /** How each settlement is doing, 0 to 100 (struggling below 34, thriving from 67). */
  fortune: Record<string, number>;
  ruined: string[];
  keepers: Record<string, string>;
  leaders: Record<string, { name: string; sinceYearsAgo: number }>;
  relations: Record<string, number>;
  gone: string[];
  groups: Array<{ name: string; kind: string; seat?: string }>;
  news: WorldNews[];
  pending: WorldPending[];
  /** How many pending outcomes have been raised, for their ids. */
  raised: number;
}

const clamp = (value: number, low = -100, high = 100) => Math.max(low, Math.min(high, value));
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const pick = <T>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)]!;

/** A settlement's band, from its fortune. */
export function worldFortuneBand(fortune: number): "struggling" | "modest" | "thriving" {
  return fortune < 34 ? "struggling" : fortune < 67 ? "modest" : "thriving";
}

/** The settlement a place is in, or the place itself; none above the settlements. */
export function worldSettlementOf(game: GameWorld, placeId: string | undefined): WorldPlace | undefined {
  let place = placeId ? game.world.places.find((each) => each.id === placeId) : undefined;
  while (place && place.rank === undefined) {
    const up: string | null = place.parentId;
    place = up ? game.world.places.find((each) => each.id === up) : undefined;
  }
  return place;
}

/**
 * One week of the world's own business, on `state`. `partyAt` is the settlement the party is in: no
 * change is resolved there, and a war over it stays pending, a hook for the scene.
 */
export function stepWorld(game: GameWorld, state: WorldEngineState, step: number, partyAt: string | undefined): void {
  const { kit, brief, world, seed } = game;
  const density = PLAY_DENSITY[kit.change.pace];
  if (!density) return;
  const on = (kind: WorldChangeKind) => kit.change.kinds[kind].on;
  const random = worldStream(seed, "play", String(step));
  const day = step * WORLD_STEP_DAYS;
  // ponytail: a settlement added by hand (W9c) is left out of the world's own changes, so adding one never
  // rewrites the weeks already played (the present is folded again from day 0). Its fortune stays where
  // it started; stamping the day it was added and joining it from then is the upgrade.
  const settlements = world.places.filter(
    (place) => place.rank !== undefined && !place.byHand && !state.ruined.includes(place.id) && place.id !== partyAt,
  );
  const say = (news: Omit<WorldNews, "day">) => state.news.push({ day, ...news });
  const seatOf = (name: string) => {
    const seat =
      brief.groups.find((group) => group.name === name)?.seat ??
      state.groups.find((group) => group.name === name)?.seat;
    return worldPlaceNamed(world.places, seat);
  };
  // One name, one group: a group the story brings back under a gone brief group's name is listed once.
  const living = [...new Set([...brief.groups.map((group) => group.name), ...state.groups.map((group) => group.name)])]
    .filter((name) => !state.gone.includes(name))
    .sort();

  // Heads keep leading as time passes: a week older in their tenure, before anyone new takes the lead.
  // Replaced, never changed in place: the history's own heads are shared with every fold.
  for (const [group, leader] of Object.entries(state.leaders)) {
    state.leaders[group] = { ...leader, sinceYearsAgo: leader.sinceYearsAgo + WORLD_STEP_DAYS / 365 };
  }

  // Fortunes: drift, pulled back toward the middle; a place starting to prosper or falling on hard
  // times is news where the world has fortunes (settling back to getting by is not).
  for (const place of settlements) {
    const before = state.fortune[place.id] ?? 50;
    const after = clamp(before + (random() - 0.5) * 6 * density + (50 - before) * 0.02, 0, 100);
    state.fortune[place.id] = after;
    const band = worldFortuneBand(after);
    if (on("fortunes") && band !== "modest" && worldFortuneBand(before) !== band) {
      say({
        kind: "fortunes",
        text: band === "thriving" ? `${place.name} is prospering.` : `${place.name} has fallen on hard times.`,
        placeId: place.id,
      });
    }
  }

  // Everyday life: a busy week somewhere.
  if (on("everyday") && settlements.length && random() < 0.3 * density) {
    const place = pick(settlements, random);
    state.fortune[place.id] = clamp((state.fortune[place.id] ?? 50) + 2, 0, 100);
    say({ kind: "everyday", text: `${place.name} had a busy market week.`, placeId: place.id });
  }

  // People's lives: newcomers settle; the heads of two groups grow close.
  if (on("lives")) {
    if (settlements.length && random() < 0.15 * density) {
      const place = pick(settlements, random);
      say({ kind: "lives", text: `A newcomer settled in ${place.name}.`, placeId: place.id });
    }
    if (living.length >= 2 && random() < 0.06 * density) {
      const a = pick(living, random);
      const b = pick(
        living.filter((name) => name !== a),
        random,
      );
      const key = pairKey(a, b);
      state.relations[key] = clamp((state.relations[key] ?? 0) + 15);
      say({ kind: "lives", text: `The heads of ${a} and ${b} have grown close.`, placeId: seatOf(a)?.id });
    }
  }

  // How groups get on: drift, pulled back toward getting along; rivals keep pulling apart.
  for (const a of living) {
    for (const b of living) {
      if (a >= b) continue;
      const key = pairKey(a, b);
      const before = state.relations[key] ?? 0;
      const rivals = brief.groups.some(
        (group) => (group.name === a && group.rivals.includes(b)) || (group.name === b && group.rivals.includes(a)),
      );
      const after = clamp(before * 0.99 + (random() - 0.5) * 4 * density - (rivals ? 0.6 * density : 0));
      state.relations[key] = after;
      if (on("rivalry") && before >= -30 && after < -30) {
        say({ kind: "rivalry", text: `${a} and ${b} have become rivals.`, placeId: seatOf(a)?.id });
      }
    }
  }

  // Leadership: a head who has led long steps down; never at the party's place.
  if (on("leadership")) {
    for (const name of living) {
      const leader = state.leaders[name];
      const seat = seatOf(name);
      if (seat && worldSettlementOf(game, seat.id)?.id === partyAt) continue;
      if (leader && leader.sinceYearsAgo < 20) continue;
      if (random() >= 0.004 * density) continue;
      const names = brief.peopleNames.find((each) => each.culture === (seat?.culture ?? kit.cultures[0]!.id));
      const others = new Set(
        Object.entries(state.leaders)
          .filter(([group]) => group !== name)
          .map(([, each]) => each.name),
      );
      let next = names?.given.length ? worldFullName(names, random) : "";
      for (let attempt = 0; attempt < 12 && next && others.has(next); attempt++) next = worldFullName(names!, random);
      if (!next || others.has(next)) continue;
      state.leaders[name] = { name: next, sinceYearsAgo: 0 };
      say({ kind: "leadership", text: `${next} has taken the lead of ${name}.`, placeId: seat?.id });
    }
  }

  // Crime: trouble finds a place on hard times.
  if (on("crime") && random() < 0.1 * density) {
    const poor = settlements.filter((place) => (state.fortune[place.id] ?? 50) < 34);
    if (poor.length) {
      const place = pick(poor, random);
      state.fortune[place.id] = clamp(state.fortune[place.id]! - 6, 0, 100);
      say({ kind: "crime", text: `There has been trouble around ${place.name}.`, placeId: place.id });
    }
  }

  // Conflict: tension below -60 brews for a season, then may become a war over a place one side keeps.
  if (on("conflict")) {
    for (const a of living) {
      for (const b of living) {
        if (a >= b) continue;
        const tense = (state.relations[pairKey(a, b)] ?? 0) < -60;
        const pending = state.pending.find((each) => each.groups[0] === a && each.groups[1] === b);
        if (!tense) {
          if (pending) {
            state.pending.splice(state.pending.indexOf(pending), 1);
            say({ kind: "conflict", text: `The tension between ${a} and ${b} has eased.`, placeId: seatOf(a)?.id });
          }
          continue;
        }
        if (!pending) {
          state.raised += 1;
          state.pending.push({ id: `p${state.raised}`, groups: [a, b], sinceStep: step });
          say({
            kind: "conflict",
            text: `Tension is rising between ${a} and ${b}.`,
            placeId: seatOf(a)?.id,
            brewing: true,
            pending: `p${state.raised}`,
          });
          continue;
        }
        if (pending.held || step - pending.sinceStep < WORLD_PLAY_BUILD_UP || random() > 0.25 * density) continue;
        // Never where the party is: a war over the party's place waits for the scene.
        const contested = settlements.filter((place) => [a, b].includes(state.keepers[place.id] ?? ""));
        if (!contested.length) continue;
        const place = pick(contested, random);
        const winner = random() < 0.5 ? a : b;
        const loser = winner === a ? b : a;
        state.keepers[place.id] = winner;
        state.fortune[place.id] = clamp((state.fortune[place.id] ?? 50) - 25, 0, 100);
        state.relations[pairKey(a, b)] = -20;
        state.pending.splice(state.pending.indexOf(pending), 1);
        say({
          kind: "conflict",
          text: `${winner} and ${loser} came to blows; ${winner} took ${place.name}.`,
          placeId: place.id,
          severe: true,
        });
      }
    }
  }
}

/** Days from each settlement to `from` along the world's links (none for a place no way reaches). The
 *  links are the compiled world's: how far word and change travel is the world's own, which hand edits
 *  (W9c) never rewrite for the weeks already played, as they never rewrite its history. */
export function worldTravelDays(game: GameWorld, from: string): Map<string, number> {
  const links = game.edits ? worldPreEdit(game).links : game.world.links;
  const known = travelCache.get(links);
  const cached = known?.get(from);
  if (cached) return cached;
  const days = new Map<string, number>([[from, 0]]);
  const queue = [from];
  while (queue.length) {
    queue.sort((a, b) => days.get(a)! - days.get(b)!);
    const at = queue.shift()!;
    for (const link of links) {
      const other = link.from === at ? link.to : link.to === at ? link.from : undefined;
      if (!other) continue;
      const total = days.get(at)! + link.days;
      if (total < (days.get(other) ?? Infinity)) {
        days.set(other, total);
        queue.push(other);
      }
    }
  }
  const map = known ?? new Map<string, Map<string, number>>();
  map.set(from, days);
  travelCache.set(links, map);
  return days;
}
const travelCache = new WeakMap<object, Map<string, Map<string, number>>>();
