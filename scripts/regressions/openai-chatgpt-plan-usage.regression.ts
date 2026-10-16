// The ChatGPT plan usage reading. Nobody on the team can read a live answer
// without a Codex login, so the fixture follows the payload the Codex CLI's own
// backend client decodes (`RateLimitStatusPayload`, codex-rs/backend-client).
import assert from "node:assert/strict";
import { normalizeOpenAIChatGPTPlanUsage } from "../../packages/server/src/services/llm/openai-chatgpt-usage.js";

const answer = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42,
      limit_window_seconds: 18_000,
      reset_after_seconds: 3_600,
      reset_at: 1_791_559_200,
    },
    secondary_window: {
      used_percent: 84,
      limit_window_seconds: 604_800,
      reset_after_seconds: 90_000,
      reset_at: 1_791_950_400,
    },
  },
  additional_rate_limits: null,
  credits: { has_credits: false, unlimited: false, balance: null },
};

const usage = normalizeOpenAIChatGPTPlanUsage(answer);
assert.equal(usage?.provider, "openai_chatgpt");
assert.equal(usage?.plan, "plus");
assert.deepEqual(
  usage?.windows.map((window) => window.id),
  ["five_hour", "seven_day"],
);
// The endpoint reports 0-100 and epoch seconds; the widget reads fractions and milliseconds.
assert.equal(usage?.windows[0]?.percentUsed, 0.42);
assert.equal(usage?.windows[0]?.resetAt, 1_791_559_200_000);
assert.equal(usage?.windows[1]?.percentUsed, 0.84);
assert.equal(usage?.windows[0]?.used, null);

// The windows are sorted by their length, not by their slot: a plan whose only
// window is the weekly one reports it as primary.
const weeklyOnly = normalizeOpenAIChatGPTPlanUsage({
  plan_type: "free",
  rate_limit: { primary_window: answer.rate_limit.secondary_window, secondary_window: null },
});
assert.deepEqual(
  weeklyOnly?.windows.map((window) => window.id),
  ["seven_day"],
);

// The 5-hour bar always comes first, whichever slot it arrived in.
const swapped = normalizeOpenAIChatGPTPlanUsage({
  plan_type: "pro",
  rate_limit: {
    primary_window: answer.rate_limit.secondary_window,
    secondary_window: answer.rate_limit.primary_window,
  },
});
assert.deepEqual(
  swapped?.windows.map((window) => window.id),
  ["five_hour", "seven_day"],
);

// Unknown is not zero, and a zero reset time is not a date.
const unknown = normalizeOpenAIChatGPTPlanUsage({
  rate_limit: { primary_window: { used_percent: "42", limit_window_seconds: 18_000, reset_at: 0 } },
});
assert.equal(unknown?.plan, null);
assert.equal(unknown?.windows[0]?.percentUsed, null);
assert.equal(unknown?.windows[0]?.resetAt, null);

// No rate-limit block means there is nothing to read; an empty one has no windows.
assert.equal(normalizeOpenAIChatGPTPlanUsage({ plan_type: "plus", rate_limit: null }), null);
assert.equal(normalizeOpenAIChatGPTPlanUsage(null), null);
assert.deepEqual(normalizeOpenAIChatGPTPlanUsage({ rate_limit: {} })?.windows, []);

console.info("[regression] openai chatgpt plan usage: windows by length, fractions, unknowns OK");
