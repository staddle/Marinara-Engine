// What a weapon shoots and what it has loaded, and what using an item spends of it, as a fight counts
// them.
//
// A weapon's `ammo` draws from the items its holder carries with that tag, in the order the bag keeps
// them; its `clip` is a loaded count the weapon keeps on itself. Both are counted on the fighter
// (`itemsUsed`, `loaded`, `recoverable`), keyed by the item's place in the fighter's items, so what a
// step changed can be written back to exactly those inventory stacks.
//
// Pure, like the rest of the fight: each function changes the fighter it is handed and returns the
// event that says so.

import type { GameInventoryJournalEntry } from "../../utils/game-inventory-ops.js";
import { GAME_INVENTORY_MAX_QUANTITY, type GameInventoryStack } from "../../utils/game-inventory-stacks.js";
import type { RulesetDefinition } from "../../schemas/ruleset.schema.js";
import type {
  RulesetCombatAction,
  RulesetCombatant,
  RulesetCombatMode,
  RulesetDroppedThing,
  RulesetCombatEvent,
  RulesetEncounterState,
} from "./types.js";

/** How many one attack shoots: what its mode says, else what its ammunition says, else one. */
function shotsPer(action: RulesetCombatAction): number {
  return action.shots ?? action.ammo?.per ?? 1;
}

/**
 * An attack made in one of its weapon's modes: named for it, adding what the mode adds to hit (dice
 * in a pool fight), moving a pool fight's per-die target (from the weapon's own, else the pool's),
 * aimed at as many as the mode says, and shooting what one attack in it shoots. Null for a mode the
 * weapon does not have.
 */
export function rulesetModedAction(
  definition: RulesetDefinition,
  action: RulesetCombatAction,
  modeId: string,
): RulesetCombatAction | null {
  const mode = action.modes?.find((entry) => entry.id === modeId);
  if (!mode) return null;
  const poolTarget = definition.resolution.kind === "dice-pool" ? definition.resolution.target.default : undefined;
  const base = action.target ?? poolTarget;
  return {
    ...action,
    label: `${action.label} (${mode.label})`,
    ...(mode.toHit !== undefined && action.toHit !== undefined ? { toHit: action.toHit + mode.toHit } : {}),
    ...(mode.target !== undefined && base !== undefined ? { target: base + mode.target } : {}),
    ...(mode.targets !== undefined ? { targets: { ...action.targets, count: mode.targets } } : {}),
    ...(mode.ammo !== undefined ? { shots: mode.ammo } : {}),
    // Its own reach and clauses (1.190): a javelin of lightning's bolt, 4d6 more on a hit.
    ...(mode.range ? { range: { ...mode.range } } : {}),
    ...(mode.plus?.length && action.damage
      ? { damage: { ...action.damage, plus: [...(action.damage.plus ?? []), ...mode.plus] } }
      : {}),
    // The one cure picked (1.204), in place of all of them.
    ...(mode.cure ? cureOnly(mode.cure) : {}),
    // The creature type picked (1.270), remembered by what it puts on: Antipathy/Sympathy.
    ...(mode.kind && action.applies ? { applies: action.applies.map((one) => ({ ...one, kind: mode.kind })) } : {}),
    // What a hit sets off around whoever it hit (1.312): a Hammer of Thunderbolts' clap.
    ...(mode.aroundHit ? { aroundHit: mode.aroundHit } : {}),
  };
}

/** A cure that does one of its cures, narrowed to the one a mode names (1.204). */
function cureOnly(
  cure: NonNullable<RulesetCombatMode["cure"]>,
): Partial<RulesetCombatAction> & { cureOneOf: undefined } {
  return {
    cureOneOf: undefined,
    ends: cure.ends !== undefined ? { conditions: [cure.ends], count: 1 } : undefined,
    tracks: cure.track ? [{ ...cure.track }] : undefined,
    unseals: cure.unseals,
  };
}

/** What is left of an item's charges a weapon spends (1.187, 1.190): as this fight left them, else
 *  as its stack kept them, else full. */
export function rulesetItemChargesLeft(actor: RulesetCombatant, charges: { max: number; item: number }): number {
  return Math.min(
    charges.max,
    actor.charges?.[charges.item] ?? actor.sheet?.items?.[charges.item]?.charges ?? charges.max,
  );
}

