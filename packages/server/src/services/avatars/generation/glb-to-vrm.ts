// ──────────────────────────────────────────────
// Avatar generation: a rigged GLB as a VRM 1.0 model (lane: 3D generation)
// ──────────────────────────────────────────────
// Tripo rigs a model with a Mixamo skeleton (`mixamorig:Hips` and so on). convertRiggedGlbToVrm changes only
// the glTF JSON: it names the bones as VRM humanoid bones, checks the body (a T-pose with legs, the rest pose
// the Engine's arm pose starts from), turns the model to face +Z, switches metal off, and adds VRMC_vrm 1.0.
// The binary chunk (mesh, skin weights, inverse bind matrices, textures) is copied byte for byte. The model has
// no face shapes, eye or jaw bones, so no expressions, look-at or first-person settings are written: the body
// moves, the face doesn't. shrinkGlbTextures then makes the large normal and metal maps smaller.
// Plain JavaScript (sharp only for the textures, and optional), so it runs on Lite and Termux too.
import type { getSharp } from "../../image/sharp-runtime.js";

/** A refusal with a message plain enough to show the user. */
export class VrmConversionError extends Error {
  readonly code: "invalid" | "not-rigged" | "missing-bones" | "not-t-pose" | "no-legs" | "compressed";
  constructor(code: VrmConversionError["code"], message: string) {
    super(message);
    this.name = "VrmConversionError";
    this.code = code;
  }
}

const FULL_BODY_ADVICE = "Use a full-body sprite where the whole character is visible.";

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"
/** The importer's own limit on the JSON chunk (VRM_MAX_JSON_CHUNK_BYTES in formats/vrm.ts). */
const MAX_JSON_BYTES = 16 * 1024 * 1024;

/** Mixamo joint names (without the `mixamorig:` prefix) and the VRM 1.0 humanoid bone each one is. */
const MIXAMO_TO_VRM: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {
    Hips: "hips",
    Spine: "spine",
    Spine1: "chest",
    Spine2: "upperChest",
    Neck: "neck",
    Head: "head",
    LeftEye: "leftEye",
    RightEye: "rightEye",
  };
  for (const side of ["Left", "Right"] as const) {
    const s = side.toLowerCase();
    Object.assign(map, {
      [`${side}Shoulder`]: `${s}Shoulder`,
      [`${side}Arm`]: `${s}UpperArm`,
      [`${side}ForeArm`]: `${s}LowerArm`,
      [`${side}Hand`]: `${s}Hand`,
      [`${side}UpLeg`]: `${s}UpperLeg`,
      [`${side}Leg`]: `${s}LowerLeg`,
      [`${side}Foot`]: `${s}Foot`,
      [`${side}ToeBase`]: `${s}Toes`,
      [`${side}HandThumb1`]: `${s}ThumbMetacarpal`,
      [`${side}HandThumb2`]: `${s}ThumbProximal`,
      [`${side}HandThumb3`]: `${s}ThumbDistal`,
    });
    for (const [mixamo, vrm] of [
      ["Index", "Index"],
      ["Middle", "Middle"],
      ["Ring", "Ring"],
      ["Pinky", "Little"],
    ] as const) {
      Object.assign(map, {
        [`${side}Hand${mixamo}1`]: `${s}${vrm}Proximal`,
        [`${side}Hand${mixamo}2`]: `${s}${vrm}Intermediate`,
        [`${side}Hand${mixamo}3`]: `${s}${vrm}Distal`,
      });
    }
  }
  return map;
})();

/** The bones three-vrm refuses a model without (VRMRequiredHumanBoneName). */
const REQUIRED_BONES = [
  "hips",
  "spine",
  "head",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
] as const;

/** Arms further below horizontal than this are not a T-pose. The Engine lowers the arms 69° from the rest
 *  pose, so a model already resting with its arms down would push them through its hips. */
export const MAX_ARM_DROP_DEGREES = 25;
/** Each arm segment (shoulder to elbow, elbow to wrist) must point this close to straight out along the
 *  shoulder line: arms held forward, or bent at the elbow, are no T-pose either. */
export const MAX_ARM_OUTWARD_DEGREES = 30;
/** Hips lower than this share of the height mean the legs are missing (a bust or a cropped sprite). */
export const MIN_HIPS_HEIGHT_RATIO = 0.35;

