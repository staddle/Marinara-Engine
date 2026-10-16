/**
 * 2D avatars show the owner's sprites and imported pictures as they are: nothing the user already has is
 * background-removed or stored as a cut-out (faces without a background come from sprite generation, which
 * draws them on a plain colour and removes it). The maintainer reversed the cut-outs of #7623 on 2026-10-14.
 *   - there is no sprite cut-out route; the avatar shows the sprite file itself (resolveAvatarImage);
 *   - blink and talk pictures are drawn from the sprite as it is. From a sprite with a background, the drawn
 *     picture is kept, background and all, and saving stores the sprite itself as their base. From a
 *     see-through sprite they still take exactly its outline and keep its own edge pixels (no lighter or
 *     darker rim) while what the model drew inside stays, even where the outline's alpha is just short of
 *     solid;
 *   - a PNGTuber Plus costume drawn on a background of its own is stored as it is;
 *   - a mesh avatar is built from the sprite as it is;
 *   - the avatar's folder never gets a cut-out, and the sprite files stay byte for byte as they were;
 *   - avatarCutout, which cleans only the picture sent to Tripo for a 3D model, uses the AI remover when it
 *     is the configured engine and the built-in cleaner when it is missing, fails or is off (Lite, Termux);
 *   - saved avatar files are never rewritten when they load.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plusSave, plusSprite } from "./fixtures/avatar-2d-fixtures.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-avatar-backgrounds-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.IMAGE_LOCAL_URLS_ENABLED = "true";
process.env.LOG_LEVEL = "silent";
// No AI remover unless a test sets one up.
process.env.BACKGROUNDREMOVER_DISABLED = "true";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const AdmZip = requireServer("adm-zip");
const { getDB } = await import("../../packages/server/src/db/connection.js");
const { characterDataSchema } = await import("../../packages/shared/src/index.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { getSharp } = await import("../../packages/server/src/services/image/sharp-runtime.js");
const { avatarOwnerDir, readAvatarConfig, writeAvatarFiles, updateAvatarConfig } =
  await import("../../packages/server/src/services/avatars/storage.js");
const { avatarCutout } = await import("../../packages/server/src/services/avatars/cutouts.js");
const { applyAvatarSourceOutline, readAvatarSourceSprite } =
  await import("../../packages/server/src/services/avatars/generation/generation-context.js");
const { generatePngtuberVariants, savePngtuberVariants } =
  await import("../../packages/server/src/services/avatars/generation/pngtuber-variants.js");
const { generateMeshRig } = await import("../../packages/server/src/services/avatars/generation/mesh-rig.js");
const { pngtuberImporter } = await import("../../packages/server/src/services/avatars/formats/pngtuber.js");
const { avatarModelsRoutes } = await import("../../packages/server/src/routes/avatar-models.routes.js");
const sharp = await getSharp();

// ── Fixtures: a front-facing bust, on a flat background and see-through ──
const SKIN = "rgb(242,201,168)";
function bustSvg(background: string | null, mouthOpen = false) {
  const eye = (cx: number) =>
    `<ellipse cx="${cx}" cy="285" rx="30" ry="14" fill="#fff"/><circle cx="${cx}" cy="285" r="11" fill="rgb(59,109,179)"/>` +
    `<circle cx="${cx}" cy="285" r="5" fill="#111"/><path d="M${cx - 34} 284 Q${cx} 260 ${cx + 34} 284" stroke="#222" stroke-width="4" fill="none"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="720">
    ${background ? `<rect width="600" height="720" fill="${background}"/>` : ""}
    <rect x="120" y="540" width="360" height="200" rx="60" fill="#3a5fa0"/>
    <rect x="262" y="440" width="76" height="130" fill="${SKIN}"/>
    <ellipse cx="300" cy="250" rx="190" ry="210" fill="#5a3a22"/>
    <ellipse cx="300" cy="300" rx="130" ry="160" fill="${SKIN}"/>
    <rect x="220" y="240" width="62" height="8" rx="4" fill="#4a2f1c"/><rect x="318" y="240" width="62" height="8" rx="4" fill="#4a2f1c"/>
    ${eye(250)}${eye(350)}
    ${mouthOpen ? `<ellipse cx="300" cy="397" rx="18" ry="11" fill="#7a2a2a"/>` : `<path d="M275 395 Q300 400 325 395" stroke="#a04848" stroke-width="3" fill="none"/>`}
  </svg>`);
}
const opaqueBust = await sharp(bustSvg("#ffffff")).png().toBuffer();
const clearBust = await sharp(bustSvg(null)).png().toBuffer();
const goodLayout = {
  headBox: [110, 40, 490, 470],
  faceBox: [170, 140, 430, 460],
  eyes: [
    { opening: [321, 272, 379, 298], region: [310, 255, 390, 308] },
    { opening: [221, 272, 279, 298], region: [210, 255, 290, 308] },
  ],
  brows: [
    [318, 238, 380, 250],
    [220, 238, 282, 250],
  ],
  nose: [300, 340],
  mouth: { left: [275, 395], right: [325, 395], box: [272, 388, 328, 402] },
  neck: [300, 490],
};

async function rgba(png: Buffer) {
  return sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
async function alphaAt(png: Buffer, x: number, y: number) {
  const { data, info } = await rgba(png);
  return data[(y * info.width + x) * 4 + 3]!;
}
async function alphaChannel(png: Buffer) {
  return sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer();
}
/** Every pixel of the see-through sprite that isn't solid is the same in the picture, colour and all. */
async function assertSpriteEdge(png: Buffer, sprite: Buffer, what: string) {
  const [picture, outline] = [await rgba(png), await rgba(sprite)];
  let differing = 0;
  for (let i = 0; i < outline.data.length; i += 4) {
    if (outline.data[i + 3]! < 255 && picture.data.readUInt32LE(i) !== outline.data.readUInt32LE(i)) differing += 1;
  }
  assert.equal(differing, 0, `${what}: the edge is the sprite's own (no rim from the model's background)`);
}
async function pixelAt(png: Buffer, x: number, y: number) {
  const { data, info } = await rgba(png);
  return [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
}
/** The background around the bust is still there: white and solid. */
async function assertBackground(png: Buffer, what: string) {
  for (const [x, y] of [
    [2, 2],
    [597, 717],
    [40, 360],
  ] as const) {
    assert.deepEqual(await pixelAt(png, x, y), [255, 255, 255, 255], `${what}: the background at ${x},${y} stays`);
  }
}
/** The red mark the image model draws in the middle of the face. */
async function assertDrawnMark(png: Buffer, what: string) {
  const [red, green, blue, alpha] = await pixelAt(png, 300, 360);
  assert.ok(red! > 200 && green! < 60 && blue! < 60 && alpha === 255, `${what}: what the model drew shows`);
}
/** Corners and the face's middle: see-through around the bust, solid on it (avatarCutout's result). */
async function assertCutout(png: Buffer, what: string) {
  for (const [x, y] of [
    [2, 2],
    [597, 2],
    [2, 600],
    [597, 717],
    [40, 360],
  ] as const) {
    assert.equal(await alphaAt(png, x, y), 0, `${what}: the background at ${x},${y} is see-through`);
  }
  for (const [x, y] of [
    [300, 330],
    [300, 600],
    [250, 285],
  ] as const) {
    assert.equal(await alphaAt(png, x, y), 255, `${what}: the bust at ${x},${y} stays solid`);
  }
}
const dataUrlPng = (url: string) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

// ── Providers: an image model and a vision model on one local server ──
let imageMode: "fill-background" | "see-through" = "fill-background";
let imageRequests = 0;
let lastSent: Buffer | null = null;
// A red square in the middle of the canvas: the middle of the face, around 300,360 on the sprite.
const mark = await sharp({ create: { width: 60, height: 60, channels: 4, background: "#ff0000" } })
  .png()
  .toBuffer();
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  response.setHeader("content-type", "application/json");
  if (request.url?.endsWith("/chat/completions")) {
    response.end(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(goodLayout) } }] }),
    );
    return;
  }
  imageRequests += 1;
  // An edit that keeps the picture where it is (the canvas GPT Image 1 is asked for, for a 600x720 sprite)
  // and marks the middle of the face, with the background filled in white like most image models, or with
  // the white left see-through.
  const start = body.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const sent = body.subarray(start, body.indexOf(Buffer.from("IEND"), start) + 8);
  lastSent = Buffer.from(sent);
  let picture = sharp(sent).resize(1024, 1536, { fit: "cover" });
  if (imageMode === "fill-background") picture = picture.flatten({ background: "#ffffff" });
  else picture = picture.unflatten();
  const drawn = await sharp(await picture.png().toBuffer())
    .composite([{ input: mark, left: 482, top: 738 }])
    .png()
    .toBuffer();
  response.end(JSON.stringify({ data: [{ b64_json: drawn.toString("base64") }] }));
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