/** Whether one of the fighter's items is switched on (1.170): as this fight left it, else as its stack
 *  kept it. Off unless something turned it on. */
export function rulesetItemOn(actor: RulesetCombatant, item: number): boolean {
  return actor.on?.[item] ?? actor.sheet?.items?.[item]?.on === true;
}

/** How many of the items with this tag the fighter still carries. */
export function rulesetAmmoLeft(actor: RulesetCombatant, tag: string): number {
  let left = 0;
  (actor.sheet?.items ?? []).forEach((held, index) => {
    if (held.item.tags?.includes(tag)) left += Math.max(0, held.quantity - (actor.itemsUsed?.[index] ?? 0));
  });
  return left;
}

/** What a weapon has loaded now: what this fight has left in it, else what its stack kept, else a
 *  full clip, since a weapon nobody has fired yet is loaded. */
export function rulesetLoaded(actor: RulesetCombatant, clip: NonNullable<RulesetCombatAction["clip"]>): number {
  const now = actor.loaded?.[clip.item] ?? actor.sheet?.items?.[clip.item]?.loaded ?? clip.max;
  return Math.max(0, Math.min(clip.max, now));
}

/** How many uses an item has left in a fight: one per item still in its stack where a use takes one,
 *  and otherwise its charges now (what the fight left it, else what its stack kept, else all of them). */
export function rulesetItemUseLeft(actor: RulesetCombatant, use: NonNullable<RulesetCombatAction["itemUse"]>): number {
  const held = actor.sheet?.items?.[use.item];
  if (use.consumes) return Math.max(0, (held?.quantity ?? 0) - (actor.itemsUsed?.[use.item] ?? 0));
  if (!use.charges) return Number.POSITIVE_INFINITY;
  const now = actor.charges?.[use.item] ?? held?.charges ?? use.charges.max;
  return Math.max(0, Math.min(use.charges.max, now));
}

/** Whether what an action shoots or loads lets it happen now: an attack needs a shot loaded or
 *  carried, a reload a clip with room in it and, where it loads from the bag, something to load. An
 *  item's use needs one of it left, or the charges it spends. */
export function rulesetShotsAvailable(actor: RulesetCombatant, action: RulesetCombatAction): boolean {
  if (action.itemUse) {
    const left = rulesetItemUseLeft(actor, action.itemUse);
    return action.itemUse.consumes ? left >= 1 : left >= (action.itemUse.charges?.cost ?? 0);
  }
  if (action.kind === "reload") {
    if (!action.clip || rulesetLoaded(actor, action.clip) >= action.clip.max) return false;
    return !action.ammo || rulesetAmmoLeft(actor, action.ammo.tag) > 0;
  }
  const per = shotsPer(action);
  if (action.clip) return rulesetLoaded(actor, action.clip) >= per;
  if (action.ammo) return rulesetAmmoLeft(actor, action.ammo.tag) >= per;
  return true;
}

/** Takes up to `count` of the items with this tag out of the fighter's bag, first stack first, and
 *  notes the share of them that comes back after a won fight. How many were taken. */
function draw(actor: RulesetCombatant, tag: string, count: number, recover?: number): number {
  let wanted = count;
  (actor.sheet?.items ?? []).forEach((held, index) => {
    if (wanted <= 0 || !held.item.tags?.includes(tag)) return;
    const used = actor.itemsUsed?.[index] ?? 0;
    const take = Math.min(wanted, Math.max(0, held.quantity - used));
    if (take <= 0) return;
    (actor.itemsUsed ??= {})[index] = used + take;
    if (recover) {
      const recoverable = (actor.recoverable ??= {});
      recoverable[index] = (recoverable[index] ?? 0) + take * recover;
    }
    wanted -= take;
  });
  return count - wanted;
}

/** One attack's shots, spent: out of the clip where the weapon has one, and otherwise out of the
 *  bag. Null for an action that shoots nothing. */
