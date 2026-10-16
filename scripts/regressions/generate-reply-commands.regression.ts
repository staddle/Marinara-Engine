import assert from "node:assert/strict";
import {
  parseConversationReplyCommands,
  parseRoleplayDmReplyCommands,
} from "../../packages/server/src/routes/generate/reply-commands.js";
import { replaceBuiltInAgentDefinitions } from "../../packages/shared/dist/index.js";

// Pins the reply command parsing moved out of generate.routes.ts (#7573).

// [selfie] is an Illustrator command: it only counts while that package is installed.
replaceBuiltInAgentDefinitions([
  {
    id: "illustrator",
    name: "Illustrator",
    description: "Selfie fixture",
    phase: "post_processing",
    enabledByDefault: true,
    category: "utility",
    defaultTools: [],
    defaultSettings: {},
    defaultPromptTemplate: "",
  },
]);

const charInfo = [
  { id: "char-1", name: "Alice" },
  { id: "char-2", name: "Bob" },
];
const selfieMeta = { imageGenConnectionId: "image-default" };

// Merged group: each speaker's selfie is credited to that speaker.
{
  const text = 'Alice: Here I am. [selfie: context="beach"]\nBob: Me too! [selfie: context="park"]';
  const parsed = parseConversationReplyCommands(text, {
    chatId: "chat-1",
    chatMeta: selfieMeta,
    charInfo,
    targetCharId: "char-1",
    speakerAttribution: true,
  });
  assert.equal(parsed.rawCount, 2);
  assert.deepEqual(
    parsed.commands.map((command) => command.type),
    ["selfie", "selfie"],
  );
  assert.deepEqual(parsed.commandCharacterIds, ["char-1", "char-2"], "each selfie belongs to its speaker");
  assert.equal(parsed.commandContent, text.trim(), "command content is the pre-parse reply");
  assert.equal(parsed.changed, true);
  assert.doesNotMatch(parsed.text, /\[selfie/u);
}

// Without speaker attribution there is no per-command id list.
{
  const parsed = parseConversationReplyCommands("Hi [selfie]", {
    chatId: "chat-1",
    chatMeta: selfieMeta,
    charInfo,
    targetCharId: "char-1",
    speakerAttribution: false,
  });
  assert.equal(parsed.commandCharacterIds, null);
  assert.equal(parsed.commands.length, 1);
}

// Implicit selfie: no command written, but the reply claims a photo the user asked for.
{
  const text = "Sure, I just took a selfie at the beach for you!";
  const options = {
    chatId: "chat-1",
    chatMeta: selfieMeta,
    charInfo,
    targetCharId: "char-2",
    latestUserMessage: "Can you send me a selfie?",
  };
  const plain = parseConversationReplyCommands(text, { ...options, speakerAttribution: false });
  assert.equal(plain.changed, false);
  assert.equal(plain.rawCount, 0);
  assert.equal(plain.text, text);
  assert.deepEqual(
    plain.commands.map((command) => command.type),
    ["selfie"],
  );
  assert.equal(plain.commandContent, null, "a recovered selfie does not set command content");
  assert.equal(plain.commandCharacterIds, null, "no id list is created for a recovered selfie alone");

  // With an attributed id list, the recovered selfie is credited to the target.
  const withList = parseConversationReplyCommands("Bob: [react: 😀] I just took a selfie for you!", {
    ...options,
    speakerAttribution: true,
  });
  assert.deepEqual(
    withList.commands.map((command) => command.type),
    ["react", "selfie"],
  );
  assert.deepEqual(withList.commandCharacterIds, ["char-2", "char-2"], "the recovered selfie falls back to the target");

  const noImageGen = parseConversationReplyCommands(text, { ...options, chatMeta: {}, speakerAttribution: false });
  assert.deepEqual(noImageGen.commands, [], "no recovery without an image generation connection");
}

// Disabled commands are stripped from the text but leave no command content.
{
  const parsed = parseConversationReplyCommands("Hello there. [selfie]", {
    chatId: "chat-1",
    chatMeta: { ...selfieMeta, conversationCommandToggles: { selfie: false } },
    charInfo,
    targetCharId: "char-1",
    speakerAttribution: true,
  });
  assert.equal(parsed.rawCount, 1);
  assert.deepEqual(parsed.commands, []);
  assert.equal(parsed.commandContent, null);
  assert.equal(parsed.commandCharacterIds, null);
  assert.equal(parsed.changed, true);
  assert.equal(parsed.text, "Hello there.");
}

// Roleplay DM: a card target runs, a cardless target falls back to plain text.
{
  let listed = 0;
  const listCharacters = async () => {
    listed += 1;
    return [{ id: "char-3", data: JSON.stringify({ name: "Carol" }) }];
  };
  const parsed = await parseRoleplayDmReplyCommands(
    'She waves.\n[dm: character="Carol" message="Meet me later."]\n[dm: character="Stranger" message="Who are you?"]',
    { charInfo, listCharacters },
  );
  assert.equal(listed, 1);
  assert.equal(parsed.changed, true);
  assert.deepEqual(
    parsed.commands.map((command) => [command.resolvedCharacterId, command.resolvedCharacterName]),
    [["char-3", "Carol"]],
  );
  assert.deepEqual(
    parsed.activity.map((item) => item.command),
    [{ type: "dm", character: "Carol", message: "Meet me later." }],
  );
  assert.equal(parsed.text, 'She waves.\n\nStranger: "Who are you?"', "cardless target gets the fallback text");

  const none = await parseRoleplayDmReplyCommands("No messages here.\n\n\n", { charInfo, listCharacters });
  assert.equal(listed, 1, "listCharacters is not called without DM commands");
  assert.deepEqual(none, { text: "No messages here.\n\n\n", changed: false, commands: [], activity: [] });
}

console.log("generate reply commands regression passed");