const db = await getDB();
const character = await createCharactersStorage(db).create(
  characterDataSchema.parse({ name: "Ann", description: "x" }),
);
const owner = { ownerType: "character" as const, ownerId: character!.id };
const connections = createConnectionsStorage(db);
const image = await connections.create({
  name: "Image fixture",
  provider: "image_generation",
  baseUrl: providerUrl,
  model: "gpt-image-1",
  imageService: "openai",
  imageGenerationSource: "openai",
  apiKey: "fixture",
});
const vision = await connections.create({
  name: "Vision fixture",
  provider: "custom",
  baseUrl: providerUrl,
  model: "vision",
  apiKey: "fixture",
});
const spriteDir = join(dataDir, "sprites", owner.ownerId);
mkdirSync(spriteDir, { recursive: true });
writeFileSync(join(spriteDir, "neutral.png"), opaqueBust);
writeFileSync(join(spriteDir, "clear.png"), clearBust);
const folder = join(avatarOwnerDir(owner), "pngtuber");
const app = Fastify();
app.decorate("db", db);
await app.register(avatarModelsRoutes, { prefix: "/api/avatar-models" });
await app.ready();
/** No avatar file is a cut-out of a sprite. */
function assertNoCutouts(what: string) {
  const stored = existsSync(folder) ? readdirSync(folder) : [];
  assert.deepEqual(
    stored.filter((name) => name.startsWith("cutout-")),
    [],
    `${what}: no cut-out is stored in the avatar's folder`,
  );
}

