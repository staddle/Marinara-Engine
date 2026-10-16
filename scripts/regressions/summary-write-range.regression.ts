// A summary written by hand with Summary Scope set to Range keeps and applies that range, like Generate (#7410).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-summary-write-range-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { createChatsStorage, withChatMetadataPatchQueue } =
  await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { isMessageHiddenFromAI } = await import("../../packages/server/src/routes/generate/generate-route-utils.js");
const { inspectChatSummaryBatchRanges, resolveChatSummaryWriteCoverage } =
  await import("../../packages/client/src/lib/chat-summary-batch.ts");
const db = await getDB();
const chats = createChatsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(chatsRoutes, { prefix: "/api/chats" });

const provider = createServer((request, response) => {
  request.resume();
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: '{"summary":"Generated summary.","title":"Generated"}' },
          finish_reason: "stop",
        },
      ],
    }),
  );
});

type Entry = {
  id: string;
  sourceMode?: string;
  rangeStartIndex?: number;
  rangeEndIndex?: number;
  messageCount?: number;
  messageIds?: string[];
  hiddenMessageIds?: string[];
  content: string;
};

try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert(address && typeof address === "object");
  const connection = await createConnectionsStorage(db).create({
    name: "Summary fixture",
    provider: "custom",
    model: "fixture",
    apiKey: "fixture",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    maxContext: 32768,
  });
  assert(connection);

  const createChat = async () => {
    const chat = await chats.create({
      name: "Range summary",
      mode: "roleplay",
      characterIds: [],
      connectionId: connection.id,
    });
    assert(chat);
    await chats.patchMetadata(chat.id, {
      automaticSummaryEnabled: false,
      hideSummarisedMessages: true,
      summaryTailMessages: 2,
    });
    const ids: string[] = [];
    for (let turn = 1; turn <= 6; turn++) {
      const message = await chats.createMessage({
        chatId: chat.id,
        role: turn % 2 ? "user" : "assistant",
        characterId: null,
        content: `Turn ${turn}.`,
      });
      assert(message);
      ids.push(message.id);
    }
    return { chatId: chat.id, ids };
  };
  const entries = async (chatId: string) => {
    const chat = await chats.getById(chatId);
    assert(chat);
    const metadata = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata;
    return (metadata.summaryEntries ?? []) as Entry[];
  };
  const hiddenIds = async (chatId: string) =>
    (await chats.listMessages(chatId)).filter((message) => isMessageHiddenFromAI(message)).map((message) => message.id);
  const write = (chatId: string, entry: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/chats/${chatId}/summary-entries`,
      payload: { operation: "replace", entry },
    });
  // The draft the Write button saves while Summary Scope is Range.
  const manualDraft = (id: string, rangeStartIndex: number, rangeEndIndex: number) => ({
    id,
    kind: "rolling",
    origin: "manual",
    title: "Manual summary",
    content: "Manual summary test",
    enabled: true,
    sourceMode: "range",
    rangeStartIndex,
    rangeEndIndex,
    tokenEstimate: 4,
    createdAt: "2026-10-11T10:00:00.000Z",
    updatedAt: "2026-10-11T10:00:00.000Z",
  });
  const coverage = (entry: Entry, ids: string[]) => ({
    sourceMode: entry.sourceMode,
    rangeStartIndex: entry.rangeStartIndex,
    rangeEndIndex: entry.rangeEndIndex,
    messageCount: entry.messageCount,
    messages: entry.messageIds?.map((id) => ids.indexOf(id) + 1),
    hidden: entry.hiddenMessageIds?.map((id) => ids.indexOf(id) + 1),
  });

  // Generate with the range 1-3 is the behavior Write must match.
  const generated = await createChat();
  const generateResponse = await app.inject({
    method: "POST",
    url: `/api/chats/${generated.chatId}/generate-summary`,
    payload: { rangeStartIndex: 1, rangeEndIndex: 3 },
  });
  assert.equal(generateResponse.statusCode, 200, generateResponse.body);
  const [generatedEntry] = await entries(generated.chatId);
  assert(generatedEntry);
  const expected = {
    sourceMode: "range",
    rangeStartIndex: 1,
    rangeEndIndex: 3,
    messageCount: 3,
    messages: [1, 2, 3],
    hidden: [1, 2, 3],
  };
  assert.deepEqual(coverage(generatedEntry, generated.ids), expected, "Generate keeps and applies the range");

  const written = await createChat();
  const writeResponse = await write(written.chatId, manualDraft("manual-range", 1, 3));
  assert.equal(writeResponse.statusCode, 200, writeResponse.body);
  const [writtenEntry] = await entries(written.chatId);
  assert(writtenEntry);
  assert.equal(writtenEntry.id, "manual-range");
  assert.equal(writtenEntry.content, "Manual summary test");
  assert.deepEqual(coverage(writtenEntry, written.ids), expected, "Write keeps and applies the range like Generate");
  assert.deepEqual(await hiddenIds(written.chatId), written.ids.slice(0, 3), "Write hides the summarized messages");

  // The protected tail stays visible, exactly as it does for Generate.
  const tailResponse = await write(written.chatId, manualDraft("manual-tail", 4, 6));
  assert.equal(tailResponse.statusCode, 200, tailResponse.body);
  const tailEntry = (await entries(written.chatId)).find((entry) => entry.id === "manual-tail");
  assert(tailEntry);
  assert.deepEqual(coverage(tailEntry, written.ids), {
    sourceMode: "range",
    rangeStartIndex: 4,
    rangeEndIndex: 6,
    messageCount: 3,
    messages: [4, 5, 6],
    hidden: [4],
  });
  assert.deepEqual(await hiddenIds(written.chatId), written.ids.slice(0, 4));

  // Editing the saved entry later changes its text but keeps what it covers.
  const editResponse = await write(written.chatId, { id: "manual-range", title: "Edited", content: "Edited text" });
  assert.equal(editResponse.statusCode, 200, editResponse.body);
  const editedEntry = (await entries(written.chatId)).find((entry) => entry.id === "manual-range");
  assert(editedEntry);
  assert.equal(editedEntry.content, "Edited text");
  assert.deepEqual(coverage(editedEntry, written.ids), expected);
  assert.deepEqual(await hiddenIds(written.chatId), written.ids.slice(0, 4));

  // A range Generate would refuse is refused for Write too, and nothing is saved.
  for (const [start, end, error, code] of [
    [1, 3, "No non-hidden messages available for the requested summary range", "hidden"],
    [5, 9, "Summary range is outside this chat's message history", "outside"],
  ] as const) {
    const generateRefusal = await app.inject({
      method: "POST",
      url: `/api/chats/${written.chatId}/generate-summary`,
      payload: { rangeStartIndex: start, rangeEndIndex: end },
    });
    assert.equal(generateRefusal.statusCode, 400, generateRefusal.body);
    assert.equal(generateRefusal.json().error, error);
    const writeRefusal = await write(written.chatId, manualDraft(`refused-${start}`, start, end));
    assert.equal(writeRefusal.statusCode, 400, writeRefusal.body);
    assert.equal(writeRefusal.json().error, error);
    assert.equal(writeRefusal.json().code, code, "The client says why in the user's language");
  }
  // A new range entry needs two positive whole message numbers; anything else is refused, not saved uncovered.
  for (const [start, end] of [
    [0, 2],
    [1.5, 3],
    [undefined, 3],
  ]) {
    const invalidRefusal = await write(written.chatId, {
      ...manualDraft(`invalid-${start}`, 1, 3),
      rangeStartIndex: start,
      rangeEndIndex: end,
    });
    assert.equal(invalidRefusal.statusCode, 400, invalidRefusal.body);
    assert.equal(invalidRefusal.json().code, "invalid");
  }
  assert.deepEqual(
    (await entries(written.chatId)).map((entry) => entry.id),
    ["manual-range", "manual-tail"],
  );

  // A refused draft stays open and follows the Summary Scope, so picking another range and saving again works
  // without losing the text.
  const firstRange = (start: string, end: string) => inspectChatSummaryBatchRanges([{ id: "first", start, end }], 6)[0];
  assert.equal(resolveChatSummaryWriteCoverage("range", firstRange("5", "9")).error, "outside");
  const nextRange = resolveChatSummaryWriteCoverage("range", firstRange("6", "5"));
  assert.deepEqual(nextRange, { error: null, coverage: { sourceMode: "range", rangeStartIndex: 5, rangeEndIndex: 6 } });
  const retryResponse = await write(written.chatId, { ...manualDraft("refused-1", 1, 3), ...nextRange.coverage });
  assert.equal(retryResponse.statusCode, 200, retryResponse.body);
  const retriedEntry = (await entries(written.chatId)).find((entry) => entry.id === "refused-1");
  assert(retriedEntry);
  assert.equal(retriedEntry.content, "Manual summary test");
  assert.deepEqual(coverage(retriedEntry, written.ids), {
    sourceMode: "range",
    rangeStartIndex: 5,
    rangeEndIndex: 6,
    messageCount: 2,
    messages: [5, 6],
    hidden: undefined,
  });
  // Switching to Last before saving drops the range, and the entry is saved without coverage as before.
  const lastScope = resolveChatSummaryWriteCoverage("last", firstRange("1", "3"));
  assert.deepEqual(lastScope, {
    error: null,
    coverage: { sourceMode: "last", rangeStartIndex: undefined, rangeEndIndex: undefined },
  });
  const lastResponse = await write(written.chatId, { ...manualDraft("refused-5", 5, 9), ...lastScope.coverage });
  assert.equal(lastResponse.statusCode, 200, lastResponse.body);
  const lastEntry = (await entries(written.chatId)).find((entry) => entry.id === "refused-5");
  assert(lastEntry);
  assert.deepEqual(coverage(lastEntry, written.ids), {
    sourceMode: "last",
    rangeStartIndex: undefined,
    rangeEndIndex: undefined,
    messageCount: undefined,
    messages: undefined,
    hidden: undefined,
  });

  // Two saves of the same new draft at once (say, a retried request) keep one entry.
  // Holding the chat's queue lets both saves pass the route's first check before either is written.
  const raced = await createChat();
  let releaseQueue = () => {};
  const queueHeld = withChatMetadataPatchQueue(
    raced.chatId,
    () => new Promise<void>((resolve) => (releaseQueue = resolve)),
  );
  const racedWrites = [
    write(raced.chatId, manualDraft("manual-race", 1, 3)),
    write(raced.chatId, manualDraft("manual-race", 1, 3)),
  ];
  await new Promise((resolve) => setTimeout(resolve, 100));
  releaseQueue();
  await queueHeld;
  const racedResponses = await Promise.all(racedWrites);
  for (const response of racedResponses) assert.equal(response.statusCode, 200, response.body);
  const racedEntries = await entries(raced.chatId);
  assert.deepEqual(
    racedEntries.map((entry) => entry.id),
    ["manual-race"],
  );
  assert.deepEqual(coverage(racedEntries[0]!, raced.ids), expected);
  assert.deepEqual(await hiddenIds(raced.chatId), raced.ids.slice(0, 3));

  // The panel wires that up: the open draft and its save use the current scope, and a refusal says why.
  const panelSource = readFileSync(
    new URL("../../packages/client/src/components/chat/ChatSummaryPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    panelSource,
    /\{ \.\.\.draftEntry, \.\.\.writeScope\.coverage \}/u,
    "The open draft shows the current scope",
  );
  assert.match(panelSource, /\.\.\.entry,\s*\.\.\.writeScope\.coverage,/u, "A new draft saves with the current scope");
  assert.match(
    panelSource,
    /refusal === "hidden"\s*\?\s*localizeUi\("ui\.chat\.summarypopover\.batchRangeAllHidden"\)/u,
    "A refused range says why",
  );
} finally {
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await app.close();
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}

console.info("Summary Write range regression passed.");
