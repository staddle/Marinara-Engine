// ──────────────────────────────────────────────
// Avatar audio: voice loudness from text-to-speech playback (lane: TTS)
// ──────────────────────────────────────────────
// While text-to-speech reads a character's line, publish an AvatarAudioLevelSource for that character, and null
// when the voice pauses, stops, moves to another speaker or the chat changes. The character is the one the TTS
// voice lookup resolved for the line (TTSSpeakRequest.characterId). Lines read by the narrator or by a speaker
// who is not a chat character move no mouth. A reading moves avatars only in the chat it was requested in
// (TTSSpeakOptions.chatId), whichever chat is open when the clip starts playing; a reading with no chat moves none.
// The level is the clip's loudness track (voice-envelope.ts) read at the playback element's current time. The
// element is never connected to Web Audio, so playback and the Safari/iOS autoplay handling in lib/tts-service.ts
// stay as they are. The director subscribes; nothing else does.
import type { AvatarAudioLevelSource, AvatarAudioListener } from "../contract";
import { ttsService, type TTSPlayback } from "../../../lib/tts-service";
import { useChatStore } from "../../../stores/chat.store";
import { decodeVoiceEnvelope, voiceLevelAt, voiceVisemeAt, type VoiceEnvelope } from "./voice-envelope";

const listeners = new Set<AvatarAudioListener>();
/** Loudness tracks by clip: "pending" while decoding, null when the clip cannot be decoded. */
const envelopes = new WeakMap<Blob, VoiceEnvelope | null | "pending">();
let published: AvatarAudioLevelSource | null = null;
let stopWatching: (() => void) | null = null;

function envelopeFor(blob: Blob): VoiceEnvelope | null | "pending" {
  const known = envelopes.get(blob);
  if (known !== undefined) return known;
  envelopes.set(blob, "pending");
  void decodeVoiceEnvelope(blob).then((envelope) => envelopes.set(blob, envelope));
  return "pending";
}

/** The character whose voice is playing for the open chat, or null. */
function speakingCharacter(playback: TTSPlayback | null): string | null {
  if (!playback?.chatId || ttsService.getState() !== "playing") return null;
  return playback.chatId === useChatStore.getState().activeChatId ? playback.characterId : null;
}

function createSource(ownerId: string): AvatarAudioLevelSource {
  /** The clip this source follows right now, once its loudness track is ready. */
  const current = () => {
    const playback = ttsService.getPlayback();
    if (published !== source || !playback || speakingCharacter(playback) !== ownerId) return null;
    const envelope = envelopeFor(playback.blob);
    return envelope && envelope !== "pending" ? { element: playback.element, envelope } : null;
  };
  const source: AvatarAudioLevelSource = {
    ownerId,
    level: () => {
      const clip = current();
      return clip ? voiceLevelAt(clip.envelope, clip.element.currentTime) : 0;
    },
    viseme: () => {
      const clip = current();
      return clip ? voiceVisemeAt(clip.envelope, clip.element.currentTime) : null;
    },
    // False while the clip decodes or when it cannot be decoded, so the director keeps its own mouth timing.
    isPlaying: () => {
      const clip = current();
      return clip !== null && !clip.element.paused && !clip.element.ended;
    },
  };
  return source;
}

function notify(listener: AvatarAudioListener, ownerId: string, source: AvatarAudioLevelSource | null): void {
  try {
    listener(ownerId, source);
  } catch (error) {
    console.warn("[Avatars] Audio listener failed:", error);
  }
}

function sync(): void {
  const playback = ttsService.getPlayback();
  const ownerId = speakingCharacter(playback);
  if (ownerId && playback) envelopeFor(playback.blob);
  if (ownerId === (published?.ownerId ?? null)) return;
  const previous = published;
  published = ownerId ? createSource(ownerId) : null;
  for (const listener of [...listeners]) {
    if (previous) notify(listener, previous.ownerId, null);
    if (published) notify(listener, published.ownerId, published);
  }
}

/** Calls `listener` with a source when a character's voice starts and with null when it ends. */
export function subscribeAvatarAudio(listener: AvatarAudioListener): () => void {
  listeners.add(listener);
  if (stopWatching) {
    if (published) notify(listener, published.ownerId, published);
  } else {
    const stopTTS = ttsService.subscribe(sync);
    const stopChat = useChatStore.subscribe((state) => state.activeChatId, sync);
    stopWatching = () => {
      stopTTS();
      stopChat();
    };
    sync();
  }
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    stopWatching?.();
    stopWatching = null;
    published = null;
  };
}
