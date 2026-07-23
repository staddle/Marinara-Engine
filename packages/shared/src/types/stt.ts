// ──────────────────────────────────────────────
// STT Types (Speech to Text)
// ──────────────────────────────────────────────
import { z } from "zod";

/**
 * Config for a self-hosted, OpenAI-Whisper-API-compatible transcription server
 * (POST {baseUrl}/audio/transcriptions, multipart `file` + `model`).
 */
export const sttConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default(""),
  /** Plain text on write; masked "••••••" on read when a key is saved */
  apiKey: z.string().default(""),
  model: z.string().default("whisper-1"),
  /** Optional ISO-639-1 language hint (e.g. "en"). Empty lets the server auto-detect. */
  language: z.string().max(8).default(""),
});
export type STTConfig = z.infer<typeof sttConfigSchema>;

export const STT_SETTINGS_KEY = "stt";
export const STT_API_KEY_MASK = "••••••";

/** Returned by POST /api/stt/transcribe */
export interface STTTranscribeResponse {
  text: string;
}