export function spendRulesetShots(
  actor: RulesetCombatant,
  action: RulesetCombatAction,
  /** More charges spent on it beyond its own (1.269). */
  more = 0,
): RulesetCombatEvent | null {
  if (action.kind === "reload") return null;
  const use = action.itemUse;
  if (use && (use.consumes || use.charges)) {
    const said = { type: "uses" as const, actorId: actor.id, optionId: action.id, label: action.label };
    if (use.consumes) {
      const quantity = actor.sheet?.items?.[use.item]?.quantity ?? 0;
      (actor.itemsUsed ??= {})[use.item] = (actor.itemsUsed?.[use.item] ?? 0) + 1;
      return { ...said, left: rulesetItemUseLeft(actor, use), of: quantity };
    }
    const left = Math.max(0, rulesetItemUseLeft(actor, use) - use.charges!.cost - more);
    (actor.charges ??= {})[use.item] = left;
    return { ...said, left, of: use.charges!.max };
  }
  const said = { type: "shot" as const, actorId: actor.id, optionId: action.id, label: action.label };
  const per = shotsPer(action);
  if (action.clip) {
    const left = Math.max(0, rulesetLoaded(actor, action.clip) - per);
    (actor.loaded ??= {})[action.clip.item] = left;
    return { ...said, left, of: action.clip.max };
  }
  if (!action.ammo) return null;
  draw(actor, action.ammo.tag, per, action.ammo.recover);
  return { ...said, left: rulesetAmmoLeft(actor, action.ammo.tag) };
}

/** A clip filled to its most, out of what it shoots where it loads from the bag: as much as the bag
 *  still holds when that is less. */
export function reloadRulesetClip(actor: RulesetCombatant, action: RulesetCombatAction): RulesetCombatEvent | null {
  const clip = action.clip;
  if (!clip) return null;
  const now = rulesetLoaded(actor, clip);
  const drew = action.ammo ? draw(actor, action.ammo.tag, clip.max - now) : undefined;
  const loaded = now + (drew ?? clip.max - now);
  (actor.loaded ??= {})[clip.item] = loaded;
  return {
    type: "reload",
    actorId: actor.id,
    optionId: action.id,
    label: action.label,
    loaded,
    of: clip.max,
    ...(drew !== undefined ? { drew } : {}),
  };
}

/** After a fight the party won: the share of what each of them shot that comes back, stack by stack,
 *  rounded down once for the whole fight. */
export function recoverRulesetAmmo(state: RulesetEncounterState): RulesetCombatEvent[] {
  const events: RulesetCombatEvent[] = [];
  for (const combatant of state.combatants) {
    if (!combatant.recoverable) continue;
    for (const [index, share] of Object.entries(combatant.recoverable)) {
      // A share summed in steps of a fraction may land a hair under the whole number it means.
      const back = Math.min(Math.floor(share + 1e-9), combatant.itemsUsed?.[index] ?? 0);
      if (back <= 0) continue;
      combatant.itemsUsed![index]! -= back;
      events.push({
        type: "recovered",
        actorId: combatant.id,
        label: combatant.sheet?.items?.[Number(index)]?.name ?? "",
        count: back,
      });
    }
    delete combatant.recoverable;
  }
  return events;
}

/** An item whose use just spent its last charge rolls its `breaksOn` die, and at or under `atMost` it
 *  breaks: taken off its stack of one, so the fight's write-back removes it. Null when it holds on. */
