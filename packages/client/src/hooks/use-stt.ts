// ──────────────────────────────────────────────
// Hook: STT Config & Transcription
// ──────────────────────────────────────────────
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import type { STTConfig, STTTranscribeResponse } from "@marinara-engine/shared";
import { STT_API_KEY_MASK } from "@marinara-engine/shared";

const KEYS = {
  config: ["stt", "config"] as const,
};

export function useSTTConfig() {
  return useQuery({
    queryKey: KEYS.config,
    queryFn: () => api.get<STTConfig>("/stt/config"),
    staleTime: 60_000,
  });
}

export function useUpdateSTTConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: STTConfig) => api.put<void>("/stt/config", config),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.config });
    },
  });
}

export function useTranscribeAudio() {
  return useMutation({
    mutationFn: (blob: Blob) => {
      const formData = new FormData();
      formData.append("file", blob, "recording.webm");
      return api.upload<STTTranscribeResponse>("/stt/transcribe", formData);
    },
  });
}

export { STT_API_KEY_MASK };
