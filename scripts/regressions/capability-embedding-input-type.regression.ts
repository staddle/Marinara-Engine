import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #7429: a package's search queries must reach a prefix-profile model as queries, not documents.
const scratch = mkdtempSync(join(tmpdir(), "marinara-capability-embedding-input-"));
process.env.DATA_DIR = scratch;
process.env.FILE_STORAGE_DIR = join(scratch, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createConfiguredCapabilityEmbeddingHost } =
  await import("../../packages/server/src/services/capability-packages/capability-embedding.service.js");

const db = await createFileNativeDB();
const inputs: unknown[] = [];
// A fixed cap, never taken from the request.
const MAX_FIXTURE_BODY = 64_000;
const embeddingServer = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_FIXTURE_BODY) {
      response.writeHead(413).end();
      request.destroy();
    }
  });
  request.on("end", () => {
    if (response.writableEnded) return;
    const { input } = JSON.parse(body) as { input: string[] };
    inputs.push(input);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: input.map((_, index) => ({ embedding: [1, 0], index })) }));
  });
});

try {
  await new Promise<void>((resolve) => embeddingServer.listen(0, "127.0.0.1", resolve));
  const address = embeddingServer.address();
  assert.ok(address && typeof address === "object");

  const connection = await createConnectionsStorage(db).create({
    name: "E5 embedding fixture",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture-chat-model",
    apiKey: "fixture-key",
    embeddingModel: "intfloat/multilingual-e5-large",
  });
  assert.ok(connection);
  const host = await createConfiguredCapabilityEmbeddingHost(db, connection.id);
  assert.match(host.spaceId, /^remote:/u, "the fixture must use the configured source, not the built-in MiniLM");

  assert.ok(await host.embed(["Where is the lighthouse?"], undefined, "query"));
  assert.ok(await host.embed(["The lighthouse stands on the cliff."]));
  assert.ok(await host.embed(["The keeper lights it at dusk."], undefined, "document"));
  assert.deepEqual(
    inputs,
    [
      ["query: Where is the lighthouse?"],
      ["passage: The lighthouse stands on the cliff."],
      ["passage: The keeper lights it at dusk."],
    ],
    "the configured capability host must forward the input type, with document as the default",
  );
} finally {
  await db._fileStore.close();
  await new Promise<void>((resolve) => embeddingServer.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
}

console.info("Capability embedding input type regression passed.");
