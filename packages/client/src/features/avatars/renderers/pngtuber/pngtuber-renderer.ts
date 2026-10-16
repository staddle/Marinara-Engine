// ──────────────────────────────────────────────
// Avatar renderer: PNGTuber layered sprites (lane: 2D)
// ──────────────────────────────────────────────
// Swaps the layer set for the frame's label (or the emotion's bound label), shows the mouth-open and
// eyes-closed variants for talking and blinking, and hops while talking. Plain canvas 2D; no WebGL.
// The stage and the setup preview hand it the owner's PNGTuber setup (built from the expression sprites
// when none is saved) and resolve its pictures from the sprite list they already hold. The mesh avatar
// renderer falls back to this one.
import {
  PNGTUBER_DEFAULT_MOTION,
  type AvatarFrameInput,
  type AvatarImageRef,
  type PngtuberAvatarData,
} from "@marinara-engine/shared";
import type { AvatarRenderer, AvatarRendererMountOptions } from "../../contract";
import {
  PNGTUBER_FADE_MS,
  PNGTUBER_HOP_MS,
  advancePngtuberBlink,
  fitPngtuberPicture,
  nextPngtuberMouthOpen,
  pickPngtuberLayerKey,
  pickPngtuberPicture,
  pngtuberBlinkWaitMs,
  pngtuberBreath,
  pngtuberHop,
  pngtuberThinkingTilt,
  type PngtuberBlinkClock,
} from "./pngtuber-layers";

/** Decoded pictures kept per avatar; older ones are released (a 2048 px face is 16 MB decoded). */
const MAX_CACHED_PICTURES = 12;
/** A paused or throttled tab hands one huge step; clocks advance at most this much per frame. */
const MAX_STEP_MS = 100;

interface Picture {
  image: HTMLImageElement;
  ready: boolean;
}

