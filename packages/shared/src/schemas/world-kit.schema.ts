// ──────────────────────────────────────────────
// A setting kit (worldgen W0): the words and scales one kind of setting is written in, so a world
// can be high fantasy, a wuxia empire, a modern town or a space sector without the Engine knowing
// any of them. Data, not code: the player sees it at setup and can change any word, and a world
// generated later is written only in its words. Every word can reach the Game Master's prompt, so
// it follows the same hygiene as a ruleset's labels.
// ──────────────────────────────────────────────
import { z } from "zod";
import { TACTICAL_ENVIRONMENTS, TACTICAL_TERRAINS } from "../features/tactical-combat/environments.js";
import { promptSafeText } from "./ruleset.schema.js";

const kitId = z
  .string()
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, "An id is lowercase letters, digits and underscores, starting with a letter");
const word = promptSafeText(80);
/** A word the model picks from a list or reads inside quotes (an element, a scene, a tile): it may not
 *  hold the list's "|" or a double quote. */
const listedWord = word.refine((value) => !/[|"]/.test(value), 'May not hold "|" or a double quote');
const named = z.object({ id: kitId, label: word }).strict();

/** The generic kinds of change a world can go through, gentlest first (worldgen plan section 7). A
 *  kit names each in its own words and says which exist by default. */
export const WORLD_CHANGE_KINDS = Object.freeze([
  "everyday",
  "lives",
  "fortunes",
  "rivalry",
  "leadership",
  "crime",
  "conflict",
  "catastrophe",
] as const);
export type WorldChangeKind = (typeof WORLD_CHANGE_KINDS)[number];

/** How lively a world starts, from no off-screen change at all to a quick one. */
export const WORLD_PACES = Object.freeze(["still", "slow", "steady", "quick"] as const);
/** How big a world the setting wants, from one site to a sector. */
export const WORLD_SCALES = Object.freeze(["site", "town", "region", "realm", "world", "sector"] as const);

const changeKind = z.object({ label: word, on: z.boolean() }).strict();

/** What a stretch of ground is, for travel: open ground anyone can cross, water a boat or a bridge
 *  crosses, or a barrier (peaks, a gravity well) only a way that crosses anything gets over. */
export const WORLD_TERRAIN_KINDS = Object.freeze(["open", "water", "barrier"] as const);
/** What a way of travel crosses: open ground, water, or anything. */
export const WORLD_TRAVEL_CROSSES = Object.freeze(["open", "water", "any"] as const);

/** One class of the world's ground, in the setting's words, and how much of the ground it covers. */
const terrain = z
  .object({ id: kitId, label: word, kind: z.enum(WORLD_TERRAIN_KINDS), share: z.number().int().min(1).max(100) })
  .strict();
/** A way of travel. `crosses` and `speed` (multiples of walking pace) say where it goes and how fast;
 *  a kit written before worlds (W0) leaves them out, and the world reads open ground at walking pace. */
const travelWay = z
  .object({
    id: kitId,
    label: word,
    crosses: z.enum(WORLD_TRAVEL_CROSSES).optional(),
    speed: z.number().min(0.25).max(500).optional(),
  })
  .strict();

/** Item names of one rarity of loot. */
const lootWords = z.array(word).max(20);

export const worldKitSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: kitId,
    label: word,
    /** One paragraph for the picker. */
    summary: promptSafeText(400),
    /** Where its art and music live (worldgen W6f): the folders named for this family, beside the
     *  shared ones. Another family's are left out, so a cyberpunk game never plays fantasy music. Left
     *  out (a kit saved before families): its starter kit's family, or every folder. */
    family: kitId.optional(),
    scale: z.enum(WORLD_SCALES),
    /** The layers of place, outermost first; exactly one holds the settlements, whose places have
     *  a size and, with a market, sell things. */
    layers: z
      .array(z.object({ id: kitId, label: word, settlements: z.literal(true).optional() }).strict())
      .min(1)
      .max(8),
    /** The size ladder, smallest first: the market's place sizes where a ruleset declares none. */
    sizes: z.array(named).min(1).max(12),
    groupKinds: z.array(named).min(1).max(24),
    placeTags: z.array(named).max(48).default([]),
    travel: z.array(travelWay).min(1).max(12),
    /** The ground a generated world is laid out on (worldgen W1). A kit without one gets open
     *  ground named for its outermost layer. */
    terrain: z.array(terrain).min(1).max(16).optional(),
    /** The words a world's people are drawn in (worldgen W2): the jobs its places need (by the place
     *  tags they are common at; none means anywhere, and a tag the kit no longer has simply never
     *  matches), and how people look, in the setting's own terms
     *  (beastfolk, androids or spirits described as themselves). What a kit leaves out is filled from
     *  `WORLD_PEOPLE_DEFAULTS`. */
    people: z
      .object({
        roles: z
          .array(z.object({ label: word, tags: z.array(kitId).max(12).optional() }).strict())
          .min(1)
          .max(60),
        hair: z.array(word).min(1).max(30),
        marks: z.array(word).min(1).max(40),
        ages: z.array(word).min(1).max(12).optional(),
        builds: z.array(word).min(1).max(20).optional(),
        temperaments: z.array(word).min(1).max(30).optional(),
        values: z.array(word).min(1).max(30).optional(),
        speech: z.array(word).min(1).max(20).optional(),
      })
      .strict()
      .optional(),
    /** What a won fight drops in a game with no ruleset loot (worldgen W6a): item names by rarity, in
     *  the setting's own words. A kit without it rolls the starter kit its game's genre names, else loot
     *  that belongs to no setting (`worldLootWords`), never another setting's. */
    loot: z
      .object({
        common: lootWords,
        uncommon: lootWords,
        rare: lootWords,
        epic: lootWords,
        legendary: lootWords,
      })
      .strict()
      .refine((loot) => Object.values(loot).some((words) => words.length > 0), {
        message: "Names at least one thing a fight can drop",
      })
      .optional(),
    /** A setting's money, for a game with no ruleset (worldgen W6b): one family of coins, each worth so
     *  many of the smallest, which is worth 1. */
    money: z
      .object({
        label: word,
        units: z
          .array(z.object({ label: word, value: z.number().int().min(1).max(1_000_000) }).strict())
          .min(1)
          .max(6),
      })
      .strict()
      .optional(),
    /** Everyday things a game with no ruleset can buy (worldgen W6b): the price in the smallest coin, the
     *  smallest place that sells it by its rank on the size ladder (0 is the smallest), and whether it
     *  is a service, bought but never carried. */
    shop: z
      .array(
        z
          .object({
            name: word,
            price: z.number().int().min(0).max(1_000_000_000),
            from: z.number().int().min(0).max(11).default(0),
            service: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(60)
      .optional(),
    /** What an elemental attack can be in this setting (worldgen W6c), how rain treats it (a hot one is
     *  damped, a charged one fed) and which it beats in a tactical fight. An empty list: this setting has no elemental attacks.
     *  Left out: the classic six. */
    elements: z
      .array(
        z
          .object({
            label: listedWord,
            emoji: z.string().max(16).optional(),
            color: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/, "A color is #rrggbb")
              .optional(),
            weather: z.enum(["hot", "charged"]).optional(),
            beats: z.array(word).max(8).optional(),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    /** What happens when one of the kit's elements lands on a target still wearing another (its aura):
     *  the reaction's name, how much harder the hit lands, and a line for the telling. */
    reactions: z
      .array(
        z
          .object({
            on: word,
            with: word,
            label: word,
            times: z.number().min(0.1).max(5),
            note: promptSafeText(200).optional(),
          })
          .strict(),
      )
      .max(24)
      .optional(),
    /** The kinds of place a fight happens in, in the setting's words, each laid out on the board like one
     *  of the engine's battlefields (worldgen W6d). Left out: the engine's own sixteen. */
    scenes: z
      .array(z.object({ label: listedWord, like: z.enum(TACTICAL_ENVIRONMENTS) }).strict())
      .min(1)
      .max(24)
      .optional(),
    /** The setting's words for the six kinds of tile on a tactical board (rubble and cover in a city). */
    tiles: z
      .object(
        Object.fromEntries(TACTICAL_TERRAINS.map((terrain) => [terrain, listedWord.optional()])) as Record<
          (typeof TACTICAL_TERRAINS)[number],
          z.ZodOptional<typeof listedWord>
        >,
      )
      .strict()
      .optional(),
    calendar: z
      .object({
        year: word,
        day: word,
        months: z.array(word).max(24).optional(),
        era: word.optional(),
      })
      .strict(),
    change: z
      .object({
        kinds: z
          .object({
            everyday: changeKind,
            lives: changeKind,
            fortunes: changeKind,
            rivalry: changeKind,
            leadership: changeKind,
            crime: changeKind,
            conflict: changeKind,
            catastrophe: changeKind,
          })
          .strict(),
        pace: z.enum(WORLD_PACES),
      })
      .strict(),
    /** Who lives here and how they are named. Real-world cultures are written with care, never as
     *  caricature; syllables, where given, are what a compile draws names from. */
    cultures: z
      .array(
        z
          .object({
            id: kitId,
            label: word,
            naming: promptSafeText(600),
            syllables: z
              .object({
                given: z.array(promptSafeText(20)).min(4).max(200).optional(),
                family: z.array(promptSafeText(20)).min(4).max(200).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .superRefine((kit, ctx) => {
    const settlements = kit.layers.filter((layer) => layer.settlements).length;
    if (settlements !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["layers"],
        message: "Exactly one layer holds the settlements",
      });
    }
    if (kit.money) {
      if (!kit.money.units.some((unit) => unit.value === 1)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["money", "units"],
          message: "One coin is the smallest, worth 1",
        });
      }
      const coins = kit.money.units.map((unit) => unit.label.trim().toLowerCase());
      if (new Set(coins).size !== coins.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["money", "units"], message: "Two coins share a name" });
      }
    }
    if (kit.shop?.length && !kit.money) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shop"], message: "A shop needs the setting's money" });
    }
    // Every element a kit's beats and reactions name is one of its own.
    const elements = new Set((kit.elements ?? []).map((element) => element.label.trim().toLowerCase()));
    if (elements.size !== (kit.elements ?? []).length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["elements"], message: "Two elements share a name" });
    }
    (kit.elements ?? []).forEach((element, index) => {
      for (const beaten of element.beats ?? []) {
        if (!elements.has(beaten.trim().toLowerCase())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["elements", index, "beats"],
            message: `Beats "${beaten}", which is not one of the kit's elements`,
          });
        }
      }
    });
    if (kit.reactions?.length && !kit.elements) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reactions"], message: "Reactions need the kit's elements" });
    }
    (kit.reactions ?? []).forEach((reaction, index) => {
      for (const key of ["on", "with"] as const) {
        if (kit.elements && !elements.has(reaction[key].trim().toLowerCase())) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["reactions", index, key],
            message: `Names "${reaction[key]}", which is not one of the kit's elements`,
          });
        }
      }
    });
    const goods = (kit.shop ?? []).map((thing) => thing.name.trim().toLowerCase());
    if (new Set(goods).size !== goods.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shop"], message: "Two things in the shop share a name" });
    }
    // A scene is picked by its name, so no two may share one (worldgen W6d).
    const scenes = (kit.scenes ?? []).map((scene) => scene.label.trim().toLowerCase());
    if (new Set(scenes).size !== scenes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scenes"], message: "Two scenes share a name" });
    }
    for (const key of ["layers", "sizes", "groupKinds", "placeTags", "travel", "cultures", "terrain"] as const) {
      const seen = new Set<string>();
      (kit[key] ?? []).forEach((entry, index) => {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, index, "id"],
            message: `Repeats the id "${entry.id}"`,
          });
        }
        seen.add(entry.id);
      });
    }
  });

export type WorldKit = z.infer<typeof worldKitSchema>;
export type WorldKitInput = z.input<typeof worldKitSchema>;
/** A kit's loot words by rarity. */
export type WorldLoot = NonNullable<WorldKit["loot"]>;

/** A kit read from anywhere (a starter, the model, the player's edits), or the reasons it is not one. */
export function parseWorldKit(input: unknown): { ok: true; kit: WorldKit } | { ok: false; issues: string[] } {
  const parsed = worldKitSchema.safeParse(input);
  if (parsed.success) return { ok: true, kit: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "kit"}: ${issue.message}`),
  };
}

/** The setting kit a game stored when it was created (`gameWorldKit`), or null when it has none.
 *  A stored kit that no longer reads as one is left out rather than half-used. */
export function gameWorldKitFromMetadata(metadata: Record<string, unknown> | null | undefined): WorldKit | null {
  if (!metadata || metadata.gameWorldKit == null) return null;
  const parsed = parseWorldKit(metadata.gameWorldKit);
  return parsed.ok ? parsed.kit : null;
}
