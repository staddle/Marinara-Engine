// ──────────────────────────────────────────────
// Routes: Speech to Text server settings
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { speechToTextConfigSchema } from "@marinara-engine/shared";
import {
  SPEECH_TO_TEXT_MAX_AUDIO_BYTES,
  createSilentTestClip,
  loadSpeechToTextConfig,
  readMaskedSpeechToTextConfig,
  saveSpeechToTextConfig,
  transcribeWithSpeechToTextServer,
} from "../services/speech-to-text.service.js";

const TEST_TIMEOUT_MS = 30_000;

export async function speechToTextRoutes(app: FastifyInstance) {
  /** GET /api/speech-to-text/config: the saved settings, with the API key masked. */
  app.get("/config", async () => readMaskedSpeechToTextConfig(app.db));

  /** PUT /api/speech-to-text/config: sending the masked key back keeps the saved one. */
  app.put("/config", async (req, reply) => {
    await saveSpeechToTextConfig(app.db, speechToTextConfigSchema.parse(req.body));
    return reply.status(204).send();
  });

  /** POST /api/speech-to-text/test: send a short silent clip to the saved server and report whether it answered. */
  app.post("/test", async (_req, reply) => {
    const config = await loadSpeechToTextConfig(app.db);
    if (!config.baseUrl) return reply.status(400).send({ error: "Enter a server URL first." });
    try {
      await transcribeWithSpeechToTextServer(config, createSilentTestClip(), {
        filename: "marinara-test.wav",
        mimeType: "audio/wav",
        timeoutMs: TEST_TIMEOUT_MS,
      });
      return { ok: true };
    } catch (error) {
      return reply.status(502).send({ error: error instanceof Error ? error.message : "The test failed." });
    }
  });

  /**
   * POST /api/speech-to-text/transcribe: multipart `file` with a recorded clip (push-to-talk, voice calls).
   * Answers `{ text }`; refuses while the server is off, so the browser can hide its voice buttons instead.
   */
  app.post("/transcribe", async (req, reply) => {
    const config = await loadSpeechToTextConfig(app.db);
    if (!config.enabled || !config.baseUrl) {
      return reply.status(400).send({ error: "Speech to Text is off. Turn it on in Connections." });
    }
    const data = await req.file({ limits: { fileSize: SPEECH_TO_TEXT_MAX_AUDIO_BYTES, files: 1 } });
    if (!data) return reply.status(400).send({ error: "No audio was uploaded." });
    const audio = await data.toBuffer();
    if (data.file.truncated) return reply.status(413).send({ error: "The recording is too large." });
    try {
      const text = await transcribeWithSpeechToTextServer(config, audio, {
        filename: data.filename,
        // Browsers label recordings like "audio/webm;codecs=opus"; the server only needs the base type.
        mimeType: data.mimetype.split(";")[0]?.trim(),
      });
      return { text };
    } catch (error) {
      return reply.status(502).send({ error: error instanceof Error ? error.message : "Transcription failed." });
    }
  });
}
