import assert from "node:assert/strict";
import { buildGenerationInfoExtra } from "../../packages/server/src/routes/generate/saved-message-extra.js";
import { GAME_MARKET_PLACE_EXTRA } from "../../packages/server/src/services/game/game-market.service.js";

// Pins the saved reply's generation-info extra moved out of generate.routes.ts (#7573).

type Input = Parameters<typeof buildGenerationInfoExtra>[0];

const absent: Input = {
  chatMode: "roleplay",
  gameOutcomeNarrationFailed: false,
  marketWorldPlace: undefined,
  gameToolPlan: null,
  gameToolConnection: null,
  generationProviderOrigin: { model: "m-1", provider: "openai" },
  temperature: undefined,
  effectiveMaxTokensForSend: undefined,
  suppressModelParameters: false,
  effectiveMaxContext: undefined,
  connectionMaxContext: undefined,
  showThoughts: undefined,
  resolvedEffort: undefined,
  reasoningEffort: null,
  verbosity: null,
  serviceTier: null,
  assistantPrefill: "",
  assistantReasoningPrefill: "",
  customParameters: {},
  usage: undefined,
  tokensContext: null,
  tokensLastRequestInput: null,
  requestCount: 0,
  durationMs: 5,
  reasoningDurationMs: null,
  finishReason: undefined,
  lastContextFit: undefined,
  fullThinking: "",
  geminiResponseParts: null,
  chatCompletionsReasoning: null,
  encryptedReasoningItems: [],
  contextInjections: [],
};

// Absent values are stored as null, never left out, so a regenerated swipe clears the previous swipe's.
assert.deepEqual(buildGenerationInfoExtra(absent), {
  generationInfo: {
    model: "m-1",
    provider: "openai",
    temperature: null,
    maxTokens: null,
    maxContext: null,
    showThoughts: null,
    reasoningEffort: null,
    verbosity: null,
    serviceTier: null,
    assistantPrefill: null,
    assistantReasoningPrefill: null,
    customParameters: null,
    tokensPrompt: null,
    tokensContext: null,
    tokensLastRequestInput: null,
    requestCount: 0,
    tokensCompletion: null,
    tokensVisibleCompletion: null,
    tokensReasoning: null,
    tokensCompletionAudio: null,
    tokensRejectedPrediction: null,
    tokensAcceptedPrediction: null,
    tokensCachedPrompt: null,
    tokensCacheWritePrompt: null,
    durationMs: 5,
    reasoningDurationMs: null,
    finishReason: null,
    contextFit: null,
  },
  thinking: null,
  geminiParts: null,
  chatCompletionsReasoning: null,
  encryptedReasoning: null,
  contextInjections: null,
});
assert.equal(buildGenerationInfoExtra({ ...absent, encryptedReasoningItems: undefined }).encryptedReasoning, null);

// Present values pass through, and the game-only keys appear in Game mode.
const usage = {
  promptTokens: 100,
  completionTokens: 40,
  completionReasoningTokens: 10,
  cachedPromptTokens: 20,
  cacheWritePromptTokens: 5,
};
const injections = [{ agentId: "a", text: "guidance" }];
const present = buildGenerationInfoExtra({
  ...absent,
  chatMode: "game",
  gameOutcomeNarrationFailed: true,
  marketWorldPlace: "bazaar",
  gameToolPlan: { usage: { promptTokens: 7, completionTokens: 3 } },
  gameToolConnection: { id: "conn-tools", model: "planner", provider: "openai" },
  temperature: 0.7,
  effectiveMaxTokensForSend: 512,
  effectiveMaxContext: 8000,
  connectionMaxContext: 16000,
  showThoughts: true,
  resolvedEffort: "high",
  reasoningEffort: "low",
  verbosity: "medium",
  serviceTier: "flex",
  assistantPrefill: "Sure",
  assistantReasoningPrefill: "Think",
  customParameters: { top_a: 0.1 },
  usage,
  tokensContext: 90,
  tokensLastRequestInput: 80,
  requestCount: 2,
  reasoningDurationMs: 1234,
  finishReason: "stop",
  lastContextFit: { trimmed: 0 },
  fullThinking: "hmm",
  geminiResponseParts: [{ thought: true }],
  chatCompletionsReasoning: { reasoning_content: "r" },
  encryptedReasoningItems: [{ id: "rs_1" }],
  contextInjections: injections,
});
assert.deepEqual(Object.keys(present), [
  "gameOutcomeNarrationFailed",
  GAME_MARKET_PLACE_EXTRA,
  "gameToolPlanning",
  "generationInfo",
  "thinking",
  "geminiParts",
  "chatCompletionsReasoning",
  "encryptedReasoning",
  "contextInjections",
]);
assert.equal(present.gameOutcomeNarrationFailed, true);
assert.equal(present[GAME_MARKET_PLACE_EXTRA], "bazaar");
assert.deepEqual(present.gameToolPlanning, {
  connectionId: "conn-tools",
  model: "planner",
  provider: "openai",
  usage: { promptTokens: 7, completionTokens: 3 },
});
assert.deepEqual(present.generationInfo, {
  model: "m-1",
  provider: "openai",
  temperature: 0.7,
  maxTokens: 512,
  maxContext: 8000,
  showThoughts: true,
  reasoningEffort: "high",
  verbosity: "medium",
  serviceTier: "flex",
  assistantPrefill: "Sure",
  assistantReasoningPrefill: "Think",
  customParameters: { top_a: 0.1 },
  tokensPrompt: 100,
  tokensContext: 90,
  tokensLastRequestInput: 80,
  requestCount: 2,
  tokensCompletion: 40,
  tokensVisibleCompletion: 30,
  tokensReasoning: 10,
  tokensCompletionAudio: null,
  tokensRejectedPrediction: null,
  tokensAcceptedPrediction: null,
  tokensCachedPrompt: 20,
  tokensCacheWritePrompt: 5,
  durationMs: 5,
  reasoningDurationMs: 1234,
  finishReason: "stop",
  contextFit: { trimmed: 0 },
});
assert.equal(present.thinking, "hmm");
assert.deepEqual(present.geminiParts, [{ thought: true }]);
assert.deepEqual(present.chatCompletionsReasoning, { reasoning_content: "r" });
assert.deepEqual(present.encryptedReasoning, [{ id: "rs_1" }]);
assert.equal(present.contextInjections, injections);

// A Game regeneration without a world-set market place clears the saved one.
assert.equal(buildGenerationInfoExtra({ ...absent, chatMode: "game" })[GAME_MARKET_PLACE_EXTRA], null);
// The tool-planning record needs both the plan and its connection.
assert.equal("gameToolPlanning" in buildGenerationInfoExtra({ ...absent, gameToolPlan: { usage } }), false);

// maxContext falls back to the connection's, and is null when model parameters are suppressed.
const info = (o: Partial<Input>) =>
  buildGenerationInfoExtra({ ...absent, ...o }).generationInfo as Record<string, unknown>;
assert.equal(info({ connectionMaxContext: 16000 }).maxContext, 16000);
assert.equal(info({ effectiveMaxContext: 8000, suppressModelParameters: true }).maxContext, null);
assert.equal(info({ resolvedEffort: null, reasoningEffort: "low" }).reasoningEffort, "low");

console.log("generate saved message extra regression passed");
