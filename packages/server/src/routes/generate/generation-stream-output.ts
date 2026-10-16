import { yieldToEventLoop } from "../../services/llm/base-provider.js";
import type { RoleplayCommandStreamFilter } from "../../services/generation/roleplay-commands.js";
import type { AssistantSpatialDirectiveStreamFilter } from "../../services/spatial-context/state-resolution.js";
import type { GameChanceStreamFilter } from "../../services/game/chance-stream-filter.js";
import { sendSseEvent, type GenerationOutput } from "./sse.js";

const TOKEN_CHUNK_SIZE = 6;
const TOKEN_CHUNK_YIELD_EVERY = 64;

/**
 * The token output chain of one generation: the roleplay command, chance and spatial
 * stream filters, the small SSE token chunks, and the reasoning-duration clock.
 *
 * The filters run in a fixed order (command → chance → spatial) so text a filter
 * releases still meets every filter downstream of it. A chat with a text-rewrite agent
 * (`holdForTextRewrite`) streams no tokens at all: the finished text arrives through
 * the rewrite frame instead, so the filters stay inert there.
 */
export class GenerationStreamOutput {
  /** Recreated per tool round and per rollback; null outside unfiltered roleplay. */
  roleplayCommandFilter: RoleplayCommandStreamFilter | null = null;
  generationStartedAt: number | null = null;
  reasoningDurationMs: number | null = null;
  receivedThinking = false;
  private tokenChunksSinceYield = 0;

  constructor(
    private readonly output: GenerationOutput,
    readonly holdForTextRewrite: boolean,
    private readonly gameChanceFilter: GameChanceStreamFilter | null,
    private readonly spatialDirectiveFilter: AssistantSpatialDirectiveStreamFilter | null,
  ) {}

  resetReasoningClock() {
    this.generationStartedAt = null;
    this.reasoningDurationMs = null;
    this.receivedThinking = false;
  }

  /** Reasoning lasts until visible output begins. */
  recordReasoningDuration(text: string) {
    if (
      text.trim() &&
      this.receivedThinking &&
      this.generationStartedAt !== null &&
      this.reasoningDurationMs === null
    ) {
      this.reasoningDurationMs = Math.max(1, Date.now() - this.generationStartedAt);
    }
  }

  /**
   * Writes text as small SSE token chunks. Some providers dump a full buffered response
   * through the streaming path; yield periodically so health checks and chat navigation
   * are not starved while that response fans out to the client.
   */
  async emitTokens(text: string) {
    for (let i = 0; i < text.length; i += TOKEN_CHUNK_SIZE) {
      sendSseEvent(this.output, { type: "token", data: text.slice(i, i + TOKEN_CHUNK_SIZE) });
      this.tokenChunksSinceYield += 1;
      if (this.tokenChunksSinceYield % TOKEN_CHUNK_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }
  }

  /** Sends text through the filter chain, then as tokens. Ignores `holdForTextRewrite`. */
  async sendFiltered(text: string) {
    const commandFiltered = this.roleplayCommandFilter?.push(text) ?? text;
    const chanceFiltered = this.gameChanceFilter?.push(commandFiltered) ?? commandFiltered;
    const visibleText = this.spatialDirectiveFilter?.push(chanceFiltered) ?? chanceFiltered;
    if (visibleText) {
      this.recordReasoningDuration(visibleText);
      await this.emitTokens(visibleText);
    }
  }

  /** Streams a piece of the reply, or only times it while a text rewrite holds the stream. */
  async write(text: string) {
    if (this.holdForTextRewrite) {
      this.recordReasoningDuration(text);
    } else {
      await this.sendFiltered(text);
    }
  }

  /** Releases the text the chance and spatial filters still hold at the end of the reply. */
  async flush() {
    if (this.holdForTextRewrite) return;
    // The chance filter drains first and its leftovers go through the spatial
    // filter, so a released candidate still meets every filter downstream of it.
    const pendingChanceText = this.gameChanceFilter?.flush() ?? "";
    const pendingChanceVisible = pendingChanceText
      ? (this.spatialDirectiveFilter?.push(pendingChanceText) ?? pendingChanceText)
      : "";
    const pendingSpatialText = this.spatialDirectiveFilter?.flush() ?? "";
    const pendingStreamText = `${pendingChanceVisible}${pendingSpatialText}`;
    if (pendingStreamText) {
      this.recordReasoningDuration(pendingStreamText);
      await this.emitTokens(pendingStreamText);
    }
  }
}
