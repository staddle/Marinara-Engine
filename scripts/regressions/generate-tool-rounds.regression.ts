import assert from "node:assert/strict";
import { GenerationStreamOutput } from "../../packages/server/src/routes/generate/generation-stream-output.js";
import { createGenerationEventSink } from "../../packages/server/src/routes/generate/sse.js";
import { runToolRounds, type ToolRoundsContext } from "../../packages/server/src/routes/generate/tool-rounds.js";
import type { ChatMessage, ChatOptions } from "../../packages/server/src/services/llm/base-provider.js";

// Pins the tool-call rounds moved out of generate.routes.ts (#7573).

type Step = (
  messages: ChatMessage[],
  options: ChatOptions,
) => Promise<Awaited<ReturnType<ToolRoundsContext["provider"]["chatComplete"]>>>;

function setup(steps: Step[], overrides: Partial<ToolRoundsContext> = {}) {
  const events: Array<Record<string, unknown>> = [];
  const calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  const executed: string[][] = [];
  const controller = new AbortController();
  const sink = createGenerationEventSink({ onEvent: (payload) => events.push(payload), onFinish: () => {} });
  const ctx: ToolRoundsContext = {
    provider: {
      async chatComplete(messages, options) {
        calls.push({ messages: [...messages], options });
        const step = steps.shift();
        assert.ok(step, "no more provider requests were expected");
        return step(messages, options);
      },
    },
    requestOptions: () => ({ model: "fixture" }),
    streaming: true,
    signal: controller.signal,
    timeoutMs: 10_000,
    stream: new GenerationStreamOutput(sink, false, null, null),
    output: sink,
    chatMode: "conversation",
    impersonate: false,
    roleplayRollEnabled: false,
    gameToolPlan: null,
    maxToolRounds: 3,
    initialMessages: [{ role: "user", content: "Go." }],
    assistantPrefillInjected: false,
    tools: [
      { type: "function", function: { name: "lookup", description: "", parameters: {} } },
    ] as ChatOptions["tools"],
    toolChoice: () => "auto" as ChatOptions["toolChoice"],
    debugMode: true,
    allowedToolNames: new Set(["lookup", "roll_dice"]),
    usageProvider: () => "openai",
    fit: async (messages) => messages,
    rememberPromptPreview: () => {},
    logPrompt: () => {},
    recordLongTermMemoryPrompt: async () => {},
    recordUsage: () => {},
    executeTools: async (toolCalls) => {
      executed.push(toolCalls.map((call) => `${call.function.name}(${call.function.arguments})`));
      return toolCalls.map((call) => ({
        toolCallId: call.id,
        name: call.function.name,
        result:
          call.function.name === "roll_dice"
            ? JSON.stringify({ notation: "1d20+3", rolls: [12], modifier: 3, total: 15 })
            : '{"found":true}',
        success: true,
      }));
    },
    roleplayActivity: [],
    roleplayInlinePrefixes: new Map(),
    toolDiceRollResults: [],
    pendingGameStateToolCalls: [],
    getCharacter: async () => null,
    sendAgentResult: () => {},
    ...overrides,
  };
  return { ctx, events, calls, executed, controller };
}

const lookupCall = { id: "c1", type: "function" as const, function: { name: "lookup", arguments: "{}" } };

// (a) A tool call streamed as text is taken back out with content_replace; the prose is written again.
{
  const { ctx, events, calls, executed } = setup([
    async (_messages, options) => {
      await options.onToken!("Hi ");
      await options.onToken!('<tool_call>{"name":"lookup"}</tool_call>');
      return { content: "Hi ", toolCalls: [lookupCall], finishReason: "tool_calls" };
    },
    async (_messages, options) => {
      await options.onToken!("Done.");
      return { content: "Done.", toolCalls: [], finishReason: "stop" };
    },
  ]);
  const outcome = await runToolRounds(ctx, "Pre. ");
  assert.equal(outcome.aborted, false);
  assert.equal(outcome.fullResponse, "Pre. Hi Done.");
  assert.deepEqual(
    events.filter((event) => event.type === "content_replace"),
    [{ type: "content_replace", data: "Pre. " }],
  );
  assert.deepEqual(executed, [["lookup({})"]]);
  assert.equal(events.filter((event) => event.type === "tool_result").length, 1);
  assert.equal(calls[1]!.options.toolChoice, "auto");
  assert.equal(calls[1]!.options.debugMode, true);
  assert.equal(calls[1]!.messages.at(-1)?.role, "tool");
  if (!outcome.aborted) assert.equal(outcome.finishReason, "stop");
}

