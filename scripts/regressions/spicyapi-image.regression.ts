import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_GENERATION_SOURCES, inferImageSource } from "../../packages/shared/src/constants/model-lists.js";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { logger } from "../../packages/server/src/lib/logger.js";
import { connectionsRoutes } from "../../packages/server/src/routes/connections.routes.js";
import { createConnectionsStorage } from "../../packages/server/src/services/storage/connections.storage.js";
import { generateImage } from "../../packages/server/src/services/image/image-generation.js";
import { resolveConnectionImageDefaults } from "../../packages/server/src/services/image/image-generation-defaults.js";
import { buildSpicyApiUrl } from "../../packages/server/src/services/image/spicyapi-image.js";
import { getSharp } from "../../packages/server/src/utils/sharp.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const key = "sk-spicy-fixture-key";
const schemas: Record<string, unknown> = {
  "alibaba/z-image-spicy-pro/text-to-image": {
    properties: {
      prompt: {},
      width: { minimum: 256, maximum: 2560, multipleOf: 16 },
      height: { minimum: 256, maximum: 2560, multipleOf: 16 },
    },
  },
  "bytedance/seedream-5.0-pro/text-to-image": {
    properties: { prompt: {}, aspect_ratio: { enum: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4"] } },
  },
  "acme/sized/edit": {
    properties: {
      prompt: {},
      negative_prompt: {},
      size: { enum: ["1024*1024", "2048*2048", "1344*768", "768*1344"] },
      image_urls: { maxItems: 1 },
    },
  },
  "acme/multi/edit": { properties: { prompt: {}, image_urls: { maxItems: 10 } } },
};
type Seen = { method: string; url: string; authorization?: string; idempotency?: string; body: any };
const requests: Seen[] = [];
let baseUrl = "";
let mode = "sync";
let polls = 0;
let creates = 0;
const envelope = (data: unknown, code = 200, msg = "success") => JSON.stringify({ code, msg, data, request_id: "r" });
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString();
  const url = new URL(request.url!, baseUrl);
  requests.push({
    method: request.method!,
    url: request.url!,
    authorization: request.headers.authorization,
    idempotency: request.headers["idempotency-key"] as string | undefined,
    body: raw ? JSON.parse(raw) : undefined,
  });
  if (url.pathname === "/image.png") {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(Buffer.from(png, "base64"));
    return;
  }
  response.setHeader("content-type", "application/json");
  const done = { taskId: "task-1", state: "succeeded", output: { assets: [{ url: `${baseUrl}/image.png` }] } };
  // SpicyAPI's documented limits: 1 MiB per decoded inline image and 2 MiB for the whole JSON body.
  if (url.pathname === "/api/v1/jobs/createTask") {
    const inline = [raw ? JSON.parse(raw).input?.image_urls : []].flat().filter((value) => typeof value === "string");
    if (
      Buffer.byteLength(raw) > 2_097_152 ||
      inline.some((value) => Buffer.byteLength(value.split(",")[1] ?? "", "base64") > 1_048_576)
    ) {
      response.writeHead(413, { "content-type": "application/json" });
      response.end(envelope(undefined, 413, "Request body too large"));
      return;
    }
  }
  // A dropped connection: the first createTask and the first poll lose their socket mid-request.
  const dropped =
    mode === "reset" &&
    (url.pathname === "/api/v1/jobs/createTask"
      ? ++creates === 1
      : url.pathname === "/api/v1/jobs/recordInfo" && polls++ === 0);
  if (dropped) {
    request.socket.destroy();
    return;
  }
  if (url.pathname === "/api/v1/models") {
    response.end(
      envelope({
        total: 3,
        items: [
          {
            model: "alibaba/z-image-spicy-pro/text-to-image",
            displayName: "Z-Image Spicy Pro",
            tasks: ["text-to-image"],
          },
          { model: "acme/sized/edit", displayName: "Sized", tasks: ["image-to-image"], available: true },
          { model: "spicyapi/image-upscaler-v1/upscale", displayName: "Upscaler", tasks: ["upscale"] },
          { model: "acme/offline/text-to-image", displayName: "Offline", tasks: ["text-to-image"], available: false },
        ],
      }),
    );
  } else if (url.pathname.startsWith("/api/v1/models/")) {
    const model = url.pathname.slice("/api/v1/models/".length);
    if (!schemas[model]) {
      response.statusCode = 404;
      response.end(envelope(undefined, 404, "Model not found"));
    } else response.end(envelope({ model, inputSchema: schemas[model] }));
  } else if (url.pathname === "/api/v1/jobs/createTask") {
    if (mode === "error") {
      response.statusCode = 402;
      response.end(envelope(undefined, 40201, "Insufficient balance"));
    } else if (mode === "failed") {
      response.end(
        envelope({ taskId: "task-1", state: "failed", errorCode: "content_rejected", errorMessage: "Refused" }),
      );
    } else if (mode === "no-state") {
      response.end(envelope({ taskId: "task-1" }));
    } else if (mode === "no-url") {
      response.end(envelope({ ...done, output: { assets: [{ unavailable: true }] } }));
    } else if (mode === "poll" || mode === "reset") {
      response.statusCode = 202;
      response.end(envelope({ taskId: "task-1", state: "queued" }));
    } else response.end(envelope(done));
  } else if (url.pathname === "/api/v1/jobs/recordInfo") {
    if (mode === "reset") {
      response.end(envelope(done));
      return;
    }
    polls += 1;
    if (polls === 1) {
      response.statusCode = 503;
      response.end(envelope(undefined, 503, "Busy"));
    } else if (polls === 2) {
      response.end(envelope({ ...done, output: { assets: [{ pending: true }] } }));
    } else response.end(envelope(done));
  } else {
    response.statusCode = 404;
    response.end("{}");
  }
});

