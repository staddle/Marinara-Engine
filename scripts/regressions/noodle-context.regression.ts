// Guards the character and lorebook context carried by Noodle timeline refresh prompts.
//
// A Noodle account keeps its own name and handle, so an account whose character card has gone
// away still renders in "Active Noodle Accounts" while contributing no character card and no
// lorebook scope. Generation then runs on names alone, with no error anywhere.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-noodle-context-"));
process.env.FILE_STORAGE_DIR = storageDir;

const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { eq } = await import("../../packages/server/src/db/file-query.js");
const { characters } = await import("../../packages/server/src/db/schema/characters.js");
const { lorebooks, lorebookEntries } = await import("../../packages/server/src/db/schema/lorebooks.js");
const { createNoodleStorage } = await import("../../packages/server/src/services/storage/noodle.storage.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createPromptOverridesStorage } = await import(
  "../../packages/server/src/services/storage/prompt-overrides.storage.js"
);
const { buildRefreshPrompt } = await import("../../packages/server/src/services/noodle/noodle-public-prompt.service.js");
const { filterResolvableNoodleParticipants } = await import(
  "../../packages/server/src/services/noodle/noodle-public-support.js"
);

type AnyDb = Awaited<ReturnType<typeof createFileNativeDB>>;

try {
  const db = (await createFileNativeDB()) as AnyDb;
  const timestamp = new Date().toISOString();

  await db.insert(characters).values({
    id: "char-luke",
    data: JSON.stringify({
      name: "Luke Skywalker",
      description: "A Jedi from Tatooine who pilots an X-wing for the Rebel Alliance.",
      personality: "earnest, impulsive, hopeful",
    }),
    comment: "",
    avatarPath: null,
    spriteFolderPath: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await db.insert(lorebooks).values({
    id: "lb-sw",
    name: "Star Wars",
    characterId: "char-luke",
    isGlobal: "false",
    enabled: "true",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await db.insert(lorebookEntries).values({
    id: "lbe-tatooine",
    lorebookId: "lb-sw",
    name: "Tatooine",
    content: "Tatooine is a binary-star desert world in the Outer Rim.",
    keys: JSON.stringify(["tatooine"]),
    enabled: "true",
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const noodle = createNoodleStorage(db as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const characterStore = createCharactersStorage(db as any);
  const account = await noodle.upsertAccountFromProfile({
    kind: "character",
    entityId: "char-luke",
    displayName: "Luke Skywalker",
    bio: "Jedi in training",
    invited: true,
    syncIdentity: true,
  });
  await noodle.createPost({
    authorKind: "character",
    authorEntityId: "char-luke",
    content: "Another dusty morning on Tatooine. The suns are brutal today.",
  });

  const settings = await noodle.updateSettings({ enableLorebookContext: true });
  const buildPrompt = async () =>
    buildRefreshPrompt({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: db as any,
      noodle,
      characters: characterStore,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chats: createChatsStorage(db as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      promptOverrides: createPromptOverridesStorage(db as any),
      activeAccounts: [account],
      personaAccount: null,
      settings,
      imageCaptioning: { enabled: false, connection: null, model: "", prompt: "" },
      debugMode: false,
    });

  // A healthy account carries its character card and activates character-scoped lorebook entries.
  const healthy = await buildPrompt();
  assert.match(healthy.textOnlyPromptForLog, /<character name="Luke Skywalker">/);
  assert.match(healthy.textOnlyPromptForLog, /Description: A Jedi from Tatooine/);
  assert.match(healthy.textOnlyPromptForLog, /# World \/ Lore/);
  assert.deepEqual(healthy.lorebookActivatedEntryIds, ["lbe-tatooine"]);

  // Every invited character account resolves, so none are treated as stale.
  const healthyParticipants = await filterResolvableNoodleParticipants([account], characterStore);
  assert.deepEqual(healthyParticipants.staleAccounts, []);
  assert.equal(healthyParticipants.resolvable.length, 1);

  // Drop the character card while leaving the Noodle account in place. This is what a deleted
  // character or a profile import (which mints new character IDs) leaves behind.
  await db.delete(characters).where(eq(characters.id, "char-luke"));

  // The prompt degrades exactly as reported: the account name survives, the card and lore vanish.
  const stalePrompt = await buildPrompt();
  assert.match(stalePrompt.textOnlyPromptForLog, /Luke Skywalker \(@luke_skywalker\)/);
  assert.doesNotMatch(stalePrompt.textOnlyPromptForLog, /<character name=/);
  assert.doesNotMatch(stalePrompt.textOnlyPromptForLog, /# World \/ Lore/);
  assert.deepEqual(stalePrompt.lorebookActivatedEntryIds, []);

  // So the stale account must be dropped before participants are chosen.
  const staleParticipants = await filterResolvableNoodleParticipants([account], characterStore);
  assert.deepEqual(staleParticipants.resolvable, []);
  assert.deepEqual(
    staleParticipants.staleAccounts.map((entry) => entry.entityId),
    ["char-luke"],
  );

  // Non-character accounts have no character card to resolve and are always kept.
  const randomUser = await noodle.upsertAccountFromProfile({
    kind: "random_user",
    entityId: "random_user:thread-countess",
    displayName: "Thread Countess",
    invited: true,
  });
  const mixed = await filterResolvableNoodleParticipants([account, randomUser], characterStore);
  assert.deepEqual(
    mixed.resolvable.map((entry) => entry.entityId),
    ["random_user:thread-countess"],
  );

  await db._fileStore.close();
} finally {
  rmSync(storageDir, { recursive: true, force: true });
}

process.stdout.write("Noodle context regression passed.\n");
