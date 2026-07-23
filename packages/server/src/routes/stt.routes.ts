// ──────────────────────────────────────────────
// Routes: Speech-to-Text
// ──────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { sttConfigSchema, STT_SETTINGS_KEY, STT_API_KEY_MASK, type STTConfig } from "@marinara-engine/shared";
import { createAppSettingsStorage } from "../services/storage/app-settings.storage.js";
import { encryptApiKey, decryptApiKey } from "../utils/crypto.js";
import { isSttLocalUrlsEnabled } from "../config/runtime-config.js";
import { safeFetch } from "../utils/security.js";

const MAX_STT_UPLOAD_BYTES = 25 * 1024 * 1024;

function parseStoredConfig(raw: string | null): STTConfig {
  if (!raw) return sttConfigSchema.parse({});
  try {
    return sttConfigSchema.parse(JSON.parse(raw));
  } catch {
    return sttConfigSchema.parse({});
  }
}

/** Mask the stored API key before returning STT configuration to the browser. */
export function maskSTTConfigForResponse(config: STTConfig): STTConfig {
  return { ...config, apiKey: config.apiKey ? STT_API_KEY_MASK : "" };
}

/** Preserve a masked key on save (keeps the previously encrypted key unchanged). */
export function prepareSTTConfigForStorage(
  input: STTConfig,
  existing: STTConfig,
  encryptKey: (value: string) => string = encryptApiKey,
): STTConfig {
  return {
    ...input,
    apiKey: input.apiKey === STT_API_KEY_MASK ? existing.apiKey : encryptKey(input.apiKey),
  };
}

async function loadConfig(storage: ReturnType<typeof createAppSettingsStorage>): Promise<STTConfig> {
  const cfg = parseStoredConfig(await storage.get(STT_SETTINGS_KEY));
  cfg.apiKey = decryptApiKey(cfg.apiKey);
  return cfg;
}

function transcriptionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
}

function readProviderErrorDetail(body: string): string {
  if (!body.trim()) return "";
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    const error = data.error;
    const message =
      typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : undefined;
    return message ?? (typeof data.message === "string" ? data.message : body.slice(0, 500));
  } catch {
    return body.slice(0, 500);
  }
}

export async function sttRoutes(app: FastifyInstance) {
  const storage = createAppSettingsStorage(app.db);

  /**
   * GET /api/stt/config
   * Returns STT config with the API key masked.
   */
  app.get("/config", async () => {
    const cfg = parseStoredConfig(await storage.get(STT_SETTINGS_KEY));
    return maskSTTConfigForResponse(cfg);
  });

  /**
   * PUT /api/stt/config
   * Saves STT config. Encrypts the API key before storage.
   * If apiKey equals the mask, the existing key is kept unchanged.
   */
  app.put("/config", async (req, reply) => {
    const input = sttConfigSchema.parse(req.body);
    const existing = parseStoredConfig(await storage.get(STT_SETTINGS_KEY));
    const storedConfig = prepareSTTConfigForStorage(input, existing);
    await storage.set(STT_SETTINGS_KEY, JSON.stringify(storedConfig));
    return reply.status(204).send();
  });

  /**
   * POST /api/stt/transcribe
   * Uploads a recorded audio clip and proxies it to the configured OpenAI-Whisper-API-compatible
   * server's /audio/transcriptions endpoint, returning the transcript.
   */
  app.post("/transcribe", async (req, reply) => {
    const cfg = await loadConfig(storage);
    if (!cfg.enabled || !cfg.baseUrl) {
      return reply.status(400).send({ error: "Speech-to-text is not configured" });
    }

    const data = await req.file({ limits: { fileSize: MAX_STT_UPLOAD_BYTES } });
    if (!data) return reply.status(400).send({ error: "No audio uploaded" });

    const buffer = await data.toBuffer();
    const truncated = (data.file as typeof data.file & { truncated?: boolean }).truncated === true;
    if (truncated) {
      return reply.status(400).send({ error: "Recording is too large (max 25 MB)." });
    }

    const form = new FormData();
    form.set("model", cfg.model || "whisper-1");
    if (cfg.language.trim()) form.set("language", cfg.language.trim());
    form.append("file", new Blob([buffer], { type: data.mimetype || "audio/webm" }), data.filename || "recording.webm");

    let providerRes: Response;
    try {
      providerRes = await safeFetch(transcriptionsUrl(cfg.baseUrl), {
        method: "POST",
        headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(60_000),
        policy: {
          allowLocal: isSttLocalUrlsEnabled(),
          allowedProtocols: ["https:", "http:"],
          flagName: "STT_LOCAL_URLS_ENABLED",
        },
        maxResponseBytes: 1 * 1024 * 1024,
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error && err.name === "TimeoutError" ? "STT request timed out" : "STT provider unreachable";
      req.log.error(err, "STT provider request failed");
      return reply.status(502).send({ error: msg });
    }

    const body = await providerRes.text().catch(() => "");
    if (!providerRes.ok) {
      return reply.status(502).send({ error: `STT provider returned ${providerRes.status}`, detail: readProviderErrorDetail(body) });
    }

    let text = "";
    try {
      const parsed = JSON.parse(body) as { text?: unknown };
      text = typeof parsed.text === "string" ? parsed.text : "";
    } catch {
      // Some servers return a bare transcript string instead of { text }.
      text = body;
    }

    return { text: text.trim() };
  });
}
