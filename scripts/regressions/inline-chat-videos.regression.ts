// Generated scene videos play inline: through the real gallery route, with a fake text model and a fake
// ComfyUI, the finished video is attached to the newest reply the user can see (whichever reply its picture
// came from, and never in Game Mode), a video attachment never reaches a model prompt as an image or a
// readable file, and attaching one does not change Advanced Memory's history fingerprint.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureDir = mkdtempSync(join(tmpdir(), "marinara-inline-chat-videos-"));
process.env.DATA_DIR = fixtureDir;
process.env.FILE_STORAGE_DIR = join(fixtureDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { galleryRoutes } = await import("../../packages/server/src/routes/gallery.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createGalleryStorage } = await import("../../packages/server/src/services/storage/gallery.storage.js");
const { resolveChatVideoAnchor } = await import("../../packages/server/src/services/video/chat-video-messages.js");
const { advancedMemorySourceFingerprint } = await import("../../packages/server/src/services/advanced-memory.js");
const { extractImageAttachmentDataUrls, extractFileAttachmentInputs, buildReadableAttachmentBlocks } =
  await import("../../packages/server/src/services/generation/prompt-attachments.js");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);

// One local server plays both the text model (director) and ComfyUI.
const comfyPrompts: string[] = [];
// Runs when a video job starts, to change the chat while the clip is being made.
let duringGeneration: (() => Promise<void>) | null = null;
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const url = request.url ?? "";
  if (url.endsWith("/prompt")) {
    comfyPrompts.push(Buffer.concat(chunks).toString());
    await duringGeneration?.();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ prompt_id: "job-1" }));
    return;
  }
  if (url.includes("/history/")) {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        "job-1": {
          status: { completed: true, status_str: "success" },
          outputs: { "9": { gifs: [{ filename: "clip.mp4", subfolder: "", type: "output" }] } },
        },
      }),
    );
    return;
  }
  if (url.startsWith("/view")) {
    response.setHeader("content-type", "video/mp4");
    response.end(mp4);
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: JSON.stringify({ narrationBeat: "Aster lifts the lantern" }) },
          finish_reason: "stop",
        },
      ],
      usage: { total_tokens: 20 },
    }),
  );
});

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(galleryRoutes, { prefix: "/api/gallery" });

