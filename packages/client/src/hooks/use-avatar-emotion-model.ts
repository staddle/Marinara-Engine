// ──────────────────────────────────────────────
// React Query: the avatar agents' local emotion model (lane: director)
// ──────────────────────────────────────────────
// The server downloads the model when a Roleplay chat with 2D or 3D Avatars on opens; the agents' pages follow it.
import { useQuery } from "@tanstack/react-query";
import { AVATAR_API_PREFIXES } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

/** GET /api/avatar-classify/model (services/avatars/emotion-classifier.ts avatarEmotionModelStatus). */
export interface AvatarEmotionModelStatus {
  /** Why this server keeps the word list (Lite, no ONNX runtime, too little memory), or null. */
  unsupported: "lite" | "no-runtime" | "low-memory" | null;
  state: "not-downloaded" | "downloading" | "loading" | "downloaded" | "failed";
  downloadedBytes: number;
  totalBytes: number;
}

export const avatarEmotionModelKeys = {
  status: ["avatar-emotion-model", "status"] as const,
};

/** Polls every 2 s while the model downloads or loads, and every 30 s otherwise (a chat may start the download). */
export function useAvatarEmotionModelStatus() {
  return useQuery({
    queryKey: avatarEmotionModelKeys.status,
    queryFn: () => api.get<AvatarEmotionModelStatus>(`${AVATAR_API_PREFIXES.classify}/model`),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "downloading" || state === "loading" ? 2_000 : 30_000;
    },
    staleTime: 2_000,
  });
}
