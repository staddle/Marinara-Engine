// Synthetic 2D avatar fixtures, drawn in code (no artwork, nothing to license): a tiny mesh avatar that
// passes mesh-avatar 0.1.1's own validation and renders, and PNGTuber Plus save records.
import { createRequire } from "node:module";

const requireFromServer = createRequire(new URL("../../../packages/server/package.json", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sharp: any = requireFromServer("sharp");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AdmZip: any = requireFromServer("adm-zip");

type Paint = (x: number, y: number) => [number, number, number, number];

/** A PNG painted pixel by pixel. */
export async function paintPng(width: number, height: number, paint: Paint): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(paint(x, y), (y * width + x) * 4);
  }
  return sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

/** PNGTuber Plus's own default avatar, `autoload/defaultAvatar.save` from
 *  https://github.com/kaiakairos/PNGTuber-Plus at ece4ffd123e19d7b187d13253208cdcfbd6713a1 (The Unlicense,
 *  public domain; sha256 4a57a933…f0d9ee). A real save as PNGTuber Plus writes it. */
export const PNGTUBER_PLUS_DEFAULT_SAVE = new URL("./pngtuber-plus-default-avatar.save", import.meta.url);

export const solid =
  (r: number, g: number, b: number, a = 255): Paint =>
  () => [r, g, b, a];

const WIDTH = 128;
const HEIGHT = 160;
const ellipse = (cx: number, cy: number, rx: number, ry: number) => ({ cx, cy, rx, ry });
const eye = (x0: number, x1: number) => ({
  opening: [
    [x0, 56],
    [(x0 + x1) / 2, 52],
    [x1, 56],
    [(x0 + x1) / 2, 60],
  ],
  roi: [
    [x0 - 2, 50],
    [x1 + 2, 50],
    [x1 + 2, 62],
    [x0 - 2, 62],
  ],
  x0,
  x1,
  top: Array.from({ length: 24 }, () => 53),
  bot: Array.from({ length: 24 }, () => 59),
});
const EYES = [eye(42, 58), eye(70, 86)];

export const MESH_AVATAR_RIG = {
  version: 1,
  image: { width: WIDTH, height: HEIGHT },
  head: {
    ...ellipse(64, 60, 40, 45),
    shiftX: 0,
    shiftY: 0,
    pivotX: 64,
    pivotY: 100,
    maxRoll: 8,
    weightBand: [0.2, 0.8],
    turnBand: [0.2, 0.8],
  },
  body: {
    pivotX: 64,
    pivotY: 150,
    maxRoll: 3,
    breathBand: [100, 160],
    rollBand: [100, 160],
    chest: ellipse(64, 130, 30, 20),
    shoulders: [ellipse(40, 120, 10, 8), ellipse(88, 120, 10, 8)],
  },
  face: {
    nose: ellipse(64, 66, 4, 4),
    mouth: ellipse(64, 80, 10, 4),
    eyeA: ellipse(50, 56, 8, 5),
    eyeB: ellipse(78, 56, 8, 5),
    earL: ellipse(25, 60, 5, 8),
    earR: ellipse(103, 60, 5, 8),
    brow: { ...ellipse(64, 45, 25, 5), band: [40, 50] },
    jaw: { ...ellipse(64, 95, 30, 10), band: [85, 105] },
  },
  eyes: EYES,
  mouth: { cx: 64, cy: 80, angle: 0, halfLen: 8, bow: 0.1, area: { ...ellipse(64, 80, 12, 6), angle: 0 } },
  cheeks: [
    [48, 72],
    [80, 72],
  ],
  mesh: {
    baseCell: 16,
    fine: { x0: 32, x1: 96, y0: 40, y1: 100, cell: 8 },
    handCell: 8,
    tasselCell: 8,
    eyeBallCell: 4,
    eyeCell: 4,
    spriteCell: 4,
  },
  view: { padTop: 0.05, padSide: 0.05 },
};

const EYE_RECTS = Object.fromEntries(
  [0, 1].flatMap((index) =>
    ["ball", "low", "crease", "lash"].map((part) => [`eye${index}_${part}`, [index === 0 ? 40 : 68, 50, 20, 12]]),
  ),
);

/** Every file of a version 1 mesh avatar, by archive path. `sprites` adds drawn mouth and closed-eye shapes. */
export async function meshAvatarFiles(options: { sprites?: boolean } = {}): Promise<Map<string, Buffer>> {
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  const face: Paint = (x, y) =>
    ((x - 64) / 40) ** 2 + ((y - 60) / 45) ** 2 <= 1
      ? [240, 200, 170, 255]
      : y > 110
        ? [70, 110, 160, 255]
        : [0, 0, 0, 0];
  const files = new Map<string, Buffer>([
    ["avatar.json", json({ format: "mesh-avatar", version: 1, name: "Fixture", license: "CC0-1.0" })],
    ["rig.json", json(MESH_AVATAR_RIG)],
    [
      "built/layers.json",
      json({
        version: 1,
        build: "fixture",
        size: [WIDTH, HEIGHT],
        layers: EYE_RECTS,
        eyes: EYES.map(({ x0, x1, top, bot }) => ({ x0, x1, top, bot })),
      }),
    ],
    ["built/base.png", await paintPng(WIDTH, HEIGHT, face)],
    ["built/hairmask.png", await paintPng(WIDTH, HEIGHT, solid(0, 0, 0))],
  ]);
  for (const name of Object.keys(EYE_RECTS)) {
    files.set(
      `built/${name}.png`,
      await paintPng(20, 12, name.endsWith("ball") ? solid(40, 40, 60) : solid(20, 20, 20)),
    );
  }
  if (options.sprites) {
    const sprites = { mouth_a: [56, 76, 16, 8], eyes_closed_0: [40, 50, 20, 12], eyes_closed_1: [68, 50, 20, 12] };
    files.set("built/sprites/sprites.json", json({ version: 1, build: "fixture", layers: sprites }));
    for (const [name, [, , width, height]] of Object.entries(sprites)) {
      files.set(`built/sprites/${name}.png`, await paintPng(width!, height!, solid(150, 40, 60)));
    }
  }
  return files;
}

/** Packs files as a ZIP; `deflate` compresses them, as a re-zipped archive would be. */
export function zipFiles(files: ReadonlyMap<string, Buffer>, options: { deflate?: boolean } = {}): Buffer {
  const zip = new AdmZip();
  for (const [name, bytes] of files) zip.addFile(name, bytes);
  if (!options.deflate) for (const entry of zip.getEntries()) entry.header.method = 0;
  return zip.toBuffer();
}

/** One PNGTuber Plus sprite record as PNGTuber Plus writes it (main_scenes/main.gd save). */
export function plusSprite(
  id: number,
  png: Buffer | null,
  fields: Partial<{
    parentId: number | null;
    path: string;
    pos: string;
    offset: string;
    zindex: number;
    showTalk: number;
    showBlink: number;
    costumeLayers: string;
    frames: number;
    clipped: boolean;
  }> = {},
): Record<string, unknown> {
  return {
    animSpeed: 0,
    clipped: false,
    costumeLayers: "[1, 1, 1, 1, 1, 1, 1, 1, 1, 1]",
    drag: 0,
    frames: 1,
    identification: id,
    ignoreBounce: false,
    ...(png ? { imageData: png.toString("base64") } : {}),
    offset: "Vector2(0, 0)",
    parentId: null,
    path: `C:/avatar/sprite-${id}.png`,
    pos: "Vector2(0, 0)",
    rLimitMax: 180,
    rLimitMin: -180,
    rotDrag: 0,
    showBlink: 0,
    showTalk: 0,
    stretchAmount: 0,
    toggle: "null",
    type: "sprite",
    xAmp: 0,
    xFrq: 0,
    yAmp: 0,
    yFrq: 0,
    zindex: 0,
    ...fields,
  };
}

/** A `.save` file's bytes from sprite records, keyed "0", "1", ... like PNGTuber Plus. */
export function plusSave(sprites: Record<string, unknown>[]): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(Object.fromEntries(sprites.map((sprite, index) => [String(index), sprite]))),
  );
}
