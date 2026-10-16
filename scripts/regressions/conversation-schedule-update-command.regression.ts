// A character's [schedule_update: ...] command must change that character's
// live Conversation status (#7230). The character card owns presence, so the
// command sets a temporary status override on the card that expires, instead
// of editing the chat's schedule cache, which the next presence read replaces.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WeekSchedule } from "../../packages/shared/src/utils/conversation-presence.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-schedule-update-command-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.MARINARA_LITE = "true";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MINUTE = 60_000;

function currentWeekStart(): string {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString();
}

/** An all-day "online" routine, so any status change must come from the command. */
function allDayOnlineSchedule(): WeekSchedule {
  return {
    weekStart: currentWeekStart(),
    days: Object.fromEntries(
      DAYS.map((day) => [
        day,
        [
          { time: "00:00-12:00", activity: "free time", status: "online" as const },
          { time: "12:00-00:00", activity: "free time", status: "online" as const },
        ],
      ]),
    ),
    inactivityThresholdMinutes: 90,
    talkativeness: 50,
  };
}

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");

try {
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
  const { parseCharacterCommands, parseDuration } =
    await import("../../packages/server/src/services/conversation/character-commands.js");
  const { handleConversationScheduleCommand } =
    await import("../../packages/server/src/services/generation/conversation-schedule-command-runtime.js");
  const { getEffectiveCurrentStatus } = await import("../../packages/shared/src/utils/conversation-presence.js");

  const db = await getDB();
  const chats = createChatsStorage(db);
  const characters = createCharactersStorage(db);

  const setup = async (name: string, schedule?: WeekSchedule) => {
    const character = await characters.create({ name, description: "", personality: "" } as never);
    assert.ok(character, `${name} was created`);
    if (schedule) {
      await characters.update(character!.id, { extensions: { conversationSchedule: schedule } } as never, undefined, {
        skipVersionSnapshot: true,
      });
    }
    const chat = await chats.create({
      name: `${name} chat`,
      mode: "conversation",
      characterIds: [character!.id],
    } as never);
    assert.ok(chat, `${name} chat was created`);
    return { characterId: character!.id, chatId: chat!.id };
  };

  const run = async (characterId: string, chatId: string, reply: string) => {
    const updates: Array<Record<string, unknown>> = [];
    const parsed = parseCharacterCommands(reply);
    for (const command of parsed.commands) {
      await handleConversationScheduleCommand({
        command,
        characterId,
        chatId,
        chats,
        characters,
        sendUpdated: (data) => updates.push(data),
      } as never);
    }
    return { parsed, updates };
  };

  const presenceAt = async (characterId: string, chatId: string, at: Date) => {
    const { schedules, statusOverrides } = await chats.resolveConversationPresenceState(chatId);
    return {
      override: statusOverrides[characterId],
      current: getEffectiveCurrentStatus(schedules[characterId], statusOverrides[characterId], at),
    };
  };

  // ── 1. A scheduled character: the command beats the routine and then expires ──
  const routine = allDayOnlineSchedule();
  const scheduled = await setup("Mira", routine);
  const before = Date.now();
  const { parsed, updates } = await run(
    scheduled.characterId,
    scheduled.chatId,
    'Okay, heads down for a bit.\n[schedule_update: status="dnd", activity="Busy", duration="1h"]',
  );
  assert.equal(parsed.cleanContent, "Okay, heads down for a bit.", "the command is stripped from the reply");
  const after = await presenceAt(scheduled.characterId, scheduled.chatId, new Date());
  assert.deepEqual(
    { status: after.current.status, activity: after.current.activity },
    { status: "dnd", activity: "Busy" },
    "the command changes the character's live status and activity",
  );
  const expiresAt = Date.parse(after.override?.expiresAt ?? "");
  assert.ok(
    expiresAt >= before + 60 * MINUTE && expiresAt <= Date.now() + 60 * MINUTE,
    "the change lasts for the requested hour",
  );
  assert.equal(
    (await presenceAt(scheduled.characterId, scheduled.chatId, new Date(expiresAt + MINUTE))).current.status,
    "online",
    "the character returns to its routine once the duration ends",
  );
  assert.deepEqual(
    JSON.parse((await characters.getById(scheduled.characterId))!.data as string).extensions.conversationSchedule,
    routine,
    "the weekly routine itself is left untouched",
  );
  assert.deepEqual(updates, [
    { characterId: scheduled.characterId, status: "dnd", activity: "Busy", expiresAt: after.override?.expiresAt },
  ]);
  const cachedMeta = JSON.parse((await chats.getById(scheduled.chatId))!.metadata as string);
  assert.equal(
    cachedMeta.conversationStatusOverrides?.[scheduled.characterId]?.status,
    "dnd",
    "the chat's presence cache is refreshed for the client",
  );

  // ── 2. A character without a schedule, with other duration spellings ──
  const unscheduled = await setup("Rowan");
  await run(unscheduled.characterId, unscheduled.chatId, '[schedule_update: status="offline", duration="1.5h"]');
  const offline = await presenceAt(unscheduled.characterId, unscheduled.chatId, new Date());
  assert.equal(offline.current.status, "offline", "a character without a schedule can change its status");
  const offlineMinutes = (Date.parse(offline.override!.expiresAt!) - Date.parse(offline.override!.createdAt)) / MINUTE;
  assert.equal(offlineMinutes, 90, "decimal hours are read as hours");

  await run(unscheduled.characterId, unscheduled.chatId, '[schedule_update: activity="Reading", duration="2"]');
  const reading = await presenceAt(unscheduled.characterId, unscheduled.chatId, new Date());
  assert.deepEqual(
    { status: reading.current.status, activity: reading.current.activity },
    { status: "offline", activity: "Reading" },
    "an activity-only update keeps the current status",
  );
  assert.equal(
    (Date.parse(reading.override!.expiresAt!) - Date.parse(reading.override!.createdAt)) / MINUTE,
    120,
    "a bare number is read as hours",
  );

  // Other duration spellings a model is likely to write.
  for (const [duration, minutes] of [
    ["1h", 60],
    ["90m", 90],
    ["1 hour", 60],
    ["2 hours", 120],
    ["30 minutes", 30],
    ["1h30m", 90],
    ["1 hour 30 minutes", 90],
    ["2hrs", 120],
    ["45 mins", 45],
    ["1.5m", 2],
  ] as const) {
    assert.equal(parseDuration(duration), minutes, `"${duration}" lasts ${minutes} minutes`);
  }
  assert.equal(parseDuration("2 months"), null, "a unit that is not hours or minutes is not read as minutes");

  // ── 3. Invalid arguments are stripped without crashing or changing anything ──
  const invalid = await run(
    unscheduled.characterId,
    unscheduled.chatId,
    'Hmm.[schedule_update: status="sleeping"][schedule_update: mood="tired"]',
  );
  assert.equal(invalid.parsed.cleanContent, "Hmm.", "invalid commands are still stripped");
  assert.deepEqual(invalid.updates, [], "invalid commands report no update");
  assert.deepEqual(
    (await presenceAt(unscheduled.characterId, unscheduled.chatId, new Date())).override,
    reading.override,
    "invalid commands leave the current status alone",
  );

  const garbled = await run(
    unscheduled.characterId,
    unscheduled.chatId,
    '[schedule_update: status="idle", duration="until later"]',
  );
  assert.equal(garbled.updates.length, 1, "an unreadable duration still applies the status");
  const idle = await presenceAt(unscheduled.characterId, unscheduled.chatId, new Date());
  assert.equal(idle.current.status, "idle");
  assert.equal(
    (Date.parse(idle.override!.expiresAt!) - Date.parse(idle.override!.createdAt)) / MINUTE,
    60,
    "an unreadable duration falls back to one hour",
  );

  // ── 4. A status the user set by hand stays in charge ──
  const manual = { status: "offline", activity: "Away", createdAt: new Date().toISOString(), expiresAt: null };
  await characters.update(
    scheduled.characterId,
    { extensions: { conversationStatusOverride: manual } } as never,
    undefined,
    { skipVersionSnapshot: true },
  );
  const manualRun = await run(scheduled.characterId, scheduled.chatId, '[schedule_update: status="online"]');
  assert.deepEqual(manualRun.updates, [], "the character does not replace the user's manual status");
  assert.deepEqual(
    (await presenceAt(scheduled.characterId, scheduled.chatId, new Date())).override,
    manual,
    "the user's manual status is kept",
  );
} finally {
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write("Conversation schedule_update command regression passed.\n");
