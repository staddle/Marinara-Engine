// ──────────────────────────────────────────────
// Avatar generation: a VRM model from one sprite through Tripo (lane: 3D generation)
// ──────────────────────────────────────────────
// With the user's own Tripo API key (tripo-key.ts): the sprite (its background cleaned off when it has one) is
// redrawn standing in a T-pose (image-to-image, template t_pose, 5 credits), made into a textured 3D model
// (image-to-model, 30 credits) and given a Mixamo skeleton (rig, 25 credits), then glb-to-vrm.ts turns it into
// a VRM 1.0 model: about 60 credits ($0.60) and 3 minutes. The rig check (free) only stops a model Tripo can't
// rig before paying for it; it is no judge of the body, which glb-to-vrm checks (a T-pose with legs).
// Generating returns a draft and stores nothing: the browser keeps it by importing the file like any VRM,
// so the importer (formats/vrm.ts) checks it and everything after works as for an imported model. The draft
// is checked by that importer here too, so a file it would refuse never reaches the browser.
// makeTripoRiggedModel is the only Tripo-specific step; another service would add its own beside it.
import { readFile } from "node:fs/promises";
import {
  AvatarImportError,
  TRIPO_VRM_MODEL_CREDITS,
  type AvatarVrmModelDraft,
  type AvatarVrmModelProgress,
  type AvatarVrmModelRequest,
  type AvatarVrmModelStep,
} from "@marinara-engine/shared";
import type { DB } from "../../../db/connection.js";
import { logDebugOverride, logger } from "../../../lib/logger.js";
import { isAllowedImageBuffer } from "../../../utils/security.js";
import { getSharp } from "../../image/sharp-runtime.js";
import { avatarCutout } from "../cutouts.js";
import { buildVrmImport, vrmImporter } from "../formats/vrm.js";
import {
  AvatarGenerationError,
  avatarGenerationDebug,
  decodeAvatarSourceSprite,
  findAvatarSpriteFile,
  readAvatarOwnerInfo,
  withAvatarGenerationJob,
} from "./generation-context.js";
import { VrmConversionError, convertRiggedGlbToVrm, shrinkGlbTextures } from "./glb-to-vrm.js";
import {
  TRIPO_UPLOAD_MAX_BYTES,
  TripoError,
  createTripoClient,
  type TripoClient,
  type TripoFetch,
} from "./tripo-client.js";
import { readTripoApiKey } from "./tripo-key.js";

/** Tripo needs no more than this: its T-pose picture comes back 1024 pixels square. */
const UPLOAD_MAX_SIDE = 2048;
const MODEL_MAX_BYTES = 64 * 1024 * 1024;
const PICTURE_MAX_BYTES = 25 * 1024 * 1024;
const PREVIEW_SIDE = 512;

/** Tripo's settings, as tried by hand on real sprites. Leave out export_orientation, compress and quad: they
 *  break the rig step, add compression the importer refuses, or switch the output to FBX. */
export const TRIPO_REQUESTS = Object.freeze({
  redraw: { template: "t_pose", model: "seedream_v5", output_format: "png" },
  model: {
    model: "v3.1-20260211",
    texture: true,
    pbr: true,
    texture_quality: "standard",
    face_limit: 40000,
    auto_size: true,
  },
  rig: { model: "v1.0-20240301", rig_type: "biped", spec: "mixamo", out_format: "glb" },
});