// (b) An abort mid-request ends the rounds; the text streamed so far is kept.
{
  const { ctx, controller } = setup([
    async (_messages, options) => {
      await options.onToken!("Partial");
      controller.abort();
      await options.onToken!(" never");
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  ]);
  const outcome = await runToolRounds(ctx, "Start ");
  assert.deepEqual(outcome, { aborted: true, fullResponse: "Start Partial" });
}

// (c) A roleplay [roll:] cuts the stream: the round's signal aborts and a roll_dice call is made from the text.
{
  let roundSignal: AbortSignal | undefined;
  const { ctx, events, calls, executed } = setup(
    [
      async (_messages, options) => {
        roundSignal = options.signal;
        await options.onToken!("I try the lock. ");
        await options.onToken!('[roll: notation="1d20+3", reason="Need 15"]');
        assert.equal(options.signal?.aborted, true, "the roll stops the request");
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
      async (_messages, options) => {
        await options.onToken!(" It opens.");
        return { content: " It opens.", toolCalls: [], finishReason: "stop" };
      },
    ],
    { chatMode: "roleplay", roleplayRollEnabled: true },
  );
  const outcome = await runToolRounds(ctx, "");
  assert.equal(outcome.aborted, false);
  assert.ok(roundSignal && roundSignal !== ctx.signal);
  assert.equal(ctx.signal.aborted, false, "the generation itself goes on");
  assert.equal(executed.length, 1);
  assert.match(executed[0]![0]!, /^roll_dice\(.*"notation":"1d20\+3".*"reason":"Need 15"/);
  assert.equal(ctx.roleplayActivity[0]?.raw, '[roll: notation="1d20+3", reason="Need 15"]');
  assert.equal(ctx.toolDiceRollResults[0]?.total, 15);
  const toolResult = events.find((event) => event.type === "tool_result") as { data: Record<string, unknown> };
  assert.equal(toolResult.data.mode, "roleplay");
  assert.ok(toolResult.data.diceRollResult);
  assert.match(String(calls[1]!.messages.at(-1)?.content), /^The engine resolved your roll request:/);
  assert.equal(outcome.fullResponse, 'I try the lock. [roll: notation="1d20+3", reason="Need 15"] It opens.');
}

// (d) The final follow-up sends no tools, tool choice or debug mode, and cuts a roll it may not make.
{
  const { ctx, events, calls } = setup(
    [
      async () => ({ content: null, toolCalls: [lookupCall], finishReason: "tool_calls" }),
      async () => ({
        content: 'The end. [roll: notation="1d6", reason="more"]',
        toolCalls: [],
        finishReason: "stop",
      }),
    ],
    { chatMode: "roleplay", roleplayRollEnabled: true, maxToolRounds: 1, streaming: false },
  );
  const outcome = await runToolRounds(ctx, "");
  assert.equal(calls.length, 2);
  const finalOptions = calls[1]!.options;
  for (const key of ["tools", "toolChoice", "debugMode"])
    assert.ok(!(key in finalOptions), `final round sends no ${key}`);
  assert.equal(finalOptions.signal, ctx.signal, "the final round uses the generation signal alone");
  assert.equal(finalOptions.onToken, undefined);
  assert.deepEqual(
    events.filter((event) => event.type === "roleplay_command_error"),
    [{ type: "roleplay_command_error", data: { rollLimit: true } }],
  );
  assert.equal(outcome.fullResponse, "The end. ");
}

// (e) A Game tool plan runs once without a provider request or usage; its results go before the prefill.
{
  let usageRecords = 0;
  const { ctx, calls, executed } = setup([], {
    chatMode: "game",
    maxToolRounds: 1,
    gameToolPlan: { toolCalls: [lookupCall] } as ToolRoundsContext["gameToolPlan"],
    assistantPrefillInjected: true,
    initialMessages: [
      { role: "user", content: "Go." },
      { role: "assistant", content: "Prefill" },
    ],
    recordUsage: () => {
      usageRecords += 1;
    },
  });
  const outcome = await runToolRounds(ctx, "");
  assert.equal(calls.length, 0, "the plan is executed, not requested again");
  assert.equal(usageRecords, 0, "the planning pass owns its usage");
  assert.deepEqual(executed, [["lookup({})"]]);
  assert.equal(outcome.aborted, false);
  if (!outcome.aborted) {
    assert.equal(outcome.narratorMessages.at(-1)?.content, "Prefill");
    assert.match(String(outcome.narratorMessages.at(-2)?.content), /^The engine ran a separate tool-planning pass/);
  }
}

console.info("Generate tool-rounds regression passed.");
