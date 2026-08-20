// ──────────────────────────────────────────────
// Hook: Continuous voice-activity-detected mic session for Call Mode
// ──────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { classifyMicAccessError } from "../lib/mic-access-error";

export type CallVoiceState = "idle" | "listening" | "speech-detected" | "paused";

const POLL_INTERVAL_MS = 100;
const DEFAULT_SILENCE_MS = 1700;
const MIN_SPEECH_MS = 300;
const MAX_UTTERANCE_MS = 30_000;
const RMS_SPEECH_THRESHOLD = 0.02;

function computeRms(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer);
  let sumSquares = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const centered = (buffer[i]! - 128) / 128;
    sumSquares += centered * centered;
  }
  return Math.sqrt(sumSquares / buffer.length);
}

interface UseCallVoiceSessionOptions {
  /** Called with a complete utterance's recorded audio once trailing silence is detected. */
  onUtterance: (blob: Blob) => void;
  /** Called on unrecoverable mic/session errors (e.g. permission denied). */
  onError?: (message: string) => void;
  /** While true, the session stays open but does not record or emit utterances (e.g. while the assistant is responding). */
  paused: boolean;
  /** Milliseconds of silence before an utterance is considered finished and sent. Defaults to DEFAULT_SILENCE_MS; raise it to tolerate longer mid-sentence thinking pauses. */
  silenceMs?: number;
}

/** Continuous mic session that opens the microphone once and segments speech into per-utterance clips via simple volume-based voice activity detection. */
export function useCallVoiceSession({ onUtterance, onError, paused, silenceMs }: UseCallVoiceSessionOptions) {
  const { t: localizeUi } = useUiTranslation();
  const [state, setState] = useState<CallVoiceState>("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const bufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pausedRef = useRef(paused);
  const utteranceStartRef = useRef(0);
  const speechMsRef = useRef(0);
  const lastSpeechAtRef = useRef(0);
  const hasSpokenRef = useRef(false);
  const onUtteranceRef = useRef(onUtterance);
  const onErrorRef = useRef(onError);
  const silenceMsRef = useRef(silenceMs ?? DEFAULT_SILENCE_MS);
  /** While true, a push-to-talk press is driving the current recording: the
   * silence-based auto-stop below is suppressed and only releasing the
   * button (endManualTurn) finalizes the utterance. */
  const manualTurnActiveRef = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    onUtteranceRef.current = onUtterance;
  }, [onUtterance]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    silenceMsRef.current = silenceMs ?? DEFAULT_SILENCE_MS;
  }, [silenceMs]);

  const stopCurrentRecorder = useCallback((emit: boolean, bypassMinDuration = false) => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      chunksRef.current = [];
      if (emit && (bypassMinDuration || speechMsRef.current >= MIN_SPEECH_MS) && blob.size > 0) {
        onUtteranceRef.current(blob);
      }
    };
    recorder.stop();
  }, []);

  const startNewRecorder = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    hasSpokenRef.current = false;
    speechMsRef.current = 0;
    utteranceStartRef.current = Date.now();
    lastSpeechAtRef.current = Date.now();
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorderRef.current = recorder;
    recorder.start();
    setState("listening");
  }, []);

  const poll = useCallback(() => {
    if (pausedRef.current) {
      if (recorderRef.current) stopCurrentRecorder(false);
      manualTurnActiveRef.current = false;
      setState("paused");
      return;
    }

    if (!recorderRef.current) {
      startNewRecorder();
      return;
    }

    const analyser = analyserRef.current;
    const buffer = bufferRef.current;
    if (!analyser || !buffer) return;

    const rms = computeRms(analyser, buffer);
    const now = Date.now();
    const speaking = rms > RMS_SPEECH_THRESHOLD;
    if (speaking) {
      if (hasSpokenRef.current) speechMsRef.current += POLL_INTERVAL_MS;
      hasSpokenRef.current = true;
      lastSpeechAtRef.current = now;
      setState("speech-detected");
    }

    const silentFor = now - lastSpeechAtRef.current;
    const utteranceAge = now - utteranceStartRef.current;
    // The hard utterance-length cap always applies; the silence-based cutoff
    // is suppressed during a push-to-talk press so a natural pause while
    // still holding the button doesn't end the turn early.
    const silenceCutoff = !manualTurnActiveRef.current && hasSpokenRef.current && silentFor > silenceMsRef.current;
    if (silenceCutoff || utteranceAge > MAX_UTTERANCE_MS) {
      stopCurrentRecorder(true);
      // Next poll tick starts a fresh recorder for the following utterance.
    }
  }, [startNewRecorder, stopCurrentRecorder]);

  const stop = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    manualTurnActiveRef.current = false;
    if (recorderRef.current) {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      recorder.onstop = null;
      recorder.stop();
    }
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    analyserRef.current = null;
    bufferRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setState("idle");
  }, []);

  const start = useCallback(async () => {
    if (streamRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      bufferRef.current = new Uint8Array(analyser.fftSize);
      pollTimerRef.current = setInterval(poll, POLL_INTERVAL_MS);
      setState(pausedRef.current ? "paused" : "listening");
    } catch (error) {
      console.error("[call-voice-session] getUserMedia failed:", error);
      const kind = classifyMicAccessError(error);
      const message =
        kind === "insecure-context"
          ? localizeUi("ui.hooks.usecallvoicesession.microphoneAccessRequiresHttpsOrLocalhostThisPage")
          : kind === "permission-denied"
            ? localizeUi("ui.hooks.usecallvoicesession.microphonePermissionWasDeniedCheckYourBrowsers")
            : kind === "not-found"
              ? localizeUi("ui.hooks.usecallvoicesession.noMicrophoneWasFoundOnThisDevice")
              : localizeUi("ui.ui.pushtotalkbutton.couldNotAccessTheMicrophone");
      onErrorRef.current?.(message);
      stop();
    }
  }, [localizeUi, poll, stop]);

  useEffect(() => stop, [stop]);

  /** Push-to-talk: hold to speak regardless of the automatic silence timeout, as a fallback when VAD misjudges a pause. */
  const beginManualTurn = useCallback(() => {
    if (pausedRef.current) return;
    manualTurnActiveRef.current = true;
    if (!recorderRef.current) startNewRecorder();
  }, [startNewRecorder]);

  /** Release the push-to-talk button: finalize and send immediately, bypassing the minimum-speech-duration guard. */
  const endManualTurn = useCallback(() => {
    if (!manualTurnActiveRef.current) return;
    manualTurnActiveRef.current = false;
    stopCurrentRecorder(true, true);
  }, [stopCurrentRecorder]);

  return { state, start, stop, beginManualTurn, endManualTurn };
}