export interface VrmModelOptions {
  signal?: AbortSignal;
  onProgress?: (progress: AvatarVrmModelProgress) => void;
  /** Replaces the network in tests. */
  fetch?: TripoFetch;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The saved Tripo API key, or a plain refusal. */
async function tripoApiKey(db: DB): Promise<string> {
  const apiKey = await readTripoApiKey(db);
  if (!apiKey) throw new AvatarGenerationError(400, "Add your Tripo API key on the 3D Avatars page first.");
  return apiKey;
}

/** The HTTP status a Tripo problem is answered with. */
function tripoStatus(error: TripoError): number {
  switch (error.kind) {
    case "bad-key":
      return 400;
    case "no-credits":
      return 402;
    case "content-policy":
      return 422;
    case "rate-limited":
      return 429;
    default:
      return 502;
  }
}

function asGenerationError(error: unknown): unknown {
  if (error instanceof TripoError)
    return new AvatarGenerationError(tripoStatus(error), error.message, { cause: error });
  if (error instanceof VrmConversionError || error instanceof AvatarImportError) {
    return new AvatarGenerationError(422, error.message, { cause: error });
  }
  return error;
}

/** The account's credits with the saved key, for the 3D Avatars setup. */
export async function tripoBalance(
  db: DB,
  options: Pick<VrmModelOptions, "fetch" | "signal"> & { debugMode?: boolean } = {},
) {
  const apiKey = await tripoApiKey(db);
  try {
    const client = createTripoClient({
      apiKey,
      fetch: options.fetch,
      signal: options.signal,
      debug: avatarGenerationDebug(options.debugMode),
    });
    return { ...(await client.balance()), cost: TRIPO_VRM_MODEL_CREDITS };
  } catch (error) {
    throw asGenerationError(error);
  }
}

/** Tripo takes pictures from 1:3 to 3:1 (width to height). */
const MAX_ASPECT = 3;
const OUT_OF_SHAPE =
  "This sprite is more than three times as tall as it is wide (or the other way round), which Tripo doesn't take. Use a less narrow full-body sprite.";

/** The sprite as Tripo takes it: a PNG at most UPLOAD_MAX_SIDE, its flat background cleaned off, and padded
 *  with see-through space to at most 1:3 when it is narrower (a tall full-body sprite often is). Without image
 *  processing (sharp on Lite or Termux) a PNG or JPEG sprite is sent as it is. */
export async function tripoSourceImage(
  ownerId: string,
  label: string,
): Promise<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" }> {
  const file = findAvatarSpriteFile(ownerId, label);
  if (!file) throw new AvatarGenerationError(404, `The sprite "${label}" was not found.`);
  const bytes = await readFile(file);
  let sharp: Awaited<ReturnType<typeof getSharp>>;
  try {
    sharp = await getSharp();
  } catch {
    const type = isAllowedImageBuffer(bytes)?.mimeType;
    if ((type === "image/png" || type === "image/jpeg") && bytes.length <= TRIPO_UPLOAD_MAX_BYTES) {
      // A PNG's size is in its header; a JPEG's shape is left to Tripo to judge.
      if (type === "image/png" && bytes.length >= 24) {
        const width = bytes.readUInt32BE(16);
        const height = bytes.readUInt32BE(20);
        if (width * MAX_ASPECT < height || height * MAX_ASPECT < width)
          throw new AvatarGenerationError(422, OUT_OF_SHAPE);
      }
      return { bytes, mimeType: type };
    }
    throw new AvatarGenerationError(
      422,
      "This sprite can't be sent to Tripo from this device. Use a PNG or JPEG sprite smaller than 20 MB.",
    );
  }
  const sprite = await decodeAvatarSourceSprite(label, bytes);
  let png = sprite.png;
  try {
    // The avatars' shared background cleanup: the sprite as it is when already a cut-out.
    png = (await avatarCutout(png)).png;
  } catch (error) {
    // A background Tripo can deal with itself (it drew a painted one away when tried) is no reason to stop.
    logger.warn(error, "[avatars] Couldn't clean the sprite's background before sending it to Tripo");
  }
  if (Math.max(sprite.width, sprite.height) > UPLOAD_MAX_SIDE) {
    png = await sharp(png).resize({ width: UPLOAD_MAX_SIDE, height: UPLOAD_MAX_SIDE, fit: "inside" }).png().toBuffer();
  }
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const padX = Math.max(0, Math.ceil(height / MAX_ASPECT) - width);
  const padY = Math.max(0, Math.ceil(width / MAX_ASPECT) - height);
  if (padX || padY) {
    png = await sharp(png)
      .extend({
        left: Math.floor(padX / 2),
        right: Math.ceil(padX / 2),
        top: Math.floor(padY / 2),
        bottom: Math.ceil(padY / 2),
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  }
  return { bytes: png, mimeType: "image/png" };
}

/** A small picture for the draft, as a data URL; null when it can't be made (no image processing). */
async function previewDataUrl(bytes: Buffer | null): Promise<string | null> {
  if (!bytes || !isAllowedImageBuffer(bytes)) return null;
  try {
    const sharp = await getSharp();
    const webp = await sharp(bytes)
      .resize({ width: PREVIEW_SIDE, height: PREVIEW_SIDE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    return `data:image/webp;base64,${webp.toString("base64")}`;
  } catch {
    return null;
  }
}

interface RiggedModel {
  glb: Buffer;
  preview: Buffer | null;
  tpose: Buffer | null;
}

/** Tripo's three paid steps: a T-pose picture of the sprite, the 3D model, and its skeleton. */
async function makeTripoRiggedModel(
  client: TripoClient,
  image: { bytes: Buffer; mimeType: "image/png" | "image/jpeg" },
  report: (step: AvatarVrmModelStep, status: "running" | "done", progress: number | null, credits?: number) => void,
): Promise<RiggedModel> {
  const optional = (download: Promise<Buffer>) =>
    download.catch((error: unknown) => {
      if (error instanceof TripoError) return null;
      throw error;
    });

  report("redraw", "running", null);
  const fileToken = await client.upload(image.bytes, image.mimeType);
  const redrawId = await client.start("/generation/image-to-image", { input: fileToken, ...TRIPO_REQUESTS.redraw });
  const redraw = await client.waitForTask(redrawId, "the T-pose picture", (p) => report("redraw", "running", p));
  const tpose = await optional(client.download(redraw.output?.generated_image_url, PICTURE_MAX_BYTES));
  report("redraw", "done", 100, redraw.credits_consumed);

  report("model", "running", null);
  const modelId = await client.start("/generation/image-to-model", { input: redrawId, ...TRIPO_REQUESTS.model });
  const model = await client.waitForTask(modelId, "the 3D model", (p) => report("model", "running", p));
  const preview = await optional(client.download(model.output?.rendered_image_url, PICTURE_MAX_BYTES));
  report("model", "done", 100, model.credits_consumed);

  report("rig", "running", null);
  const checkId = await client.start("/animations/rig-check", { input: modelId });
  const check = await client.waitForTask(checkId, "the skeleton check");
  if (check.output?.riggable === false) {
    throw new AvatarGenerationError(
      422,
      "Tripo can't give this model a skeleton. Use a full-body sprite where the whole character is visible.",
    );
  }
  const rigId = await client.start("/animations/rig", { input: modelId, ...TRIPO_REQUESTS.rig });
  const rig = await client.waitForTask(rigId, "the skeleton", (p) => report("rig", "running", p));
  const glb = await client.download(rig.output?.model_url, MODEL_MAX_BYTES);
  report("rig", "done", 100, (check.credits_consumed ?? 0) + (rig.credits_consumed ?? 0));
  return { glb, preview, tpose };
}

/** A file name for the model from the owner's name. */
function vrmFileName(name: string): string {
  const base = name
    .replace(/[^\p{L}\p{N} _-]+/gu, "")
    .trim()
    .slice(0, 60);
  return `${base || "avatar"}.vrm`;
}

/** Makes a VRM model of the owner from one sprite through Tripo and returns it as a draft. */
export async function generateVrmModel(
  db: DB,
  request: AvatarVrmModelRequest,
  options: VrmModelOptions = {},
): Promise<AvatarVrmModelDraft> {
  const job = async (signal: AbortSignal): Promise<AvatarVrmModelDraft> => {
    const debug = avatarGenerationDebug(request.debugMode);
    let creditsUsed = 0;
    const report = (step: AvatarVrmModelStep, status: "running" | "done", progress: number | null, credits = 0) => {
      creditsUsed += Number.isFinite(credits) ? credits : 0;
      options.onProgress?.({ step, status, progress, creditsUsed });
    };
    try {
      const [apiKey, owner] = await Promise.all([tripoApiKey(db), readAvatarOwnerInfo(db, request.owner)]);
      const image = await tripoSourceImage(request.owner.ownerId, request.sourceLabel);
      const client = createTripoClient({
        apiKey,
        signal,
        debug,
        fetch: options.fetch,
        wait: options.wait,
      });
      // Checked first, so a model the account can't pay for doesn't stop halfway with credits spent.
      const { balance } = await client.balance();
      if (balance < TRIPO_VRM_MODEL_CREDITS) {
        throw new AvatarGenerationError(
          402,
          `This model needs about ${TRIPO_VRM_MODEL_CREDITS} Tripo credits and your account has ${balance}. Top up at Tripo, then try again.`,
        );
      }
      const rigged = await makeTripoRiggedModel(client, image, report);

      report("convert", "running", null);
      const converted = convertRiggedGlbToVrm(rigged.glb, { name: owner.name });
      const shrunk = await shrinkGlbTextures(converted.vrm, getSharp);
      logDebugReport(debug, converted.report, shrunk);
      const fileName = vrmFileName(owner.name);
      const input = { owner: request.owner, filename: fileName, bytes: new Uint8Array(shrunk.glb) };
      const imported = buildVrmImport(await vrmImporter.validate(input), input, null);
      report("convert", "done", 100);
      return {
        vrm: shrunk.glb.toString("base64"),
        fileName,
        preview: await previewDataUrl(rigged.preview),
        tpose: await previewDataUrl(rigged.tpose),
        creditsUsed,
        warnings: [...converted.report.warnings, ...imported.warnings],
      };
    } catch (error) {
      throw asGenerationError(error);
    }
  };
  // The job's signal stops on a closed stream (options.signal) and on Cancel (POST /cancel, kind "vrm").
  return withAvatarGenerationJob(request.owner, "vrm", job, options.signal);
}

function logDebugReport(
  debug: boolean,
  report: ReturnType<typeof convertRiggedGlbToVrm>["report"],
  shrunk: Awaited<ReturnType<typeof shrinkGlbTextures>>,
) {
  logDebugOverride(
    debug,
    "[debug/avatar-generation] Tripo model as VRM: %d bones, %s m tall, hips at %s%%, arms %s° down, turned %d°, metal off in %d material(s), textures %s",
    Object.keys(report.humanBones).length,
    report.heightMetres.toFixed(2),
    (report.hipsHeightRatio * 100).toFixed(0),
    report.armDropDegrees.map((drop) => drop.toFixed(0)).join("/"),
    report.facingTurnDegrees,
    report.metalMaterials,
    shrunk.skipped ? "kept (no image processing)" : JSON.stringify(shrunk.resized),
  );
}
