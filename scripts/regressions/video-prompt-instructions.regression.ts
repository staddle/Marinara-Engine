// #7408: a video connection's Video Prompting Instructions are saved with the connection and reach the
// language model that writes video prompts (the Roleplay gallery animation director and Storyboard's
// image-aware shot planner), and a sentence of them the writer copied word for word is removed.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureDir = mkdtempSync(join(tmpdir(), "marinara-video-prompt-instructions-"));
process.env.DATA_DIR = fixtureDir;
process.env.FILE_STORAGE_DIR = join(fixtureDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { galleryRoutes } = await import("../../packages/server/src/routes/gallery.routes.js");
const { connectionsRoutes } = await import("../../packages/server/src/routes/connections.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createGalleryStorage } = await import("../../packages/server/src/services/storage/gallery.storage.js");
const { appendImagePromptInstructions } =
  await import("../../packages/server/src/services/generation/image-prompt-instructions.js");
const { buildStoryboardAnimationRefinementMessages, resolveStoryboardAnimationRefinement } =
  await import("../../packages/server/src/services/video/storyboard-animation-refinement.js");

const INSTRUCTIONS = "Describe one slow continuous dolly move and nothing else.";
const COPIED = /Describe one slow continuous dolly move/iu;
const BEAT = "Aster turns toward the window as rain streaks the glass";

let writerRequest = "";
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  writerRequest = JSON.stringify(JSON.parse(Buffer.concat(chunks).toString()).messages);
  response.setHeader("content-type", "application/json");
  // The director obeys the instructions but also echoes them.
  const content = JSON.stringify({ narrationBeat: `${BEAT}. ${INSTRUCTIONS}` });
  response.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { total_tokens: 20 },
    }),
  );
});

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(galleryRoutes, { prefix: "/api/gallery" });
await app.register(connectionsRoutes, { prefix: "/api/connections" });

try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const connections = createConnectionsStorage(db);

  // The field round-trips through create, the editor's update route and duplicate.
  const video = await connections.create({
    name: "Video fixture",
    provider: "video_generation",
    baseUrl: "http://127.0.0.1:1",
    model: "fixture-video",
    videoService: "comfyui",
    videoGenerationSource: "comfyui",
    apiKey: "fixture",
    videoPromptInstructions: INSTRUCTIONS,
  });
  assert.ok(video);
  assert.equal((await connections.getWithKey(video.id))?.videoPromptInstructions, INSTRUCTIONS);
  // The connection editor saves through PATCH /connections/:id, which must keep the field.
  const patch = (videoPromptInstructions: string | null) =>
    app.inject({ method: "PATCH", url: `/api/connections/${video.id}`, payload: { videoPromptInstructions } });
  const cleared = await patch(null);
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal((await connections.getWithKey(video.id))?.videoPromptInstructions, null);
  const saved = await patch(INSTRUCTIONS);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((saved.json() as { videoPromptInstructions?: string }).videoPromptInstructions, INSTRUCTIONS);
  assert.equal((await connections.getWithKey(video.id))?.videoPromptInstructions, INSTRUCTIONS);
  // Saving another field leaves the instructions alone.
  const renamed = await app.inject({
    method: "PATCH",
    url: `/api/connections/${video.id}`,
    payload: { name: "Video fixture (renamed)" },
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal((await connections.getWithKey(video.id))?.videoPromptInstructions, INSTRUCTIONS);
  const duplicated = await app.inject({ method: "POST", url: `/api/connections/${video.id}/duplicate` });
  assert.equal(duplicated.statusCode, 200, duplicated.body);
  const copyId = (duplicated.json() as { id: string }).id;
  assert.equal((await connections.getWithKey(copyId))?.videoPromptInstructions, INSTRUCTIONS);

  // Through the real gallery route, the Roleplay animation director gets the instructions next to its
  // request, and the prompt it returns no longer carries the sentence it copied.
  const text = await connections.create({
    name: "Text fixture",
    provider: "custom",
    baseUrl,
    model: "fixture",
    apiKey: "fixture",
  });
  const chats = createChatsStorage(db);
  const roleplay = await chats.create({ name: "Roleplay", mode: "roleplay", characterIds: [], connectionId: text.id });
  assert.ok(roleplay);
  await chats.patchMetadata(roleplay.id, { sceneVideoConnectionId: video.id });
  const image = await createGalleryStorage(db).create({
    chatId: roleplay.id,
    filePath: "fixture.png",
    prompt: "Aster by a rainy window",
  });
  assert.ok(image);

  const preview = async () => {
    writerRequest = "";
    const response = await app.inject({
      method: "POST",
      url: "/api/gallery/generate-scene-video/preview",
      payload: { chatId: roleplay.id, galleryImageId: image.id },
    });
    assert.equal(response.statusCode, 200, response.body);
    return (response.json() as { prompt: string }).prompt;
  };

  const guided = await preview();
  assert.match(writerRequest, /<video_prompting_instructions>[^<]*Describe one slow continuous dolly move/u);
  assert.doesNotMatch(guided, COPIED, guided);
  assert.match(guided, /Aster turns toward the window/u, guided);

  // Without instructions the director's request has no block (and the echo is left alone).
  await connections.update(video.id, { videoPromptInstructions: null });
  await preview();
  assert.doesNotMatch(writerRequest, /video_prompting_instructions/u);

  // Storyboard's image-aware shot planner gets the block after the (possibly custom) template.
  const motionIntent = "Aster turns | The camera holds";
  const [refinementMessage] = buildStoryboardAnimationRefinementMessages({
    templates: [{ id: "shot", name: "Shot", promptTemplate: "CUSTOM_SHOT ${motionIntent}" }],
    templateId: "shot",
    title: "Window",
    motionIntent,
    imagePrompt: "Aster by a rainy window",
    sourceSections: "Aster waits.",
    characters: ["Aster"],
    durationSeconds: 6,
    aspectRatio: "16:9",
    referenceImage: { base64: "cGl4ZWxz", mimeType: "image/png" },
    videoPromptInstructions: INSTRUCTIONS,
  });
  assert.match(
    refinementMessage?.content ?? "",
    /^CUSTOM_SHOT[\s\S]*<video_prompting_instructions>\n[^<]*Describe one slow continuous dolly move/u,
  );

  // A copied sentence inside a segment is removed and the segments survive.
  assert.deepEqual(
    resolveStoryboardAnimationRefinement(
      JSON.stringify({ classification: "suitable", narrationBeat: `Aster turns. ${INSTRUCTIONS} | The camera holds` }),
      motionIntent,
      [INSTRUCTIONS],
    ),
    { classification: "suitable", narrationBeat: "Aster turns. | The camera holds" },
  );
  // A segment that was only the copied sentence keeps the planner's beat instead of losing a segment.
  assert.deepEqual(
    resolveStoryboardAnimationRefinement(
      JSON.stringify({ classification: "suitable", narrationBeat: `Aster turns | ${INSTRUCTIONS}` }),
      motionIntent,
      [INSTRUCTIONS],
    ),
    { classification: "suitable", narrationBeat: `Aster turns | ${INSTRUCTIONS}` },
  );

  // The image block the shared helper builds is unchanged.
  assert.equal(
    appendImagePromptInstructions("PROMPT", " Use tags. "),
    "PROMPT\n\n<image_prompting_instructions>\nApply these image-backend instructions when writing the provider-ready prompt. They are instructions, not text to copy into the prompt:\nUse tags.\n</image_prompting_instructions>",
  );
  console.log("video-prompt-instructions regression passed");
} finally {
  await app.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await closeDB();
  rmSync(fixtureDir, { recursive: true, force: true });
}
