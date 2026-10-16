// Trashing a message removes or reverts the agent lore written from it, so a deleted turn stops steering
// prompts. Restoring the message from the trash must bring that lore back, unless someone changed it since.
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { eq } = await import("../../packages/server/src/db/file-query.js");
const { lorebookEntries } = await import("../../packages/server/src/db/schema/index.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createLorebooksStorage } = await import("../../packages/server/src/services/storage/lorebooks.storage.js");
const { createMessageTrashStorage } =
  await import("../../packages/server/src/services/storage/message-trash.storage.js");

const db = await getDB();
try {
  const chats = createChatsStorage(db);
  const lorebooks = createLorebooksStorage(db);
  const trash = createMessageTrashStorage(db);
  const chat = (await chats.create({ name: "Trash lore", mode: "roleplay", characterIds: [] } as never))!;
  const say = async (role: "user" | "assistant", content: string) =>
    (await chats.createMessage({ chatId: chat.id, role, characterId: null, content } as never))!;
  const book = (await lorebooks.create({ name: "Keeper notes" } as never))!;
  const keeperEntry = async (name: string, content: string, refs: string[]) =>
    (await lorebooks.createEntry({
      lorebookId: book.id,
      name,
      content,
      keys: [name.toLowerCase()],
      sourceAgentId: "lorebook-keeper",
      sourceMessageRefs: refs.map((id) => ({ id, swipeIndex: 0 })),
    } as never))!;
  const entry = async (id: string) =>
    (await db.select().from(lorebookEntries).where(eq(lorebookEntries.id, id)))[0] ?? null;
  const restoreMessage = async (messageId: string) => {
    const row = (await trash.list(chat.id)).find((item) => item.messageId === messageId);
    assert.ok(row, `message ${messageId} is in the trash`);
    return trash.restore(chat.id, [row.id]);
  };

  // ── (a) a keeper entry the delete removed comes back with the message ──
  const user = await say("user", "Where is the key?");
  const reply = await say("assistant", "The curator took the key.");
  const created = await keeperEntry("Key", "The curator took the key.", [user.id, reply.id]);
  await trash.trashMessages(chat.id, [reply.id]);
  assert.equal(await entry(created.id), null, "a trashed turn's lore stops steering prompts");
  await restoreMessage(reply.id);
  const back = await entry(created.id);
  assert.equal(back?.content, "The curator took the key.", "restoring the message restores its lore");
  assert.equal(back?.sourceAgentId, "lorebook-keeper");
  assert.equal(back?.lorebookId, book.id);

  // ── (b) a keeper rewrite the delete reverted is re-applied ──
  const rewriteTurn = await say("assistant", "The key is now in the vault.");
  const rewritten = await keeperEntry("Vault", "The key is in the vault.", [rewriteTurn.id]);
  await db
    .update(lorebookEntries)
    .set({
      previousContent: "The key is lost.",
      previousSourceMessageRefs: JSON.stringify([{ id: user.id, swipeIndex: 0 }]),
      previousSourceAgentId: "lorebook-keeper",
    })
    .where(eq(lorebookEntries.id, rewritten.id));
  await trash.trashMessages(chat.id, [rewriteTurn.id]);
  assert.equal((await entry(rewritten.id))?.content, "The key is lost.", "the delete reverts the rewrite");
  await restoreMessage(rewriteTurn.id);
  const reapplied = await entry(rewritten.id);
  assert.equal(reapplied?.content, "The key is in the vault.", "restore re-applies the rewrite");
  assert.deepEqual(
    JSON.parse(reapplied!.sourceMessageRefs).map((ref: { id: string }) => ref.id),
    [rewriteTurn.id],
  );
  assert.equal(reapplied?.previousContent, "The key is lost.", "the rewrite keeps its undo");

  // ── (c) an entry the user edited while the message sat in the trash keeps the edit ──
  await trash.trashMessages(chat.id, [rewriteTurn.id]);
  await db
    .update(lorebookEntries)
    .set({ content: "My own note.", sourceAgentId: null, sourceMessageRefs: "[]" })
    .where(eq(lorebookEntries.id, rewritten.id));
  await restoreMessage(rewriteTurn.id);
  assert.equal((await entry(rewritten.id))?.content, "My own note.", "a later edit wins over the trash snapshot");

  // ── (d) lore written from two turns waits until both are back, whichever is restored first ──
  const first = await say("user", "Open the vault.");
  const second = await say("assistant", "The vault opens.");
  const pair = await keeperEntry("Open vault", "The vault is open.", [first.id, second.id]);
  await trash.trashMessages(chat.id, [second.id]);
  await trash.trashMessages(chat.id, [first.id]);
  await restoreMessage(second.id);
  assert.equal(await entry(pair.id), null, "lore stays out while one of its turns is still in the trash");
  await restoreMessage(first.id);
  assert.equal((await entry(pair.id))?.content, "The vault is open.", "it returns with the last of its turns");

  // ── (e) a turn deleted together with its partner comes back in one restore ──
  await trash.trashMessages(chat.id, [first.id, second.id]);
  assert.equal(await entry(pair.id), null);
  const both = await trash.list(chat.id);
  await trash.restore(
    chat.id,
    both.map((item) => item.id),
  );
  assert.equal((await entry(pair.id))?.content, "The vault is open.");

  // ── (f) a lorebook deleted while the message was in the trash is not recreated ──
  const gone = (await lorebooks.create({ name: "Short-lived" } as never))!;
  const goneTurn = await say("assistant", "A passing remark.");
  const goneEntry = (await lorebooks.createEntry({
    lorebookId: gone.id,
    name: "Remark",
    content: "Passing.",
    keys: ["remark"],
    sourceAgentId: "lorebook-keeper",
    sourceMessageRefs: [{ id: goneTurn.id, swipeIndex: 0 }],
  } as never))!;
  await trash.trashMessages(chat.id, [goneTurn.id]);
  await lorebooks.remove(gone.id);
  const restoredGone = await restoreMessage(goneTurn.id);
  assert.deepEqual(restoredGone.restoredMessageIds, [goneTurn.id], "the message still comes back");
  assert.equal(await entry(goneEntry.id), null);

  console.info("Message trash lore regression passed");
} finally {
  await closeDB();
}
