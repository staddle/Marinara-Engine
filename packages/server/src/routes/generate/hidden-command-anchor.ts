import type { createChatsStorage } from "../../services/storage/chats.storage.js";

export interface HiddenCommandAnchorInput {
  chatId: string;
  regenerateMessageId?: string | null;
  targetCharId: string | null;
  /** A Conversation scene invitation keeps the anchor visible, so the player can accept it. */
  sceneRequest: unknown;
  conversationCommandContent: string | null;
  encryptedReasoningItems: unknown[] | undefined;
}

/**
 * Saves the empty assistant message a commands-only turn needs: a new blank swipe on regenerate,
 * otherwise a new blank message, marked command-only and hidden from the user (unless it carries
 * a scene invitation) and from the model (unless it carries command content).
 */
export async function saveHiddenCommandAnchor(
  chats: Pick<
    ReturnType<typeof createChatsStorage>,
    "addSwipe" | "getMessage" | "createMessage" | "updateMessageExtra"
  >,
  anchor: HiddenCommandAnchorInput,
) {
  if (anchor.regenerateMessageId) await chats.addSwipe(anchor.regenerateMessageId, "");
  const savedMsg = anchor.regenerateMessageId
    ? await chats.getMessage(anchor.regenerateMessageId)
    : await chats.createMessage({
        chatId: anchor.chatId,
        role: "assistant",
        characterId: anchor.targetCharId,
        content: "",
      });
  return savedMsg?.id
    ? await chats.updateMessageExtra(savedMsg.id, {
        hiddenFromUser: !anchor.sceneRequest,
        hiddenFromAI: !anchor.conversationCommandContent,
        commandOnly: true,
        sceneRequest: anchor.sceneRequest,
        conversationCommandContent: anchor.conversationCommandContent ?? null,
        isGenerated: true,
        encryptedReasoning: anchor.encryptedReasoningItems?.length ? anchor.encryptedReasoningItems : null,
      })
    : savedMsg;
}
