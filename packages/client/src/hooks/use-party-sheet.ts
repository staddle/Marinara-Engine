// Kept apart from use-game so the sheet components load without the game stores.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Chat } from "@marinara-engine/shared";
import { ApiError, api } from "../lib/api-client";
import { patchChatMetadata } from "../lib/chat-metadata-patch";
import { useChatStore } from "../stores/chat.store";
import { chatKeys } from "./use-chats";

export interface SavedPartySheet {
  revision: number;
  sheet: unknown;
}

/** A save refused because someone else's landed since the draft was opened; theirs comes with it. */
export function stalePartySheet(error: unknown): SavedPartySheet | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.payload as { reason?: string; revision?: number; sheet?: unknown } | null;
  return body?.reason === "stale" && typeof body.revision === "number"
    ? { revision: body.revision, sheet: body.sheet ?? null }
    : null;
}

/** The party's shared sheet (1.163), saved on the revision it was opened at. A saved sheet, or the one a
 *  stale save was refused for, goes into the chat's metadata at once. */
export function useSavePartySheet() {
  const qc = useQueryClient();
  const apply = (chatId: string, saved: SavedPartySheet) => {
    const patch = { gamePartySheet: saved.sheet, gamePartySheetRevision: saved.revision };
    const patchedChat = patchChatMetadata(qc.getQueryData<Chat>(chatKeys.detail(chatId)), patch);
    if (patchedChat) qc.setQueryData(chatKeys.detail(chatId), patchedChat);
    const chatStore = useChatStore.getState();
    if (chatStore.activeChatId === chatId) {
      const patchedActiveChat = patchChatMetadata(chatStore.activeChat, patch);
      if (patchedActiveChat) chatStore.setActiveChat(patchedActiveChat);
    }
  };
  return useMutation({
    mutationFn: (data: { chatId: string; sheet: unknown; revision: number }) =>
      api.post<SavedPartySheet>("/game-rulesets/party-sheet", data),
    onSuccess: (saved, variables) => apply(variables.chatId, saved),
    onError: (error, variables) => {
      const theirs = stalePartySheet(error);
      if (theirs) apply(variables.chatId, theirs);
    },
  });
}
