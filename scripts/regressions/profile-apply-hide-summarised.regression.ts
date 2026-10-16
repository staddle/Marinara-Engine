// Applying a settings profile that turns "Hide summarised messages" on or off hides or shows the
// summarised messages, as the toggle in the summary popover does (#7426).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-profile-apply-hide-summarised-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { chatPresetsRoutes } = await import("../../packages/server/src/routes/chat-presets.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createChatPresetsStorage } = await import("../../packages/server/src/services/storage/chat-presets.storage.js");
const { isMessageHiddenFromAI } = await import("../../packages/server/src/routes/generate/generate-route-utils.js");
const db = await getDB();
const chats = createChatsStorage(db);
const presets = createChatPresetsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(chatsRoutes, { prefix: "/api/chats" });
await app.register(chatPresetsRoutes, { prefix: "/api/chat-presets" });

type Entry = { id: string; messageIds?: string[]; hiddenMessageIds?: string[]; updatedAt?: string };
const readMeta = async (chatId: string) => {
  const chat = await chats.getById(chatId);
  assert(chat);
  return (typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata) as Record<string, unknown>;
};
const entries = async (chatId: string) => ((await readMeta(chatId)).summaryEntries ?? []) as Entry[];
// One-based positions of the messages hidden from the AI.
const hidden = async (chatId: string, ids: string[]) =>
  (await chats.listMessages(chatId))
    .filter((message) => isMessageHiddenFromAI(message))
    .map((message) => ids.indexOf(message.id) + 1);
const positions = (ids: string[], list: string[] | undefined) => list?.map((id) => ids.indexOf(id) + 1);

// Six messages, a summary of the first five, and message 6 hidden by the user.
const createChat = async (metadata: Record<string, unknown>) => {
  const chat = await chats.create({ name: "Summarised", mode: "roleplay", characterIds: [] });
  assert(chat);
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
  await chats.bulkSetHiddenFromAI(chat.id, [ids[5]!], true);
  await chats.patchMetadata(chat.id, {
    summaryTailMessages: 0,
    summaryEntries: [
      {
        id: "entry-1",
        kind: "rolling",
        origin: "auto",
        title: "First turns",
        content: "The first five turns.",
        enabled: true,
        messageIds: ids.slice(0, 5),
        createdAt: "2026-10-11T10:00:00.000Z",
        updatedAt: "2026-10-11T10:00:00.000Z",
      },
    ],
    ...metadata,
  });
  return { chatId: chat.id, ids };
};
const profile = async (name: string, metadata: Record<string, unknown>) => {
  const created = await presets.create({ name, mode: "roleplay", settings: { metadata } });
  assert(created);
  return created.id;
};
const apply = async (presetId: string, chatId: string) => {
  const response = await app.inject({ method: "POST", url: `/api/chat-presets/${presetId}/apply/${chatId}` });
  assert.equal(response.statusCode, 200, response.body);
};
const toggle = async (chatId: string, hideSummarisedMessages: boolean) => {
  const response = await app.inject({
    method: "PATCH",
    url: `/api/chats/${chatId}/metadata`,
    payload: { hideSummarisedMessages },
  });
  assert.equal(response.statusCode, 200, response.body);
};

try {
  // The profile keeps the two most recent visible messages in view: messages 4 and 5, as 6 is hidden.
  const hideOn = await profile("Hide on", { hideSummarisedMessages: true, summaryTailMessages: 2 });
  const hideOff = await profile("Hide off", { summaryTailMessages: 2 });

  // Profile on, chat off: the summarised messages are hidden, and the summary records which.
  const chat = await createChat({ hideSummarisedMessages: false });
  await apply(hideOn, chat.chatId);
  assert.equal((await readMeta(chat.chatId)).hideSummarisedMessages, true);
  assert.deepEqual(await hidden(chat.chatId, chat.ids), [1, 2, 3, 6], "applying the profile hides messages 1-3");
  const [hiddenEntry] = await entries(chat.chatId);
  assert.deepEqual(positions(chat.ids, hiddenEntry!.hiddenMessageIds), [1, 2, 3]);
  assert.equal((await readMeta(chat.chatId)).summary, "The first five turns.");

  // No change: applying the profile again touches neither the messages nor the summary.
  await apply(hideOn, chat.chatId);
  assert.deepEqual(await hidden(chat.chatId, chat.ids), [1, 2, 3, 6]);
  assert.deepEqual(await entries(chat.chatId), [hiddenEntry]);

  // Profile off, chat on: the messages the summary hid are shown again; the one the user hid stays hidden.
  await apply(hideOff, chat.chatId);
  assert.equal((await readMeta(chat.chatId)).hideSummarisedMessages, undefined);
  assert.deepEqual(await hidden(chat.chatId, chat.ids), [6], "applying the profile shows messages 1-3 again");
  const [shownEntry] = await entries(chat.chatId);
  assert.equal(shownEntry!.hiddenMessageIds, undefined);

  // No change while off: nothing is touched either.
  await apply(hideOff, chat.chatId);
  assert.deepEqual(await hidden(chat.chatId, chat.ids), [6]);
  assert.deepEqual(await entries(chat.chatId), [shownEntry]);

  // The toggle in the summary popover works as before, with the chat's own recent-message count.
  const toggled = await createChat({ hideSummarisedMessages: false });
  await toggle(toggled.chatId, true);
  assert.deepEqual(await hidden(toggled.chatId, toggled.ids), [1, 2, 3, 4, 5, 6]);
  const [toggledEntry] = await entries(toggled.chatId);
  assert.deepEqual(positions(toggled.ids, toggledEntry!.hiddenMessageIds), [1, 2, 3, 4, 5]);
  await toggle(toggled.chatId, true);
  assert.deepEqual(await entries(toggled.chatId), [toggledEntry], "the same value changes nothing");
  await toggle(toggled.chatId, false);
  assert.equal((await readMeta(toggled.chatId)).hideSummarisedMessages, false);
  assert.deepEqual(await hidden(toggled.chatId, toggled.ids), [6]);
  assert.equal((await entries(toggled.chatId))[0]!.hiddenMessageIds, undefined);

  // Saving a profile and updating its other chats leaves each chat's own setting and messages alone.
  const follower = await createChat({ hideSummarisedMessages: false });
  await toggle(follower.chatId, true);
  await apply(hideOff, follower.chatId);
  await toggle(follower.chatId, true);
  const before = await entries(follower.chatId);
  const followers = await app.inject({ method: "POST", url: `/api/chat-presets/${hideOff}/apply-to-followers` });
  assert.equal(followers.statusCode, 200, followers.body);
  assert(followers.json().chatIds.includes(follower.chatId));
  assert.equal((await readMeta(follower.chatId)).hideSummarisedMessages, true);
  assert.deepEqual(await entries(follower.chatId), before);

  console.info("Profile apply hide summarised regression passed.");
} finally {
  await app.close();
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