export function breakRulesetItem(
  actor: RulesetCombatant,
  action: RulesetCombatAction,
  roll: (sides: number) => number,
): RulesetCombatEvent | null {
  const use = action.itemUse;
  const breaks = use?.charges?.breaksOn;
  if (!use?.charges || !breaks || rulesetItemUseLeft(actor, use) > 0 || actor.broken?.[use.item]) return null;
  const face = roll(breaks.die);
  // A high face gives charges back instead (1.271): a Staff of the Magi's 20.
  if (breaks.regains && face >= breaks.regains.atLeast) {
    const amount = breaks.regains.amount;
    const rolls = Array.from({ length: Math.max(0, amount.count) }, () => roll(amount.sides));
    const back = Math.max(0, Math.min(use.charges.max, rolls.reduce((sum, one) => sum + one, 0) + amount.flat));
    (actor.charges ??= {})[use.item] = back;
    return {
      type: "recharged",
      actorId: actor.id,
      optionId: action.id,
      label: action.label,
      roll: face,
      rolls,
      amount: back,
    };
  }
  if (breaks.atMost === undefined || face > breaks.atMost) return null;
  // It becomes another item instead (1.272): a staff of striking's nonmagical quarterstaff, struck
  // and used as that from now on.
  const next = breaks.becomes !== undefined ? actor.becomes?.[use.item] : undefined;
  if (next) {
    const held = actor.sheet?.items?.[use.item];
    if (held && actor.sheet?.items) {
      const { charges: _charges, ...rest } = held;
      actor.sheet.items = actor.sheet.items.map((one, at) =>
        at === use.item ? { ...rest, item: next.item, name: next.name } : one,
      );
    }
    actor.actions = [
      ...actor.actions.filter((one) => rulesetActionItemIndex(one) !== use.item),
      ...structuredClone(next.actions),
    ];
    (actor.became ??= {})[use.item] = next.ref;
    delete actor.charges?.[use.item];
    return {
      type: "broke",
      actorId: actor.id,
      optionId: action.id,
      label: action.label,
      roll: face,
      becomes: next.name,
    };
  }
  (actor.itemsUsed ??= {})[use.item] = (actor.itemsUsed?.[use.item] ?? 0) + 1;
  (actor.broken ??= {})[use.item] = true;
  return { type: "broke", actorId: actor.id, optionId: action.id, label: action.label, roll: face };
}

/** What one step of a fight did to one of the party's inventory stacks: how many it took out of it
 *  (fewer than none when a won fight gave some back) and what a weapon has loaded now. */
export interface RulesetFightItemChange {
  stack: { id: string; ref: string; holder?: string };
  /** The stack's own name, for the journal and for a stack made again. */
  name: string;
  taken: number;
  loaded?: number;
  /** What an item with charges holds now. */
  charges?: number;
  /** It broke when its last charge was spent: what was taken is lost, not used. */
  broke?: true;
  /** It became another item when its last charge was spent (1.272): that item, and its name. */
  becomes?: { ref: string; name: string };
  /** A fake's true name (1.79): what a use of it is written as. */
  truly?: string;
  /** Its switch as the fight left it, when the fight turned it (1.170). */
  on?: boolean;
}

/**
 * What changed of the party's inventory between two states of one fight, stack by stack: every shot,
 * load and share won back since `before`, which is nothing at all when the fight is new. An item the
 * fight was handed without a stack (a test's, or one read from nowhere) is never written anywhere.
 */
export function rulesetFightItemChanges(
  before: RulesetEncounterState | undefined,
  after: RulesetEncounterState,
): RulesetFightItemChange[] {
  const changes: RulesetFightItemChange[] = [];
  for (const combatant of after.combatants) {
    const items = combatant.sheet?.items;
    if (
      combatant.side !== "party" ||
      !items ||
      (!combatant.itemsUsed && !combatant.loaded && !combatant.charges && !combatant.on && !combatant.became)
    ) {
      continue;
    }
    const earlier = before?.combatants.find((entry) => entry.id === combatant.id);
    items.forEach((held, index) => {
      if (!held.stack) return;
      const taken = (combatant.itemsUsed?.[index] ?? 0) - (earlier?.itemsUsed?.[index] ?? 0);
      const loaded = combatant.loaded?.[index];
      const reloaded = loaded !== undefined && loaded !== earlier?.loaded?.[index];
      const charges = combatant.charges?.[index];
      const spent = charges !== undefined && charges !== earlier?.charges?.[index];
      const on = combatant.on?.[index];
      const switched = on !== undefined && on !== (earlier?.on?.[index] ?? held.on === true);
      // Become another item on its last charge (1.272), since `before`.
      const became = combatant.became?.[index];
      const turned = became !== undefined && earlier?.became?.[index] === undefined;
      if (taken === 0 && !reloaded && !spent && !switched && !turned) return;
      // The stack holds what it became from the step after it turned, so later changes name that.
      const ref = earlier?.became?.[index] ?? held.stack.ref;
      changes.push({
        stack: { ...held.stack, ref },
        name: held.name ?? held.stack.ref,
        taken,
        ...(reloaded ? { loaded } : {}),
        ...(spent ? { charges } : {}),
        ...(switched ? { on } : {}),
        ...(combatant.broken?.[index] && !earlier?.broken?.[index] ? { broke: true as const } : {}),
        ...(turned ? { becomes: { ref: became, name: combatant.sheet?.items?.[index]?.name ?? became } } : {}),
        ...(held.truly ? { truly: held.truly.name } : {}),
      });
    });
  }
  return changes;
}

