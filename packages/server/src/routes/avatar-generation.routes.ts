// ──────────────────────────────────────────────
// Routes: avatar generation from sprites (lane: generation)
// ──────────────────────────────────────────────
// Registered at /api/avatar-generation (AVATAR_API_PREFIXES.generation). Generating returns drafts and
// stores nothing, so an avatar stays as it was until the user keeps the result:
//   POST /pngtuber-variants/preview   AvatarPngtuberVariantsRequest → { items } for the image prompt review
//   POST /pngtuber-variants           AvatarPngtuberVariantsRequest (+ promptOverrides) → drafts
//   POST /pngtuber-variants/save      { owner, images } → AvatarGenerationResponse
//   POST /mesh-rig                    AvatarMeshRigRequest → draft
//   POST /mesh-rig/save               { owner, archive } → AvatarGenerationResponse
//   GET  /tripo-key                   { saved }: whether a Tripo API key is saved (never the key itself)
//   PUT  /tripo-key                   { apiKey } → { saved: true }; DELETE /tripo-key → { saved: false }
//   GET  /vrm-model/balance           the saved key's Tripo credits → { balance, frozen, cost }
//   POST /vrm-model                   AvatarVrmModelRequest → server-sent events: { type: "progress", data:
//                                     AvatarVrmModelProgress } while Tripo works, then { type: "done", data:
//                                     AvatarVrmModelDraft } or { type: "error", data: { message } }
//   POST /cancel                      { owner, kind: "pngtuber" | "mesh-avatar" | "vrm" } → { cancelled }
// Backed by services/avatars/generation/. Requests accept `debugMode`, and every prompt and Tripo request is
// logged with logDebugOverride, honouring DEBUG_AGENTS. Cancel and a closed connection both abort the provider
// requests and free the avatar for a new job.
// A VRM model is made only with the user's own Tripo API key (tripo-key.ts); the draft is kept by importing it.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  AVATAR_PNGTUBER_VARIANTS,
  avatarMeshRigRequestSchema,
  avatarOwnerRefSchema,
  avatarPngtuberVariantsRequestSchema,
  avatarVrmModelRequestSchema,
} from "@marinara-engine/shared";
import { logger } from "../lib/logger.js";
import { failureLevel } from "../lib/log-context.js";
import { sendSseEvent, startSseKeepalive, startSseReply } from "./generate/sse.js";
import {
  AvatarGenerationError,
  cancelAvatarGenerationJob,
  plainErrorText,
} from "../services/avatars/generation/generation-context.js";
import { generateMeshRig, saveMeshRig } from "../services/avatars/generation/mesh-rig.js";
import { generateVrmModel, tripoBalance } from "../services/avatars/generation/tripo-vrm.js";
import { readTripoApiKey, removeTripoApiKey, saveTripoApiKey } from "../services/avatars/generation/tripo-key.js";
import {
  generatePngtuberVariants,
  previewPngtuberVariantPrompts,
  savePngtuberVariants,
} from "../services/avatars/generation/pngtuber-variants.js";

const promptOverridesSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(300),
        prompt: z.string().max(16_000),
        negativePrompt: z.string().max(8_000).optional(),
      })
      .strict(),
  )
  .max(128)
  .optional();

const pngtuberVariantsBodySchema = avatarPngtuberVariantsRequestSchema.extend({
  promptOverrides: promptOverridesSchema,
});

const pngtuberSaveBodySchema = z
  .object({
    owner: avatarOwnerRefSchema,
    images: z
      .array(
        z
          .object({
            label: z.string().min(1).max(64),
            variant: z.enum(AVATAR_PNGTUBER_VARIANTS),
            image: z.string().min(1),
            sourceHash: z.string().regex(/^[0-9a-f]{64}$/u),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();

const meshSaveBodySchema = z.object({ owner: avatarOwnerRefSchema, archive: z.string().min(1) }).strict();

const balanceQuerySchema = z.object({ debugMode: z.string().optional() });
/** A pasted key: trimmed, with no spaces or line breaks inside. */
const tripoKeyBodySchema = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/u),
  })
  .strict();
const cancelBodySchema = z
  .object({ owner: avatarOwnerRefSchema, kind: z.enum(["pngtuber", "mesh-avatar", "vrm"]) })
  .strict();

/** Aborted when the browser goes away (Cancel, a closed tab) before the reply is sent. The reason is an
 *  AbortError, so the failure is logged as a cancellation, not an error. */
function abortOnClose(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) controller.abort(new DOMException("The request was cancelled.", "AbortError"));
  });
  return controller.signal;
}

