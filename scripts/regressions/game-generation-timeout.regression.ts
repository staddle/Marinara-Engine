import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// #7177: Game Master calls (new-game setup and the other Game routes) wait as long as the Text
// generation timeout says, not a fixed 5 minutes, and a reasoning model's thinking counts as
// progress. The setting's floor is 10 s, so 10 s and 20 s stand in for any value up to an hour.
process.env.CHAT_GENERATION_TIMEOUT_MS = "10000";
const { runGameChatComplete } = await import("../../packages/server/src/routes/game.routes.js");
const { createLLMProvider } = await import("../../packages/server/src/services/llm/provider-registry.js");

const QUIET_MS = 12_000; // past a 10 s setting, within a 20 s one
const chunk = (delta: Record<string, string>, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

// Streams `beat` every second, then the reply. Fixed routes and delays only.
function streamReply(response: ServerResponse, beat: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.flushHeaders();
  const beats = setInterval(() => response.write(beat), 1_000);
  const reply = setTimeout(() => {
    clearInterval(beats);
    response.end(chunk({ content: "done" }, "stop") + "data: [DONE]\n\n");
  }, QUIET_MS);
  response.on("close", () => {
    clearInterval(beats);
    clearTimeout(reply);
  });
}

const server = createServer((request, response) => {
  request.resume();
  switch (request.url) {
    // No output for 12 s. SSE comments keep the socket busy, so only the Game wait can end it.
    case "/stalled/chat/completions":
      return streamReply(response, ": keep-alive\n\n");
    // A reasoning model (llama.cpp reasoning_content) thinking for 12 s before its first token.
    case "/thinking/chat/completions":
      return streamReply(response, chunk({ reasoning_content: "thinking " }));
    default:
      response.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address() as AddressInfo;

// By default like Game setup with streaming on: content tokens arrive through onToken. `totalCapMs` is
// like the image-prompt calls: no onToken and a fixed cap, on a provider that streams anyway.
const generate = (route: string, totalCapMs?: number) => {
  const provider = createLLMProvider("custom", `http://127.0.0.1:${port}/${route}`, "", null, null, null, false, true);
  const started = Date.now();
  return runGameChatComplete(
    provider,
    [{ role: "user", content: "Set up the game." }],
    { model: "qwen-reasoner", stream: true, ...(totalCapMs ? {} : { onToken: () => undefined }) },
    "Game setup",
    totalCapMs,
  ).then(
    (result) => ({ content: result.content, error: null, seconds: (Date.now() - started) / 1000 }),
    (error: Error) => ({ content: null, error, seconds: (Date.now() - started) / 1000 }),
  );
};

try {
  // Each call reads the setting when it starts, so these run side by side.
  const stalledAtTen = generate("stalled");
  const thinkingAtTen = generate("thinking");
  process.env.CHAT_GENERATION_TIMEOUT_MS = "20000";
  const stalledAtTwenty = generate("stalled");
  const thinkingUnderTotalCap = generate("thinking", 10_000);
  const [shorter, thinking, longer, capped] = await Promise.all([
    stalledAtTen,
    thinkingAtTen,
    stalledAtTwenty,
    thinkingUnderTotalCap,
  ]);

  assert.equal(shorter.error?.name, "GameGenerationTimeoutError", "a 10 s setting ends a 12 s silence");
  assert.match(shorter.error.message, /^Game setup timed out after 10 seconds$/);
  assert.ok(shorter.seconds < QUIET_MS / 1000, `it ends at the setting, not later (${shorter.seconds}s)`);

  assert.equal(longer.error, null, "a 20 s setting waits through the same 12 s silence");
  assert.equal(longer.content, "done");

  assert.equal(thinking.error, null, "12 s of thinking under a 10 s setting is progress, not silence");
  assert.equal(thinking.content, "done");

  assert.equal(capped.error?.name, "GameGenerationTimeoutError", "thinking does not stretch a fixed total cap");
  assert.ok(capped.seconds < QUIET_MS / 1000, `the total cap ends it on time (${capped.seconds}s)`);
  console.log("Game generations follow the Text generation timeout, and thinking counts as progress.");
} finally {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}