/**
 * A fight's changes written onto the inventory, by stack id: each stack takes what was shot or loaded
 * out of it (and is gone at none), a weapon keeps what it has loaded, and what a won fight gives back
 * to a stack it had emptied makes that stack again, where it was. Null when the inventory no longer
 * holds what the fight counted on (a stack gone, another item or another bag under its id, or fewer
 * in it than were shot), which the caller refuses the step for, as it does a spent item it cannot
 * find.
 */
export function applyRulesetFightItemChanges(
  stacks: readonly GameInventoryStack[],
  changes: readonly RulesetFightItemChange[],
): { stacks: GameInventoryStack[]; journal: GameInventoryJournalEntry[] } | null {
  let next = [...stacks];
  const journal: GameInventoryJournalEntry[] = [];
  for (const change of changes) {
    const at = next.findIndex((stack) => stack.id === change.stack.id);
    // A fake used is found out (1.79): written by its true name. What is left of it stays as it is, since
    // the fight still holds it by what it passes for.
    if (change.taken > 0) {
      const name = change.truly && !change.broke ? change.truly : change.name;
      journal.push({ item: name, action: change.broke ? "lost" : "used", quantity: change.taken });
    }
    if (change.taken < 0) journal.push({ item: change.name, action: "acquired", quantity: -change.taken });
    if (at < 0) {
      // Only what came back may land where nothing is left: a shot or a load needed the stack.
      if (change.taken >= 0 || change.loaded !== undefined) return null;
      next.push({
        id: change.stack.id,
        name: change.name,
        item: change.stack.ref,
        quantity: Math.min(GAME_INVENTORY_MAX_QUANTITY, -change.taken),
        ...(change.stack.holder !== undefined ? { holder: change.stack.holder } : {}),
      });
      continue;
    }
    const stack = next[at]!;
    // Given to somebody else keeps a stack's id, and one fighter's shots never come out of another's bag.
    if (stack.item !== change.stack.ref || stack.holder !== change.stack.holder) return null;
    const quantity = Math.min(GAME_INVENTORY_MAX_QUANTITY, stack.quantity - change.taken);
    if (quantity < 0) return null;
    if (quantity === 0) {
      next = next.filter((_, index) => index !== at);
      continue;
    }
    const { on: wasOn, ...kept } = stack;
    const on = change.on ?? wasOn === true;
    // Become another item (1.272): the stack holds that item now, under its name, with no charges.
    if (change.becomes) {
      const { charges: _charges, loaded: _loaded, ...plain } = kept;
      journal.push({ item: stack.name, action: "lost", quantity: 1 });
      journal.push({ item: change.becomes.name, action: "acquired", quantity: 1 });
      next[at] = { ...plain, item: change.becomes.ref, name: change.becomes.name, quantity };
      continue;
    }
    next[at] = {
      ...kept,
      quantity,
      ...(change.loaded !== undefined ? { loaded: change.loaded } : {}),
      ...(change.charges !== undefined ? { charges: change.charges } : {}),
      ...(on && quantity === 1 ? { on: true as const } : {}),
    };
  }
  return { stacks: next, journal };
}

/** The option that picks something dropped back up (1.266), followed by what it picks up. */
export const RULESET_PICK_UP_OPTION_PREFIX = "pickup:";
/** Spending more of an item's charges on a use (1.269): `charges:<how many more>`, paid with as a
 *  higher pool is, a step of a higher cost each. */
export const RULESET_CHARGE_STEP_PREFIX = "charges:";

/** How many more charges a payment spends on this action (1.269), or null for a payment of another
 *  kind. Never past what its use allows. */