/** Logs a failure as sendFailure does and returns the status and the message to show. */
function describeFailure(error: unknown, what: string): { status: number; message: string } {
  if (error instanceof AvatarGenerationError) {
    if (error.statusCode >= 500) logger.warn(error, "%s failed", what);
    return { status: error.statusCode, message: error.message };
  }
  logger[failureLevel(error)](error, "%s failed", what);
  return { status: 500, message: plainErrorText(error, `${what} failed.`) };
}

function sendFailure(reply: FastifyReply, error: unknown, what: string) {
  if (error instanceof z.ZodError) {
    return reply.status(400).send({ error: "The request isn't valid.", issues: error.issues.slice(0, 5) });
  }
  const { status, message } = describeFailure(error, what);
  return reply.status(status).send({ error: message });
}

export async function avatarGenerationRoutes(app: FastifyInstance) {
  app.post("/pngtuber-variants/preview", async (req, reply) => {
    try {
      return {
        items: await previewPngtuberVariantPrompts(app.db, avatarPngtuberVariantsRequestSchema.parse(req.body)),
      };
    } catch (error) {
      return sendFailure(reply, error, "PNGTuber variant preview");
    }
  });

  app.post("/pngtuber-variants", async (req, reply) => {
    try {
      const body = pngtuberVariantsBodySchema.parse(req.body);
      return await generatePngtuberVariants(app.db, body, { signal: abortOnClose(reply) });
    } catch (error) {
      return sendFailure(reply, error, "PNGTuber variant generation");
    }
  });

  app.post("/pngtuber-variants/save", async (req, reply) => {
    try {
      return await savePngtuberVariants(pngtuberSaveBodySchema.parse(req.body));
    } catch (error) {
      return sendFailure(reply, error, "Saving PNGTuber variants");
    }
  });

  app.post("/mesh-rig", async (req, reply) => {
    try {
      const body = avatarMeshRigRequestSchema.parse(req.body);
      return await generateMeshRig(app.db, body, { signal: abortOnClose(reply) });
    } catch (error) {
      return sendFailure(reply, error, "Mesh avatar generation");
    }
  });

  app.post("/mesh-rig/save", async (req, reply) => {
    try {
      return await saveMeshRig(meshSaveBodySchema.parse(req.body));
    } catch (error) {
      return sendFailure(reply, error, "Saving the mesh avatar");
    }
  });

  // The answers only ever say whether a key is saved: the key never leaves the server.
  app.get("/tripo-key", async () => ({ saved: !!(await readTripoApiKey(app.db)) }));

  app.put("/tripo-key", async (req, reply) => {
    const body = tripoKeyBodySchema.safeParse(req.body);
    // One plain sentence instead of sendFailure's list of schema issues.
    if (!body.success) return reply.status(400).send({ error: "That doesn't look like a Tripo API key." });
    await saveTripoApiKey(app.db, body.data.apiKey);
    return { saved: true };
  });

  app.delete("/tripo-key", async () => {
    await removeTripoApiKey(app.db);
    return { saved: false };
  });

  app.get("/vrm-model/balance", async (req, reply) => {
    try {
      const query = balanceQuerySchema.parse(req.query);
      return await tripoBalance(app.db, { debugMode: query.debugMode === "true" });
    } catch (error) {
      return sendFailure(reply, error, "Reading the Tripo balance");
    }
  });

  // Minutes of work: progress is streamed, and closing the stream (Cancel) stops waiting for Tripo.
  app.post("/vrm-model", async (req, reply) => {
    let body;
    try {
      body = avatarVrmModelRequestSchema.parse(req.body);
    } catch (error) {
      return sendFailure(reply, error, "VRM model generation");
    }
    const signal = abortOnClose(reply);
    reply.hijack();
    startSseReply(reply, { "X-Accel-Buffering": "no" });
    const stopKeepalive = startSseKeepalive(reply);
    try {
      const draft = await generateVrmModel(app.db, body, {
        signal,
        onProgress: (progress) => sendSseEvent(reply, { type: "progress", data: progress }),
      });
      sendSseEvent(reply, { type: "done", data: draft });
    } catch (error) {
      const { message } = describeFailure(error, "VRM model generation");
      sendSseEvent(reply, { type: "error", data: { message } });
    } finally {
      stopKeepalive();
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });

  app.post("/cancel", async (req, reply) => {
    try {
      const body = cancelBodySchema.parse(req.body);
      return { cancelled: cancelAvatarGenerationJob(body.owner, body.kind) };
    } catch (error) {
      return sendFailure(reply, error, "Cancelling avatar generation");
    }
  });
}
