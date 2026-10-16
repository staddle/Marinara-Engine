// The reason text is shared so the client-side reply checkup (diagnoseReply) can reuse it.
export {
  GENERIC_EMPTY_RESPONSE_MESSAGE,
  describeEmptyModelResponse,
  type EmptyResponseContext,
} from "@marinara-engine/shared";

/** Endings that mean a reply was cut off, stopped, blocked or handed to a tool before it was finished. */
const UNFINISHED_FINISH_REASONS = new Set(["length", "abort", "error", "content_filter", "refusal", "tool_calls"]);

/**
 * Whether a reply ended before it was finished. Any other ending counts as finished: OpenAI's "stop",
 * Anthropic's own "end_turn" or "stop_sequence" (passed through as is), or none at all. Callers that asked for a
 * format judge the reply by whether it has that format, not by how the provider named its ending.
 */
export function replyUnfinished(finishReason: string | null | undefined): boolean {
  return !!finishReason && UNFINISHED_FINISH_REASONS.has(finishReason);
}

/**
 * The output budget that actually went to the provider. Routes compute
 * max_tokens before the connection-level override is applied; the provider
 * caps it on the way out (BaseLLMProvider.applyMaxTokensCap). Quote the capped
 * number, or "16 of 4096" is what the user reads when 16 is what was sent.
 */
export function sentOutputBudget(
  maxTokens: number | null | undefined,
  maxTokensOverride: number | null | undefined,
): number | undefined {
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0) return undefined;
  if (typeof maxTokensOverride === "number" && Number.isFinite(maxTokensOverride) && maxTokensOverride > 0) {
    return Math.min(maxTokens, Math.floor(maxTokensOverride));
  }
  return maxTokens;
}
