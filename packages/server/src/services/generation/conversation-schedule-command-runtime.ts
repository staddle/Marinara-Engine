import {
  getActiveStatusOverride,
  getEffectiveCurrentStatus,
  type ConversationStatusOverride,
  type WeekSchedule,
} from "@marinara-engine/shared";
import { currentRoomGeneration } from "../multiplayer/generation-policy.js";
import { resolveConversationTimeZone, toZonedWallClockDate } from "../conversation/timezone.js";
import {
  parseDuration,
  type CharacterCommand,
  type ScheduleUpdateCommand,
} from "../conversation/character-commands.js";
import { logger } from "../../lib/logger.js";
import { getEnabledConversationSchedules } from "./conversation-context-utils.js";

type ChatsStore = {
  getById(id: string): Promise<{ metadata?: unknown } | null>;
  patchMetadata?(id: string, updater: (metadata: Record<string, unknown>) => Record<string, unknown>): Promise<unknown>;
  resolveConversationPresenceState(id: string): Promise<{
    schedules: Record<string, WeekSchedule>;
    statusOverrides: Record<string, ConversationStatusOverride>;
  }>;
};

type CharactersStore = {
  update(
    id: string,
    data: { extensions: { conversationStatusOverride: ConversationStatusOverride } },
    avatarPath?: string,
    options?: { skipVersionSnapshot?: boolean },
  ): Promise<unknown>;
};

type ScheduleBlock = {
  time: string;
  activity: string;
  status: string;
};

type WeekScheduleRecord = {
  days?: Record<string, ScheduleBlock[]>;
};

const DAYS_LIST = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
/** Used when the model leaves out the duration or writes one we cannot read. */
const DEFAULT_STATUS_MINUTES = 60;
/** Keeps a runaway duration from pinning a status for weeks (or overflowing the date). */
const MAX_STATUS_MINUTES = 7 * 24 * 60;

export async function handleConversationScheduleCommand(args: {
  command: CharacterCommand;
  characterId: string | null;
  chatId: string;
  chats: ChatsStore;
  characters: CharactersStore;
  sendUpdated: (data: Record<string, unknown>) => void;
}): Promise<boolean> {
  if (args.command.type !== "schedule_update") return false;
  const command = args.command as ScheduleUpdateCommand;
  if (!args.characterId) return true;
  if (!command.status && !command.activity) {
    logger.warn("[commands] Ignored a schedule_update from %s without a valid status or activity", args.characterId);
    return true;
  }
  const room = currentRoomGeneration();
  if (!room) return applyCharacterStatusCommand(args, args.characterId, command);
  if (room.signal?.aborted) return false;
  if (room.chatId !== args.chatId || !room.characterIds.includes(args.characterId) || !args.chats.patchMetadata)
    return false;

  // Shared rooms keep their own copy of each routine and never touch the
  // character card, so the command edits the room's current schedule block.
  const characterId = args.characterId;
  const updateSchedule = (metadata: Record<string, unknown>) => {
    const schedules = getEnabledConversationSchedules(metadata) as Record<string, WeekScheduleRecord>;
    const schedule = schedules[characterId];
    if (!schedule) return null;
    const nowDate = toZonedWallClockDate(new Date(), resolveConversationTimeZone(metadata));
    const dayName = DAYS_LIST[(nowDate.getDay() + 6) % 7]!;
    const daySchedule = schedule.days?.[dayName] ?? [];
    if (!updateCurrentScheduleBlock(daySchedule, nowDate.getHours() * 60 + nowDate.getMinutes(), command)) return null;
    schedule.days = { ...(schedule.days ?? {}), [dayName]: daySchedule };
    schedules[characterId] = schedule;
    return { characterSchedules: schedules };
  };
  let updated = false;
  await args.chats.patchMetadata(args.chatId, (metadata) => {
    const active = parseRecord(metadata.multiplayer);
    if (room.signal?.aborted || active?.status !== "active" || active.epoch !== room.epoch) return {};
    const patch = updateSchedule(metadata);
    updated = !!patch;
    return patch ?? {};
  });
  if (!updated) return true;

  args.sendUpdated({ characterId: args.characterId, status: command.status, activity: command.activity });
  logger.info(
    "[commands] Schedule updated for %s: status=%s, activity=%s",
    args.characterId,
    command.status,
    command.activity,
  );

  return true;
}