/** Tripo's terms for what was made with it: free users' results stay Tripo's, paid users' are theirs. */
const TRIPO_TERMS_URL = "https://developers.tripo3d.ai/en/terms";
/** The licence VRM 1.0 requires every file to name. */
const VRM_LICENSE_URL = "https://vrm.dev/licenses/1.0/";

type Vec3 = [number, number, number];
type Mat4 = number[];

interface GltfNode {
  name?: string;
  children?: number[];
  matrix?: number[];
  rotation?: number[];
  scale?: number[];
  translation?: number[];
  mesh?: number;
  skin?: number;
}

interface GltfJson {
  asset?: { generator?: string; version?: string } & Record<string, unknown>;
  scene?: number;
  scenes?: Array<{ nodes?: number[] } & Record<string, unknown>>;
  nodes?: GltfNode[];
  skins?: Array<{ joints: number[] } & Record<string, unknown>>;
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
  accessors?: Array<{ min?: number[]; max?: number[] } & Record<string, unknown>>;
  materials?: Array<{ pbrMetallicRoughness?: Record<string, unknown> } & Record<string, unknown>>;
  textures?: Array<{ source?: number } & Record<string, unknown>>;
  images?: Array<{ bufferView?: number; mimeType?: string; uri?: string } & Record<string, unknown>>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number } & Record<string, unknown>>;
  buffers?: Array<{ byteLength: number; uri?: string } & Record<string, unknown>>;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extensions?: Record<string, unknown>;
}

export interface ParsedGlb {
  json: GltfJson;
  /** The binary chunk's data, or an empty buffer when the file has none. */
  bin: Buffer;
}

/** Reads a GLB 2.0 file: its JSON chunk, parsed, and its binary chunk's data. */
export function parseGlb(bytes: Uint8Array): ParsedGlb {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const damaged = () => new VrmConversionError("invalid", "The 3D model file is damaged.");
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC || buffer.readUInt32LE(4) !== 2) throw damaged();
  if (buffer.readUInt32LE(8) !== buffer.length) throw damaged();
  const jsonLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== CHUNK_JSON || jsonLength > MAX_JSON_BYTES || 20 + jsonLength > buffer.length) {
    throw damaged();
  }
  let json: GltfJson;
  try {
    json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8")) as GltfJson;
  } catch {
    throw damaged();
  }
  let bin: Buffer = Buffer.alloc(0);
  const binStart = 20 + jsonLength;
  if (binStart < buffer.length) {
    if (buffer.length - binStart < 8 || buffer.readUInt32LE(binStart + 4) !== CHUNK_BIN) throw damaged();
    const binLength = buffer.readUInt32LE(binStart);
    if (binStart + 8 + binLength > buffer.length) throw damaged();
    bin = buffer.subarray(binStart + 8, binStart + 8 + binLength);
  }
  return { json, bin };
}

function pad4(bytes: Buffer, fill: number): Buffer {
  const padding = (4 - (bytes.length % 4)) % 4;
  return padding ? Buffer.concat([bytes, Buffer.alloc(padding, fill)]) : bytes;
}

/** Writes a GLB 2.0 file from a JSON document and binary chunk data. */
export function writeGlb(json: unknown, bin: Buffer): Buffer {
  const text = pad4(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const data = bin.length ? pad4(bin, 0) : bin;
  const header = Buffer.alloc(20);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.length + (data.length ? 8 + data.length : 0), 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(CHUNK_JSON, 16);
  if (!data.length) return Buffer.concat([header, text]);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(data.length, 0);
  binHeader.writeUInt32LE(CHUNK_BIN, 4);
  return Buffer.concat([header, text, binHeader, data]);
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[column * 4 + row]! += a[k * 4 + row]! * b[column * 4 + k]!;
    }
  }
  return out;
}

/** A node's local matrix (column-major, as glTF stores it). */
function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix?.length === 16) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!,
    2 * (x! * y! + z! * w!) * sx!,
    2 * (x! * z! - y! * w!) * sx!,
    0,
    2 * (x! * y! - z! * w!) * sy!,
    (1 - 2 * (x! * x! + z! * z!)) * sy!,
    2 * (y! * z! + x! * w!) * sy!,
    0,
    2 * (x! * z! + y! * w!) * sz!,
    2 * (y! * z! - x! * w!) * sz!,
    (1 - 2 * (x! * x! + y! * y!)) * sz!,
    0,
    tx!,
    ty!,
    tz!,
    1,
  ];
}

