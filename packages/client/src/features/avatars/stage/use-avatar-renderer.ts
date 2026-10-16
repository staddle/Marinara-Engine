// ──────────────────────────────────────────────
// Avatar stage: mount one avatar's lazy renderer on a canvas (lane: base)
// ──────────────────────────────────────────────
// Shared by the chat stage and the setup preview. Loads the kind's renderer chunk on first use, mounts it,
// keeps its size in step with the canvas (device pixel ratio capped by the budget), and disposes it when
// anything it was mounted with changes. Frames come from the caller's loop; this hook draws nothing itself.
import { useEffect, useRef, useState } from "react";
import type { AvatarConfig, AvatarImageRef, AvatarKind, AvatarOwnerRef } from "@marinara-engine/shared";
import { loadAvatarRenderer, type AvatarRenderer } from "../contract";
import { avatarDevicePixelRatio } from "./avatar-stage-logic";

export interface UseAvatarRendererOptions {
  canvas: HTMLCanvasElement | null;
  owner: AvatarOwnerRef;
  config: AvatarConfig | null;
  kind: AvatarKind | null;
  /** Null while the images it needs are still loading; the mount waits. */
  resolveImage: ((ref: AvatarImageRef) => string | null) | null;
  /** Changes when resolveImage would answer differently, so the renderer remounts with the new images. */
  imagesKey: string;
  reducedMotion: boolean;
  phone: boolean;
}

export type AvatarRendererStatus = "idle" | "loading" | "ready" | "error";

export function useAvatarRenderer({
  canvas,
  owner,
  config,
  kind,
  resolveImage,
  imagesKey,
  reducedMotion,
  phone,
}: UseAvatarRendererOptions): { renderer: AvatarRenderer | null; status: AvatarRendererStatus } {
  const [state, setState] = useState<{ renderer: AvatarRenderer | null; status: AvatarRendererStatus }>({
    renderer: null,
    status: "idle",
  });
  const resolveImageRef = useRef(resolveImage);
  resolveImageRef.current = resolveImage;
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  const resizeRef = useRef<() => void>(() => {});
  const { ownerType, ownerId } = owner;
  const imagesReady = resolveImage !== null;

  useEffect(() => {
    if (!canvas || !config || !kind || !imagesReady) {
      setState({ renderer: null, status: "idle" });
      return;
    }
    const controller = new AbortController();
    let renderer: AvatarRenderer | null = null;
    let observer: ResizeObserver | null = null;
    setState({ renderer: null, status: "loading" });

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        renderer?.resize(rect.width, rect.height, avatarDevicePixelRatio(window.devicePixelRatio, phoneRef.current));
      }
    };
    resizeRef.current = resize;

    void (async () => {
      try {
        const created = await loadAvatarRenderer(kind);
        if (controller.signal.aborted) return;
        renderer = created;
        await created.mount({
          owner: { ownerType, ownerId },
          config,
          canvas,
          resolveImage: (ref) => resolveImageRef.current?.(ref) ?? null,
          reducedMotion,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        resize();
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(resize);
          observer.observe(canvas);
        }
        setState({ renderer: created, status: "ready" });
      } catch (error) {
        if (controller.signal.aborted) return;
        // A half-mounted renderer may hold its kind's one WebGL context; free it now, not on the next change.
        renderer?.dispose();
        renderer = null;
        console.warn(`[avatars] The ${kind} avatar could not be shown`, error);
        setState({ renderer: null, status: "error" });
      }
    })();

    return () => {
      controller.abort();
      observer?.disconnect();
      resizeRef.current = () => {};
      renderer?.dispose();
    };
  }, [canvas, config, kind, imagesReady, imagesKey, ownerType, ownerId, reducedMotion]);

  // Crossing the phone breakpoint changes only the pixel-ratio cap; no remount.
  useEffect(() => resizeRef.current(), [phone]);

  return state;
}
