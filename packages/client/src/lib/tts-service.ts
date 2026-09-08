// ──────────────────────────────────────────────
// TTS Service — Server-proxied audio playback
// ──────────────────────────────────────────────
import { TTS_DIALOGUE_PAUSE_MAX_SECONDS } from "@marinara-engine/shared";
import { getOrCreateCachedTTSAudioBlob } from "./tts-audio-cache";
import { streamPcmChunk, TTSPcmStreamPlayer } from "./tts-pcm-stream-player";

export type TTSState = "idle" | "loading" | "playing" | "paused" | "blocked" | "error";

/** Cap on merged provider-streamed request text; POST /api/tts/speak accepts at most 4096 chars. */
const MAX_COALESCED_STREAM_CHARS = 2000;

type StateListener = (state: TTSState, activeId: string | null) => void;

export interface TTSSpeakOptions {
  speaker?: string;
  tone?: string;
  voice?: string;
  /** Explicit audio connection to synthesize with. Empty string forces the legacy TTS settings blob. */
  audioConnectionId?: string;
  signal?: AbortSignal;
  throwOnError?: boolean;
  cacheKey?: string;
  cacheAliases?: string[];
  abortCacheGenerationOnAbort?: boolean;
  volume?: number;
  muted?: boolean;
}

export interface TTSSpeakRequest {
  text: string;
  speaker?: string;
  tone?: string;
  voice?: string;
  pauseAfterMs?: number;
  cacheKey?: string;
  cacheAliases?: string[];
  activeId?: string | null;
  /** SGLang-Omni only: play via progressive PCM streaming instead of a single buffered clip. */
  streamProviderSynthesis?: boolean;
}

export interface TTSSpeakSequenceOptions extends Pick<TTSSpeakOptions, "signal" | "throwOnError" | "volume" | "muted"> {
  progressive?: boolean;
  onChunkStart?: (request: TTSSpeakRequest, index: number) => void;
  onChunkEnd?: (request: TTSSpeakRequest, index: number) => void;
}

export interface TTSStreamingSequenceHandle {
  /** Queue newly-available request(s) for playback, in order. */
  push(requests: TTSSpeakRequest[]): void;
  /** Signal that no more requests will be pushed; playback finishes normally once the queue drains. */
  finish(): void;
  /** Stop playback and drop any unplayed queued requests immediately. */
  abort(): void;
}

function clampPlaybackVolume(volume: number | undefined): number {
  if (typeof volume !== "number" || !Number.isFinite(volume)) return 1;
  return Math.max(0, Math.min(1, volume));
}

function waitForBlobWithAbort(promise: Promise<Blob>, signal?: AbortSignal): Promise<Blob> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("TTS request aborted", "AbortError"));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("TTS request aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (blob) => {
        signal.removeEventListener("abort", onAbort);
        resolve(blob);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function playbackAbortError(): DOMException {
  return new DOMException("TTS playback aborted", "AbortError");
}

export async function readTTSApiError(res: Response): Promise<string> {
  const fallback = `TTS request failed (${res.status})`;
  const raw = await res.text().catch(() => "");
  if (!raw.trim()) return fallback;

  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const error = typeof data.error === "string" ? data.error : "";
    const detail = typeof data.detail === "string" ? data.detail : "";
    const message = typeof data.message === "string" ? data.message : "";
    return [error || message || fallback, detail].filter(Boolean).join(": ");
  } catch {
    return `${fallback}: ${raw.slice(0, 500)}`;
  }
}

export function normalizeTTSPlaybackDelayMs(delayMs: number | undefined): number {
  const maximumDelayMs = TTS_DIALOGUE_PAUSE_MAX_SECONDS * 1000;
  return typeof delayMs === "number" && Number.isFinite(delayMs) ? Math.max(0, Math.min(maximumDelayMs, delayMs)) : 0;
}