function transformPoint(matrix: Mat4, [x, y, z]: Vec3): Vec3 {
  return [
    matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
    matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
    matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
  ];
}

export interface VrmConversionOptions {
  /** The model's name: the character's or persona's. */
  name: string;
}

export interface VrmConversionReport {
  /** VRM humanoid bone → the file's joint name. */
  humanBones: Record<string, string>;
  unmappedJoints: string[];
  heightMetres: number;
  hipsHeightRatio: number;
  /** How far each arm points below horizontal at rest (left, right). */
  armDropDegrees: [number, number];
  /** How far each arm segment points away from straight out (left upper, left lower, right upper, right lower). */
  armOutwardDegrees: number[];
  /** The turn around the up axis that made the model face +Z. */
  facingTurnDegrees: number;
  /** Materials whose metal was switched off. */
  metalMaterials: number;
  warnings: string[];
}

/** World matrices of every node, by index. */
function worldMatrices(nodes: readonly GltfNode[]): (index: number) => Mat4 {
  const parent = new Map<number, number>();
  nodes.forEach((node, index) => node.children?.forEach((child) => parent.set(child, index)));
  const cache = new Map<number, Mat4>();
  const world = (index: number, depth = 0): Mat4 => {
    const cached = cache.get(index);
    if (cached) return cached;
    if (depth > nodes.length) throw new VrmConversionError("invalid", "The 3D model's node tree loops.");
    const node = nodes[index];
    if (!node) throw new VrmConversionError("invalid", "The 3D model's skeleton points to parts that aren't there.");
    const up = parent.get(index);
    const matrix = up === undefined ? localMatrix(node) : multiply(world(up, depth + 1), localMatrix(node));
    cache.set(index, matrix);
    return matrix;
  };
  return world;
}

/** The lowest and highest point of the model at rest. A skinned mesh's positions already are where the
 *  skeleton puts them at rest (its node transform is ignored); any other mesh is placed by its node. */
