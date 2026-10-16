// ──────────────────────────────────────────────
// Avatar import: mesh-avatar `.mavatar` archives (lane: 2D)
// ──────────────────────────────────────────────
// A `.mavatar` (npm "mesh-avatar" 0.1.1, MIT) is a ZIP of `avatar.json`, `rig.json` and the built layers
// (docs/format.md in https://github.com/shinshin86/mesh-avatar-studio). The archive is read with the
// Engine's strict ZIP reader (AVATAR_IMPORT_MAX_BYTES per entry and for all kept files together, no lower
// limit), its JSON is checked against the format's version 1 rules (the rig mirrors the runtime's own
// validateRig, and its mesh must stay playable), and every PNG it names must be present and a real PNG no
// larger than the rig's image. The stored copy is repacked with only the files the player reads, as stored
// (uncompressed) entries, which is what the runtime opens.
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { z } from "zod";
import {
  AVATAR_EMOTIONS,
  AVATAR_IMPORT_EXTENSIONS,
  AvatarImportError,
  type AvatarExpressionMap,
  type AvatarFormatImporter,
  type AvatarViseme,
} from "@marinara-engine/shared";
import { logger } from "../../../lib/logger.js";
import { openZipArchive, ZipArchiveError } from "../../../lib/zip-reader.js";
import { readImageDimensionsFromBuffer } from "../../../utils/image-metadata.js";
import { AVATAR_IMPORT_MAX_BYTES } from "../storage.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LAYER_NAME = /^[A-Za-z0-9_-]+$/u;
const EYE_PARTS = ["ball", "low", "crease", "lash"] as const;
const RESERVED_LAYERS = new Set([
  "base",
  "hairmask",
  "hand",
  ...[0, 1].flatMap((eye) => EYE_PARTS.map((part) => `eye${eye}_${part}`)),
]);
/** The browser runtime refuses archives above these (its unpackAvatar); the import itself adds no limit. */
const RUNTIME_MAX_ENTRIES = 200;
const RUNTIME_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** Most mesh points the player may build. mesh-avatar 0.1.1 lays a grid over the picture and every layer
 *  (buildGrid) and moves every point on each frame, on the main thread. Studio's example cell sizes give tens
 *  of thousands on a 2048 px picture; a rig far past this freezes the chat, so it is a broken (or hostile) file
 *  however small it is. */
export const MESH_AVATAR_MAX_GRID_POINTS = 500_000;

/** Drawn mouth sprites per viseme, and the runtime's vowel for it (mesh-avatar holdMouth). `e` reuses the
 *  half-open "a" and `u` the rounded "o", as the format describes. */
export const MESH_AVATAR_VISEME_SPRITES: Readonly<Record<AvatarViseme, { vowel: string; sprite: string }>> = {
  aa: { vowel: "a", sprite: "mouth_a" },
  ih: { vowel: "i", sprite: "mouth_i" },
  ou: { vowel: "u", sprite: "mouth_o" },
  ee: { vowel: "e", sprite: "mouth_a_half" },
  oh: { vowel: "o", sprite: "mouth_o" },
};

const NOT_A_MESH_AVATAR = "This file isn't a mesh avatar.";
const DAMAGED = "This mesh avatar file is damaged or was made for a newer version, so it can't be imported.";
const TOO_LARGE = "This mesh avatar is too large once unpacked, so it can't be imported.";
const TOO_DETAILED = "This mesh avatar is too detailed to play smoothly, so it can't be imported.";

function refuse(message: string, detail?: string): never {
  if (detail) logger.debug("[avatars] Refused a .mavatar import: %s", detail);
  throw new AvatarImportError("invalid-file", message);
}

// ── rig.json: the runtime's version 1 rig rules (mesh-avatar validateRig), so a refused rig never reaches
// the player ──

