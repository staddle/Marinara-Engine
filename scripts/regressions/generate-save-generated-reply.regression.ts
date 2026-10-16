import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pins the save of a generated reply moved out of generate.routes.ts (#7573): new, swipe, continue, split, spatial.
const dir = mkdtempSync(join(tmpdir(), "marinara-save-generated-reply-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createGenerationEventSink } = await import("../../packages/server/src/routes/generate/sse.js");
const { saveGeneratedReply } = await import("../../packages/server/src/routes/generate/save-generated-reply.js");
const { registerCapabilityService } =
  await import("../../packages/server/src/services/capability-packages/capability-service-registry.service.js");
const { SpatialOwnerTurnError } = await import("../../packages/server/src/services/spatial-context/owner-turn.js");
const { splitAtSceneBreaks } = await import("../../packages/shared/dist/index.js");

type Context = Parameters<typeof saveGeneratedReply>[0];

const db = await getDB();
const chats = createChatsStorage(db);
try {
  const chat = await chats.create({ name: "Save proof", mode: "roleplay", characterIds: [] });
  assert(chat);
  const events: Array<Record<string, unknown>> = [];
  const context = (overrides: Partial<Context> = {}): Context => ({
    chats,
    reply: createGenerationEventSink({ onEvent: (payload) => events.push(payload), onFinish: () => undefined }),
    input: { chatId: chat.id, continueAddsNewline: false, impersonate: false, pendingSpatialTransition: null },
    chatMode: "roleplay",
    targetCharId: null,
    continueTargetMessage: null,
    advancedMemoryEnabled: false,
    ...overrides,
  });

  // A new reply is one assistant message, swipe 0, never split without Advanced Memory.
  const fresh = await saveGeneratedReply(context(), "Hello.\n\n***\n\nLater.");
  assert.equal(fresh.savedMsg.role, "assistant");
  assert.equal(fresh.savedMsg.content, "Hello.\n\n***\n\nLater.");
  assert.deepEqual(
    [fresh.savedSwipeIndex, fresh.replyParts, fresh.continuedSource, fresh.recoveredSpatialTurn],
    [0, null, null, false],
  );
  assert.equal((await chats.listMessages(chat.id)).length, 1);

  // A regenerate adds a swipe to the message and returns its index.
  const regen = await saveGeneratedReply(
    context({ input: { ...context().input, regenerateMessageId: fresh.savedMsg.id } }),
    "Hi again.",
  );
  assert.equal(regen.savedMsg.id, fresh.savedMsg.id);
  assert.equal(regen.savedSwipeIndex, 1);
  assert.equal(regen.savedMsg.content, "Hi again.");
  assert.equal((await chats.listMessages(chat.id)).length, 1);

  // A continue appends to the message and hands back its whole new content.
  const continued = await saveGeneratedReply(
    context({ input: { ...context().input, continueMessageId: fresh.savedMsg.id } }),
    " More.",
  );
  assert.equal(continued.continuedSource, "Hi again. More.");
  assert.equal(continued.savedMsg.content, "Hi again. More.");
  assert.equal(continued.savedSwipeIndex, 1);

  // With Advanced Memory, a reply with scene breaks is saved as one message per part, the last one returned.
  const whole = "Scene one.\n\n***\n\nScene two.\n\n---\n\nScene three.";
  const expected = splitAtSceneBreaks(whole);
  assert.equal(expected.length, 3);
  const split = await saveGeneratedReply(context({ advancedMemoryEnabled: true }), whole);
  assert(split.replyParts);
  assert.deepEqual(
    split.replyParts.map((part) => [part.content, part.start, part.message.content, part.activity]),
    expected.map((content) => [content, whole.indexOf(content), content, []]),
  );
  assert.equal(split.savedMsg.id, split.replyParts.at(-1)!.message.id);
  assert.equal((await chats.listMessages(chat.id)).length, 4);

  // A repeated part starts after the part before it, not at its first match.
  const repeated = "Same.\n\n---\n\nSame.\n\n---\n\nSame.";
  const twice = await saveGeneratedReply(context({ advancedMemoryEnabled: true }), repeated);
  assert.deepEqual(
    twice.replyParts!.map((part) => part.start),
    [0, 7, 19],
  );
  for (const part of twice.replyParts!) await chats.removeMessage(part.message.id);

  // A continue of a message that can no longer be read starts from the message read before generation.
  const fallback = await saveGeneratedReply(
    context({
      chats: { ...chats, getMessage: async () => null, updateMessageContent: async (_id, content) => ({ content }) },
      input: { ...context().input, continueMessageId: "gone" },
      continueTargetMessage: { content: "Before." },
    }),
    " After.",
  );
  assert.equal(fallback.continuedSource, "Before. After.");
  assert.equal(fallback.savedSwipeIndex, 0);

  // An impersonated reply is one user message without a character, never split.
  const persona = await saveGeneratedReply(
    context({ input: { ...context().input, impersonate: true }, targetCharId: "char_1", advancedMemoryEnabled: true }),
    "Me.\n\n***\n\nMe again.",
  );
  assert.deepEqual([persona.savedMsg.role, persona.savedMsg.characterId, persona.replyParts], ["user", null, null]);
  await chats.removeMessage(persona.savedMsg.id);

  // A split save that fails on part 2 removes part 1 and rethrows.
  let creates = 0;
  const failing = {
    ...chats,
    createMessage: (async (...args: Parameters<typeof chats.createMessage>) => {
      if (++creates === 2) throw new Error("disk full");
      return chats.createMessage(...args);
    }) as typeof chats.createMessage,
  };
  await assert.rejects(
    saveGeneratedReply(context({ chats: failing, advancedMemoryEnabled: true }), whole),
    /disk full/,
  );
  assert.equal(creates, 2);
  assert.equal((await chats.listMessages(chat.id)).length, 4);

  // An owner turn without World Maps is rejected over SSE, then thrown.
  const transition = {
    destinationId: "loc_b",
    expectedDefinitionRevision: 1,
    expectedCurrentLocationId: "loc_a",
    commandId: "cmd_1",
  };
  const ownerInput = { ...context().input, impersonate: true, pendingSpatialTransition: transition };
  events.length = 0;
  await assert.rejects(saveGeneratedReply(context({ input: ownerInput }), "I walk."), SpatialOwnerTurnError);
  assert.deepEqual(
    events.map((event) => [event.type, (event.data as { code?: string }).code]),
    [["spatial_transition_rejected", "spatial_feature_unavailable"]],
  );

  // An owner turn already applied is recovered: its saved content replaces the reply, before the commit event.
  // A committed owner turn is saved at swipe 0 and announced with its location.
  let unregister = registerCapabilityService("hierarchical-maps:owner-turn", {
    commitSpatialOwnerTurn: async () => ({
      message: { id: "msg_owner", content: "I walk." },
      snapshot: { currentLocationId: "loc_b", definitionRevision: 2 },
    }),
  });
  events.length = 0;
  const committed = await saveGeneratedReply(context({ input: ownerInput }), "I walk.");
  unregister();
  assert.deepEqual([committed.savedMsg.id, committed.savedSwipeIndex], ["msg_owner", 0]);
  assert.deepEqual(events, [
    {
      type: "spatial_transition_committed",
      data: { chatId: chat.id, commandId: "cmd_1", currentLocationId: "loc_b", definitionRevision: 2 },
    },
  ]);

  const applied = await chats.createMessage({ chatId: chat.id, role: "user", characterId: null, content: "I walked." });
  unregister = registerCapabilityService("hierarchical-maps:owner-turn", {
    commitSpatialOwnerTurn: async () => {
      throw new SpatialOwnerTurnError("spatial_transition_already_applied", "Already applied.", 409, {
        messageId: applied.id,
        snapshot: { messageId: applied.id, swipeIndex: 0, currentLocationId: "loc_b", definitionRevision: 2 } as never,
      });
    },
  });
  events.length = 0;
  const recovered = await saveGeneratedReply(context({ input: ownerInput }), "I walk.");
  unregister();
  assert.equal(recovered.recoveredSpatialTurn, true);
  assert.equal(recovered.savedMsg.id, applied.id);
  assert.equal(recovered.fullResponse, "I walked.");
  assert.equal(recovered.savedSwipeIndex, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    ["content_replace", "spatial_transition_committed"],
  );
  assert.equal(events[0]!.data, "I walked.");
  assert.deepEqual(events[1]!.data, {
    chatId: chat.id,
    commandId: "cmd_1",
    currentLocationId: "loc_b",
    definitionRevision: 2,
  });
} finally {
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}

console.log("generate-save-generated-reply regression passed");
