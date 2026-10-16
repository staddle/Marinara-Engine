import { BaseLLMProvider, type ChatMessage, type ChatOptions, type LLMUsage } from "./base-provider.js";

/**
 * A provider whose reply is already written (Capability API 1.339): a defined Game Master intro is the
 * game's first message exactly as set, so the turn streams it instead of asking a model. Everything the
 * reply goes through after (its tags, the story, the scene) is as for any other.
 */
export function fixedTextProvider(text: string, like: BaseLLMProvider): BaseLLMProvider {
  class FixedTextProvider extends BaseLLMProvider {
    constructor() {
      super("", "", like.maxContextValue ?? undefined, null, like.maxTokensOverrideValue);
    }

    async *chat(_messages: ChatMessage[], _options: ChatOptions): AsyncGenerator<string, LLMUsage | void, unknown> {
      yield text;
    }

    override embed(texts: string[], model: string, signal?: AbortSignal) {
      return like.embed(texts, model, signal);
    }
  }
  return new FixedTextProvider();
}
