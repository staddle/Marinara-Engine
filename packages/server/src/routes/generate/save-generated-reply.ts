import {
  appendContinuationMessageContent,
  splitAtSceneBreaks,
  type GenerateRequestInput,
  type RoleplayCommandActivity,
} from "@marinara-engine/shared";
import { currentRoomGeneration } from "../../services/multiplayer/generation-policy.js";
import { commitSpatialOwnerTurn, SpatialOwnerTurnError } from "../../services/spatial-context/owner-turn.js";
import type { createChatsStorage } from "../../services/storage/chats.storage.js";
import { sendSseEvent, type GenerationOutput } from "./sse.js";
import { resolveAlreadyAppliedSpatialTurn } from "./spatial-transition-request.js";

/** A new reply split at scene breaks: each part with where it starts in the whole reply. */
export type ReplyPart = { content: string; start: number; message: any; activity: RoleplayCommandActivity[] };

export interface SaveGeneratedReplyContext {
  chats: Pick<
    ReturnType<typeof createChatsStorage>,
    "addSwipe" | "getMessage" | "updateMessageContent" | "createMessage" | "removeMessage"
  >;
  reply: GenerationOutput;
  input: Pick<
    GenerateRequestInput,
    | "chatId"
    | "regenerateMessageId"
    | "continueMessageId"
    | "continueAddsNewline"
    | "impersonate"
    | "pendingSpatialTransition"
  >;
  chatMode: string;
  targetCharId: string | null;
  /** The continued message as read before generation, used when it can no longer be read. */
  continueTargetMessage: any;
  advancedMemoryEnabled: boolean;
}

export interface SavedGeneratedReply {
  savedMsg: any;
  savedSwipeIndex: number | null;
  /** Set only when a new reply was saved as more than one part. */
  replyParts: ReplyPart[] | null;
  /** The reply as saved: an already applied owner turn's saved content replaces the generated one. */
  fullResponse: string;
  /** A continued message's whole new content; null when no message was continued. */
  continuedSource: string | null;
  /** An owner turn the spatial transition had already saved was recovered instead of saved again. */
  recoveredSpatialTurn: boolean;
}

/**
 * Saves a generated reply: as a new swipe (regenerate), appended to the continued message, as the
 * owner's turn of a pending spatial transition (impersonate), or as a new message, split into one
 * message per scene break with Advanced Memory. A split reply is saved whole or not at all.
 */
