// ──────────────────────────────────────────────
// Avatar setup: the example PNGTuber shown before an avatar is set up (lane: base)
// ──────────────────────────────────────────────
// Used only by the setup preview, never in chats. The pictures live in public/sprites/avatar-demo/
// (fetched on demand; the service worker skips sprites/**). Provenance: public/sprites/avatar-demo/README.md.
import {
  AVATAR_EMOTIONS,
  DEFAULT_AVATAR_FEATURE_FLAGS,
  PNGTUBER_DEFAULT_MOTION,
  type AvatarConfig,
  type AvatarExpressionMap,
  type AvatarImageRef,
  type AvatarOwnerRef,
} from "@marinara-engine/shared";

const DEMO_ROOT = "/sprites/avatar-demo";
const DEMO_FILES: Readonly<Record<string, string>> = {
  demo: "base.png",
  demo_mouth_open: "mouth-open.png",
  demo_eyes_closed: "eyes-closed.png",
  demo_eyes_closed_mouth_open: "eyes-closed-mouth-open.png",
};

export const DEMO_AVATAR_OWNER: AvatarOwnerRef = Object.freeze({ ownerType: "character", ownerId: "avatar-demo" });

const sprite = (label: string): AvatarImageRef => ({ source: "sprite", label });

export const DEMO_AVATAR_CONFIG: AvatarConfig = {
  version: 1,
  owner: DEMO_AVATAR_OWNER,
  enabled: true,
  activeKind: "pngtuber",
  features: { ...DEFAULT_AVATAR_FEATURE_FLAGS },
  kinds: {
    pngtuber: {
      layers: {
        demo: {
          base: sprite("demo"),
          mouthOpen: sprite("demo_mouth_open"),
          eyesClosed: sprite("demo_eyes_closed"),
          eyesClosedMouthOpen: sprite("demo_eyes_closed_mouth_open"),
        },
      },
      expressionMap: Object.fromEntries(
        AVATAR_EMOTIONS.map((emotion) => [emotion, { target: "demo", source: "preset", confidence: 1 }]),
      ) as AvatarExpressionMap,
      motion: { ...PNGTUBER_DEFAULT_MOTION },
      source: "generated",
    },
  },
  updatedAt: "2026-10-13T00:00:00.000Z",
};

export function resolveDemoAvatarImage(ref: AvatarImageRef): string | null {
  const file = ref.source === "sprite" ? DEMO_FILES[ref.label] : undefined;
  return file ? `${DEMO_ROOT}/${file}` : null;
}
