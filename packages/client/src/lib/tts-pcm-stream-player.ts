// ──────────────────────────────────────────────
// TTS PCM Stream Player — SGLang-Omni (Higgs TTS) low-latency playback
// ──────────────────────────────────────────────
// SGLang-Omni's streaming endpoint (see /api/tts/speak-stream) returns raw
// 16-bit signed little-endian mono PCM bytes with no container and no
// terminal sentinel — just a growing byte stream as the vocoder emits audio.
// <audio>/Blob playback can't start until the whole clip is buffered, and
// MediaSource Extensions doesn't accept unmuxed PCM, so this decodes and
// schedules each chunk directly on the Web Audio API as it arrives.
import { readTTSApiError } from "./tts-service";

const DEFAULT_SAMPLE_RATE = 24000;
const PCM_BYTES_PER_SAMPLE = 2;

function clampGain(volume: number | undefined, muted: boolean | undefined): number {
  if (muted) return 0;
  if (typeof volume !== "number" || !Number.isFinite(volume)) return 1;
  return Math.max(0, Math.min(1, volume));
}

export class TTSPcmStreamPlayer {
  private readonly audioContext: AudioContext;
  private readonly gain: GainNode;
  private readonly sampleRate: number;
  private nextStartTime: number;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private carryByte: Uint8Array | null = null;
  private stopped = false;

  constructor(sampleRate: number, volume?: number, muted?: boolean) {
    this.sampleRate = sampleRate;
    // Some browsers reject exotic sample rates; fall back to the context's
    // native rate (the browser resamples on playback) rather than throwing.
    try {
      this.audioContext = new AudioContext({ sampleRate });
    } catch {
      this.audioContext = new AudioContext();
    }
    this.gain = this.audioContext.createGain();
    this.gain.gain.value = clampGain(volume, muted);
    this.gain.connect(this.audioContext.destination);
    this.nextStartTime = this.audioContext.currentTime;
  }

  setVolume(volume: number, muted: boolean): void {
    this.gain.gain.value = clampGain(volume, muted);
  }

  /** Decode and schedule one chunk of raw PCM bytes for gapless playback. Returns its duration in seconds. */
  pushChunk(chunk: Uint8Array): number {
    if (this.stopped) return 0;

    let bytes = chunk;
    if (this.carryByte) {
      const merged = new Uint8Array(this.carryByte.length + bytes.length);
      merged.set(this.carryByte, 0);
      merged.set(bytes, this.carryByte.length);
      bytes = merged;
      this.carryByte = null;
    }
    if (bytes.length % PCM_BYTES_PER_SAMPLE !== 0) {
      this.carryByte = bytes.slice(bytes.length - 1);
      bytes = bytes.slice(0, bytes.length - 1);
    }
    if (bytes.length === 0) return 0;

    const sampleCount = bytes.length / PCM_BYTES_PER_SAMPLE;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      samples[i] = view.getInt16(i * PCM_BYTES_PER_SAMPLE, true) / 32768;
    }

    const buffer = this.audioContext.createBuffer(1, sampleCount, this.sampleRate);
    buffer.copyToChannel(samples, 0);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => this.sources.delete(source);

    const startAt = Math.max(this.nextStartTime, this.audioContext.currentTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.sources.add(source);
    return buffer.duration;
  }

  /** Seconds remaining until every scheduled chunk finishes playing. */
  remainingSeconds(): number {
    return Math.max(0, this.nextStartTime - this.audioContext.currentTime);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* already stopped/ended */
      }
    }
    this.sources.clear();
    void this.audioContext.close().catch(() => undefined);
  }
}

export interface PlayPcmStreamOptions {
  voice?: string;
  speaker?: string;
  tone?: string;
  signal?: AbortSignal;
  volume?: number;
  muted?: boolean;
  /** Fired once the first chunk is scheduled, so callers can flip UI state to "playing". */
  onFirstAudio?: () => void;
  /** Fired with the live player so callers can push volume/mute changes mid-playback. */
  onPlayerReady?: (player: TTSPcmStreamPlayer) => void;
}

/** Streams `/api/tts/speak-stream` and plays it back progressively. Resolves once playback fully drains. */
export async function playPcmStream(text: string, options: PlayPcmStreamOptions = {}): Promise<void> {
  const res = await fetch("/api/tts/speak-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      ...(options.voice ? { voice: options.voice } : {}),
      ...(options.speaker ? { speaker: options.speaker } : {}),
      ...(options.tone ? { tone: options.tone } : {}),
    }),
    signal: options.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(await readTTSApiError(res));
  }

  const sampleRate = Number(res.headers.get("x-sample-rate")) || DEFAULT_SAMPLE_RATE;
  const player = new TTSPcmStreamPlayer(sampleRate, options.volume, options.muted);
  options.onPlayerReady?.(player);

  const reader = res.body.getReader();
  const onAbort = () => {
    player.stop();
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let firstChunkSeen = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || options.signal?.aborted) break;
      if (!value || value.length === 0) continue;

      player.pushChunk(value);
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        options.onFirstAudio?.();
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  if (options.signal?.aborted) {
    player.stop();
    return;
  }

  const remainingMs = player.remainingSeconds() * 1000;
  if (remainingMs > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remainingMs);
      const onLateAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      options.signal?.addEventListener("abort", onLateAbort, { once: true });
    });
  }
  player.stop();
}
