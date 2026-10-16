import assert from "node:assert/strict";
import { GenerationStreamOutput } from "../../packages/server/src/routes/generate/generation-stream-output.js";
import { createGenerationEventSink } from "../../packages/server/src/routes/generate/sse.js";
import { RoleplayCommandStreamFilter } from "../../packages/server/src/services/generation/roleplay-commands.js";
import { createGameChanceStreamFilter } from "../../packages/server/src/services/game/chance-stream-filter.js";
import { createAssistantSpatialDirectiveStreamFilter } from "../../packages/server/src/services/spatial-context/state-resolution.js";

// Pins the token output chain moved out of generate.routes.ts (#7573).

function setup(options: { hold?: boolean; chance?: boolean; spatial?: boolean } = {}) {
  const tokens: string[] = [];
  const sink = createGenerationEventSink({
    onEvent: (payload) => {
      if (payload.type === "token") tokens.push(String(payload.data));
    },
    onFinish: () => {},
  });
  const output = new GenerationStreamOutput(
    sink,
    options.hold ?? false,
    options.chance ? createGameChanceStreamFilter() : null,
    options.spatial ? createAssistantSpatialDirectiveStreamFilter() : null,
  );
  return { output, tokens };
}

// Tokens go out in 6-character chunks.
{
  const { output, tokens } = setup();
  await output.write("abcdefghijklm");
  await output.flush();
  assert.deepEqual(tokens, ["abcdef", "ghijkl", "m"]);
}

// Roleplay: the command filter sits in the chain, in front of the spatial filter.
{
  const { output, tokens } = setup({ spatial: true });
  output.roleplayCommandFilter = new RoleplayCommandStreamFilter(false);
  for (const chunk of ["She waits. [illus", "trate: a smile] ", "Then [spatial_move: Forest]", " done."]) {
    await output.write(chunk);
  }
  await output.flush();
  assert.equal(tokens.join(""), "She waits.  Then  done.");
}

// Game: the dice span and the spatial directive stay hidden.
{
  const { output, tokens } = setup({ chance: true, spatial: true });
  for (const chunk of ["You roll [[roll: 2d", "6+3]] and ", "walk on. [spatial_move: Forest]", " Done."]) {
    await output.write(chunk);
  }
  await output.flush();
  const visible = tokens.join("");
  assert.doesNotMatch(visible, /roll:|spatial_move/);
  assert.match(visible, /^You roll +and walk on\. +Done\.$/);
}

// The chance filter's leftovers still pass the spatial filter on flush.
{
  const { output, tokens } = setup({ chance: true, spatial: true });
  await output.write("Ends with [spatial_move: Cave]");
  await output.write(" and [[");
  await output.flush();
  assert.equal(tokens.join(""), "Ends with  and [[");
}

// A text-rewrite chat streams nothing and flushes nothing, but still times the reasoning.
{
  const { output, tokens } = setup({ hold: true, chance: true });
  output.receivedThinking = true;
  output.generationStartedAt = Date.now() - 50;
  await output.write("   ");
  assert.equal(output.reasoningDurationMs, null, "whitespace is not visible output");
  await output.write("Hello [[");
  await output.flush();
  assert.deepEqual(tokens, []);
  assert.ok(output.reasoningDurationMs !== null && output.reasoningDurationMs >= 50);
  const first = output.reasoningDurationMs;
  await output.write("more");
  assert.equal(output.reasoningDurationMs, first, "the clock stops at the first visible output");
  output.resetReasoningClock();
  assert.equal(output.reasoningDurationMs, null);
  assert.equal(output.receivedThinking, false);
}

// No thinking, no reasoning duration.
{
  const { output } = setup();
  output.generationStartedAt = Date.now();
  await output.write("Hello");
  assert.equal(output.reasoningDurationMs, null);
}

console.log("Generation stream output: chunks, filter chain, flush and text-rewrite hold are pinned.");
