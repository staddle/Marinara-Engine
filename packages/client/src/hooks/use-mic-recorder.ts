// ──────────────────────────────────────────────
// Hook: Microphone recording via MediaRecorder
// ──────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from "react";

export type MicRecorderState = "idle" | "recording" | "stopping";

/** Toggle-style mic capture: call start() to begin, stop() resolves with the recorded clip. */
export function useMicRecorder() {
  const [state, setState] = useState<MicRecorderState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => releaseStream, [releaseStream]);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorderRef.current = recorder;
    recorder.start();
    setState("recording");
  }, []);

  const stop = useCallback((): Promise<Blob> => {
    const recorder = recorderRef.current;
    if (!recorder) return Promise.reject(new Error("Not recording"));
    setState("stopping");
    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        releaseStream();
        setState("idle");
        if (blob.size === 0) {
          reject(new Error("No audio recorded"));
        } else {
          resolve(blob);
        }
      };
      recorder.stop();
    });
  }, [releaseStream]);

  const cancel = useCallback(() => {
    recorderRef.current?.stop();
    releaseStream();
    setState("idle");
  }, [releaseStream]);

  return { state, start, stop, cancel };
}
