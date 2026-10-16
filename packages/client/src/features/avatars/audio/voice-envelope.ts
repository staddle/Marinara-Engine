// ──────────────────────────────────────────────
// Avatar audio: how loud a voice clip is over time
// ──────────────────────────────────────────────
// Each text-to-speech clip is decoded a second time, on the side, into a short loudness track. The avatar reads
// that track at the playback element's current time. The decoder is an OfflineAudioContext: it plays nothing
// and needs no user gesture. The voice itself never passes through Web Audio. On iOS, a media element routed
// through an AudioContext goes silent while that context is suspended or interrupted.
import type { AvatarViseme } from "@marinara-engine/shared";

/** A clip's loudness, one step per STEP_SECONDS. */
export interface VoiceEnvelope {
  readonly stepSeconds: number;
  /** 0..1 per step, gated and smoothed. */
  readonly levels: Float32Array;
  /** Coarse mouth shape per step; null where the voice is silent. */
  readonly visemes: readonly (AvatarViseme | null)[];
}

/** The part of an AudioBuffer the envelope reads. */
export interface VoiceSamples {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

const STEP_SECONDS = 0.02;
/** Loudness relative to the clip's loud parts (95th percentile), so quiet and loud voices both move the mouth. */
const REFERENCE_PERCENTILE = 0.95;
/** A clip quieter than this throughout is silence (for example the priming clip). */
const SILENT_REFERENCE = 1e-3;
/** Below this share of the reference the mouth stays shut (breaths, room noise, codec hiss). */
const NOISE_GATE = 0.15;
/** Opens fast and closes a little slower, like a mouth. */
const ATTACK_SECONDS = 0.02;
const RELEASE_SECONDS = 0.07;
/** Effective frequency bands (Hz) for the coarse mouth shape: dark sounds round the lips, bright ones (s, sh)
 *  show the teeth, and the rest open the mouth. It tells sound classes apart, not exact vowels. */
const ROUNDED_BELOW_HZ = 500;
const TEETH_FROM_HZ = 1600;
/** Decoding at a low rate keeps it cheap; mouth shapes need nothing above 8 kHz. */
const DECODE_SAMPLE_RATES = [16_000, 44_100] as const;

function coarseViseme(effectiveHz: number): AvatarViseme {
  if (effectiveHz < ROUNDED_BELOW_HZ) return "ou";
  return effectiveHz < TEETH_FROM_HZ ? "aa" : "ih";
}

export function computeVoiceEnvelope(samples: VoiceSamples): VoiceEnvelope {
  const windowLength = Math.max(1, Math.round(samples.sampleRate * STEP_SECONDS));
  const steps = Math.ceil(samples.length / windowLength);
  const channels = Array.from({ length: samples.numberOfChannels }, (_, index) => samples.getChannelData(index));
  const channelScale = 1 / Math.max(1, channels.length);
  const rms = new Float32Array(steps);
  const effectiveHz = new Float32Array(steps);
  let previous = 0;
  for (let step = 0; step < steps; step += 1) {
    const start = step * windowLength;
    const end = Math.min(samples.length, start + windowLength);
    let energy = 0;
    let differenceEnergy = 0;
    for (let index = start; index < end; index += 1) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] ?? 0;
      sample *= channelScale;
      energy += sample * sample;
      differenceEnergy += (sample - previous) ** 2;
      previous = sample;
    }
    rms[step] = Math.sqrt(energy / Math.max(1, end - start));
    // For a tone, sum((x[n] - x[n-1])^2) / sum(x^2) = 2 - 2cos(w); solving for w gives the window's
    // energy-weighted frequency without an FFT.
    const cosine = energy > 0 ? Math.max(-1, Math.min(1, 1 - differenceEnergy / (2 * energy))) : 1;
    effectiveHz[step] = (Math.acos(cosine) * samples.sampleRate) / (2 * Math.PI);
  }

  const sorted = Float32Array.from(rms).sort();
  const reference = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * REFERENCE_PERCENTILE))] ?? 0;
  const levels = new Float32Array(steps);
  const visemes: (AvatarViseme | null)[] = new Array(steps).fill(null);
  if (reference < SILENT_REFERENCE) return { stepSeconds: STEP_SECONDS, levels, visemes };

  const attack = 1 - Math.exp(-STEP_SECONDS / ATTACK_SECONDS);
  const release = 1 - Math.exp(-STEP_SECONDS / RELEASE_SECONDS);
  let level = 0;
  let shape: AvatarViseme | null = null;
  for (let step = 0; step < steps; step += 1) {
    const relative = Math.min(1, (rms[step] ?? 0) / reference);
    const target = relative <= NOISE_GATE ? 0 : (relative - NOISE_GATE) / (1 - NOISE_GATE);
    level += (target - level) * (target > level ? attack : release);
    levels[step] = level < 0.01 ? 0 : level;
    // While the mouth closes after a sound it keeps that sound's shape.
    if (target > 0) shape = coarseViseme(effectiveHz[step] ?? 0);
    else if (levels[step] === 0) shape = null;
    visemes[step] = shape;
  }
  return { stepSeconds: STEP_SECONDS, levels, visemes };
}

/** 0..1 loudness at a playback time; 0 before the clip starts and after it ends. */
export function voiceLevelAt(envelope: VoiceEnvelope, seconds: number): number {
  const position = seconds / envelope.stepSeconds;
  if (!Number.isFinite(position) || position < 0) return 0;
  const step = Math.floor(position);
  if (step >= envelope.levels.length) return 0;
  const here = envelope.levels[step] ?? 0;
  const next = envelope.levels[step + 1] ?? 0;
  return here + (next - here) * (position - step);
}

/** Coarse mouth shape at a playback time, or null where the voice is silent. */
export function voiceVisemeAt(envelope: VoiceEnvelope, seconds: number): AvatarViseme | null {
  if (voiceLevelAt(envelope, seconds) <= 0) return null;
  return envelope.visemes[Math.floor(seconds / envelope.stepSeconds)] ?? null;
}

let decoder: BaseAudioContext | null | undefined;

/** One decoder, created on first use and kept. */
function getDecoder(): BaseAudioContext | null {
  if (decoder !== undefined) return decoder;
  decoder = null;
  if (typeof OfflineAudioContext !== "function") return decoder;
  for (const sampleRate of DECODE_SAMPLE_RATES) {
    try {
      decoder = new OfflineAudioContext(1, 1, sampleRate);
      break;
    } catch {
      // Older engines only accept common rates; try the next one.
    }
  }
  return decoder;
}

/** The clip's loudness track, or null when this browser cannot decode it (the avatar then gets no level). */
export async function decodeVoiceEnvelope(blob: Blob): Promise<VoiceEnvelope | null> {
  const context = getDecoder();
  if (!context) return null;
  try {
    return computeVoiceEnvelope(await context.decodeAudioData(await blob.arrayBuffer()));
  } catch {
    return null;
  }
}