function verticalExtent(json: GltfJson, world: (index: number) => Mat4): { minY: number; maxY: number } {
  let minY = Infinity;
  let maxY = -Infinity;
  (json.nodes ?? []).forEach((node, index) => {
    const mesh = node.mesh === undefined ? undefined : json.meshes?.[node.mesh];
    for (const primitive of mesh?.primitives ?? []) {
      const accessor = json.accessors?.[primitive.attributes.POSITION ?? -1];
      if (accessor?.min?.length !== 3 || accessor.max?.length !== 3) continue;
      const [x0, y0, z0] = accessor.min as Vec3;
      const [x1, y1, z1] = accessor.max as Vec3;
      const corners: Vec3[] = [];
      for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) corners.push([x, y, z]);
      const matrix = node.skin === undefined ? world(index) : null;
      for (const corner of corners) {
        const y = matrix ? transformPoint(matrix, corner)[1] : corner[1];
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  });
  if (!Number.isFinite(minY) || !(maxY > minY)) {
    throw new VrmConversionError("invalid", "The 3D model has no mesh to show.");
  }
  return { minY, maxY };
}

/** The VRM 1.0 details of a generated model. What may be done with it depends on the user's Tripo plan
 *  (Tripo keeps the rights to free users' results; paid users own theirs) and on who owns the sprite, which
 *  the Engine can't know. So the file claims nothing beyond personal use by its maker and links Tripo's
 *  terms. */
function vrmMeta(name: string) {
  return {
    name: name.trim() || "Avatar",
    version: "1",
    authors: ["Tripo AI"],
    copyrightInformation:
      "Made with Tripo AI from a sprite in Marinara Engine. Who may use it depends on your Tripo plan and on who owns the sprite.",
    licenseUrl: VRM_LICENSE_URL,
    otherLicenseUrl: TRIPO_TERMS_URL,
    avatarPermission: "onlyAuthor",
    commercialUsage: "personalNonProfit",
    allowExcessivelyViolentUsage: false,
    allowExcessivelySexualUsage: false,
    allowPoliticalOrReligiousUsage: false,
    allowAntisocialOrHateUsage: false,
    creditNotation: "required",
    allowRedistribution: false,
    modification: "allowModification",
  };
}

/** Turns a Mixamo-rigged GLB into a VRM 1.0 model, or refuses it with a plain reason. */
export function convertRiggedGlbToVrm(
  glb: Uint8Array,
  options: VrmConversionOptions,
): { vrm: Buffer; report: VrmConversionReport } {
  const { json, bin } = parseGlb(glb);
  const extensionsUsed = json.extensionsUsed ?? [];
  if (
    ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression", "KHR_texture_basisu"].some(
      (name) => extensionsUsed.includes(name),
    )
  ) {
    throw new VrmConversionError("compressed", "The 3D model is compressed in a way avatars can't load.");
  }
  if (json.extensions?.VRMC_vrm || json.extensions?.VRM) {
    throw new VrmConversionError("invalid", "The 3D model is already a VRM.");
  }
  const nodes = json.nodes ?? [];
  const skin = json.skins?.[0];
  if (!skin?.joints?.length) throw new VrmConversionError("not-rigged", "The 3D model came back without a skeleton.");
  const warnings: string[] = [];

  // ── Bones ──
  const humanBones: Record<string, { node: number }> = {};
  const unmappedJoints: string[] = [];
  for (const joint of skin.joints) {
    const raw = nodes[joint]?.name ?? "";
    const bone = MIXAMO_TO_VRM[raw.replace(/^mixamorig\d*[:_]/u, "")];
    if (bone && !humanBones[bone]) humanBones[bone] = { node: joint };
    else unmappedJoints.push(raw);
  }
  const missing = REQUIRED_BONES.filter((bone) => !humanBones[bone]);
  if (missing.length) {
    throw new VrmConversionError(
      "missing-bones",
      `The 3D model's skeleton is missing parts a VRM needs: ${missing.join(", ")}.`,
    );
  }
  // VRM 1.0 lets upperChest exist only below a chest.
  if (humanBones.upperChest && !humanBones.chest) {
    humanBones.chest = humanBones.upperChest;
    delete humanBones.upperChest;
  }

  // ── Body: a T-pose with legs ──
  const world = worldMatrices(nodes);
  const at = (bone: string): Vec3 => {
    const matrix = world(humanBones[bone]!.node);
    return [matrix[12]!, matrix[13]!, matrix[14]!];
  };
  const { minY, maxY } = verticalExtent(json, world);
  const height = maxY - minY;
  const hipsHeightRatio = (at("hips")[1] - minY) / height;
  if (!(hipsHeightRatio >= MIN_HIPS_HEIGHT_RATIO)) {
    throw new VrmConversionError("no-legs", `The 3D model has no legs. ${FULL_BODY_ADVICE}`);
  }
  const armDrop = (side: "left" | "right") => {
    const shoulder = at(`${side}UpperArm`);
    const hand = at(`${side}Hand`);
    const along: Vec3 = [hand[0] - shoulder[0], hand[1] - shoulder[1], hand[2] - shoulder[2]];
    const length = Math.hypot(...along);
    return length > 0 ? (Math.asin(Math.max(-1, Math.min(1, -along[1] / length))) * 180) / Math.PI : 90;
  };
  const armDropDegrees: [number, number] = [armDrop("left"), armDrop("right")];
  // Out along the shoulder line, level: each segment of each arm, measured against it.
  const shoulderLine = (() => {
    const l = at("leftUpperArm");
    const r = at("rightUpperArm");
    const line: Vec3 = [l[0] - r[0], 0, l[2] - r[2]];
    const length = Math.hypot(...line);
    return length > 0 ? (line.map((value) => value / length) as Vec3) : null;
  })();
  const outwardDegrees = (side: "left" | "right", from: string, to: string) => {
    if (!shoulderLine) return 0;
    const a = at(`${side}${from}`);
    const b = at(`${side}${to}`);
    const along: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const length = Math.hypot(...along);
    const sign = side === "left" ? 1 : -1;
    const cos = length > 0 ? (sign * (along[0] * shoulderLine[0] + along[2] * shoulderLine[2])) / length : -1;
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  };
  const armOutwardDegrees = (["left", "right"] as const).flatMap((side) => [
    outwardDegrees(side, "UpperArm", "LowerArm"),
    outwardDegrees(side, "LowerArm", "Hand"),
  ]);
  if (
    armDropDegrees.some((drop) => Math.abs(drop) > MAX_ARM_DROP_DEGREES) ||
    armOutwardDegrees.some((angle) => angle > MAX_ARM_OUTWARD_DEGREES)
  ) {
    throw new VrmConversionError(
      "not-t-pose",
      `The 3D model's arms aren't held out to the sides, so it can't move like an avatar. ${FULL_BODY_ADVICE}`,
    );
  }
  if (Math.abs(minY) > 0.05) warnings.push(`The feet are ${minY.toFixed(2)} m from the ground.`);

  // ── Facing: the character's left, crossed with up, is forward; VRM 1.0 models face +Z ──
  const left = at("leftUpperArm");
  const right = at("rightUpperArm");
  const leftward: Vec3 = [left[0] - right[0], 0, left[2] - right[2]];
  let facingTurnDegrees = 0;
  if (Math.hypot(leftward[0], leftward[2]) > 1e-6) {
    const yaw = Math.atan2(-leftward[2], leftward[0]);
    // Snapped to quarter turns: a generator faces one axis, and a crooked shoulder line must not tilt the model.
    const turn = -Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
    facingTurnDegrees = Math.round((turn * 180) / Math.PI) || 0;
    if (facingTurnDegrees !== 0) {
      const scene = json.scenes?.[json.scene ?? 0];
      if (!scene?.nodes?.length) throw new VrmConversionError("invalid", "The 3D model has no scene to show.");
      // ponytail: a parent rotation, not baked into the vertices and bind matrices. three-vrm reads world-space
      // rest positions, so the Engine loads it; bake it if a stricter VRM reader (UniVRM) must open these files.
      nodes.push({
        name: "VRM_FacingRoot",
        rotation: [0, Math.sin(turn / 2), 0, Math.cos(turn / 2)],
        children: scene.nodes,
      });
      scene.nodes = [nodes.length - 1];
      json.nodes = nodes;
    }
  } else {
    warnings.push("The shoulders are at the same place, so the model's facing was left as it was.");
  }

  // ── Metal off: avatars have no reflections to show, so metal would draw almost black ──
  let metalMaterials = 0;
  for (const material of json.materials ?? []) {
    const pbr = (material.pbrMetallicRoughness ??= {});
    if (pbr.metallicFactor === 0) continue;
    pbr.metallicFactor = 0;
    metalMaterials += 1;
  }

  json.extensionsUsed = [...new Set([...extensionsUsed, "VRMC_vrm"])];
  json.extensions = {
    ...json.extensions,
    VRMC_vrm: { specVersion: "1.0", meta: vrmMeta(options.name), humanoid: { humanBones } },
  };
  json.asset = { ...json.asset, generator: `${json.asset?.generator ?? "unknown"} + Marinara Engine glb-to-vrm` };

  return {
    vrm: writeGlb(json, bin),
    report: {
      humanBones: Object.fromEntries(
        Object.entries(humanBones).map(([bone, { node }]) => [bone, nodes[node]?.name ?? ""]),
      ),
      unmappedJoints,
      heightMetres: height,
      hipsHeightRatio,
      armDropDegrees,
      armOutwardDegrees,
      facingTurnDegrees,
      metalMaterials,
      warnings,
    },
  };
}