const finite = z.number().finite();
const positive = finite.positive();
const positiveInt = z.number().int().positive();
const integer = z.number().int();
const unit = finite.min(0).max(1);
const point = z.tuple([finite, finite]);
const band = point.refine(([start, end]) => start < end, "start must be less than end");
const ellipseShape = { cx: finite, cy: finite, rx: positive, ry: positive };
const ellipse = z.object(ellipseShape);
const polygon = z.array(point).min(3);
const polyline = z.array(point).min(2);
const curve = z.array(finite).length(24);

const rigSchema = z
  .object({
    version: z.literal(1),
    image: z.object({ width: positiveInt, height: positiveInt }),
    head: z.object({
      ...ellipseShape,
      shiftX: finite,
      shiftY: finite,
      pivotX: finite,
      pivotY: finite,
      maxRoll: finite,
      weightBand: band,
      turnBand: band,
    }),
    body: z.object({
      pivotX: finite,
      pivotY: finite,
      maxRoll: finite,
      breathBand: band,
      rollBand: band,
      chest: ellipse,
      shoulders: z.array(ellipse),
    }),
    face: z.object({
      nose: ellipse,
      mouth: ellipse,
      eyeA: ellipse,
      eyeB: ellipse,
      earL: ellipse,
      earR: ellipse,
      brow: z.object({ ...ellipseShape, band }),
      jaw: z.object({ ...ellipseShape, band }),
    }),
    buns: z.object({ bunL: ellipse.optional(), bunR: ellipse.optional() }).optional(),
    eyes: z
      .array(
        z
          .object({ opening: polygon, roi: polygon, x0: finite, x1: finite, top: curve, bot: curve })
          .refine(
            (eye) => eye.x0 < eye.x1 && eye.top.every((top, index) => top <= eye.bot[index]!),
            "an eye needs x0 < x1 and its top curve above its bottom curve",
          ),
      )
      .length(2),
    mouth: z.object({
      cx: finite,
      cy: finite,
      angle: finite,
      halfLen: positive,
      bow: finite,
      area: z.object({ ...ellipseShape, angle: finite }),
    }),
    cheeks: z.array(point).length(2),
    strands: z
      .array(
        z
          .object({ name: z.string().trim().min(1), nodes: polyline, sigma: positive, k: positive, max: positive })
          .refine(
            (strand) =>
              strand.nodes.every(
                (node, index) =>
                  index === 0 || node[0] !== strand.nodes[index - 1]![0] || node[1] !== strand.nodes[index - 1]![1],
              ),
            "consecutive strand nodes must differ",
          ),
      )
      .optional(),
    accessories: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            pivot: point,
            tip: point,
            split: unit,
            box: z.tuple([integer, integer, integer, integer]),
            color: z.object({ redness: unit, minRed: finite }),
          })
          .refine((accessory) => accessory.split > 0 && accessory.split < 1, "split must be between 0 and 1")
          .refine(
            (accessory) => accessory.pivot.some((value, index) => value !== accessory.tip[index]),
            "tip must differ from pivot",
          )
          .refine(
            (accessory) => accessory.box[0] < accessory.box[2] && accessory.box[1] < accessory.box[3],
            "box needs an area",
          ),
      )
      .optional(),
    hand: z
      .object({
        outline: polygon,
        jaw: polyline,
        jawRange: band,
        background: polygon,
        elbow: point,
        wrist: point,
        knuckle: point,
        contact: point,
        forearmShare: unit,
        armBand: band,
        wristBand: band,
        handBand: band,
        fingerXBand: band,
        fingerYBand: band,
        pinBand: band,
      })
      .optional(),
    mesh: z.object({
      baseCell: positiveInt,
      fine: z
        .object({ x0: integer, x1: integer, y0: integer, y1: integer, cell: positiveInt })
        .refine((fine) => fine.x0 < fine.x1 && fine.y0 < fine.y1, "the fine mesh needs an area"),
      handCell: positiveInt,
      tasselCell: positiveInt,
      eyeBallCell: positiveInt,
      eyeCell: positiveInt,
      spriteCell: positiveInt,
    }),
    view: z
      .object({ padTop: finite, padSide: finite, gazeCenter: point.optional() })
      .refine((view) => view.padTop > -1 && view.padTop < 1 && view.padSide > -0.5, "margins must leave a viewport"),
  })
  .superRefine((rig, context) => {
    for (const [index, accessory] of (rig.accessories ?? []).entries()) {
      if (
        accessory.box[0] < 0 ||
        accessory.box[1] < 0 ||
        accessory.box[2] > rig.image.width ||
        accessory.box[3] > rig.image.height
      ) {
        context.addIssue({
          code: "custom",
          path: ["accessories", index, "box"],
          message: "box must stay inside the image",
        });
      }
    }
  });
