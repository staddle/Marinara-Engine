// ──────────────────────────────────────────────
// Hook: Translation — multi-provider message translation
// ──────────────────────────────────────────────
import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "../lib/api-client";
import { useTranslationStore } from "../stores/translation.store";

const translationPersistenceQueues = new Map<string, Promise<void>>();

function enqueueTranslationPersistence(chatId: string, messageId: string, extra: Record<string, unknown>) {
  const queueKey = `${chatId}:${messageId}`;
  const previous = translationPersistenceQueues.get(queueKey) ?? Promise.resolve();
  const request = previous
    .catch(() => undefined)
    .then(() => api.patch(`/chats/${chatId}/messages/${messageId}/extra`, extra));
  const settled = request.then(
    () => undefined,
    () => undefined,
  );
  translationPersistenceQueues.set(queueKey, settled);
  void settled.finally(() => {
    if (translationPersistenceQueues.get(queueKey) === settled) {
      translationPersistenceQueues.delete(queueKey);
    }
  });
  return request;
}

// ── Hook ──
export function useTranslate() {
  const translations = useTranslationStore((s) => s.translations);
  const translationSources = useTranslationStore((s) => s.translationSources);
  const translating = useTranslationStore((s) => s.translating);
  const config = useTranslationStore((s) => s.config);

  const translate = useCallback(
    async (messageId: string, text: string, chatId?: string, currentSourceAliases: readonly string[] = []) => {
      const store = useTranslationStore.getState();
      const storedSource = store.translationSources[messageId];
      const translationMatchesCurrentText = storedSource === text || currentSourceAliases.includes(storedSource);

      // Toggle off if already translated. Keep the saved translation, but persist the hidden display state.
      if (store.translations[messageId] && translationMatchesCurrentText) {
        store.removeTranslation(messageId);
        if (chatId) {
          enqueueTranslationPersistence(chatId, messageId, { translationHidden: true }).catch(() => {});
        }
        return;
      }

      // Skip if already in-flight
      if (store.translating[messageId]) return;

      store.setTranslating(messageId, true);
      try {
        const result = await api.post<{ translatedText: string }>("/translate", {
          text,
          provider: store.config.provider,
          targetLanguage: store.config.outputTargetLanguage,
          connectionId: store.config.connectionId,
          systemPrompt: store.config.outputSystemPrompt,
          deeplApiKey: store.config.deeplApiKey,
          deeplxUrl: store.config.deeplxUrl,
        });
        store.setTranslation(messageId, result.translatedText, text);
        // Persist to message extra so translation survives refresh/chat switch
        if (chatId) {
          enqueueTranslationPersistence(chatId, messageId, {
            translation: result.translatedText,
            translationSource: text,
            translationHidden: false,
          }).catch(() => {});
        }
      } catch (err) {
        console.error("Translation failed:", err);
        toast.error(err instanceof Error ? err.message : "Translation failed");
      } finally {
        store.setTranslating(messageId, false);
      }
    },
    [],
  );

  return {
    translate,
    translations,
    translationSources,
    translating,
    config,
  };
}
