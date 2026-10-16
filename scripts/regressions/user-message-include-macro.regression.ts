/**
 * #7607: `{{include::...}}` in a message the user sends is filled in once, when it is sent,
 * the same way Send, Post Only and /send fill in `{{random}}` and the other macros (#7585).
 * The stored message then shows what the model reads, so a `{{random}}` inside the entry
 * is rolled once and a later edit to the entry does not change old messages.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "marinara-user-include-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const { resolveMacros, createLorebookSchema, createLorebookEntrySchema } =
  await import("../../packages/shared/src/index.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { lorebooksRoutes } = await import("../../packages/server/src/routes/lorebooks.routes.js");
const { api } = await import("../../packages/client/src/lib/api-client.js");
const { prepareUserInputMessage } = await import("../../packages/client/src/lib/chat-macros.js");
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(lorebooksRoutes, { prefix: "/api/lorebooks" });
const originalPost = api.post;
const originalRandom = Math.random;
const originalWarn = console.warn;
const originalFetch = globalThis.fetch;
try {
  const lorebooks = createLorebooksStorage(db);
  const chats = createChatsStorage(db);
  const world = await lorebooks.create(createLorebookSchema.parse({ name: "World" }));
  const vault = await lorebooks.create(createLorebookSchema.parse({ name: "Vault", enabled: false }));
  const test = await lorebooks.createEntry(
    createLorebookEntrySchema.parse({
      lorebookId: world.id,
      name: "Test",
      content: "Random Number: {{random:0:100}} for {{user}}",
    }),
  );
  await lorebooks.createEntry(
    createLorebookEntrySchema.parse({
      lorebookId: world.id,
      name: "Nested",
      content: "Outer({{include::Test}}) Loop({{include::Nested}})",
    }),
  );
  await lorebooks.createEntry(
    createLorebookEntrySchema.parse({ lorebookId: vault.id, name: "Secret", content: "VAULT_SECRET" }),
  );
  const stored = await chats.create({ name: "Include send", mode: "roleplay", characterIds: [] } as never);
  assert.ok(stored && test);
  await chats.patchMetadata(stored.id, { activeLorebookIds: [world.id] });

  // The composer's chat, characters and personas, as Send, Post Only and /send pass them.
  const chat = { id: stored.id, characterIds: ["mira"], personaId: "pat", mode: "roleplay", metadata: {} };
  const characters = [{ id: "mira", data: { name: "Mira" } }];
  const personas = [{ id: "pat", name: "Pat" }] as never;
  const requests: unknown[] = [];
  api.post = (async (path: string, body: unknown) => {
    requests.push(body);
    const response = await app.inject({ method: "POST", url: `/api${path}`, payload: body as object });
    if (response.statusCode >= 400) throw new Error(response.body);
    return response.json();
  }) as typeof api.post;
  // A send starts its request deadline right away. Hold that timer, so it cannot keep the run
  // open for its full length; the deadline check below moves it on by hand.
  const send = (text: string, sendChat: Omit<typeof chat, "id"> & { id?: string } = chat, holdDeadline = false) => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      return prepareUserInputMessage(text, {
        chat: sendChat,
        characters,
        personas,
        applyToUserInput: (value) => value,
        onTranslationError: () => assert.fail("no translation runs here"),
      });
    } finally {
      if (!holdDeadline) mock.timers.reset();
    }
  };

  Math.random = () => 0.42;
  const roll = resolveMacros("{{random:0:100}}", { user: "Pat", char: "Mira", characters: [], variables: {} });
  assert.equal(
    await send("Respond with: {{include::Test}}"),
    `Respond with: Random Number: ${roll} for Pat`,
    "the entry is put in and its own macros are filled in with the rest of the message",
  );

  // The first message already holds its text and roll; an edit and a new roll only reach later sends.
  await lorebooks.updateEntry(test.id, { content: "Changed {{random:0:100}}" });
  Math.random = () => 0.99;
  const laterRoll = resolveMacros("{{random:0:100}}", { user: "Pat", char: "Mira", characters: [], variables: {} });
  assert.notEqual(laterRoll, roll);
  assert.equal(await send("{{include::Test}}"), `Changed ${laterRoll}`, "a later send reads the edited entry");

  // The same lorebooks and rules as an include in a prompt (#6912).
  assert.equal(await send("[{{include::Secret}}]"), "[]", "a name in a lorebook the chat does not use is not found");
  assert.equal(await send("{{include::Vault::Secret}}"), "VAULT_SECRET", "the long form reads any lorebook");
  assert.equal(await send("[{{include::Missing}}]"), "[]", "a missing entry reads as empty, as in a prompt");
  assert.equal(
    await send("{{include::Nested}}"),
    `Outer(Changed ${laterRoll}) Loop()`,
    "a nested include is filled in, and one that loops back reads as empty",
  );

  // A message without the macro never asks the server.
  requests.length = 0;
  assert.equal(await send("Hello {{user}}."), "Hello Pat.");
  assert.equal(requests.length, 0, "a plain message sends no lorebook request");

  // Without a chat a name has no lorebooks to look in, so it stays as written for the prompt to fill in.
  assert.equal(await send("[{{include::Test}}]", { ...chat, id: undefined }), "[{{include::Test}}]");
  assert.equal(requests.length, 0, "a send without a chat sends no lorebook request");

  const badRequest = await app.inject({ method: "POST", url: "/api/lorebooks/expand-includes", payload: {} });
  assert.equal(badRequest.statusCode, 400, "the route needs the message text");

  // If the lorebooks cannot be read, the include stays as written for the prompt to fill in, as before.
  api.post = (async () => {
    throw new Error("server offline");
  }) as typeof api.post;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  assert.equal(await send("Hi {{user}}: {{include::Test}}"), "Hi Pat: {{include::Test}}");
  assert.equal(warnings.length, 1, "the failure is logged once");

  // A server that never answers cannot hold the send: after the deadline the include goes as written.
  api.post = originalPost;
  let fetchSignal: AbortSignal | null | undefined;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      fetchSignal = init?.signal;
      if (fetchSignal?.aborted) reject(fetchSignal.reason);
      fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
    })) as typeof fetch;
  try {
    const pending = send("Hi {{user}}: {{include::Test}}", chat, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(fetchSignal instanceof AbortSignal, "the request has a deadline");
    mock.timers.tick(10_000);
    const stillWaiting = Symbol("still waiting");
    const outcome = await Promise.race([pending, new Promise((resolve) => setImmediate(() => resolve(stillWaiting)))]);
    assert.equal(outcome, "Hi Pat: {{include::Test}}", "the send goes on once the deadline passes");
    assert.equal(warnings.length, 2, "the timeout is logged");
  } finally {
    mock.timers.reset();
  }

  console.info("user-message-include-macro regression passed");
} finally {
  api.post = originalPost;
  Math.random = originalRandom;
  console.warn = originalWarn;
  globalThis.fetch = originalFetch;
  mock.timers.reset();
  await app.close();
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}
