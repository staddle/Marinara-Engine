import { roomHostIdentity } from "../multiplayer/generation-policy.js";
// ──────────────────────────────────────────────
// Game: one turn of a ruleset game's live sheet state
// ──────────────────────────────────────────────
// The Game Master records what happens to a character sheet with `[sheet: ...]` commands. The
// Engine owns the arithmetic: every command is checked against the live state the turn started
// with, applied or refused, and written back into the saved reply with its outcome. The live state
// itself rides the game-state snapshot of the message and swipe, so a swipe or a regenerated turn
// starts from the state before it and can never spend twice.
import {
  applySheetCommandTags,
  RULESET_PARTY_KEY,
  rulesetPartyDefinition,
  createSheetCommandTagRegex,
  defaultRulesetSheetBuild,
  normalizeCharacterLookupName,
  parseSheetCommandTagBody,
  renderRulesetSheetBlock,
  rulesetCatalogIdsForBuild,
  readRulesetSheetEnvelope,
  rulesetSheetStamp,
  rulesetSheetEnvelopeSchema,
  storedRulesetSheetsSchema,
  type RulesetSheetBuild,
  type RulesetSheetEnvelope,
  type RulesetCatalogEntriesById,
  type RulesetDefinition,
  type RulesetLiveStates,
  type SheetCommandCard,
  type SheetCommandOutcome,
  rulesetCardItems,
  normalizeGameInventoryStacks,
  rulesetReadsItems,
  type GameInventoryStack,
  type RulesetItemBook,
  readRulesetPartySheet,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import {
  createChatsStorage,
  withChatMetadataPatchQueue,
  withMessageExtraPatchQueue,
} from "../storage/chats.storage.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { gamePartySheetRevision } from "./game-party-sheet.service.js";
import { rollDieSecurely } from "./dice-rng.js";
import { loadRulesetCatalogEntries } from "./ruleset-catalog.service.js";
import { loadRulesetRegistry, resolveGameRuleset, type ResolvedGameRuleset } from "./ruleset-registry.service.js";

export interface GameRulesetSheetContext {
  definition: RulesetDefinition;
  /** The package that supplied the ruleset, or null for an imported one. A catalog asset can only
   *  be read from a package, so the `use` command needs to know which. */
  packageId: string | null;
  cards: SheetCommandCard[];
  /** The player's card name, which a command that names nobody applies to. */
  playerName: string | null;
  advancementRefusal?: "save-failed";
  partyBuild?: RulesetSheetBuild | null;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Every party card with the build its live state is measured against. A card with NO sheet gets
 *  the ruleset's blank build, the same one setup would have copied for it. A card that HOLDS a sheet
 *  this version cannot read is left out: its maximums are unknown, so a command against a guessed
 *  build would store wrong values that the in-game sheet (which shows a notice for such a card)
 *  would not even display. Commands that name it are refused as naming nobody. */
export function sheetCommandCards(
  definition: RulesetDefinition,
  cards: ReadonlyArray<Record<string, unknown>>,
): SheetCommandCard[] {
  const blank = defaultRulesetSheetBuild(definition);
  return cards.flatMap((card) => {
    const name = typeof card.name === "string" ? card.name.trim() : "";
    if (!name) return [];
    if (card.rulesetSheet == null) return [{ name, build: blank }];
    const envelope = readRulesetSheetEnvelope(definition, card.rulesetSheet);
    if (!envelope) {
      logger.warn("[game/sheet] The ruleset sheet for %s is unreadable; its live state is left alone", name);
      return [];
    }
    return [{ name, build: envelope.build }];
  });
}

/** One prompt block per party card, showing the sheet as it stands at the start of this turn, with
 *  the items each one holds when the ruleset reads them (`itemStat`). */
export function renderGameRulesetSheetBlocks(
  definition: RulesetDefinition,
  cards: unknown,
  live: RulesetLiveStates | null | undefined,
  catalogs: RulesetCatalogEntriesById = {},
  items?: { book: Pick<RulesetItemBook, "itemOf">; stacks: readonly GameInventoryStack[]; playerName?: string | null },
  partySheet?: unknown,
): string[] {
  const party = Array.isArray(cards) ? (cards as Array<Record<string, unknown>>) : [];
  const built = sheetCommandCards(definition, party);
  const itemsOf =
    items && rulesetReadsItems(definition)
      ? rulesetCardItems(
          items.book,
          items.stacks,
          built.map((card) => card.name),
          items.playerName,
        )
      : undefined;
  // The stored sheets, whose builder picks say which items a character can reach (1.215).
  const envelopes = new Map(
    party
      .filter((card) => typeof card.name === "string")
      .map((card) => [normalizeCharacterLookupName((card.name as string).trim()), card.rulesetSheet]),
  );
  const blocks = built.map((card) =>
    renderRulesetSheetBlock(
      definition,
      { ...card, envelope: envelopes.get(normalizeCharacterLookupName(card.name)) },
      live?.[normalizeCharacterLookupName(card.name)],
      catalogs,
      itemsOf?.(card.name),
    ),
  );
  const partyDefinition = rulesetPartyDefinition(definition);
  const envelope = readRulesetPartySheet(
    definition,
    partySheet,
    built.map((card) => card.build),
  );
  if (partyDefinition && envelope)
    blocks.push(
      renderRulesetSheetBlock(
        partyDefinition,
        { name: definition.party!.label, build: envelope.build },
        live?.[RULESET_PARTY_KEY],
      ),
    );
  return blocks;
}

/** The ruleset, the party's builds and the player's name for one game. Null when the game has no
 *  ruleset, or pins one this install cannot honour: then no command is applied and none is lost,
 *  because the tags stay in the saved reply exactly as the Game Master wrote them. */
export async function loadGameRulesetSheetContext(
  db: DB,
  chatId: string,
  /** The resolution the turn's prompt was rendered with. Passing it keeps one turn on one ruleset:
   *  a package updated mid-turn must not have its commands checked against a definition the Game
   *  Master was never shown. Omitted, the pin is resolved here. */
  resolved?: ResolvedGameRuleset | null,
  regenerateMessageId?: string | null,
): Promise<GameRulesetSheetContext | null> {
  const chat = await createChatsStorage(db).getById(chatId);
  if (!chat) return null;
  const meta = parseMetadata(chat.metadata);
  if (meta.gameRuleset == null) return null;
  const pinned = resolved ?? resolveGameRuleset(meta, await loadRulesetRegistry());
  if (pinned.status !== "ok") {
    logger.warn("[game/sheet] Chat %s pins a ruleset that is not available; sheet commands were not applied", chatId);
    return null;
  }
  const turnMeta = await rulesetAdvancementTurnStart(db, chatId, meta, regenerateMessageId);
  const cards = Array.isArray(turnMeta.gameCharacterCards)
    ? (turnMeta.gameCharacterCards as Array<Record<string, unknown>>)
    : [];
  const setupConfig = meta.gameSetupConfig as { personaId?: string | null } | null | undefined;
  const personaId = chat.personaId || setupConfig?.personaId || null;
  const persona = roomHostIdentity() ?? (personaId ? await createCharactersStorage(db).getPersona(personaId) : null);
  const playerName = persona?.name?.trim() || null;
  const built = sheetCommandCards(pinned.definition, cards);
  // What each one carries, where the ruleset reads items (1.337): a rest's dice read Pell's Teapot.
  const stacks = normalizeGameInventoryStacks(meta.gameInventory);
  if (rulesetReadsItems(pinned.definition) && stacks.some((stack) => stack.item)) {
    // Imported here: the inventory service reads this module's cards.
    const { loadGameInventoryItemBook } = await import("./game-inventory.service.js");
    const book = await loadGameInventoryItemBook(db, { metadata: meta, resolved: pinned, playerName }, "game-master");
    if (book) {
      const itemsOf = rulesetCardItems(
        book,
        stacks,
        built.map((card) => card.name),
        playerName,
      );
      for (const card of built) card.items = itemsOf(card.name);
    }
  }
  return {
    definition: pinned.definition,
    packageId: pinned.packageId,
    cards: built,
    partyBuild:
      readRulesetPartySheet(
        pinned.definition,
        turnMeta.gamePartySheet,
        built.map((card) => card.build),
      )?.build ?? null,
    playerName,
  };
}

/** Whether this reply asks to use something out of a catalog. Every other command is answered from
 *  the sheet alone, so a turn without one never touches a catalog file. */
function replyUsesCatalogEntry(content: string): boolean {
  if (!content.includes("[")) return false;
  for (const match of content.matchAll(createSheetCommandTagRegex())) {
    if (parseSheetCommandTagBody(match[1] ?? "").op?.op === "use") return true;
  }
  return false;
}

/** The catalog entries this reply's `use` commands need: nothing at all unless the reply carries
 *  one, and then only the catalogs the party's own rows point at. A catalog that cannot be read is
 *  logged and left out, and the command is refused as naming something the Engine does not know,
 *  which is the honest answer: it cannot tell what the ability would have cost. */
export async function loadTurnRulesetCatalogs(
  context: GameRulesetSheetContext,
  content: string,
  /** `force` skips the "does this reply use one" gate, for a caller that has already decided it
   *  needs them: a check tag's `use=` is a different tag in a different place, and the gate below
   *  only knows about `[sheet:]` commands. */
  options?: { force?: boolean },
): Promise<RulesetCatalogEntriesById> {
  const declared = context.definition.catalogs;
  if (!declared?.length || !(options?.force || replyUsesCatalogEntry(content))) return {};
  const wanted = new Set(context.cards.flatMap((card) => rulesetCatalogIdsForBuild(context.definition, card.build)));
  const catalogs: RulesetCatalogEntriesById = {};
  for (const catalog of declared) {
    if (!wanted.has(catalog.id)) continue;
    try {
      const read = await loadRulesetCatalogEntries(context.packageId, context.definition, catalog);
      if (read.ok) catalogs[catalog.id] = read.entries;
      else {
        logger.warn(
          "[game/sheet] Catalog %s of %s could not be read for this turn: %s",
          catalog.id,
          context.definition.id,
          read.issues.slice(0, 3).join("; "),
        );
      }
    } catch (error) {
      // A turn is never lost to a catalog file.
      logger.warn(error, "[game/sheet] Could not read catalog %s of %s", catalog.id, context.definition.id);
    }
  }
  return catalogs;
}

export interface GameRulesetSheetTurn {
  builds: Record<string, RulesetSheetBuild>;
  baseBuilds: Record<string, RulesetSheetBuild>;
  content: string;
  live: RulesetLiveStates;
  outcomes: SheetCommandOutcome[];
  /** Each rest a character took this turn, by card name. */
  rests: Array<{ who: string; rest: string }>;
}

/** Apply a reply's sheet commands on top of the live state the turn started with. Never throws:
 *  a turn is never lost to its bookkeeping. */
export function applyGameRulesetSheetTurn(
  context: GameRulesetSheetContext,
  content: string,
  baseLive: RulesetLiveStates | null | undefined,
  /** What `loadTurnRulesetCatalogs` found, for the `use` command. Absent, every `use` is refused. */
  catalogs?: RulesetCatalogEntriesById,
): GameRulesetSheetTurn {
  try {
    const partyBuild =
      context.partyBuild === undefined ? readRulesetPartySheet(context.definition, null)?.build : context.partyBuild;
    const applied = applySheetCommandTags(content, {
      ...context,
      partyBuild,
      live: baseLive ?? {},
      catalogs,
      // A rest that brings on what a condition does with it (1.260) rolls real dice.
      roll: rollDieSecurely,
    });
    for (const outcome of applied.outcomes) {
      if (!outcome.ok) logger.warn("[game/sheet] Refused for %s: %s (%s)", outcome.who, outcome.reason, outcome.tag);
    }
    return {
      content: applied.content,
      live: applied.live,
      outcomes: applied.outcomes,
      rests: applied.rests,
      builds: applied.builds,
      baseBuilds: Object.fromEntries([
        ...context.cards.map((card) => [normalizeCharacterLookupName(card.name), card.build]).reverse(),
        ...(partyBuild ? [[RULESET_PARTY_KEY, partyBuild]] : []),
      ]),
    };
  } catch (error) {
    logger.error(error, "[game/sheet] Could not apply sheet commands; the reply is saved as written");
    return { content, live: baseLive ?? {}, outcomes: [], rests: [], builds: {}, baseBuilds: {} };
  }
}

// Adapt the shared sheet to the existing advancement history without storing a fake character.
const PARTY_CARD = Symbol("party sheet");
function advancementCardName(card: Record<string, unknown>): string {
  return Reflect.get(card, PARTY_CARD) ? RULESET_PARTY_KEY : normalizeCharacterLookupName(String(card.name));
}
function advancementCards(metadata: Record<string, unknown>): Record<string, unknown>[] {
  const cards = Array.isArray(metadata.gameCharacterCards) ? metadata.gameCharacterCards : [];
  return [
    ...cards,
    ...(Object.hasOwn(metadata, "gamePartySheet")
      ? [{ name: RULESET_PARTY_KEY, rulesetSheet: metadata.gamePartySheet, [PARTY_CARD]: true }]
      : []),
  ];
}
function advancementMetadata(cards: unknown, current: Record<string, unknown>): Record<string, unknown> {
  const entries = cards as Record<string, unknown>[];
  const party = entries.find((card) => Reflect.get(card, PARTY_CARD));
  const sheet = party ? (party.rulesetSheet ?? null) : undefined;
  // A shared sheet the story changed is a new revision, so a player's draft opened before it is
  // refused rather than saved over it (1.163).
  const changed = party && JSON.stringify(sheet) !== JSON.stringify(current.gamePartySheet ?? null);
  return {
    gameCharacterCards: entries.filter((card) => !Reflect.get(card, PARTY_CARD)),
    ...(party ? { gamePartySheet: sheet } : {}),
    ...(changed ? { gamePartySheetRevision: gamePartySheetRevision(current) + 1 } : {}),
  };
}

interface AdvancementChange {
  name: string;
  before: RulesetSheetEnvelope | null;
  after: RulesetSheetEnvelope | null;
}

/** Imported messages can carry receipts too; only bounded, readable envelopes are replayed. */
function advancementChanges(raw: unknown): AdvancementChange[] {
  if (!Array.isArray(raw) || raw.length > 1600) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry.name !== "string" || entry.name.length > 100) return [];
    const before = entry.before === null ? null : rulesetSheetEnvelopeSchema.safeParse(entry.before);
    const after = entry.after === null ? null : rulesetSheetEnvelopeSchema.safeParse(entry.after);
    if ((before && !before.success) || (after && !after.success)) return [];
    if (
      !storedRulesetSheetsSchema.safeParse({
        ...(after?.success ? { receipt: after.data } : {}),
        ...(before?.success ? { before: before.data } : {}),
      }).success
    )
      return [];
    return [
      { name: entry.name, before: before?.success ? before.data : null, after: after?.success ? after.data : null },
    ];
  });
}

