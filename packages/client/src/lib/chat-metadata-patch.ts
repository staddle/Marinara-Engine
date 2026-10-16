import type { Chat } from "@marinara-engine/shared";

export function patchChatMetadata(chat: Chat | null | undefined, patch: Record<string, unknown>): Chat | null {
  if (!chat) return null;
  const rawMetadata = chat.metadata as unknown;
  const metadata =
    typeof rawMetadata === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(rawMetadata);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {};
          } catch {
            return {};
          }
        })()
      : rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
        ? (rawMetadata as Record<string, unknown>)
        : {};
  return {
    ...chat,
    metadata: {
      ...metadata,
      ...patch,
    } as Chat["metadata"],
  };
}
