// Clock tags carry requests only. Outcomes are always written by the Engine.
import { readGmTagAttributes } from "./skill-check-tag.js";

const MAX_CLOCK_TAG_BODY = 600;
export function createClockCommandTagRegex(): RegExp {
  return new RegExp(`\\[clock:([^\\]]{0,${MAX_CLOCK_TAG_BODY}})\\]`, "gi");
}

export type ClockCommand = { name: string } & ({ size: number } | { tick: number } | { clear: true });

export function parseClockCommandTagBody(body: string): ClockCommand | null {
  if (body.length > MAX_CLOCK_TAG_BODY) return null;
  const attributes = readGmTagAttributes(body);
  const values = new Map<string, string>();
  let bare = "";
  let end = 0;
  for (const attribute of attributes) {
    bare += body.slice(end, attribute.start);
    end = attribute.end;
    const key = attribute.key.toLowerCase();
    if (!["name", "size", "tick"].includes(key)) continue;
    if (values.has(key)) return null;
    values.set(key, attribute.rawValue.replace(/^['"]|['"]$/g, "").trim());
  }
  bare += body.slice(end);
  const clear = /(?:^|\s)clear(?:\s|$)/i.test(bare);
  const name = values.get("name");
  if (!name || name.length > 100 || /\{\{|\}\}/.test(name) || /[\p{Cc}\p{Zl}\p{Zp}"[\]]/u.test(name)) return null;
  if (Number(values.has("size")) + Number(values.has("tick")) + Number(clear) !== 1) return null;
  if (clear) return { name, clear: true };
  const key = values.has("size") ? "size" : "tick";
  const value = values.get(key)!;
  if (!/^[+-]?\d{1,9}$/.test(value)) return null;
  return key === "size" ? { name, size: Number(value) } : { name, tick: Number(value) };
}

export type ClockCommandOutcome = { ok: true; now: string } | { ok: false; reason: string };

export function serializeClockCommandTag(command: ClockCommand | null, outcome: ClockCommandOutcome): string {
  const parts: string[] = [];
  const attribute = (key: string, value: string | number) => {
    const safe = String(value)
      .replace(/[\p{Cc}\p{Zl}\p{Zp}"[\]]/gu, " ")
      .slice(0, 120);
    parts.push(`${key}="${safe}"`);
  };
  if (command) {
    attribute("name", command.name);
    if ("size" in command) attribute("size", command.size);
    else if ("tick" in command) attribute("tick", command.tick);
    else parts.push("clear");
  }
  attribute("result", outcome.ok ? "ok" : "refused");
  if (outcome.ok) attribute("now", outcome.now);
  else attribute("reason", outcome.reason);
  return `[clock: ${parts.join(" ")}]`;
}

export function stripClockCommandTags(text: string): string {
  return text.replace(
    new RegExp(`([^\\S\\r\\n]?)\\[clock:[^\\]]{0,${MAX_CLOCK_TAG_BODY}}\\]([^\\S\\r\\n]?)`, "gi"),
    (_match, before: string, after: string) => (before && after ? " " : ""),
  );
}