export function rulesetChargeSteps(action: RulesetCombatAction, payWith: string | undefined): number | null {
  const step = action.itemUse?.charges?.step;
  if (!step || !payWith?.startsWith(RULESET_CHARGE_STEP_PREFIX)) return null;
  const more = Number(payWith.slice(RULESET_CHARGE_STEP_PREFIX.length));
  return Number.isInteger(more) && more > 0 ? Math.min(more, step.max) : 0;
}

/** Averting the eyes from a gaze's holder, or looking again (1.268): `avert:<holder id>`. */
export const RULESET_AVERT_OPTION_PREFIX = "avert:";

const ITEM_ACTION = /^(?:item|offhand|use|switch|reload|spend):(\d+)(?::\d+)?$/;

/** The place in its holder's items of the item an action is made with, when it is one: a weapon's
 *  blow, its off-hand blow, a use, a switch, a reload or charges spent on a hit (1.273). */
export function rulesetActionItemIndex(action: Pick<RulesetCombatAction, "id">): number | undefined {
  const match = ITEM_ACTION.exec(action.id);
  return match ? Number(match[1]) : undefined;
}

/** Whether what an action is made with lies where its holder dropped it (1.266): a held item's
 *  every action, or a stat block's own. */
export function rulesetActionDropped(actor: RulesetCombatant, action: RulesetCombatAction): boolean {
  if (!actor.dropped?.length) return false;
  const index = actor.sheet ? rulesetActionItemIndex(action) : undefined;
  const key = index !== undefined ? `item:${index}` : action.id;
  return actor.dropped.some((thing) => thing.key === key);
}

/** The items a fighter holds that do nothing for them now, dropped (1.266), by their place. */
export function rulesetDroppedItems(actor: RulesetCombatant): Set<number> {
  const out = new Set<number>();
  if (!actor.sheet) return out;
  for (const thing of actor.dropped ?? []) {
    if (thing.key.startsWith("item:")) out.add(Number(thing.key.slice("item:".length)));
  }
  return out;
}

/** What a stat block's held things it has let fall (1.267) gave its defense. */
export function rulesetDroppedHeldDefense(actor: RulesetCombatant): number {
  if (!actor.block?.held || !actor.dropped?.length) return 0;
  let lost = 0;
  for (const thing of actor.dropped) {
    if (!thing.key.startsWith("held:")) continue;
    lost += actor.block.held[Number(thing.key.slice("held:".length))]?.defense ?? 0;
  }
  return lost;
}

/** What a fighter would let fall now (1.266): each worn item taking one of `slots` or carrying one of
 *  `tags`, and each of a stat block's actions carrying one of `tags`, that is not down already. */
export function rulesetThingsToDrop(
  actor: RulesetCombatant,
  drops: { slots?: string[]; tags?: string[]; pickUp?: string },
): RulesetDroppedThing[] {
  const down = new Set((actor.dropped ?? []).map((thing) => thing.key));
  const at = typeof actor.x === "number" && typeof actor.y === "number" ? { x: actor.x, y: actor.y } : undefined;
  const out: RulesetDroppedThing[] = [];
  const add = (key: string, label: string) => {
    if (down.has(key)) return;
    down.add(key);
    out.push({ key, label, ...(at ? { at } : {}), ...(drops.pickUp ? { pickUp: drops.pickUp } : {}) });
  };
  if (actor.sheet) {
    (actor.sheet.items ?? []).forEach((held, index) => {
      if (!held.worn) return;
      const slotted = drops.slots?.some((slot) => (held.item.slots?.[slot] ?? 0) > 0);
      const tagged = drops.tags?.some((tag) => held.item.tags?.includes(tag));
      if (!slotted && !tagged) return;
      const named = actor.actions.find((action) => rulesetActionItemIndex(action) === index)?.label;
      add(`item:${index}`, held.name ?? named ?? held.item.category);
    });
    return out;
  }
  for (const action of actor.actions) {
    if (drops.tags?.some((tag) => action.qualities?.includes(tag))) add(action.id, action.label);
  }
  // What it holds that is no action (1.267): a printed shield.
  actor.block?.held?.forEach((thing, index) => {
    if (drops.tags?.some((tag) => thing.tags.includes(tag))) add(`held:${index}`, thing.label);
  });
  return out;
}