type MeshAvatarRig = z.infer<typeof rigSchema>;

// ── Archive ──

export interface ValidatedMeshAvatar {
  /** Files the player reads, by archive path, in the order they are repacked. */
  files: Map<string, Buffer>;
  sprites: Set<string>;
  /** Short hash of the upload, so a re-import gets a new file name. */
  hash: string;
  warnings: string[];
}

function readJson(
  entry: { read(maxBytes: number): Buffer },
  name: string,
): { bytes: Buffer; value: Record<string, unknown> } {
  const bytes = entry.read(AVATAR_IMPORT_MAX_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse(DAMAGED, `${name} is not UTF-8 JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(DAMAGED, `${name} is not an object`);
  return { bytes, value: value as Record<string, unknown> };
}

function checkVersion(value: Record<string, unknown>, name: string, optional: boolean) {
  if (value.version === 1 || (optional && value.version === undefined)) return;
  refuse(DAMAGED, `${name} has version ${JSON.stringify(value.version) ?? "missing"}`);
}

function checkManifest(value: Record<string, unknown>) {
  const problem =
    value.format !== "mesh-avatar"
      ? "format"
      : typeof value.name !== "string" || !value.name.trim()
        ? "name"
        : (["author", "license", "thumbnail", "source"] as const).find(
            (key) => value[key] !== undefined && typeof value[key] !== "string",
          );
  if (problem) refuse(NOT_A_MESH_AVATAR, `avatar.json.${problem} is invalid`);
  checkVersion(value, "avatar.json", false);
  const studio = value.studio;
  if (
    studio !== undefined &&
    (typeof studio !== "object" ||
      studio === null ||
      typeof (studio as { version?: unknown }).version !== "string" ||
      !(studio as { version: string }).version.trim())
  ) {
    refuse(DAMAGED, "avatar.json.studio.version is invalid");
  }
}

type Rect = [number, number, number, number];

/** A layer rectangle map: safe names, integer rectangles inside the image. */
function readRects(value: unknown, name: string, size: { width: number; height: number }): Map<string, Rect> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    refuse(DAMAGED, `${name}.layers is not a map`);
  const rects = new Map<string, Rect>();
  for (const [layer, rect] of Object.entries(value)) {
    const valid =
      LAYER_NAME.test(layer) &&
      Array.isArray(rect) &&
      rect.length === 4 &&
      rect.every((part) => Number.isInteger(part)) &&
      rect[0] >= 0 &&
      rect[1] >= 0 &&
      rect[2] > 0 &&
      rect[3] > 0 &&
      rect[0] + rect[2] <= size.width &&
      rect[1] + rect[3] <= size.height;
    if (!valid) refuse(DAMAGED, `${name}.layers.${layer} is not a rectangle inside the image`);
    rects.set(layer, rect as Rect);
  }
  return rects;
}

function sameNumbers(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right)
    ? left.length === right.length && left.every((value, index) => value === right[index])
    : left === right;
}

type FineBand = { from: number; to: number; cell: number } | null;

/** Grid lines across one side of a layer, placed as mesh-avatar 0.1.1's buildGrid places them: every `cell`
 *  pixels, or every `fine.cell` inside the fine band. Counting stops past `limit`. */
function gridLines(start: number, length: number, cell: number, fine: FineBand, limit: number): number {
  let lines = 1;
  for (let at = start; at < start + length - 0.5 && lines <= limit; lines += 1) {
    at = Math.min(start + length, at + (fine && at >= fine.from && at < fine.to ? fine.cell : cell));
  }
  return lines;
}

/** Mesh points the player builds for this rig: the picture's grid (finer in the fine rectangle), each eye
 *  part, the hand, each hanging accessory and each drawn sprite. Stops counting once past the limit. */
export function countMeshAvatarGridPoints(
  rig: Pick<MeshAvatarRig, "image" | "mesh" | "hand" | "accessories">,
  rects: ReadonlyMap<string, Rect>,
  spriteRects: ReadonlyMap<string, Rect>,
): number {
  const { mesh } = rig;
  const grids: { rect: Rect | undefined; cell: number; fine?: MeshAvatarRig["mesh"]["fine"] }[] = [
    { rect: [0, 0, rig.image.width, rig.image.height], cell: mesh.baseCell, fine: mesh.fine },
    ...[0, 1].flatMap((eye) =>
      EYE_PARTS.map((part) => ({
        rect: rects.get(`eye${eye}_${part}`),
        cell: part === "ball" ? mesh.eyeBallCell : mesh.eyeCell,
      })),
    ),
    ...(rig.hand ? [{ rect: rects.get("hand"), cell: mesh.handCell }] : []),
    ...(rig.accessories ?? []).map((accessory) => ({ rect: rects.get(accessory.name), cell: mesh.tasselCell })),
    ...[...spriteRects.values()].map((rect) => ({ rect, cell: mesh.spriteCell })),
  ];
  let total = 0;
  for (const { rect, cell, fine } of grids) {
    if (!rect || total > MESH_AVATAR_MAX_GRID_POINTS) continue;
    const limit = MESH_AVATAR_MAX_GRID_POINTS - total;
    const columns = gridLines(
      rect[0],
      rect[2],
      cell,
      fine ? { from: fine.x0, to: fine.x1, cell: fine.cell } : null,
      limit,
    );
    const rows = gridLines(
      rect[1],
      rect[3],
      cell,
      fine ? { from: fine.y0, to: fine.y1, cell: fine.cell } : null,
      limit,
    );
    total += columns * rows;
  }
  return total;
}

/** Parses and checks an untrusted `.mavatar`. Throws AvatarImportError with a plain message. */
export function readMeshAvatarArchive(bytes: Uint8Array): ValidatedMeshAvatar {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let archive: ReturnType<typeof openZipArchive>;
  try {
    archive = openZipArchive(buffer);
  } catch (error) {
    if (error instanceof ZipArchiveError) refuse(`This mesh avatar file can't be read: ${error.message}.`);
    throw error;
  }
  const entries = new Map<string, { read(maxBytes: number): Buffer; size: number }>();
  // Everything kept is held in memory and stored again, so the unpacked files share the upload cap, as
  // .marinara packages do (import.routes.ts). Only an archive that inflates past its own upload limit fails.
  let unpackedBytes = 0;
  for (const entry of archive.getEntries()) {
    const name = entry.entryName;
    if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
      refuse(DAMAGED, `unsafe entry name ${JSON.stringify(name.slice(0, 120))}`);
    }
    if (entry.isDirectory) continue;
    entries.set(name, {
      size: entry.size,
      read(maxBytes) {
        unpackedBytes += entry.size;
        if (unpackedBytes > AVATAR_IMPORT_MAX_BYTES) refuse(TOO_LARGE, `${name} unpacks past the upload cap`);
        return entry.read(maxBytes);
      },
    });
  }
  const get = (name: string) => entries.get(name) ?? refuse(DAMAGED, `${name} is missing`);

  try {
    return readCheckedArchive(entries, get, buffer);
  } catch (error) {
    if (error instanceof ZipArchiveError) refuse(`This mesh avatar file can't be read: ${error.message}.`);
    throw error;
  }
}