/** Undo only values still matching the receipt, preserving subsequent edits to other values. */
export function replayRulesetAdvancementCards(cards: unknown, raw: unknown, undo: boolean): unknown {
  const changes = advancementChanges(raw);
  if (!Array.isArray(cards) || changes.length === 0) return cards;
  const next = cards.map((card) => ({ ...card }));
  for (const change of undo ? changes.reverse() : changes) {
    const card = next.find((entry) => typeof entry.name === "string" && advancementCardName(entry) === change.name);
    if (!card) continue;
    const expected = undo ? change.after : change.before;
    const sheet = undo ? change.before : change.after;
    if (JSON.stringify(card.rulesetSheet ?? null) === JSON.stringify(expected)) {
      if (sheet === null) delete card.rulesetSheet;
      else card.rulesetSheet = structuredClone(sheet);
      continue;
    }
    const current = rulesetSheetEnvelopeSchema.safeParse(card.rulesetSheet);
    if (!current.success) continue;
    for (const group of ["fields", "abilities", "skills", "saves"] as const) {
      const from = expected?.build[group] ?? {};
      const to = sheet?.build[group] ?? {};
      const values = current.data.build[group] as Record<string, string | number | boolean>;
      for (const id of new Set([...Object.keys(from), ...Object.keys(to)])) {
        if (from[id] === to[id] || values[id] !== from[id]) continue;
        if (to[id] === undefined) delete values[id];
        else values[id] = to[id];
      }
    }
    card.rulesetSheet = current.data;
  }
  return next;
}

