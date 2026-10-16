import { z } from "zod";
import { promptSafeText, type RulesetDefinition } from "../../schemas/ruleset.schema.js";
import {
  createClockCommandTagRegex,
  parseClockCommandTagBody,
  serializeClockCommandTag,
  type ClockCommandOutcome,
} from "../../utils/clock-command-tag.js";

const clockName = z
  .string()
  .trim()
  .pipe(promptSafeText(100))
  .refine((name) => !/["[\]]/.test(name));
const nameKey = (name: string) => name.trim().toLowerCase();
export const rulesetClocksSchema = z
  .array(
    z
      .object({
        name: clockName,
        size: z.number().int().min(2).max(12),
        filled: z.number().int().min(0).max(12),
      })
      .strict()
      .refine((clock) => clock.filled <= clock.size, "Clock fill exceeds its size"),
  )
  .max(12)
  .refine(
    (clocks) => new Set(clocks.map((clock) => nameKey(clock.name))).size === clocks.length,
    "Clock names must be unique",
  );
export type RulesetClocks = z.infer<typeof rulesetClocksSchema>;

/** Apply commands in reply order without mutating the starting snapshot. Filled clocks remain
 *  until cleared, so completion stays visible and a later negative tick can reopen one. */
export function applyClockCommandTags(
  content: string,
  definition: RulesetDefinition,
  base: RulesetClocks | null | undefined,
): { content: string; clocks: RulesetClocks; outcomes: ClockCommandOutcome[] } {
  const parsed = rulesetClocksSchema.safeParse(base ?? []);
  const clocks = parsed.success ? parsed.data : [];
  const outcomes: ClockCommandOutcome[] = [];
  let seen = 0;
  const rewritten = content.replace(createClockCommandTagRegex(), (_tag, body: string) => {
    const command = parseClockCommandTagBody(body);
    const apply = (): ClockCommandOutcome => {
      if (++seen > 40) return { ok: false, reason: "too-many-commands" };
      if (!definition.clocks) return { ok: false, reason: "clocks-disabled" };
      if (!command) return { ok: false, reason: "bad-command" };
      const index = clocks.findIndex((clock) => nameKey(clock.name) === nameKey(command.name));
      if ("size" in command) {
        if (!definition.clocks.sizes.includes(command.size)) return { ok: false, reason: "size-not-allowed" };
        if (index >= 0) return { ok: false, reason: "name-exists" };
        if (clocks.length >= definition.clocks.max) return { ok: false, reason: "max-clocks" };
        clocks.push({ name: command.name, size: command.size, filled: 0 });
        return { ok: true, now: `0/${command.size}` };
      }
      const clock = clocks[index];
      if (!clock) return { ok: false, reason: "unknown-clock" };
      if ("clear" in command) {
        clocks.splice(index, 1);
        return { ok: true, now: "cleared" };
      }
      clock.filled = Math.max(0, Math.min(clock.size, clock.filled + command.tick));
      return { ok: true, now: `${clock.filled}/${clock.size}` };
    };
    const outcome = apply();
    outcomes.push(outcome);
    return serializeClockCommandTag(command, outcome);
  });
  return { content: rewritten, clocks, outcomes };
}