// ── Textures ──

type Sharp = Awaited<ReturnType<typeof getSharp>>;
type TextureRole = "baseColor" | "metallicRoughness" | "normal" | "other";

/** The largest side each kind of texture keeps. The colour map carries the face the chat frames, so it keeps
 *  Tripo's 2048 pixels; the normal and metal maps drop to 1024, about a third of the GPU memory of the three
 *  2048 maps Tripo sends (roughly 64 MB with mipmaps) for no visible change at chat size. */
export const TEXTURE_MAX_SIDES: Readonly<Record<TextureRole, number>> = {
  baseColor: 2048,
  metallicRoughness: 1024,
  normal: 1024,
  other: 1024,
};

/** Which kind of texture each image is, from the materials that use it. */
function imageRoles(json: GltfJson): Map<number, TextureRole> {
  const roles = new Map<number, TextureRole>();
  const note = (texture: unknown, role: TextureRole) => {
    const index = (texture as { index?: unknown } | undefined)?.index;
    const image = typeof index === "number" ? json.textures?.[index]?.source : undefined;
    if (typeof image !== "number") return;
    const current = roles.get(image);
    // An image used two ways keeps the larger of the two sizes.
    if (!current || TEXTURE_MAX_SIDES[role] > TEXTURE_MAX_SIDES[current]) roles.set(image, role);
  };
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness;
    note(pbr?.baseColorTexture, "baseColor");
    note(pbr?.metallicRoughnessTexture, "metallicRoughness");
    note(material.normalTexture, "normal");
    note(material.occlusionTexture, "other");
    note(material.emissiveTexture, "other");
  }
  return roles;
}

