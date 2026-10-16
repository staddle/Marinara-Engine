// What a refused buy or sale in the Game Master's reply is told to the player as. The Game Master writes
// its narration before the Engine answers its tags, so the prose can say a purchase was made that the
// Engine refused (not sold here, too dear); the player is told, and the Game Master reads the refusal
// back next turn.
import type { ResolvedInventoryTag } from "@marinara-engine/shared";

/** The reasons said in words of their own; any other is the general one. */
const SAID = new Set([
  "no-market",
  "no-place",
  "not-for-sale",
  "not-here",
  "no-seller",
  "not-to-you",
  "sold-out",
  "cannot-afford",
  "too-heavy",
  "not-bought",
  "purse-spent",
  "cursed",
  "none-held",
]);

/** The message and reason keys for a refused buy or sale, or null for anything else. A sale an honest
 *  buyer saw through is told by the fake's own notice. */
export function gameInventoryRefusalKeys(
  update: Pick<ResolvedInventoryTag, "action" | "ok" | "reason" | "revealed">,
): { message: string; reason: string } | null {
  if (update.ok || (update.action !== "buy" && update.action !== "sell")) return null;
  if (update.action === "sell" && update.revealed) return null;
  const reason = update.reason && SAID.has(update.reason) ? update.reason : "other";
  return {
    message: `ui.game.gamesurfacecomponent.${update.action === "buy" ? "inventoryBuyRefused" : "inventorySellRefused"}`,
    // Locale keys are camel case: "not-here" is told by `notHere`.
    reason: `ui.game.gamesurfacecomponent.inventoryRefusedBecause.${reason.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}`,
  };
}
