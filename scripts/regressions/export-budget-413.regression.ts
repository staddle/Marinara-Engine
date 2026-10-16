// An export's own 413 (reference images over the export budget) must reach the user with its advice,
// while Fastify's body-limit 413 keeps the generic text that names no limit.
import assert from "node:assert/strict";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { errorHandler } from "../../packages/server/src/middleware/error-handler.js";
import { embedLorebookImages, saveLorebookImage } from "../../packages/server/src/services/lorebook/lorebook-images.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2jX8AAAAASUVORK5CYII=",
  "base64",
);
const image = await saveLorebookImage(png);
const app = Fastify();
app.setErrorHandler(errorHandler);
// The same call the lorebook and character export routes make, with the budget already spent.
app.get("/export", async () => embedLorebookImages([{ images: [image] }], { remainingBytes: 0 }));
app.post("/small", { bodyLimit: 16 }, async () => ({ ok: true }));
try {
  const budget = await app.inject("/export");
  assert.equal(budget.statusCode, 413);
  assert.match(budget.json().error, /64 MiB.*fewer items/, "the export budget error keeps its explanation");

  const tooLarge = await app.inject({ method: "POST", url: "/small", payload: { text: "x".repeat(64) } });
  assert.equal(tooLarge.statusCode, 413);
  assert.deepEqual(tooLarge.json(), { error: "The request body is larger than this endpoint accepts." });
  console.info("Export budget 413 regression passed");
} finally {
  await app.close();
}