type AdvancementMessage = { id: string; extra: unknown };

/** Each reply carries its ending sheets, like the live-state snapshot. The initial envelopes are
 *  undo history in the same chat metadata; the cards remain the only editable build store. */
function advancementProjection(
  baseline: unknown,
  messages: AdvancementMessage[],
): Map<string, RulesetSheetEnvelope | null> {
  const state = new Map(advancementChanges(baseline).map((entry) => [entry.name, entry.after]));
  for (const message of messages) {
    for (const entry of advancementChanges(parseMetadata(message.extra).rulesetAdvancement))
      state.set(entry.name, entry.after);
  }
  return state;
}

function projectAdvancementCards(
  metadata: Record<string, unknown>,
  from: AdvancementMessage[],
  to: AdvancementMessage[],
): unknown {
  const before = advancementProjection(metadata.gameRulesetAdvancementBase, from);
  const after = advancementProjection(metadata.gameRulesetAdvancementBase, to);
  const changes = [...before].map(([name, expected]) => ({ name, after: expected, before: after.get(name) ?? null }));
  return replayRulesetAdvancementCards(advancementCards(metadata), changes, true);
}

/** A regenerated prompt and its commands see the snapshot before that message. No write. */
export async function rulesetAdvancementTurnStart(
  db: DB,
  chatId: string,
  metadata: Record<string, unknown>,
  messageId?: string | null,
): Promise<Record<string, unknown>> {
  if (!messageId || !metadata.gameRulesetAdvancementBase) return metadata;
  const messages = await createChatsStorage(db).listMessages(chatId);
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return metadata;
  return {
    ...metadata,
    ...advancementMetadata(projectAdvancementCards(metadata, messages, messages.slice(0, index)), metadata),
  };
}

