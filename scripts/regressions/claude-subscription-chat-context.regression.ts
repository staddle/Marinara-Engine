import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../../packages/server/src/lib/logger.js";
import {
  __setSdkForTesting,
  assertChatContextPlugin,
  ClaudeSubscriptionProvider,
} from "../../packages/server/src/services/llm/providers/claude-subscription.provider.js";
import { register } from "../../packages/server/src/assets/claude-code-plugin/hooks/register.mjs";

// The provider presets the session title (no hidden naming request) and loads the chat-context mod.
let sdkOptions: Record<string, unknown> = {};
let pluginErrors: unknown[] = [];
const warnings: string[] = [];
const originalWarn = logger.warn;
logger.warn = ((_data: unknown, message: string) => void warnings.push(message)) as typeof logger.warn;
__setSdkForTesting({
  query: ((args: { options: Record<string, unknown> }) => {
    sdkOptions = args.options;
    return (async function* () {
      yield {
        type: "system",
        subtype: "init",
        tools: [],
        mcp_servers: [],
        skills: [],
        plugins: [],
        slash_commands: [],
        plugin_errors: pluginErrors,
      };
      yield { type: "result", subtype: "success", result: "Reply", usage: {} };
    })();
  }) as never,
});
const provider = new ClaudeSubscriptionProvider("", "");
const chat = () => provider.chatComplete([{ role: "user", content: "Hello" }], { model: "claude-opus-5" });
try {
  await chat();
  assert.equal(sdkOptions.title, "Title", "a preset title skips the CLI's hidden session-naming request");
  const plugins = sdkOptions.plugins as Array<{ type: string; path: string }>;
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0]!.type, "local");

  // The plugin is complete where the provider points, so it ships with the build.
  const pluginDir = plugins[0]!.path;
  assertChatContextPlugin(pluginDir);
  const hooks = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8")) as { modules: string[] };
  assert.deepEqual(hooks.modules, ["./register.mjs"]);

  // Without the plugin's files, a request fails before anything is sent.
  const emptyDir = mkdtempSync(join(tmpdir(), "marinara-chat-context-"));
  try {
    assert.throws(() => assertChatContextPlugin(emptyDir), /hooks\/register\.mjs/);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }

  // Only the mod's own load errors warn; a built-in plugin's error doesn't.
  pluginErrors = [{ plugin: "cc-plugin-telemetry@builtin", type: "generic-error", message: "boom" }];
  await chat();
  assert.deepEqual(warnings, []);
  pluginErrors = [{ plugin: "inline[0]", type: "path-not-found", message: "missing", path: pluginDir }];
  await chat();
  pluginErrors = [{ plugin: "marinara-chat-context@inline", type: "hook-load-failed", message: "syntax" }];
  await chat();
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /chat-context mod failed to load/);
} finally {
  logger.warn = originalWarn;
  __setSdkForTesting(null);
}

// The mod drops every attachment Claude Code adds, without handing it on.
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
register((event: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(event, handler));
assert.deepEqual([...handlers.keys()], ["prompt.attachment"]);
const next = () => assert.fail("an attachment must not reach Claude Code's default handler");
for (const type of ["session_context", "context_sections", "environment", "model", "date", "total_tokens_reminder"]) {
  assert.deepEqual(await handlers.get("prompt.attachment")!({}, { type }, next), { text: null }, type);
}

console.log("Claude subscription chat-context regression passed");