export function createAvatarRenderer(): AvatarRenderer {
  let options: AvatarRendererMountOptions | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let data: PngtuberAvatarData | null = null;
  const pictures = new Map<string, Picture>();
  let disposed = false;
  let paused = false;
  let dirty = true;
  let lastDrawn = "";
  let lastFrame: AvatarFrameInput | null = null;

  let timeMs = 0;
  let mouthOpen = false;
  let wasMouthOpen = false;
  let hopStartedMs = -Infinity;
  const blink: PngtuberBlinkClock = { waitMs: 0, closedMs: 0 };
  /** The picture now showing (and its layer set), and the face fading out under it. */
  let shown: { url: string; sinceMs: number } | null = null;
  let shownKey: string | null = null;
  let previousUrl: string | null = null;

  function urlFor(ref: AvatarImageRef): string | null {
    return options?.resolveImage(ref) ?? null;
  }

  function picture(url: string): Picture {
    const entry = pictures.get(url);
    if (entry) {
      // Most recently used last, so the oldest is released first.
      pictures.delete(url);
      pictures.set(url, entry);
      return entry;
    }
    const image = new Image();
    image.decoding = "async";
    const created: Picture = { image, ready: false };
    image.onload = () => {
      created.ready = true;
      dirty = true;
    };
    // A picture that fails to load stays cached and never ready, so a missing sprite is not refetched each frame.
    image.src = url;
    pictures.set(url, created);
    for (const [key, old] of pictures) {
      if (pictures.size <= MAX_CACHED_PICTURES) break;
      if (key === url || key === shown?.url || key === previousUrl) continue;
      old.image.src = "";
      pictures.delete(key);
    }
    return created;
  }

  /** Starts loading every picture of a layer set, so its talk and blink swaps are ready when needed. */
  function warm(key: string | null) {
    const set = key && data ? data.layers[key] : undefined;
    if (!set) return;
    for (const ref of [set.base, set.mouthOpen, set.eyesClosed, set.eyesClosedMouthOpen]) {
      const url = ref ? urlFor(ref) : null;
      if (url) picture(url);
    }
  }

  function draw(frame: AvatarFrameInput) {
    if (!options || !context || !data) return;
    const { canvas } = options;
    const features = options.config.features;
    const motion = data.motion ?? PNGTUBER_DEFAULT_MOTION;
    const key = pickPngtuberLayerKey(data, frame);
    const set = key ? data.layers[key] : undefined;
    if (!set) return;
    const url = urlFor(pickPngtuberPicture(set, mouthOpen, eyesShut(frame)));
    if (!url) return;
    const next = picture(url);
    // Keep the current face until the new one has loaded; swaps of an already shown set never fade.
    if (next.ready && shown?.url !== url) {
      const sameFace = shown && shownKey === key;
      previousUrl = sameFace ? null : (shown?.url ?? null);
      shown = { url, sinceMs: sameFace ? -Infinity : timeMs };
      shownKey = key;
      if (!sameFace) warm(key);
    }
    if (!shown) return;

    const still = options.reducedMotion;
    const moving = features.idleMotion && !still;
    const fade = Math.min(1, (timeMs - shown.sinceMs) / PNGTUBER_FADE_MS);
    const hop = motion.bounceOnTalk && !still ? pngtuberHop(timeMs - hopStartedMs) * motion.bounceHeight : 0;
    const breath = moving ? pngtuberBreath(timeMs) : 1;
    const tilt = moving && frame.state === "thinking" ? pngtuberThinkingTilt(timeMs) : 0;
    const signature = `${shown.url}|${previousUrl}|${fade.toFixed(2)}|${hop.toFixed(3)}|${breath.toFixed(4)}|${tilt.toFixed(4)}|${canvas.width}x${canvas.height}`;
    if (!dirty && signature === lastDrawn) return;
    lastDrawn = signature;
    dirty = false;

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const headroom = motion.bounceOnTalk && !still ? motion.bounceHeight : 0;
    // The new face fades in over the old one, which stays solid underneath so the avatar never thins out.
    const layers: [string | null, number][] = [
      [fade < 1 ? previousUrl : null, 1],
      [shown.url, fade < 1 && previousUrl ? fade : 1],
    ];
    for (const [layerUrl, alpha] of layers) {
      const entry = layerUrl ? pictures.get(layerUrl) : undefined;
      if (!entry?.ready || alpha <= 0) continue;
      const { naturalWidth, naturalHeight } = entry.image;
      if (!naturalWidth || !naturalHeight) continue;
      const box = fitPngtuberPicture(canvas.width, canvas.height, naturalWidth, naturalHeight, headroom);
      const lift = hop * canvas.height;
      // Breathing and the thinking tilt pivot on the middle of the bottom edge, where the avatar stands.
      context.setTransform(1, 0, 0, 1, box.x + box.width / 2, box.y + box.height - lift);
      context.rotate(tilt);
      context.scale(1, breath);
      context.globalAlpha = alpha;
      context.drawImage(entry.image, -box.width / 2, -box.height, box.width, box.height);
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
  }

  function eyesShut(frame: AvatarFrameInput): boolean {
    if (!options?.config.features.blink) return false;
    if (frame.blink !== undefined) return frame.blink > 0.5;
    return blink.closedMs > 0;
  }

  return {
    kind: "pngtuber",

    async mount(mountOptions) {
      options = mountOptions;
      context = mountOptions.canvas.getContext("2d");
      data = mountOptions.config.kinds.pngtuber ?? null;
      blink.waitMs = pngtuberBlinkWaitMs((data?.motion ?? PNGTUBER_DEFAULT_MOTION).blinkIntervalSeconds, Math.random);
      if (data) warm(pickPngtuberLayerKey(data, { emotion: "neutral" }));
      dirty = true;
    },

    update(frame, dtMs) {
      if (disposed || paused || !data) return;
      const step = Math.max(0, Math.min(MAX_STEP_MS, dtMs));
      timeMs += step;
      const features = options?.config.features;
      mouthOpen = !!features?.lipSync && nextPngtuberMouthOpen(mouthOpen, frame.mouthOpen);
      if (mouthOpen && !wasMouthOpen && timeMs - hopStartedMs >= PNGTUBER_HOP_MS) hopStartedMs = timeMs;
      wasMouthOpen = mouthOpen;
      if (features?.blink && frame.blink === undefined) {
        advancePngtuberBlink(blink, step, (data.motion ?? PNGTUBER_DEFAULT_MOTION).blinkIntervalSeconds, Math.random);
      }
      lastFrame = frame;
      draw(frame);
    },

    resize(width, height, devicePixelRatio) {
      if (!options) return;
      const canvas = options.canvas;
      const pixelWidth = Math.max(1, Math.round(width * devicePixelRatio));
      const pixelHeight = Math.max(1, Math.round(height * devicePixelRatio));
      if (canvas.width === pixelWidth && canvas.height === pixelHeight) return;
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      dirty = true;
      // Resizing clears the canvas, and the stage's next frame may be a while off (or paused): draw it now.
      if (lastFrame) draw(lastFrame);
    },

    setPaused(value) {
      paused = value;
      dirty = true;
    },

    dispose() {
      disposed = true;
      for (const entry of pictures.values()) {
        entry.image.onload = null;
        entry.image.src = "";
      }
      pictures.clear();
      options = null;
      context = null;
      data = null;
    },
  };
}