/** Called with the metadata and message queues held. Selecting or removing an older telling must
 *  leave a later snapshot in force, just as it does for live sheet state. */
export async function reconcileGameRulesetAdvancement(
  db: DB,
  owner: { id: string; chatId: string },
  undo: boolean,
  excluded: ReadonlySet<string> = new Set(),
): Promise<void> {
  const chats = createChatsStorage(db);
  const all = (await chats.listMessages(owner.chatId)).filter((message) => !excluded.has(message.id));
  const without = all.filter((message) => message.id !== owner.id);
  await chats.patchMetadata(
    owner.chatId,
    (metadata) => ({
      ...advancementMetadata(projectAdvancementCards(metadata, undo ? all : without, undo ? without : all), metadata),
    }),
    { metadataQueueHeld: true },
  );
}

/** Saves builds through the same metadata patch as the sheet editor, with the swipe's snapshot. */
export async function saveGameRulesetAdvancement(
  db: DB,
  chatId: string,
  messageId: string,
  swipeIndex: number,
  definition: RulesetDefinition,
  turn: Pick<GameRulesetSheetTurn, "builds" | "baseBuilds">,
): Promise<void> {
  const { builds, baseBuilds } = turn;
  if (!definition.sheet.advancement && !definition.party) return;
  const chats = createChatsStorage(db);
  await withChatMetadataPatchQueue(chatId, () =>
    withMessageExtraPatchQueue(messageId, () =>
      db.transaction(async () => {
        const message = await chats.getMessage(messageId);
        if (!message || message.chatId !== chatId || message.activeSwipeIndex !== swipeIndex)
          throw new Error("Advancement reply is no longer active");
        const messages = await chats.listMessages(chatId);
        const index = messages.findIndex((entry) => entry.id === messageId);
        const existing = advancementChanges(parseMetadata(message.extra).rulesetAdvancement);
        let snapshots: AdvancementChange[] = [];
        await chats.patchMetadata(
          chatId,
          (metadata) => {
            if (definition.party) metadata = { ...metadata, gamePartySheet: metadata.gamePartySheet ?? null };
            const cards = advancementCards(metadata);
            const hasSnapshots = messages.some(
              (entry) => advancementChanges(parseMetadata(entry.extra).rulesetAdvancement).length > 0,
            );
            const baseline = hasSnapshots ? advancementChanges(metadata.gameRulesetAdvancementBase) : [];
            const known = new Set(baseline.map((entry) => entry.name));
            for (const card of cards) {
              if (typeof card.name !== "string") continue;
              const name = advancementCardName(card);
              if (known.has(name)) continue;
              const read = card.rulesetSheet == null ? null : rulesetSheetEnvelopeSchema.safeParse(card.rulesetSheet);
              if (read && !read.success) continue;
              const before = read?.success ? read.data : null;
              baseline.push({ name, before, after: before });
              known.add(name);
            }
            const recorded = { ...metadata, gameRulesetAdvancementBase: baseline };
            // A continuation builds on its own snapshot; a new swipe starts before its message.
            const startCards = projectAdvancementCards(
              recorded,
              messages,
              messages.slice(0, index + (existing.length ? 1 : 0)),
            ) as Record<string, unknown>[];
            const seen = new Set<string>();
            snapshots = startCards.flatMap((card) => {
              if (typeof card.name !== "string") return [];
              const key = advancementCardName(card);
              if (seen.has(key)) return [];
              const parsed = card.rulesetSheet == null ? null : rulesetSheetEnvelopeSchema.safeParse(card.rulesetSheet);
              if (parsed && !parsed.success) {
                if (builds[key]) throw new Error("Advancement sheet is unreadable");
                return [];
              }
              seen.add(key);
              const previous = parsed?.success ? parsed.data : null;
              let after = previous;
              const build = builds[key];
              const sheetDefinition = key === RULESET_PARTY_KEY ? rulesetPartyDefinition(definition) : definition;
              if (build) {
                if (!sheetDefinition) throw new Error("Party sheet no longer exists");
                const migrated = previous ? readRulesetSheetEnvelope(sheetDefinition, previous) : null;
                if (previous && !migrated) throw new Error("Advancement sheet is unreadable");
                const current = structuredClone(migrated?.build ?? defaultRulesetSheetBuild(sheetDefinition));
                const base = baseBuilds[key];
                if (!base) throw new Error("Advancement has no starting build");
                for (const group of ["fields", "abilities", "skills", "saves"] as const) {
                  for (const [id, value] of Object.entries(build[group])) {
                    if (value === base[group][id]) continue;
                    if (current[group][id] !== base[group][id])
                      throw new Error(`Advancement conflicts with an edited ${group}.${id}`);
                    (current[group] as Record<string, string | number | boolean>)[id] = value;
                  }
                }
                after = rulesetSheetEnvelopeSchema.parse({
                  ...migrated,
                  v: rulesetSheetStamp(definition, previous),
                  build: current,
                });
                storedRulesetSheetsSchema.parse({ [definition.id]: after });
              }
              return [{ name: key, before: previous, after }];
            });
            if (Object.keys(builds).some((key) => !seen.has(key))) throw new Error("Advancement card no longer exists");
            const beforeMessages = messages.map((entry) =>
              entry.id === messageId
                ? {
                    ...entry,
                    extra: {
                      rulesetAdvancement: snapshots.map((snapshot) => ({ ...snapshot, after: snapshot.before })),
                    },
                  }
                : entry,
            );
            const nextMessages = messages.map((entry) =>
              entry.id === messageId ? { ...entry, extra: { rulesetAdvancement: snapshots } } : entry,
            );
            return {
              gameRulesetAdvancementBase: baseline,
              ...advancementMetadata(projectAdvancementCards(recorded, beforeMessages, nextMessages), metadata),
            };
          },
          { metadataQueueHeld: true },
        );
        await chats.updateMessageExtraForSwipe(messageId, swipeIndex, { rulesetAdvancement: snapshots }, undefined, {
          messageQueueHeld: true,
        });
      }),
    ),
  );
}
