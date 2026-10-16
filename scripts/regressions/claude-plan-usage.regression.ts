// The Claude plan usage reading, as the Agent SDK's experimental usage call
// reports it. The fixture is trimmed from a real answer for a Pro login.
import assert from "node:assert/strict";
import { normalizeClaudePlanUsage } from "../../packages/server/src/services/llm/providers/claude-subscription/plan-usage.js";

const answer = {
  subscription_type: "pro",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 58, resets_at: "2026-10-09T15:20:00.280835+00:00" },
    seven_day: { utilization: 44, resets_at: "2026-10-14T04:00:00.280858+00:00" },
    seven_day_opus: null,
    extra_usage: { is_enabled: false },
  },
};

const usage = normalizeClaudePlanUsage(answer);
assert.equal(usage?.provider, "claude_subscription");
assert.equal(usage?.plan, "pro");
assert.deepEqual(
  usage?.windows.map((window) => window.id),
  ["five_hour", "seven_day"],
);
// The SDK reports 0-100; the widget's windows carry fractions, like NanoGPT's.
assert.equal(usage?.windows[0]?.percentUsed, 0.58);
assert.equal(usage?.windows[0]?.resetAt, Date.parse("2026-10-09T15:20:00.280835+00:00"));
// The plan reports no counts, and the widget reads null counts as "none to show".
assert.equal(usage?.windows[0]?.used, null);
assert.equal(usage?.windows[0]?.remaining, null);

// API-key billing and logins without a plan have no windows to read.
assert.equal(normalizeClaudePlanUsage({ ...answer, rate_limits_available: false, rate_limits: null }), null);
assert.equal(normalizeClaudePlanUsage({ ...answer, rate_limits: null }), null);
assert.equal(normalizeClaudePlanUsage(null), null);
assert.equal(normalizeClaudePlanUsage("nope"), null);

// A window the plan does not report is left out, not drawn as unused.
const weeklyOnly = normalizeClaudePlanUsage({
  ...answer,
  rate_limits: { five_hour: null, seven_day: answer.rate_limits.seven_day },
});
assert.deepEqual(
  weeklyOnly?.windows.map((window) => window.id),
  ["seven_day"],
);

// Unknown is not zero: a window without a reading keeps a null percentage.
const unknown = normalizeClaudePlanUsage({
  ...answer,
  rate_limits: { five_hour: { utilization: null, resets_at: null } },
});
assert.equal(unknown?.windows[0]?.percentUsed, null);
assert.equal(unknown?.windows[0]?.resetAt, null);
const garbled = normalizeClaudePlanUsage({
  ...answer,
  rate_limits: { five_hour: { utilization: "58", resets_at: "not a date" } },
});
assert.equal(garbled?.windows[0]?.percentUsed, null);
assert.equal(garbled?.windows[0]?.resetAt, null);

console.info("[regression] claude plan usage: windows, fractions, unavailable plans OK");