function waitForPlaybackDelay(delayMs: number | undefined, signal: AbortSignal): Promise<void> {
  const ms = normalizeTTSPlaybackDelayMs(delayMs);

  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(playbackAbortError());

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(playbackAbortError());
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// #5889: Safari rejects play() with NotAllowedError when there is no live
// user activation - autoplay firing after generation, and even manual play
// once the awaited synthesis fetch has left the click's synchronous window.
// The old loop treated that as "wait until the tab is visible and focused",
// which it already was, so it retried with zero backoff forever: a promise
// and DOMException per iteration until the tab froze and WebKit killed it.
// No retry can succeed without a NEW gesture, so a blocked visible tab now
// waits for one - the retried play() then lands inside that gesture's
// transient activation and is allowed.
const MAX_PLAY_ATTEMPTS = 20;
const PLAY_RETRY_FLOOR_MS = 250;

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(playbackAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(playbackAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const USER_GESTURE_EVENTS = ["pointerdown", "keydown", "touchend"] as const;

function waitForUserGesture(signal?: AbortSignal): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (signal?.aborted) return Promise.reject(playbackAbortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      for (const name of USER_GESTURE_EVENTS) window.removeEventListener(name, onGesture, true);
      signal?.removeEventListener("abort", onAbort);
    };
    const onGesture = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(playbackAbortError());
    };
    for (const name of USER_GESTURE_EVENTS) window.addEventListener(name, onGesture, true);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForPlaybackReturn(signal?: AbortSignal): Promise<void> {
  if (typeof document === "undefined" || typeof window === "undefined") return Promise.resolve();
  if (document.visibilityState === "visible" && document.hasFocus()) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(playbackAbortError());

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("pageshow", onReturn);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onReturn = () => {
      if (document.visibilityState === "visible") finish();
    };
    const onAbort = () => {
      cleanup();
      reject(playbackAbortError());
    };

    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    window.addEventListener("pageshow", onReturn);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Exported for the regression lane, which drives it with stubbed globals. */
export async function playWhenAvailable(
  audio: Pick<HTMLAudioElement, "play">,
  signal?: AbortSignal,
  onBlocked?: () => void,
): Promise<void> {
  let attempts = 0;
  let waitBeforeRetry = typeof document !== "undefined" && document.visibilityState === "hidden";

  while (true) {
    if (signal?.aborted) throw playbackAbortError();
    if (waitBeforeRetry) {
      await waitForPlaybackReturn(signal);
      waitBeforeRetry = false;
      // The return gate resolves instantly for a visible, focused tab, so a
      // floor between attempts keeps any residual misclassification from
      // ever spinning hot again.
      await sleepWithAbort(PLAY_RETRY_FLOOR_MS, signal);
    }

    try {
      await audio.play();
      return;
    } catch (err) {
      attempts += 1;
      if (attempts >= MAX_PLAY_ATTEMPTS) {
        throw err instanceof Error ? err : new Error("Browser blocked audio playback");
      }
      // Only the autoplay-policy rejection is retryable - a decode or
      // not-supported failure does not heal by waiting or foregrounding.
      if (!(err instanceof Error) || err.name !== "NotAllowedError") throw err;
      const hiddenNow = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (!hiddenNow) {
        // Autoplay policy, not visibility: only a fresh user gesture can
        // unblock playback, and retrying inside its transient activation is
        // exactly what makes the retry succeed.
        onBlocked?.();
        await waitForUserGesture(signal);
        continue;
      }
      waitBeforeRetry = true;
      continue;
    }
  }
}

class TTSService {
  private audio: HTMLAudioElement | null = null;
  private currentObjectUrl: string | null = null;
  private abortController: AbortController | null = null;
  private state: TTSState = "idle";
  private lastError: string | null = null;
  private sequence = 0;
  /** ID of the entity (e.g. message id) currently being spoken */
  private activeId: string | null = null;
  private listeners = new Set<StateListener>();
  private livePlaybackVolume: number | null = null;
  private livePlaybackMuted: boolean | null = null;
  private currentPcmPlayer: TTSPcmStreamPlayer | null = null;

  // ── Listeners ─────────────────────────────────

  subscribe(fn: StateListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getState(): TTSState {
    return this.state;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  private setState(s: TTSState, id: string | null = this.activeId) {
    this.state = s;
    this.activeId = s === "idle" || s === "error" ? null : id;
    this.listeners.forEach((fn) => fn(this.state, this.activeId));
  }

  private async readError(res: Response): Promise<string> {
    return readTTSApiError(res);
  }

  private isCurrentSequence(sequence: number): boolean {
    return this.sequence === sequence;
  }

  // ── Playback ──────────────────────────────────

  private beginPlaybackOptions(options: Pick<TTSSpeakOptions, "volume" | "muted">): void {
    this.livePlaybackVolume = typeof options.volume === "number" ? clampPlaybackVolume(options.volume) : null;
    this.livePlaybackMuted = typeof options.muted === "boolean" ? options.muted : null;
  }

  private clearPlaybackOptions(): void {
    this.livePlaybackVolume = null;
    this.livePlaybackMuted = null;
  }

  private applyPlaybackOptions(audio: HTMLAudioElement, options: Pick<TTSSpeakOptions, "volume" | "muted">): void {
    const volume = this.livePlaybackVolume ?? clampPlaybackVolume(options.volume);
    audio.volume = volume;
    audio.muted = (this.livePlaybackMuted ?? options.muted) === true || volume <= 0;
  }

  setCurrentPlaybackVolume(volume: number, muted = false): void {
    this.livePlaybackVolume = clampPlaybackVolume(volume);
    this.livePlaybackMuted = muted;
    this.currentPcmPlayer?.setVolume(volume, muted);
    if (!this.audio) return;
    this.applyPlaybackOptions(this.audio, { volume, muted });
  }

  async generateAudio(text: string, options: TTSSpeakOptions = {}): Promise<Blob> {
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        ...(options.speaker ? { speaker: options.speaker } : {}),
        ...(options.tone ? { tone: options.tone } : {}),
        ...(options.voice ? { voice: options.voice } : {}),
        // "" is meaningful (legacy-blob sentinel), so gate on undefined.
        ...(options.audioConnectionId !== undefined ? { audioConnectionId: options.audioConnectionId } : {}),
      }),
      signal: options.signal,
    });

    if (!res.ok) {
      throw new Error(await this.readError(res));
    }

    return res.blob();
  }

  private async getAudioBlob(text: string, options: TTSSpeakOptions = {}): Promise<Blob> {
    if (!options.cacheKey) return this.generateAudio(text, options);
    const sharedPromise = getOrCreateCachedTTSAudioBlob(
      options.cacheKey,
      () =>
        this.generateAudio(text, {
          ...options,
          signal: options.abortCacheGenerationOnAbort ? options.signal : undefined,
        }),
      options.cacheAliases,
    );
    return waitForBlobWithAbort(sharedPromise, options.signal);
  }

  /** Speak the given text. `id` is an optional caller-supplied key (e.g. message id) so callers can track which item is active. */
  async speak(text: string, id?: string, options: TTSSpeakOptions = {}): Promise<void> {
    this.stop();
    this.beginPlaybackOptions(options);
    const sequence = ++this.sequence;
    this.lastError = null;

    this.setState("loading", id ?? null);
    const abortController = new AbortController();
    this.abortController = abortController;

    let blob: Blob;
    try {
      blob = await this.getAudioBlob(text, { ...options, signal: abortController.signal });
    } catch (err) {
      if (!this.isCurrentSequence(sequence)) return;
      if (err instanceof Error && err.name === "AbortError") {
        this.setState("idle");
        return;
      }
      const error = err instanceof Error ? err : new Error("TTS request failed");
      this.lastError = error.message;
      this.setState("error");
      if (options.throwOnError) throw error;
      return;
    }

    if (!this.isCurrentSequence(sequence)) return;

    const objectUrl = URL.createObjectURL(blob);
    if (!this.isCurrentSequence(sequence)) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    this.currentObjectUrl = objectUrl;

    const audio = new Audio(objectUrl);
    this.applyPlaybackOptions(audio, options);
    this.audio = audio;

    audio.onended = () => {
      if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
      if (this.abortController === abortController) {
        this.abortController = null;
      }
      this.cleanup();
      this.setState("idle");
    };
    audio.onerror = () => {
      if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
      if (this.abortController === abortController) {
        this.abortController = null;
      }
      // Record the REAL failure and detach the element first: the abort below
      // rejects a parked playWhenAvailable with AbortError, and the outer
      // catch must find this.audio already cleared so it cannot overwrite the
      // decode error with the abort message.
      this.audio = null;
      this.cleanup();
      this.lastError = "Audio playback failed";
      this.setState("error");
      // A decode error can land while playWhenAvailable is parked waiting for
      // a user gesture; aborting (not merely dropping) the controller is what
      // releases those window listeners, so no future keystroke retries a
      // dead element on a revoked URL.
      abortController.abort();
    };

    try {
      await playWhenAvailable(audio, abortController.signal, () => {
        if (this.isCurrentSequence(sequence) && this.audio === audio) this.setState("blocked", id ?? null);
      });
      if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
      this.setState("playing", id ?? null);
    } catch (err) {
      if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
      if (this.abortController === abortController) {
        this.abortController = null;
      }
      this.cleanup();
      const error = err instanceof Error ? err : new Error("Browser blocked audio playback");
      this.lastError = error.message;
      this.setState("error");
      if (options.throwOnError) throw error;
    }
  }

  /**
   * Generate every request first, then play the resulting clips in order.
   * This keeps multi-speaker dialogue from starting until the whole spoken queue is ready.
   */
  async speakSequence(requests: TTSSpeakRequest[], id?: string, options: TTSSpeakSequenceOptions = {}): Promise<void> {
    const playableRequests = requests.filter((request) => request.text.trim().length > 0);
    if (playableRequests.length === 0) return;

    this.stop();
    this.beginPlaybackOptions(options);
    const sequence = ++this.sequence;
    this.lastError = null;

    this.setState("loading", id ?? null);
    const abortController = new AbortController();
    this.abortController = abortController;

    const abortFromCaller = () => abortController.abort();
    const detachAbortSignal = () => options.signal?.removeEventListener("abort", abortFromCaller);
    if (options.signal?.aborted) {
      abortController.abort();
    } else {
      options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    type ChunkResult =
      | { ok: true; blob: Blob; request: TTSSpeakRequest; index: number }
      | { ok: false; error: Error; request: TTSSpeakRequest; index: number };
    const toError = (err: unknown, fallback: string) => (err instanceof Error ? err : new Error(fallback));
    const isAbortError = (error: Error) => error.name === "AbortError";
    const fetchChunk = async (request: TTSSpeakRequest, index: number): Promise<ChunkResult> => {
      try {
        const blob = await this.getAudioBlob(request.text, {
          speaker: request.speaker,
          tone: request.tone,
          voice: request.voice,
          signal: abortController.signal,
          cacheKey: request.cacheKey,
          cacheAliases: request.cacheAliases,
          abortCacheGenerationOnAbort: true,
        });
        return { ok: true, blob, request, index };
      } catch (err) {
        return { ok: false, error: toError(err, "TTS request failed"), request, index };
      }
    };

    const playBlob = async (blob: Blob, request: TTSSpeakRequest, index: number): Promise<void> => {
      if (!this.isCurrentSequence(sequence)) return;
      this.cleanup();

      const objectUrl = URL.createObjectURL(blob);
      if (!this.isCurrentSequence(sequence)) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      this.currentObjectUrl = objectUrl;

      const audio = new Audio(objectUrl);
      this.applyPlaybackOptions(audio, options);
      this.audio = audio;
      const runChunkStart = () => {
        try {
          options.onChunkStart?.(request, index);
        } catch (err) {
          console.warn("[TTS] Chunk start callback failed:", err);
        }
      };
      const runChunkEnd = () => {
        try {
          options.onChunkEnd?.(request, index);
        } catch (err) {
          console.warn("[TTS] Chunk end callback failed:", err);
        }
      };

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          abortController.signal.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = () => {
          try {
            audio.pause();
          } catch {
            /* ignore interrupted playback cleanup */
          }
          finish(resolve);
        };
        const fail = (error: Error) => {
          if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
          finish(() => {
            this.cleanup();
            this.lastError = error.message;
            this.setState("error");
            reject(error);
          });
        };

        abortController.signal.addEventListener("abort", onAbort, { once: true });
        audio.onended = () => {
          if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
          finish(() => {
            try {
              runChunkEnd();
            } finally {
              this.cleanup();
              resolve();
            }
          });
        };
        audio.onerror = () => {
          try {
            runChunkEnd();
          } finally {
            // Settle the chunk with the REAL failure before aborting: the
            // abort synchronously rejects the parked playWhenAvailable, and a
            // fail() after that would hit an already-settled promise, letting
            // the sequence continue as if the decode error never happened.
            fail(new Error("Audio playback failed"));
            // Then release the parked gesture listeners.
            abortController.abort();
          }
        };

        void playWhenAvailable(audio, abortController.signal, () => {
          if (this.isCurrentSequence(sequence) && this.audio === audio) {
            this.setState("blocked", request.activeId ?? id ?? null);
          }
        })
          .then(() => {
            if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
            runChunkStart();
            this.setState("playing", request.activeId ?? id ?? null);
          })
          .catch((err) => fail(toError(err, "Browser blocked audio playback")));
      });
    };

    const handleFetchFailure = (error: Error) => {
      this.lastError = error.message;
      console.warn("[TTS] Audio chunk generation failed; stopping the sequence:", error);
      this.setState("error");
    };

    try {
      if (options.progressive) {
        let nextFetch: Promise<ChunkResult> | null = fetchChunk(playableRequests[0]!, 0);

        for (let index = 0; index < playableRequests.length; index += 1) {
          const result = await nextFetch!;
          if (!this.isCurrentSequence(sequence)) return;

          if (!result.ok) {
            if (isAbortError(result.error)) {
              detachAbortSignal();
              if (this.abortController === abortController) {
                this.abortController = null;
              }
              this.setState("idle");
              return;
            }
            detachAbortSignal();
            if (this.abortController === abortController) {
              this.abortController = null;
            }
            handleFetchFailure(result.error);
            if (options.throwOnError) throw result.error;
            return;
          }

          nextFetch = index + 1 < playableRequests.length ? fetchChunk(playableRequests[index + 1]!, index + 1) : null;

          try {
            await playBlob(result.blob, result.request, result.index);
            await waitForPlaybackDelay(result.request.pauseAfterMs, abortController.signal);
            if (nextFetch && this.isCurrentSequence(sequence)) {
              this.setState("loading", id ?? null);
            }
          } catch (err) {
            detachAbortSignal();
            if (this.abortController === abortController) {
              this.abortController = null;
            }
            if (err instanceof Error && err.name === "AbortError") {
              this.setState("idle");
              return;
            }
            if (options.throwOnError) throw err;
            return;
          }
        }

        detachAbortSignal();
        if (!this.isCurrentSequence(sequence)) return;
        if (this.abortController === abortController) {
          this.abortController = null;
        }
        this.setState("idle");
        return;
      }

      const playableChunks: Array<Extract<ChunkResult, { ok: true }>> = [];
      for (let index = 0; index < playableRequests.length; index += 1) {
        const result = await fetchChunk(playableRequests[index]!, index);
        if (!this.isCurrentSequence(sequence)) return;
        if (!result.ok) {
          detachAbortSignal();
          if (this.abortController === abortController) {
            this.abortController = null;
          }
          if (isAbortError(result.error)) {
            this.setState("idle");
            return;
          }
          handleFetchFailure(result.error);
          if (options.throwOnError) throw result.error;
          return;
        }
        playableChunks.push(result);
      }

      for (const chunk of playableChunks) {
        try {
          await playBlob(chunk.blob, chunk.request, chunk.index);
          await waitForPlaybackDelay(chunk.request.pauseAfterMs, abortController.signal);
        } catch (err) {
          detachAbortSignal();
          if (this.abortController === abortController) {
            this.abortController = null;
          }
          if (err instanceof Error && err.name === "AbortError") {
            this.setState("idle");
            return;
          }
          if (options.throwOnError) throw err;
          return;
        }
        if (!this.isCurrentSequence(sequence)) return;
      }
      detachAbortSignal();
      if (this.abortController === abortController) {
        this.abortController = null;
      }
      this.setState("idle");
    } finally {
      detachAbortSignal();
    }
  }

  /**
   * Like speakSequence, but the request list can keep growing after playback
   * has already started — for speaking a message's completed sentences as
   * they stream in instead of waiting for the whole message to finish.
   * Unlike speakSequence's `progressive` mode, chunks are fetched only once
   * dequeued (no one-ahead prefetch), trading a small per-chunk gap for a
   * much simpler dynamic-queue implementation.
   */
  startStreamingSequence(id?: string, options: TTSSpeakSequenceOptions = {}): TTSStreamingSequenceHandle {
    this.stop();
    this.beginPlaybackOptions(options);
    const sequence = ++this.sequence;
    this.lastError = null;
    this.setState("loading", id ?? null);

    const abortController = new AbortController();
    this.abortController = abortController;
    const abortFromCaller = () => abortController.abort();
    const detachAbortSignal = () => options.signal?.removeEventListener("abort", abortFromCaller);
    if (options.signal?.aborted) {
      abortController.abort();
    } else {
      options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    const pending: TTSSpeakRequest[] = [];
    let finished = false;
    let wake: (() => void) | null = null;

    const waitForWork = (): Promise<boolean> =>
      new Promise((resolve) => {
        if (abortController.signal.aborted || pending.length > 0 || finished) {
          resolve(pending.length > 0);
          return;
        }
        wake = () => resolve(pending.length > 0);
      });

    const push = (requests: TTSSpeakRequest[]) => {
      if (finished || abortController.signal.aborted) return;
      const playable = requests.filter((request) => request.text.trim().length > 0);
      if (playable.length === 0) return;
      pending.push(...playable);
      wake?.();
      wake = null;
    };
    const finish = () => {
      finished = true;
      wake?.();
      wake = null;
    };
    const abort = () => abortController.abort();

    /**
     * Take the next request, merging any immediately-following compatible ones.
     *
     * Sentences are enqueued eagerly, the moment each one finishes streaming in, to keep
     * time-to-first-audio low. But a fast model can finish the whole message while the first
     * sentence is still synthesizing, leaving a queue of one-sentence requests — and sending
     * those separately pays the provider's per-request startup latency once per sentence,
     * audible as a gap before every sentence. Merging the backlog means the first sentence
     * still goes out immediately and alone, then everything already available follows as one
     * continuous stream.
     *
     * Restricted to provider-streamed requests: those bypass the audio cache (so merging
     * cannot mismatch per-chunk cache keys against their text) and play as a continuous
     * stream, which a longer request only makes smoother.
     */
    const dequeueCoalesced = (): TTSSpeakRequest | null => {
      const first = pending.shift() ?? null;
      if (!first?.streamProviderSynthesis || first.pauseAfterMs) return first;

      let text = first.text;
      while (pending.length > 0) {
        const next = pending[0]!;
        if (
          !next.streamProviderSynthesis ||
          next.voice !== first.voice ||
          next.speaker !== first.speaker ||
          next.tone !== first.tone ||
          text.length + next.text.length + 1 > MAX_COALESCED_STREAM_CHARS
        ) {
          break;
        }
        pending.shift();
        text = `${text} ${next.text}`;
        // A queued pause is a deliberate dialogue gap — stop merging so it survives.
        if (next.pauseAfterMs) return { ...first, text, pauseAfterMs: next.pauseAfterMs };
      }
      return text === first.text ? first : { ...first, text };
    };

    const fetchChunk = async (request: TTSSpeakRequest, index: number) => {
      try {
        const blob = await this.getAudioBlob(request.text, {
          speaker: request.speaker,
          tone: request.tone,
          voice: request.voice,
          signal: abortController.signal,
          cacheKey: request.cacheKey,
          cacheAliases: request.cacheAliases,
        });
        return { ok: true as const, blob, request, index };
      } catch (err) {
        const error = err instanceof Error ? err : new Error("TTS request failed");
        return { ok: false as const, error, request, index };
      }
    };

    const playBlob = async (blob: Blob, request: TTSSpeakRequest, index: number): Promise<void> => {
      if (!this.isCurrentSequence(sequence)) return;
      this.cleanup();

      const objectUrl = URL.createObjectURL(blob);
      if (!this.isCurrentSequence(sequence)) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      this.currentObjectUrl = objectUrl;

      const audio = new Audio(objectUrl);
      this.applyPlaybackOptions(audio, options);
      this.audio = audio;
      const runChunkStart = () => {
        try {
          options.onChunkStart?.(request, index);
        } catch (err) {
          console.warn("[TTS] Chunk start callback failed:", err);
        }
      };
      const runChunkEnd = () => {
        try {
          options.onChunkEnd?.(request, index);
        } catch (err) {
          console.warn("[TTS] Chunk end callback failed:", err);
        }
      };

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          abortController.signal.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = () => {
          try {
            audio.pause();
          } catch {
            /* ignore interrupted playback cleanup */
          }
          settle(resolve);
        };
        const fail = (error: Error) => {
          if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
          settle(() => {
            this.cleanup();
            this.lastError = error.message;
            this.setState("error");
            reject(error);
          });
        };

        abortController.signal.addEventListener("abort", onAbort, { once: true });
        audio.onended = () => {
          if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
          settle(() => {
            try {
              runChunkEnd();
            } finally {
              this.cleanup();
              resolve();
            }
          });
        };
        audio.onerror = () => {
          try {
            runChunkEnd();
          } finally {
            fail(new Error("Audio playback failed"));
          }
        };

        void playWhenAvailable(audio, abortController.signal)
          .then(() => {
            if (!this.isCurrentSequence(sequence) || this.audio !== audio) return;
            runChunkStart();
            this.setState("playing", request.activeId ?? id ?? null);
          })
          .catch((err) => fail(err instanceof Error ? err : new Error("Browser blocked audio playback")));
      });
    };

    /**
     * Synthesizes one chunk onto the session's shared PCM player and resolves once its bytes are
     * received and scheduled — not once they've finished playing. The caller (the loop below)
     * relies on that: it moves on to the next queued chunk immediately, so that chunk's synthesis
     * runs on the GPU while this one is still audible, instead of the GPU going idle until
     * playback catches up. All chunks in a session share one player/AudioContext (created lazily
     * on the first chunk) so they queue onto a single continuous timeline.
     */
    const streamChunk = async (request: TTSSpeakRequest, index: number): Promise<void> => {
      if (!this.isCurrentSequence(sequence)) return;
      const runChunkStart = () => {
        try {
          options.onChunkStart?.(request, index);
        } catch (err) {
          console.warn("[TTS] Chunk start callback failed:", err);
        }
      };
      const runChunkEnd = () => {
        try {
          options.onChunkEnd?.(request, index);
        } catch (err) {
          console.warn("[TTS] Chunk end callback failed:", err);
        }
      };

      try {
        await streamPcmChunk(
          (sampleRate) => {
            if (!this.currentPcmPlayer) {
              this.currentPcmPlayer = new TTSPcmStreamPlayer(
                sampleRate,
                this.livePlaybackVolume ?? options.volume,
                this.livePlaybackMuted ?? options.muted,
              );
            }
            return this.currentPcmPlayer;
          },
          request.text,
          {
            voice: request.voice,
            speaker: request.speaker,
            tone: request.tone,
            signal: abortController.signal,
            onFirstAudio: () => {
              if (!this.isCurrentSequence(sequence)) return;
              runChunkStart();
              this.setState("playing", request.activeId ?? id ?? null);
            },
          },
        );
        // "End" here means this chunk's synthesis is done and queued, not that it has finished
        // playing — nothing downstream currently depends on the stricter timing, and the whole
        // point of the shared timeline is that chunk boundaries no longer produce a real gap.
        if (!abortController.signal.aborted) runChunkEnd();
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        if (!this.isCurrentSequence(sequence)) return;
        this.lastError = err instanceof Error ? err.message : "TTS streaming playback failed";
        this.setState("error");
        throw err instanceof Error ? err : new Error("TTS streaming playback failed");
      }
    };

    /** Waits for the shared PCM player's queued audio to actually finish playing, then releases it. */
    const drainPcmPlayer = async (): Promise<void> => {
      const player = this.currentPcmPlayer;
      if (!player) return;
      // An already-fired abort won't retrigger a freshly-added "abort" listener below, so it
      // must be checked up front — otherwise cancelling mid-sequence would wait out the full
      // remaining playback instead of stopping immediately.
      if (abortController.signal.aborted) {
        if (this.currentPcmPlayer === player) {
          player.stop();
          this.currentPcmPlayer = null;
        }
        return;
      }
      const remainingMs = player.remainingSeconds() * 1000;
      if (remainingMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remainingMs);
          abortController.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
      if (this.currentPcmPlayer === player) {
        player.stop();
        this.currentPcmPlayer = null;
      }
    };

    void (async () => {
      let index = 0;
      let played = 0;
      const fetchErrors: Error[] = [];

      for (;;) {
        const hasWork = await waitForWork();
        if (!this.isCurrentSequence(sequence) || abortController.signal.aborted) break;
        if (!hasWork) break; // finished() was called and the queue is drained

        const request = dequeueCoalesced();
        if (!request) continue;
        const currentIndex = index;
        index += 1;

        if (request.streamProviderSynthesis) {
          try {
            await streamChunk(request, currentIndex);
            played += 1;
            if (request.pauseAfterMs) {
              // Unreachable today — dialogue pauses only come from the non-incremental
              // multi-speaker extraction path, which never feeds this queue — but if that
              // changes, drain the shared timeline first so the requested silence is actually
              // audible instead of swallowed by audio still catching up to real time.
              await drainPcmPlayer();
              await waitForPlaybackDelay(request.pauseAfterMs, abortController.signal);
            }
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") break;
            detachAbortSignal();
            if (this.abortController === abortController) this.abortController = null;
            this.currentPcmPlayer?.stop();
            this.currentPcmPlayer = null;
            return;
          }
          if (!this.isCurrentSequence(sequence)) break;
          continue;
        }

        const result = await fetchChunk(request, currentIndex);
        if (!this.isCurrentSequence(sequence)) break;

        if (!result.ok) {
          if (result.error.name === "AbortError") break;
          fetchErrors.push(result.error);
          continue;
        }

        try {
          await playBlob(result.blob, result.request, result.index);
          await waitForPlaybackDelay(result.request.pauseAfterMs, abortController.signal);
          played += 1;
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") break;
          detachAbortSignal();
          if (this.abortController === abortController) this.abortController = null;
          return;
        }
        if (!this.isCurrentSequence(sequence)) break;
      }

      detachAbortSignal();
      if (this.abortController === abortController) this.abortController = null;
      if (!this.isCurrentSequence(sequence)) return;
      await drainPcmPlayer();
      if (!this.isCurrentSequence(sequence)) return;
      if (fetchErrors.length > 0) {
        console.warn("[TTS] Skipped failed audio chunks:", fetchErrors);
        this.lastError =
          fetchErrors.length === 1
            ? fetchErrors[0]!.message
            : `${fetchErrors.length} TTS chunks failed; first error: ${fetchErrors[0]!.message}`;
      }
      if (played === 0 && fetchErrors.length > 0 && fetchErrors.length === index) {
        this.setState("error");
        return;
      }
      this.setState("idle");
    })();

    return { push, finish, abort };
  }

  /** Stop any in-progress fetch or playback. */
  stop(): void {
    this.sequence += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.clearPlaybackOptions();

    if (this.audio) {
      this.audio.pause();
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio = null;
    }
    if (this.currentPcmPlayer) {
      this.currentPcmPlayer.stop();
      this.currentPcmPlayer = null;
    }

    this.cleanup();
    this.lastError = null;
    this.setState("idle");
  }

  /** Pause the current generated audio without clearing it. */
  pause(): void {
    if (this.state !== "playing" || !this.audio) return;
    this.audio.pause();
    this.setState("paused");
  }

  /** Resume paused generated audio. */
  resume(): void {
    if (this.state !== "paused" || !this.audio) return;
    const audio = this.audio;
    void playWhenAvailable(audio, this.abortController?.signal, () => {
      if (this.audio === audio) this.setState("blocked");
    })
      .then(() => {
        if (this.audio !== audio) return;
        this.setState("playing");
      })
      .catch((err) => {
        if (this.audio !== audio) return;
        this.cleanup();
        const error = err instanceof Error ? err : new Error("Browser blocked audio playback");
        this.lastError = error.message;
        this.setState("error");
      });
  }

  /** Restart the current generated audio from the beginning. */
  restart(): void {
    if (!this.audio || (this.state !== "playing" && this.state !== "paused")) return;
    const audio = this.audio;
    audio.currentTime = 0;
    void playWhenAvailable(audio, this.abortController?.signal, () => {
      if (this.audio === audio) this.setState("blocked");
    })
      .then(() => {
        if (this.audio !== audio) return;
        this.setState("playing");
      })
      .catch((err) => {
        if (this.audio !== audio) return;
        this.cleanup();
        const error = err instanceof Error ? err : new Error("Browser blocked audio playback");
        this.lastError = error.message;
        this.setState("error");
      });
  }

  private cleanup(): void {
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
  }
}

export const ttsService = new TTSService();