function readCheckedArchive(
  entries: Map<string, { read(maxBytes: number): Buffer; size: number }>,
  get: (name: string) => { read(maxBytes: number): Buffer; size: number },
  upload: Buffer,
): ValidatedMeshAvatar {
  if (!entries.has("avatar.json") || !entries.has("rig.json"))
    refuse(NOT_A_MESH_AVATAR, "avatar.json or rig.json is missing");
  const files = new Map<string, Buffer>();
  const manifest = readJson(get("avatar.json"), "avatar.json");
  checkManifest(manifest.value);
  files.set("avatar.json", manifest.bytes);

  const rigFile = readJson(get("rig.json"), "rig.json");
  checkVersion(rigFile.value, "rig.json", false);
  const parsedRig = rigSchema.safeParse(rigFile.value);
  if (!parsedRig.success) {
    const issue = parsedRig.error.issues[0];
    refuse(DAMAGED, `rig.json.${issue?.path.join(".")}: ${issue?.message}`);
  }
  const rig: MeshAvatarRig = parsedRig.data;
  files.set("rig.json", rigFile.bytes);

  const layersFile = readJson(get("built/layers.json"), "built/layers.json");
  const layers = layersFile.value;
  checkVersion(layers, "built/layers.json", true);
  if (typeof layers.build !== "string" || !layers.build.trim()) refuse(DAMAGED, "built/layers.json.build is missing");
  if (!sameNumbers(layers.size, [rig.image.width, rig.image.height])) {
    refuse(DAMAGED, "built/layers.json.size does not match rig.json.image");
  }
  const rects = readRects(layers.layers, "built/layers.json", rig.image);
  const accessories = (rig.accessories ?? []).map((accessory) => accessory.name);
  if (new Set(accessories).size !== accessories.length || accessories.some((name) => RESERVED_LAYERS.has(name))) {
    refuse(DAMAGED, "rig.json.accessories reuse a layer name");
  }
  const required = [
    ...[0, 1].flatMap((eye) => EYE_PARTS.map((part) => `eye${eye}_${part}`)),
    ...(rig.hand ? ["hand"] : []),
    ...accessories,
  ];
  const missingLayer = required.find((name) => !rects.has(name));
  if (missingLayer) refuse(DAMAGED, `built/layers.json.layers.${missingLayer} is missing`);
  const eyes = layers.eyes;
  if (
    !Array.isArray(eyes) ||
    eyes.length !== 2 ||
    !eyes.every(
      (eye, index) =>
        typeof eye === "object" &&
        eye !== null &&
        (["x0", "x1", "top", "bot"] as const).every((key) =>
          sameNumbers((eye as Record<string, unknown>)[key], rig.eyes[index]![key]),
        ),
    )
  ) {
    refuse(DAMAGED, "built/layers.json.eyes does not match rig.json.eyes");
  }
  files.set("built/layers.json", layersFile.bytes);

  const pictures = ["built/base.png", "built/hairmask.png", ...[...rects.keys()].map((name) => `built/${name}.png`)];
  const sprites = new Set<string>();
  let spriteRects = new Map<string, Rect>();
  const spritesEntry = entries.get("built/sprites/sprites.json");
  if (spritesEntry) {
    const spritesFile = readJson(spritesEntry, "built/sprites/sprites.json");
    checkVersion(spritesFile.value, "built/sprites/sprites.json", true);
    if (typeof spritesFile.value.build !== "string" || !spritesFile.value.build.trim()) {
      refuse(DAMAGED, "built/sprites/sprites.json.build is missing");
    }
    spriteRects = readRects(spritesFile.value.layers, "built/sprites/sprites.json", rig.image);
    for (const name of spriteRects.keys()) {
      sprites.add(name);
      pictures.push(`built/sprites/${name}.png`);
    }
    files.set("built/sprites/sprites.json", spritesFile.bytes);
  }
  if (countMeshAvatarGridPoints(rig, rects, spriteRects) > MESH_AVATAR_MAX_GRID_POINTS) {
    refuse(TOO_DETAILED, "the rig's mesh has too many points");
  }

  for (const name of new Set(pictures)) {
    const png = get(name).read(AVATAR_IMPORT_MAX_BYTES);
    const size = png.subarray(0, 8).equals(PNG_SIGNATURE) ? readImageDimensionsFromBuffer(png) : null;
    // A layer is cropped from the illustration, so a bigger picture is a broken (or hostile) file.
    if (!size || size.width > rig.image.width || size.height > rig.image.height) {
      refuse(DAMAGED, `${name} is not a PNG that fits the rig's image`);
    }
    files.set(name, png);
  }

  const warnings: string[] = [];
  if (sprites.size === 0)
    warnings.push("This avatar has no drawn mouth or eye shapes, so simple ones are drawn for it.");
  if (files.size > RUNTIME_MAX_ENTRIES || [...files.values()].some((file) => file.length > RUNTIME_MAX_ENTRY_BYTES)) {
    warnings.push("This avatar may be too large for the mesh avatar player to open.");
  }
  return { files, sprites, hash: createHash("sha256").update(upload).digest("hex").slice(0, 10), warnings };
}