/**
 * Outside shared rooms the character card owns presence, and the chat's
 * schedule map is only a cache that the next presence read replaces. So the
 * command sets a temporary status override on the card, the same record the
 * presence card and /status write, and lets it expire after the duration.
 */
async function applyCharacterStatusCommand(
  args: {
    chatId: string;
    chats: ChatsStore;
    characters: CharactersStore;
    sendUpdated: (data: Record<string, unknown>) => void;
  },
  characterId: string,
  command: ScheduleUpdateCommand,
): Promise<boolean> {
  const now = new Date();
  const presence = await args.chats.resolveConversationPresenceState(args.chatId);
  const current = presence.statusOverrides[characterId];
  // A status the user set by hand has no end time, and it stays in charge.
  if (getActiveStatusOverride(current, now) && !current?.expiresAt) {
    logger.info("[commands] Kept the manual status for %s and ignored its schedule_update", characterId);
    return true;
  }

  let status = command.status;
  if (!status) {
    const meta = parseRecord((await args.chats.getById(args.chatId))?.metadata) ?? {};
    const scheduleNow = toZonedWallClockDate(now, resolveConversationTimeZone(meta));
    status = getEffectiveCurrentStatus(presence.schedules[characterId], current, now, "free time", scheduleNow).status;
  }
  const parsedMinutes = command.duration ? parseDuration(command.duration) : null;
  if (command.duration && parsedMinutes === null) {
    logger.warn(
      "[commands] Unreadable schedule_update duration from %s; using %d minutes",
      characterId,
      DEFAULT_STATUS_MINUTES,
    );
  }
  const minutes = Math.min(parsedMinutes ?? DEFAULT_STATUS_MINUTES, MAX_STATUS_MINUTES);
  const override: ConversationStatusOverride = {
    status,
    activity: command.activity?.trim() || null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
  };
  const saved = await args.characters.update(
    characterId,
    { extensions: { conversationStatusOverride: override } },
    undefined,
    { skipVersionSnapshot: true },
  );
  if (!saved) return true;
  // Refresh this chat's cached copy so the client shows the change right away.
  await args.chats.resolveConversationPresenceState(args.chatId);

  args.sendUpdated({ characterId, status, activity: override.activity, expiresAt: override.expiresAt });
  logger.info(
    "[commands] Status updated for %s: status=%s, activity=%s, minutes=%d",
    characterId,
    status,
    override.activity,
    minutes,
  );
  return true;
}

function updateCurrentScheduleBlock(
  daySchedule: ScheduleBlock[],
  currentMinutes: number,
  command: ScheduleUpdateCommand,
): boolean {
  for (const block of daySchedule) {
    const [startStr, endStr] = block.time.split("-");
    if (!startStr || !endStr) continue;
    const [sh, sm] = startStr.split(":").map(Number);
    const [eh, em] = endStr.split(":").map(Number);
    if (![sh, sm, eh, em].every((part) => Number.isFinite(part))) continue;
    const startMin = (sh ?? 0) * 60 + (sm ?? 0);
    const endMin = (eh ?? 0) * 60 + (em ?? 0);
    if (startMin > currentMinutes || currentMinutes >= endMin) continue;

    if (command.status) block.status = command.status;
    if (command.activity) block.activity = command.activity;

    if (command.duration) {
      const durationMin = parseDuration(command.duration);
      if (durationMin && currentMinutes + durationMin < endMin) {
        const splitTime = currentMinutes + durationMin;
        const splitH = String(Math.floor(splitTime / 60)).padStart(2, "0");
        const splitM = String(splitTime % 60).padStart(2, "0");
        block.time = `${startStr}-${splitH}:${splitM}`;
        const idx = daySchedule.indexOf(block);
        daySchedule.splice(idx + 1, 0, {
          time: `${splitH}:${splitM}-${endStr}`,
          activity: "free time",
          status: "online",
        });
      }
    }
    return true;
  }
  return false;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