try {
  // ── No cut-out route: the avatar shows the sprite file itself ──
  {
    const route = await app.inject({
      method: "GET",
      url: `/api/avatar-models/character/${owner.ownerId}/sprite-cutouts/neutral?v=1`,
    });
    assert.equal(route.statusCode, 404, "there is no sprite cut-out route");
  }

  // ── avatarCutout (Tripo's picture only): the AI remover when configured, the built-in cleaner without it ──
  {
    const lite = await avatarCutout(opaqueBust);
    assert.equal(lite.cleaned, true);
    await assertCutout(lite.png, "the built-in cleaner (no AI remover, as on Lite and Termux)");
    if (process.platform !== "win32") {
      const tools = mkdtempSync(join(tmpdir(), "marinara-fake-bgrem-"));
      const marker = join(tools, "ran");
      const fake = join(tools, "backgroundremover");
      // Called as `backgroundremover -i <in> -o <out>`; answers with the bust's true cut-out.
      writeFileSync(join(tools, "answer.png"), clearBust);
      writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\ncp "${join(tools, "answer.png")}" "$4"\n`);
      chmodSync(fake, 0o755);
      const failing = join(tools, "broken");
      writeFileSync(failing, "#!/bin/sh\nexit 3\n");
      chmodSync(failing, 0o755);
      const savedPath = process.env.PATH;
      delete process.env.BACKGROUNDREMOVER_DISABLED;
      process.env.SPRITE_BACKGROUND_REMOVAL_ENGINE = "backgroundremover";
      try {
        process.env.BACKGROUNDREMOVER_COMMAND = fake;
        const ai = await avatarCutout(opaqueBust);
        assert.ok(existsSync(marker), "the AI remover runs when it is the configured engine");
        await assertCutout(ai.png, "the AI remover's cut-out");
        process.env.BACKGROUNDREMOVER_COMMAND = failing;
        await assertCutout((await avatarCutout(opaqueBust)).png, "a failing AI remover falls back to the built-in");
        delete process.env.BACKGROUNDREMOVER_COMMAND;
        const empty = join(tools, "empty");
        mkdirSync(empty);
        process.env.PATH = empty; // and none on PATH
        await assertCutout((await avatarCutout(opaqueBust)).png, "a missing AI remover falls back to the built-in");
      } finally {
        process.env.PATH = savedPath;
        delete process.env.SPRITE_BACKGROUND_REMOVAL_ENGINE;
        delete process.env.BACKGROUNDREMOVER_COMMAND;
        process.env.BACKGROUNDREMOVER_DISABLED = "true";
        rmSync(tools, { recursive: true, force: true });
      }
    }
  }

  // ── PNGTuber blink and talk pictures from the sprite with a background ──
  {
    const sprite = await readAvatarSourceSprite(owner.ownerId, "neutral");
    imageMode = "fill-background";
    const response = await generatePngtuberVariants(db, {
      owner,
      labels: ["neutral"],
      variants: ["eyes-closed", "mouth-open"],
      connectionId: image.id,
    });
    assert.equal(response.drafts.length, 2, response.failed.map((entry) => entry.error).join("; "));
    assert.deepEqual(await pixelAt(lastSent!, 2, 2), [255, 255, 255, 255], "the model sees the sprite as it is");
    for (const draft of response.drafts) {
      const png = dataUrlPng(draft.image);
      await assertBackground(png, `a ${draft.variant} picture`);
      await assertDrawnMark(png, `a ${draft.variant} picture`);
    }
    assert.deepEqual(existsSync(folder) ? readdirSync(folder) : [], [], "drawing stores nothing, not even a cut-out");
    const saved = await savePngtuberVariants({
      owner,
      images: response.drafts.map(({ label, variant, image, sourceHash }) => ({ label, variant, image, sourceHash })),
    });
    const layers = saved.config.kinds.pngtuber!.layers.neutral!;
    const file = (ref: { source: string } | undefined) =>
      readFileSync(join(avatarOwnerDir(owner), (ref as { path: string }).path));
    assert.deepEqual(file(layers.base), sprite.png, "the saved base is the sprite itself");
    for (const [ref, draft] of [
      [layers.eyesClosed, response.drafts.find((entry) => entry.variant === "eyes-closed")!],
      [layers.mouthOpen, response.drafts.find((entry) => entry.variant === "mouth-open")!],
    ] as const) {
      assert.deepEqual(
        (await rgba(file(ref))).data,
        (await rgba(dataUrlPng(draft.image))).data,
        "a saved blink or talk picture is the drawn picture as it is",
      );
    }
    assertNoCutouts("after saving");
    assert.deepEqual(readFileSync(join(spriteDir, "neutral.png")), opaqueBust, "the sprite is untouched");
  }

  // ── PNGTuber blink and talk pictures from a see-through sprite: its outline ──
  {
    for (const mode of ["fill-background", "see-through"] as const) {
      imageMode = mode;
      const own = await generatePngtuberVariants(db, {
        owner,
        labels: ["clear"],
        variants: ["eyes-closed"],
        connectionId: image.id,
      });
      const png = dataUrlPng(own.drafts[0]!.image);
      const what = `a picture from a see-through sprite when the model ${mode === "fill-background" ? "fills the background" : "leaves it see-through"}`;
      assert.deepEqual(await alphaChannel(png), await alphaChannel(clearBust), `${what}: it has the sprite's outline`);
      await assertSpriteEdge(png, clearBust, what);
      await assertDrawnMark(png, what);
    }
    assert.deepEqual(readFileSync(join(spriteDir, "clear.png")), clearBust, "the sprite is untouched");

    // A sprite whose alpha is just short of solid inside the face (an AI remover's mask): what the model drew
    // there stays.
    const { data, info } = await rgba(clearBust);
    for (let i = 3; i < data.length; i += 4) if (data[i] === 255) data[i] = 250;
    const softCut = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png()
      .toBuffer();
    const softSource = { ...(await readAvatarSourceSprite(owner.ownerId, "clear")), png: softCut };
    const marked = await sharp(opaqueBust)
      .composite([{ input: mark, left: 270, top: 330 }])
      .png()
      .toBuffer();
    const outlined = await applyAvatarSourceOutline(marked, softSource);
    assert.deepEqual((await pixelAt(outlined, 300, 360)).slice(0, 3), [255, 0, 0], "the drawn mark stays");
    assert.deepEqual(await alphaChannel(outlined), await alphaChannel(softCut), "with the sprite's alpha");
    const [after, before] = [await rgba(outlined), await rgba(softCut)];
    let rim = 0;
    for (let i = 0; i < before.data.length; i += 4) {
      if (before.data[i + 3]! < 250 && after.data.readUInt32LE(i) !== before.data.readUInt32LE(i)) rim += 1;
    }
    assert.equal(rim, 0, "and its own edge");

    // Saving keeps the kept picture exactly. It already has the sprite's outline; giving it the outline again
    // lays it over the sprite once more, and inside a soft mask the open eyes would show through the blink.
    const { data: softer } = await rgba(clearBust);
    for (let i = 3; i < softer.length; i += 4) if (softer[i] === 255) softer[i] = 200;
    writeFileSync(
      join(spriteDir, "soft.png"),
      await sharp(softer, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toBuffer(),
    );
    imageMode = "fill-background";
    const softDrafts = await generatePngtuberVariants(db, {
      owner,
      labels: ["soft"],
      variants: ["eyes-closed"],
      connectionId: image.id,
    });
    const softDraft = softDrafts.drafts[0]!;
    const softSaved = await savePngtuberVariants({
      owner,
      images: [
        { label: "soft", variant: "eyes-closed", image: softDraft.image, sourceHash: softDraft.sourceHash },
      ],
    });
    const blink = softSaved.config.kinds.pngtuber!.layers.soft!.eyesClosed as { path: string };
    assert.deepEqual(
      (await rgba(readFileSync(join(avatarOwnerDir(owner), blink.path)))).data,
      (await rgba(dataUrlPng(softDraft.image))).data,
      "a saved picture from a see-through sprite is the kept picture as it is",
    );
  }

  // ── A PNGTuber Plus costume drawn on a background ──
  {
    const backdrop = await sharp({ create: { width: 600, height: 720, channels: 4, background: "#ffffff" } })
      .png()
      .toBuffer();
    const talkMouth = await sharp(bustSvg(null, true))
      .extract({ left: 260, top: 380, width: 80, height: 40 })
      .png()
      .toBuffer();
    const save = plusSave([
      plusSprite(1, backdrop, { zindex: -1 }),
      plusSprite(2, clearBust),
      // The open mouth shows only while talking, over the closed one.
      plusSprite(3, talkMouth, { pos: "Vector2(0, 40)", showTalk: 2, zindex: 1 }),
    ]);
    const input = { owner, filename: "avatar.save", bytes: save };
    const imported = await pngtuberImporter.extract(await pngtuberImporter.validate(input), input);
    const files = new Map(imported.files.map((entry) => [entry.path, Buffer.from(entry.bytes)]));
    const set = imported.data.layers.costume_1!;
    const base = files.get((set.base as { path: string }).path)!;
    const talk = files.get((set.mouthOpen as { path: string }).path)!;
    await assertBackground(base, "an imported costume drawn on a background");
    await assertBackground(talk, "its talk picture");
    const [baseRaw, talkRaw] = [await rgba(base), await rgba(talk)];
    let differing = 0;
    for (let i = 0; i < baseRaw.data.length; i += 4) {
      const x = (i / 4) % baseRaw.info.width;
      const y = Math.floor(i / 4 / baseRaw.info.width);
      const inMouth = x >= 255 && x <= 345 && y >= 375 && y <= 425;
      if (!inMouth && baseRaw.data.readUInt32LE(i) !== talkRaw.data.readUInt32LE(i)) differing += 1;
    }
    assert.equal(differing, 0, "outside what talking changes, the talk picture is the base exactly");
    const [red, green] = await pixelAt(talk, 300, 397);
    assert.ok(red! > 100 && green! < 60, "the open mouth shows");
  }

  // ── A mesh avatar from the sprite with a background ──
  {
    const draft = await generateMeshRig(db, { owner, sourceLabel: "neutral", connectionId: vision.id });
    const zip = new AdmZip(Buffer.from(draft.archive, "base64"));
    const basePicture = zip.getEntry("built/base.png")!.getData() as Buffer;
    await assertBackground(basePicture, "the mesh avatar's base picture");
    const meta = await sharp(basePicture).metadata();
    assert.deepEqual([meta.width, meta.height], [600, 720]);
    assert.deepEqual(readFileSync(join(spriteDir, "neutral.png")), opaqueBust, "the sprite is untouched");
    assertNoCutouts("after the mesh avatar");
  }

  // ── Saved files stay as saved ──
  {
    // A saved PNGTuber picture with a background is shown as saved, never rewritten.
    await writeAvatarFiles(owner, [{ path: "pngtuber/old-base.png", bytes: opaqueBust }]);
    await updateAvatarConfig(owner, (current) => ({
      ...current!,
      kinds: {
        ...current!.kinds,
        pngtuber: {
          ...current!.kinds.pngtuber!,
          layers: { old: { base: { source: "file", path: "pngtuber/old-base.png" } } },
        },
      },
    }));
    const before = readFileSync(join(folder, "old-base.png"));
    const served = await app.inject({
      method: "GET",
      url: `/api/avatar-models/character/${owner.ownerId}/files/pngtuber/old-base.png`,
    });
    assert.equal(served.statusCode, 200);
    await readAvatarConfig(owner);
    assert.deepEqual(readFileSync(join(folder, "old-base.png")), before, "loading a saved avatar rewrites nothing");
  }
} finally {
  await app.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}
assert.ok(imageRequests > 0);
console.log("avatar backgrounds regression passed");