const logs: unknown[][] = [];
const priorWarn = logger.warn;
const priorLevel = logger.level;
logger.level = "warn";
logger.warn = ((...args: unknown[]) => logs.push(args)) as typeof logger.warn;

const app = Fastify();
const previousDirectory = process.env.FILE_STORAGE_DIR;
const directory = mkdtempSync(join(tmpdir(), "marinara-spicyapi-"));
let db:
  | Awaited<ReturnType<typeof import("../../packages/server/src/db/file-backed-store.js").createFileNativeDB>>
  | undefined;
try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;

  for (const spelling of ["https://api.spicyapi.ai", "https://api.spicyapi.ai/v1/", "https://api.spicyapi.ai/api/v1"]) {
    assert.equal(buildSpicyApiUrl(spelling, "jobs/createTask"), "https://api.spicyapi.ai/api/v1/jobs/createTask");
  }
  assert.equal(
    IMAGE_GENERATION_SOURCES.find((source) => source.id === "spicyapi")?.defaultBaseUrl,
    "https://api.spicyapi.ai/api/v1",
  );
  // The host wins over model-name guesses: a FLUX model ID here must not fall through to Together AI.
  assert.equal(
    inferImageSource("black-forest-labs/flux-2-pro/text-to-image", "https://api.spicyapi.ai/api/v1"),
    "spicyapi",
  );

  const generate = (model: string, extra: Record<string, unknown> = {}) =>
    generateImage("spicyapi", `${baseUrl}/api/v1`, key, "spicyapi", {
      prompt: "moonlit laboratory",
      negativePrompt: "text",
      width: 770,
      height: 1030,
      model,
      allowLocalUrls: true,
      debugMode: true,
      ...extra,
    });

  // Width/height models get fitted dimensions; no negative_prompt field, so it joins the prompt.
  assert.equal((await generate("alibaba/z-image-spicy-pro/text-to-image")).base64, png);
  const [lookup, create, download] = requests;
  assert.equal(lookup!.url, "/api/v1/models/alibaba/z-image-spicy-pro/text-to-image");
  assert.equal(lookup!.authorization, `Bearer ${key}`);
  assert.equal(create!.method, "POST");
  assert.equal(create!.url, "/api/v1/jobs/createTask?wait=50");
  assert.equal(create!.authorization, `Bearer ${key}`);
  assert.ok(create!.idempotency, "Every task carries an Idempotency-Key so a resend is never billed twice");
  assert.deepEqual(create!.body, {
    model: "alibaba/z-image-spicy-pro/text-to-image",
    input: { prompt: "moonlit laboratory\n\nDo not include: text.", width: 768, height: 1024 },
  });
  assert.equal(download!.authorization, undefined, "Signed result links must not receive the API key");
  const logText = JSON.stringify(logs);
  assert.ok(logText.includes("[debug/image/spicyapi]") && logText.includes("moonlit laboratory"));
  assert.ok(!logText.includes(key), "The API key never enters debug logs");

  // Aspect-ratio models get the closest declared ratio and nothing they do not declare.
  requests.length = 0;
  await generate("bytedance/seedream-5.0-pro/text-to-image", { width: 1024, height: 576 });
  assert.deepEqual(requests[1]!.body.input, {
    prompt: "moonlit laboratory\n\nDo not include: text.",
    aspect_ratio: "16:9",
  });

  // Preset-size edit models get the closest size, a real negative prompt, and capped references as data URLs.
  requests.length = 0;
  await generate("acme/sized/edit", {
    width: 1344,
    height: 768,
    referenceImages: [png, `data:image/png;base64,${png}`],
    imageDefaults: resolveConnectionImageDefaults({
      imageService: "spicyapi",
      defaultParameters: JSON.stringify({ customParameters: { seed: 7 } }),
    }),
  });
  assert.deepEqual(requests[1]!.body.input, {
    prompt: "moonlit laboratory",
    negative_prompt: "text",
    size: "1344*768",
    image_urls: [`data:image/png;base64,${png}`],
    seed: 7,
  });
  assert.ok(!JSON.stringify(logs).includes(png), "Reference image bytes stay out of debug logs");

  // Queued tasks are polled; a busy status reply or a result still being stored does not abandon the paid task.
  mode = "poll";
  requests.length = 0;
  assert.equal((await generate("alibaba/z-image-spicy-pro/text-to-image")).base64, png);
  assert.equal(polls, 3);
  assert.deepEqual(
    requests.filter((entry) => entry.url.startsWith("/api/v1/jobs/recordInfo")).map((entry) => entry.url),
    Array(3).fill("/api/v1/jobs/recordInfo?taskId=task-1"),
  );

  // A dropped connection never abandons the paid task: createTask is resent with the same Idempotency-Key,
  // which SpicyAPI answers with the original task, and polling carries on as after a busy reply.
  mode = "reset";
  polls = 0;
  requests.length = 0;
  assert.equal((await generate("alibaba/z-image-spicy-pro/text-to-image")).base64, png);
  const creations = requests.filter((entry) => entry.url.startsWith("/api/v1/jobs/createTask"));
  assert.equal(creations.length, 2);
  assert.equal(creations[1]!.idempotency, creations[0]!.idempotency, "A resend reuses the task's Idempotency-Key");
  assert.deepEqual(creations[1]!.body, creations[0]!.body);
  assert.equal(requests.filter((entry) => entry.url.startsWith("/api/v1/jobs/recordInfo")).length, 2);

  // References are fitted to SpicyAPI's inline limits instead of failing the whole generation.
  mode = "sync";
  const sharp = await getSharp();
  assert.ok(sharp, "sharp is installed for the regression run");
  const avatar = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(800_000, 1)]).toString("base64");
  const noise = Buffer.from(Array.from({ length: 900 * 700 * 3 }, (_, index) => (index * 7919) % 251));
  const sheet = (
    await sharp(noise, { raw: { width: 900, height: 700, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer()
  ).toString("base64");
  assert.ok(Buffer.byteLength(sheet, "base64") > 1_048_576, "The character sheet starts over the 1 MiB inline limit");
  requests.length = 0;
  assert.equal((await generate("acme/multi/edit", { referenceImages: [avatar, avatar] })).base64, png);
  assert.deepEqual(requests[1]!.body.input.image_urls, [`data:image/png;base64,${avatar}`], "Extras are dropped");
  requests.length = 0;
  assert.equal((await generate("acme/multi/edit", { referenceImages: [sheet] })).base64, png);
  const [shrunk] = requests[1]!.body.input.image_urls as string[];
  assert.match(shrunk!, /^data:image\/webp;base64,/);
  assert.ok(Buffer.byteLength(shrunk!.split(",")[1]!, "base64") <= 1_048_576, "Oversize references are shrunk");

  mode = "no-state";
  await assert.rejects(generate("alibaba/z-image-spicy-pro/text-to-image"), /did not include a state/);
  mode = "no-url";
  await assert.rejects(generate("alibaba/z-image-spicy-pro/text-to-image"), /finished without an image URL/);
  mode = "failed";
  await assert.rejects(generate("alibaba/z-image-spicy-pro/text-to-image"), /failed: content_rejected: Refused/);
  mode = "error";
  await assert.rejects(generate("alibaba/z-image-spicy-pro/text-to-image"), /\(402\): Insufficient balance/);
  await assert.rejects(generate("missing/model/text-to-image"), /model lookup failed \(404\): Model not found/);
  const beforeInvalid = requests.length;
  for (const model of ["z-image", "../admin/x", "acme/../admin", "acme/x?token=1"]) {
    await assert.rejects(generate(model), /requires a model ID/);
  }
  await assert.rejects(
    generateImage("spicyapi", baseUrl, " ", "spicyapi", { prompt: "x", allowLocalUrls: true }),
    /requires an API key/,
  );
  assert.equal(requests.length, beforeInvalid, "Invalid input fails before any request");

  process.env.FILE_STORAGE_DIR = directory;
  const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
  db = await createFileNativeDB();
  app.decorate("db", db);
  await app.register(connectionsRoutes, { prefix: "/api/connections" });
  const storage = createConnectionsStorage(db);
  const connection = await storage.create({
    name: "SpicyAPI fixture",
    provider: "image_generation",
    imageGenerationSource: "spicyapi",
    baseUrl,
    apiKey: key,
    model: "alibaba/z-image-spicy-pro/text-to-image",
  });
  requests.length = 0;
  const tested = await app.inject({ method: "POST", url: `/api/connections/${connection.id}/test` });
  assert.equal(tested.json().success, true, tested.body);
  const models = await app.inject({ method: "GET", url: `/api/connections/${connection.id}/models` });
  assert.deepEqual(models.json().models, [
    { id: "alibaba/z-image-spicy-pro/text-to-image", name: "Z-Image Spicy Pro · text-to-image" },
    { id: "acme/sized/edit", name: "Sized · image-to-image" },
  ]);
  assert.deepEqual(
    requests.map((entry) => [entry.url, entry.authorization]),
    [
      ["/api/v1/models?modality=image", `Bearer ${key}`],
      ["/api/v1/models?modality=image", `Bearer ${key}`],
    ],
    "Testing and model discovery read the catalog and never start a paid task",
  );
} finally {
  logger.warn = priorWarn;
  logger.level = priorLevel;
  await app.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await db?._fileStore.close();
  if (previousDirectory === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
}
console.info("SpicyAPI image generation and connection regressions passed.");
