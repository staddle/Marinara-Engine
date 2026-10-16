import assert from "node:assert/strict";
import type { Persona } from "@marinara-engine/shared";
import { api } from "../../packages/client/src/lib/api-client.js";
import { prepareUserInputMessage } from "../../packages/client/src/lib/chat-macros.js";
import { matchSlashCommand, type SlashCommandContext } from "../../packages/client/src/lib/slash-commands.js";

// #7585: /send must store what a normal send stores. A raw {{random}} left in the stored
// message rolls again for the model while the chat shows a different word.
const colours = ["red", "green", "blue", "yellow", "cyan", "magenta"];
const typed = `Reply with the following word: {{random::${colours.join("::")}}}, {{user}}`;
const characters = [{ id: "mira", data: { name: "Mira" } }];
const personas = [{ id: "pat", name: "Pat", isActive: true }] as Persona[];
const chat = { characterIds: ["mira"], personaId: "pat", mode: "roleplay", metadata: {} as Record<string, unknown> };

const regexCalls: Array<{ text: string; resolvesMacros: boolean }> = [];
let translationErrors = 0;
// The same call the Roleplay and Conversation composers make for Send, Post Only and /send.
const prepareUserMessage = (text: string) =>
  prepareUserInputMessage(text, {
    chat,
    characters,
    personas,
    applyToUserInput: (value, options) => {
      regexCalls.push({ text: value, resolvesMacros: options.resolveMacros("{{user}}") === "Pat" });
      return value.replace("following", "next");
    },
    onTranslationError: () => {
      translationErrors += 1;
    },
  });

const created: Array<{ role: string; content: string; characterId?: string | null }> = [];
const context: SlashCommandContext = {
  chatId: "send-chat",
  mode: "roleplay",
  characterNames: ["Mira"],
  invalidate: () => {},
  generate: async () => assert.fail("a posting command must not start a generation"),
  createMessage: async (data) => {
    created.push(data);
  },
  prepareUserMessage,
};

async function runSend(commandLine: string): Promise<string> {
  const match = matchSlashCommand(commandLine, { mode: "roleplay" });
  assert.equal(match?.command.name, "send");
  created.length = 0;
  assert.deepEqual(await match.command.execute(match.args, context), { handled: true });
  assert.equal(created.length, 1);
  assert.equal(created[0]!.role, "user");
  assert.equal(created[0]!.characterId, null);
  return created[0]!.content;
}

const originalRandom = Math.random;
const originalPost = api.post;
const originalSetTimeout = globalThis.setTimeout;
try {
  for (const roll of [0, 0.2, 0.99]) {
    Math.random = () => roll;
    const normalSend = await prepareUserMessage(typed);
    const pick = colours[Math.floor(roll * colours.length)];
    assert.equal(normalSend, `Reply with the next word: ${pick}, Pat`);
    for (const commandLine of [`/send ${typed}`, `/send "${typed}"`]) {
      assert.equal(await runSend(commandLine), normalSend, `${commandLine} stores the normal-send text`);
    }
  }
  assert.ok(regexCalls.length > 0 && regexCalls.every((call) => call.text === typed && call.resolvesMacros));

  // Input translation runs on /send too, before the final macro pass.
  chat.metadata = { translateInput: true };
  const translations: string[] = [];
  api.post = (async (path: string, body: { text: string }) => {
    assert.equal(path, "/translate");
    translations.push(body.text);
    return { translatedText: body.text.replace("Reply with the next word", "Responde con la palabra") };
  }) as typeof api.post;
  Math.random = () => 0;
  assert.equal(await runSend(`/send ${typed}`), "Responde con la palabra: red, Pat");
  assert.deepEqual(translations, [typed.replace("following", "next")]);

  api.post = (async () => {
    throw new Error("translator offline");
  }) as typeof api.post;
  assert.equal(await runSend(`/send ${typed}`), "Reply with the next word: red, Pat");
  assert.equal(translationErrors, 1, "a failed translation reports once and posts the original");

  // /remind posts the user's own typed text later, inside a narrator message. Left raw, its
  // {{random}} showed one word in the chat and gave the model another, and the toast showed
  // {{user}}. It is stored as a normal send stores it, so every place shows the same text.
  chat.metadata = {};
  const match = matchSlashCommand(`/remind 30m ${typed}`, { mode: "roleplay" });
  assert.equal(match?.command.name, "remind");
  const timers: Array<{ callback: () => Promise<void>; ms: number }> = [];
  const posted: Array<{ path: string; body: { role: string; content: string } }> = [];
  api.post = (async (path: string, body: { role: string; content: string }) => {
    posted.push({ path, body });
    return {};
  }) as typeof api.post;
  globalThis.setTimeout = ((callback: () => Promise<void>, ms: number) => {
    timers.push({ callback, ms });
    return 0;
  }) as unknown as typeof setTimeout;
  let feedback: string | undefined;
  created.length = 0;
  try {
    feedback = (await match.command.execute(match.args, context)).feedback;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, 30 * 60_000);
  await timers[0]!.callback();
  const reminded = "Reply with the next word: red, Pat";
  assert.deepEqual(posted, [
    { path: "/chats/send-chat/messages", body: { role: "narrator", content: `⏰ **Reminder:** ${reminded}` } },
  ]);
  assert.match(feedback ?? "", new RegExp(`: "${reminded}"`, "u"), "the confirmation shows the stored text");
  assert.equal(created.length, 0, "the reminder is the only message /remind posts");
} finally {
  Math.random = originalRandom;
  api.post = originalPost;
  globalThis.setTimeout = originalSetTimeout;
}

console.info("/send and /remind macro regressions passed.");