/** Makes textures larger than TEXTURE_MAX_SIDES smaller (same format, same shape) and repacks the binary
 *  chunk. Without image processing (sharp on Lite or Termux) the file stays as it is, and so does a texture
 *  sharp can't read. */
export async function shrinkGlbTextures(
  glb: Uint8Array,
  loadSharp: () => Promise<Sharp>,
): Promise<{ glb: Buffer; resized: Array<{ image: number; from: number; to: number }>; skipped: boolean }> {
  const { json, bin } = parseGlb(glb);
  const unchanged = { glb: Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength), resized: [], skipped: false };
  const views = json.bufferViews ?? [];
  // Only a file whose every view sits inside its one binary chunk is repacked; anything else is left as it is.
  if (
    !json.images?.length ||
    (json.buffers?.length ?? 0) !== 1 ||
    views.some((view) => view.buffer !== 0 || (view.byteOffset ?? 0) + view.byteLength > bin.length)
  ) {
    return unchanged;
  }
  let sharp: Sharp;
  try {
    sharp = await loadSharp();
  } catch {
    return { ...unchanged, skipped: true };
  }
  const roles = imageRoles(json);
  // Per view: images sharing one view (rare) are resized once, to the largest size any of them keeps.
  const targets = new Map<number, { mimeType: string; limit: number; images: number[] }>();
  json.images.forEach((image, index) => {
    if (image.bufferView === undefined || !views[image.bufferView]) return;
    if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") return;
    const limit = TEXTURE_MAX_SIDES[roles.get(index) ?? "other"];
    const target = targets.get(image.bufferView);
    if (target) {
      target.limit = Math.max(target.limit, limit);
      target.images.push(index);
    } else targets.set(image.bufferView, { mimeType: image.mimeType, limit, images: [index] });
  });
  const replaced = new Map<number, Buffer>();
  const resized: Array<{ image: number; from: number; to: number }> = [];
  for (const [viewIndex, { mimeType, limit, images }] of targets) {
    const view = views[viewIndex]!;
    const start = view.byteOffset ?? 0;
    const bytes = bin.subarray(start, start + view.byteLength);
    let side: number;
    let smaller: Buffer;
    try {
      const { width = 0, height = 0 } = await sharp(bytes).metadata();
      side = Math.max(width, height);
      if (side <= limit) continue;
      const pipeline = sharp(bytes).resize({ width: limit, height: limit, fit: "inside" });
      smaller = await (
        mimeType === "image/png" ? pipeline.png({ compressionLevel: 9 }) : pipeline.jpeg({ quality: 90 })
      ).toBuffer();
    } catch {
      // Smaller textures are a saving, not a need: a picture sharp can't read stays as it is.
      continue;
    }
    replaced.set(viewIndex, smaller);
    for (const image of images) resized.push({ image, from: side, to: limit });
  }
  if (!replaced.size) return unchanged;
  // Every view is copied in order, each starting on a 4-byte boundary (accessors need their component size).
  const parts: Buffer[] = [];
  let offset = 0;
  views.forEach((view, index) => {
    const start = view.byteOffset ?? 0;
    const bytes = replaced.get(index) ?? bin.subarray(start, start + view.byteLength);
    const padded = pad4(bytes, 0);
    view.byteOffset = offset;
    view.byteLength = bytes.length;
    parts.push(padded);
    offset += padded.length;
  });
  json.buffers![0]!.byteLength = offset;
  return { glb: writeGlb(json, Buffer.concat(parts)), resized, skipped: false };
}