export async function saveGeneratedReply(
  ctx: SaveGeneratedReplyContext,
  fullResponse: string,
): Promise<SavedGeneratedReply> {
  const { chats, reply, input, chatMode, targetCharId, continueTargetMessage, advancedMemoryEnabled } = ctx;
  let savedMsg: any;
  let savedSwipeIndex: number | null = null;
  let replyParts = null as ReplyPart[] | null;
  let continuedSource: string | null = null;
  let recoveredSpatialTurn = false;
  if (input.regenerateMessageId) {
    const createdSwipe = await chats.addSwipe(input.regenerateMessageId, fullResponse);
    savedSwipeIndex = createdSwipe.index;
    savedMsg = await chats.getMessage(input.regenerateMessageId);
  } else if (input.continueMessageId) {
    const targetMessage = (await chats.getMessage(input.continueMessageId)) ?? continueTargetMessage;
    continuedSource = appendContinuationMessageContent(targetMessage?.content, fullResponse, input.continueAddsNewline);
    savedMsg = await chats.updateMessageContent(input.continueMessageId, continuedSource);
    savedSwipeIndex =
      typeof savedMsg?.activeSwipeIndex === "number" && Number.isInteger(savedMsg.activeSwipeIndex)
        ? savedMsg.activeSwipeIndex
        : 0;
  } else if (input.impersonate && input.pendingSpatialTransition) {
    try {
      const committed = await commitSpatialOwnerTurn({
        chatId: input.chatId,
        content: fullResponse,
        transition: input.pendingSpatialTransition,
      });
      savedMsg = committed.message;
      savedSwipeIndex = 0;
      sendSseEvent(reply, {
        type: "spatial_transition_committed",
        data: {
          chatId: input.chatId,
          commandId: input.pendingSpatialTransition.commandId,
          currentLocationId: committed.snapshot.currentLocationId,
          definitionRevision: committed.snapshot.definitionRevision,
          ...(committed.travel ? { travel: committed.travel } : {}),
        },
      });
    } catch (error) {
      if (error instanceof SpatialOwnerTurnError) {
        if (error.code === "spatial_transition_already_applied") {
          const recovered = resolveAlreadyAppliedSpatialTurn(error);
          if (!recovered) throw error;
          const recoveredMessage = await chats.getMessage(recovered.messageId);
          if (!recoveredMessage) throw error;
          recoveredSpatialTurn = true;
          savedMsg = recoveredMessage;
          savedSwipeIndex = recovered.swipeIndex;
          fullResponse = recoveredMessage.content;
          sendSseEvent(reply, { type: "content_replace", data: fullResponse });
          sendSseEvent(reply, {
            type: "spatial_transition_committed",
            data: {
              chatId: input.chatId,
              commandId: input.pendingSpatialTransition.commandId,
              currentLocationId: recovered.currentLocationId,
              definitionRevision: recovered.definitionRevision,
              ...(recovered.travel ? { travel: recovered.travel } : {}),
            },
          });
        } else {
          sendSseEvent(reply, {
            type: "spatial_transition_rejected",
            data: {
              chatId: input.chatId,
              commandId: input.pendingSpatialTransition.commandId,
              code: error.code,
              message: error.message,
              ...(error.details ?? {}),
            },
          });
          throw error;
        }
      } else {
        throw error;
      }
    }
  } else {
    const roomAuthority = currentRoomGeneration();
    const roomAudience = chatMode === "game" ? roomAuthority : undefined;
    const roomActor = roomAuthority?.characters.find((character) =>
      chatMode === "game" ? character.role === "gm" : character.id === targetCharId,
    );
    // With Advanced Memory, each scene or POV break starts a message of its own, so each part has its own
    // audience (#7481). The last part is the reply the rest of this turn works with.
    const parts = advancedMemoryEnabled && !input.impersonate ? splitAtSceneBreaks(fullResponse) : [fullResponse];
    const saved: ReplyPart[] = [];
    try {
      for (const content of parts) {
        const previous = saved.at(-1);
        const start = fullResponse.indexOf(content, previous ? previous.start + previous.content.length : 0);
        savedMsg = await chats.createMessage({
          chatId: input.chatId,
          role: input.impersonate ? "user" : "assistant",
          characterId: input.impersonate ? null : targetCharId,
          content,
          ...(roomAuthority
            ? {
                extra: {
                  multiplayerActor: roomActor
                    ? { id: roomActor.id, name: roomActor.name, role: roomActor.role }
                    : { id: null, name: "GM", role: "gm" },
                  ...(roomAudience
                    ? {
                        multiplayerGameAudience: {
                          roomId: roomAudience.roomId,
                          participants: roomAudience.participants.map((participant) => ({
                            id: participant.id,
                            name: participant.persona.name,
                          })),
                        },
                      }
                    : {}),
                },
              }
            : {}),
        });
        saved.push({ content, start, message: savedMsg, activity: [] });
      }
    } catch (error) {
      // A reply is saved whole or not at all: drop the parts already saved, so no half-reply is left.
      for (const part of saved) await chats.removeMessage(part.message.id).catch(() => undefined);
      throw error;
    }
    if (saved.length > 1) replyParts = saved;
    savedSwipeIndex = 0;
  }
  return { savedMsg, savedSwipeIndex, replyParts, fullResponse, continuedSource, recoveredSpatialTurn };
}