/** A `.mavatar` the runtime opens: stored (uncompressed) entries, `avatar.json` first. The generation lane
 *  packs its rigs with this too. */
export function packMeshAvatarArchive(files: ReadonlyMap<string, Buffer>): Buffer {
  const zip = new AdmZip();
  const names = [...files.keys()].sort(
    (left, right) => Number(right === "avatar.json") - Number(left === "avatar.json"),
  );
  for (const name of names) zip.addFile(name, files.get(name)!);
  for (const entry of zip.getEntries()) entry.header.method = 0;
  return zip.toBuffer();
}

/** What the player can show for each slot. Every emotion is a runtime preset; mouths and blinks use drawn
 *  sprites when the file has them and the runtime's own drawing otherwise. */
export function detectMeshAvatarBindings(sprites: ReadonlySet<string>): AvatarExpressionMap {
  const map: AvatarExpressionMap = {};
  for (const emotion of AVATAR_EMOTIONS) map[emotion] = { target: emotion, source: "preset", confidence: 1 };
  for (const [viseme, { vowel, sprite }] of Object.entries(MESH_AVATAR_VISEME_SPRITES) as [
    AvatarViseme,
    { vowel: string; sprite: string },
  ][]) {
    map[viseme] = { target: vowel, source: "preset", confidence: sprites.has(sprite) ? 1 : 0.6 };
  }
  map.blink = {
    target: "eyes_closed",
    source: "preset",
    confidence: sprites.has("eyes_closed_0") && sprites.has("eyes_closed_1") ? 1 : 0.6,
  };
  return map;
}

export const mavatarImporter: AvatarFormatImporter<"mesh-avatar", ValidatedMeshAvatar> = {
  kind: "mesh-avatar",
  extensions: AVATAR_IMPORT_EXTENSIONS["mesh-avatar"],
  detect({ filename, head }) {
    return (
      filename.toLowerCase().endsWith(".mavatar") &&
      head[0] === 0x50 &&
      head[1] === 0x4b &&
      head[2] === 0x03 &&
      head[3] === 0x04
    );
  },
  async validate(input) {
    return readMeshAvatarArchive(input.bytes);
  },
  async extract(validated) {
    const path = `mesh-avatar/avatar-${validated.hash}.mavatar`;
    const detected = detectMeshAvatarBindings(validated.sprites);
    return {
      kind: "mesh-avatar",
      files: [{ path, bytes: packMeshAvatarArchive(validated.files) }],
      data: { file: path, expressionMap: detected, source: "import" },
      detected,
      warnings: validated.warnings,
    };
  },
};
