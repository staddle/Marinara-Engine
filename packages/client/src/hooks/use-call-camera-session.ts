// ──────────────────────────────────────────────
// Hook: Optional camera stream for Call Mode, captured frame-by-utterance
// ──────────────────────────────────────────────
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { classifyMicAccessError } from "../lib/mic-access-error";
import { canvasToBlob, createCanvasSurface } from "../lib/chat-attachment-images";

export type CallCameraState = "idle" | "starting" | "active" | "error";

interface UseCallCameraSessionOptions {
  /** Called on unrecoverable camera errors (e.g. permission denied). Never ends the call — only the camera toggle. */
  onError?: (message: string) => void;
}

/** Optional video-only camera stream for Call Mode, independent of the mic stream, that can grab a still frame on demand. */
export function useCallCameraSession({ onError }: UseCallCameraSessionOptions) {
  const { t: localizeUi } = useUiTranslation();
  const [state, setState] = useState<CallCameraState>("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setState("idle");
  }, []);

  const start = useCallback(async () => {
    if (streamRef.current) return;
    setState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setState("active");
    } catch (error) {
      console.error("[call-camera-session] getUserMedia failed:", error);
      const kind = classifyMicAccessError(error);
      const message =
        kind === "insecure-context"
          ? localizeUi("ui.hooks.usecallcamerasession.cameraAccessRequiresHttpsOrLocalhostThisPage")
          : kind === "permission-denied"
            ? localizeUi("ui.hooks.usecallcamerasession.cameraPermissionWasDeniedCheckYourBrowsers")
            : kind === "not-found"
              ? localizeUi("ui.hooks.usecallcamerasession.noCameraWasFoundOnThisDevice")
              : localizeUi("ui.hooks.usecallcamerasession.couldNotAccessTheCamera");
      onErrorRef.current?.(message);
      setState("error");
      stop();
    }
  }, [localizeUi, stop]);

  const captureFrame = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video || state !== "active" || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }
    const canvas = createCanvasSurface(video.videoWidth, video.videoHeight);
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
    try {
      return await canvasToBlob(canvas, "image/jpeg", 0.85);
    } catch {
      return null;
    }
  }, [state]);

  useEffect(() => stop, [stop]);

  return { state, videoRef, start, stop, captureFrame };
}