try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const connections = createConnectionsStorage(db);
  const text = await connections.create({
    name: "Text fixture",
    provider: "custom",
    baseUrl: `${baseUrl}/v1`,
    model: "fixture",
    apiKey: "fixture",
  });
  const video = await connections.create({
    name: "ComfyUI video fixture",
    provider: "video_generation",
    baseUrl,
    model: "fixture-video",
    videoService: "comfyui",
    videoGenerationSource: "comfyui",
    comfyuiWorkflow: JSON.stringify({ "1": { inputs: { text: "%prompt%", image: "%reference_image%" } } }),
    apiKey: "",
  });

  const chats = createChatsStorage(db);
  const gallery = createGalleryStorage(db);
  const roleplay = await chats.create({ name: "Roleplay", mode: "roleplay", characterIds: [], connectionId: text.id });
  assert.ok(roleplay);
  await chats.patchMetadata(roleplay.id, { sceneVideoConnectionId: video.id });
  mkdirSync(join(fixtureDir, "gallery", roleplay.id), { recursive: true });
  writeFileSync(join(fixtureDir, "gallery", roleplay.id, "lantern.png"), png);
  const image = await gallery.create({
    chatId: roleplay.id,
    filePath: `${roleplay.id}/lantern.png`,
    prompt: "A lantern",
  });
  assert.ok(image);

  // The source message shows the image; the clip still joins the newest reply, where the user is.
  const source = await chats.createMessage({
    chatId: roleplay.id,
    role: "assistant",
    characterId: null,
    content: "Aster finds a lantern.",
    extra: { attachments: [{ type: "image", url: "/api/gallery/file/x/lantern.png", galleryId: image.id }] },
  });
  const later = await chats.createMessage({
    chatId: roleplay.id,
    role: "assistant",
    characterId: null,
    content: "The night goes on.",
  });
  assert.ok(source && later);

  const generate = async (payload: Record<string, unknown>) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/gallery/generate-scene-video",
      payload: { chatId: roleplay.id, ...payload },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { video: { id: string; url: string }; messageId: string | null };
  };
  const videoAttachments = async (messageId: string) => {
    const message = await chats.getMessage(messageId);
    const extra = typeof message?.extra === "string" ? JSON.parse(message.extra) : (message?.extra ?? {});
    const swipes = await chats.getSwipes(messageId);
    const swipeExtra = swipes[0]?.extra;
    const parsedSwipe = typeof swipeExtra === "string" ? JSON.parse(swipeExtra) : (swipeExtra ?? {});
    const pick = (record: { attachments?: Array<{ type?: string }> }) =>
      (record.attachments ?? []).filter((attachment) => attachment.type === "video");
    return { message: pick(extra), swipe: pick(parsedSwipe) };
  };

  // Animating the image attaches the video to the newest reply, on the message and its swipe.
  // A clip landing on the newest reply mid-send must not look like a history change to Advanced Memory.
  const fingerprintBefore = advancedMemorySourceFingerprint(await chats.listMessages(roleplay.id));
  const first = await generate({ galleryImageId: image.id });
  assert.equal(
    advancedMemorySourceFingerprint(await chats.listMessages(roleplay.id)),
    fingerprintBefore,
    "adding a clip leaves the memory fingerprint unchanged",
  );
  assert.equal(first.messageId, later.id);
  assert.equal((await videoAttachments(source.id)).message.length, 0, "not under the older picture's message");
  const onSource = await videoAttachments(later.id);
  assert.equal(onSource.message.length, 1);
  assert.equal(onSource.swipe.length, 1);
  assert.deepEqual(
    { ...onSource.message[0], url: undefined },
    {
      type: "video",
      url: undefined,
      filename: first.video.url.split("/").pop(),
      prompt: (onSource.message[0] as { prompt?: string }).prompt,
      videoId: first.video.id,
      durationSeconds: (onSource.message[0] as { durationSeconds?: number }).durationSeconds,
      aspectRatio: (onSource.message[0] as { aspectRatio?: string }).aspectRatio,
    },
  );
  assert.equal((onSource.message[0] as { url?: string }).url, first.video.url);
  assert.match(comfyPrompts[0] ?? "", /Aster lifts the lantern/u);

  // An image no message shows also goes to the newest reply.
  writeFileSync(join(fixtureDir, "gallery", roleplay.id, "loose.png"), png);
  const loose = await gallery.create({ chatId: roleplay.id, filePath: `${roleplay.id}/loose.png`, prompt: "Loose" });
  assert.ok(loose);
  const second = await generate({ galleryImageId: loose.id });
  assert.equal(second.messageId, later.id);
  assert.equal((await videoAttachments(later.id)).message.length, 2);

  // A reply that arrives while the clip is being made gets it: the newest reply is chosen after generating.
  let arrived: { id: string } | null = null;
  duringGeneration = async () => {
    arrived = await chats.createMessage({
      chatId: roleplay.id,
      role: "assistant",
      characterId: null,
      content: "Meanwhile, the storm breaks.",
    });
  };
  const third = await generate({ galleryImageId: loose.id });
  duringGeneration = null;
  assert.ok(arrived);
  assert.equal(third.messageId, (arrived as { id: string }).id);
  assert.equal((await videoAttachments((arrived as { id: string }).id)).message.length, 1);

  // Game Mode is unchanged: its clip stays in the gallery and no message gets it.
  const game = await chats.create({ name: "Game", mode: "game", characterIds: [], connectionId: text.id });
  assert.ok(game);
  await chats.patchMetadata(game.id, { sceneVideoConnectionId: video.id });
  mkdirSync(join(fixtureDir, "gallery", game.id), { recursive: true });
  writeFileSync(join(fixtureDir, "gallery", game.id, "map.png"), png);
  const gameImage = await gallery.create({ chatId: game.id, filePath: `${game.id}/map.png`, prompt: "A map" });
  const gameTurn = await chats.createMessage({
    chatId: game.id,
    role: "assistant",
    characterId: null,
    content: "The party unrolls the map.",
  });
  assert.ok(gameImage && gameTurn);
  const gameClip = await generate({ chatId: game.id, galleryImageId: gameImage.id });
  assert.equal(gameClip.messageId, null, "a Game clip is not attached to a message");
  assert.equal((await videoAttachments(gameTurn.id)).message.length, 0);

  // The newest reply's shown swipe gets the clip.
  assert.deepEqual(
    resolveChatVideoAnchor([
      { id: "old", role: "assistant", activeSwipeIndex: 0 },
      { id: "reply", role: "assistant", activeSwipeIndex: 1 },
      { id: "you", role: "user" },
    ]),
    { messageId: "reply", swipeIndex: 1 },
  );
  assert.equal(resolveChatVideoAnchor([{ id: "you", role: "user" }]), null, "no reply yet: Gallery only");
  // A hidden command-only reply is never shown, so the clip goes to the newest reply the user can see.
  assert.deepEqual(
    resolveChatVideoAnchor([
      { id: "shown", role: "assistant", activeSwipeIndex: 0 },
      { id: "hidden", role: "assistant", activeSwipeIndex: 0, extra: JSON.stringify({ hiddenFromUser: true }) },
    ]),
    { messageId: "shown", swipeIndex: 0 },
  );
  assert.equal(
    resolveChatVideoAnchor([{ id: "hidden", role: "assistant", extra: { hiddenFromUser: true } }]),
    null,
    "only hidden replies: Gallery only",
  );

  // A video attachment is never an image, a provider file, or readable text for a model prompt.
  const attachment = { type: "video", url: first.video.url, filename: "clip.mp4", prompt: "Aster lifts the lantern" };
  assert.deepEqual(extractImageAttachmentDataUrls([attachment]), []);
  assert.deepEqual(extractFileAttachmentInputs([attachment]), []);
  assert.deepEqual(buildReadableAttachmentBlocks([attachment]), []);
  console.log("inline-chat-videos regression passed");
} finally {
  await app.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await closeDB();
  rmSync(fixtureDir, { recursive: true, force: true });
}
