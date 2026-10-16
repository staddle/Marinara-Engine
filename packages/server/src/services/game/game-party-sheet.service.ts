// The party's shared sheet (Capability API 1.163): one crew, ship or village per game, set up once
// through its guided builder and saved for everyone. Each save names the revision it was made on, so
// two players editing at once never overwrite each other silently: the second save is refused and
// both drafts survive, the saved one here and the refused one in that player's editor.
import {
  defaultRulesetSheetBuild,
  readRulesetSheetEnvelope,
  rulesetPartyDefinition,
  rulesetPartyWithMembers,
  type RulesetSheetBuild,
  type RulesetSheetEnvelope,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { readMetadata } from "./game-inventory.service.js";
import { loadRulesetRegistry, resolveGameRuleset } from "./ruleset-registry.service.js";

/** A shared sheet past this many serialized bytes is refused, as a character's stored sheet is. */
const PARTY_SHEET_MAX_BYTES = 64 * 1024;

export type GamePartySheetRefusal = "no-party" | "invalid" | "stale";

export type GamePartySheetOutcome =
  | { ok: true; revision: number; sheet: RulesetSheetEnvelope }
  | {
      ok: false;
      status: 400 | 404 | 409;
      error: string;
      reason: GamePartySheetRefusal;
      /** On a stale save: the revision and sheet that are saved now. */
      revision?: number;
      sheet?: unknown;
    };

/** The revision the stored shared sheet is at: 0 before anybody saved one. */
export function gamePartySheetRevision(metadata: Record<string, unknown>): number {
  const value = metadata.gamePartySheetRevision;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export async function saveGamePartySheet(
  db: DB,
  input: { chatId: string; sheet: unknown; revision: number },
): Promise<GamePartySheetOutcome> {
  const chats = createChatsStorage(db);
  const chat = await chats.getById(input.chatId);
  if (!chat) return { ok: false, status: 404, error: "Chat not found", reason: "no-party" };
  const metadata = readMetadata(chat.metadata);
  if (metadata.gameRuleset == null)
    return { ok: false, status: 409, error: "This game plays by no ruleset", reason: "no-party" };
  const resolved = resolveGameRuleset(metadata, await loadRulesetRegistry(db));
  if (resolved.status !== "ok")
    return { ok: false, status: 409, error: "This game's ruleset is unavailable", reason: "no-party" };
  const { definition } = resolved;
  const party = rulesetPartyDefinition(definition);
  if (!party) return { ok: false, status: 409, error: "This game's ruleset has no party sheet", reason: "no-party" };
  const envelope = readRulesetSheetEnvelope(party, input.sheet);
  if (!envelope) return { ok: false, status: 400, error: "That is not a party sheet", reason: "invalid" };

  let outcome: GamePartySheetOutcome | null = null;
  await chats.patchMetadata(input.chatId, (current) => {
    const revision = gamePartySheetRevision(current);
    if (revision !== input.revision) {
      outcome = {
        ok: false,
        status: 409,
        error: "Someone saved the party sheet since this draft was opened",
        reason: "stale",
        revision,
        sheet: current.gamePartySheet ?? null,
      };
      return {};
    }
    // What the party's own characters add up to is read here, from the cards this save sits beside.
    const members = (Array.isArray(current.gameCharacterCards) ? current.gameCharacterCards : []).flatMap(
      (card: unknown): RulesetSheetBuild[] => {
        if (!card || typeof card !== "object") return [];
        const name = (card as { name?: unknown }).name;
        if (typeof name !== "string" || !name.trim()) return [];
        // Read as a turn reads the party: a card with no sheet yet counts, with a blank one.
        const stored = (card as { rulesetSheet?: unknown }).rulesetSheet;
        if (stored == null) return [defaultRulesetSheetBuild(definition)];
        const build = readRulesetSheetEnvelope(definition, stored)?.build;
        return build ? [build] : [];
      },
    );
    const sheet: RulesetSheetEnvelope = {
      ...envelope,
      build: rulesetPartyWithMembers(definition, envelope.build, members),
    };
    if (new TextEncoder().encode(JSON.stringify(sheet)).length > PARTY_SHEET_MAX_BYTES) {
      outcome = { ok: false, status: 400, error: "The party sheet is too large", reason: "invalid" };
      return {};
    }
    outcome = { ok: true, revision: revision + 1, sheet };
    return { gamePartySheet: sheet, gamePartySheetRevision: revision + 1 };
  });
  return outcome ?? { ok: false, status: 404, error: "Chat not found", reason: "no-party" };
}
