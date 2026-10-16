// ──────────────────────────────────────────────
// Avatar agents: the client contract (no lane edits this file)
// ──────────────────────────────────────────────
// Renderers, setup panels and the generation panel load through dynamic import(), so three, @pixiv/three-vrm
// and mesh-avatar stay out of the main bundle and load only when an avatar of that kind is set up or shown.
// Import this file only for types and the loaders below; never import a renderer module statically.
// The shared half of the contract is packages/shared/src/types/avatars.ts.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type {
  AvatarAgentId,
  AvatarConfig,
  AvatarFrameInput,
  AvatarImageRef,
  AvatarKind,
  AvatarOwnerRef,
  AvatarViseme,
  ChatMode,
} from "@marinara-engine/shared";

// ── Performance budget ──

/** Hard limits for every renderer and the stage. "Phone" is a coarse pointer or a viewport below the md
 *  breakpoint. The stage owns the single frame loop: renderers never run their own requestAnimationFrame. */
export const AVATAR_RENDER_BUDGET = Object.freeze({
  /** Avatars drawn at once; the rest show their still sprite or nothing. */
  maxVisible: Object.freeze({ phone: 2, desktop: 4 }),
  /** Canvas device-pixel-ratio cap. */
  maxDevicePixelRatio: Object.freeze({ phone: 1.5, desktop: 2 }),
  /** Frame rates. Hidden tab, offscreen canvas, or paused effects mean 0 fps (setPaused(true)). Reduced
   *  motion keeps the face and mouth changing but drops idle motion and bounce. */
  fps: Object.freeze({ talking: 30, idleDesktop: 30, idlePhone: 20, idlePhoneUnderLoad: 15 }),
  /** WebGL contexts per renderer kind, shared by every avatar of that kind. */
  webglContextsPerKind: 1,
});

// ── Renderers (lanes 2D and 3D) ──

export interface AvatarRendererMountOptions {
  owner: AvatarOwnerRef;
  config: AvatarConfig;
  /** The canvas this avatar draws into. The stage sizes it with CSS and calls resize(). */
  canvas: HTMLCanvasElement;
  /** URL for a PNGTuber image: one of the owner's sprites or a stored file. Null when the sprite is gone. */
  resolveImage(ref: AvatarImageRef): string | null;
  reducedMotion: boolean;
  /** Aborted when the stage unmounts before mount() settles. */
  signal: AbortSignal;
}

/** One avatar on screen. Load stored model bytes with `api.raw(avatarModelFilePath(owner, path))` (never a
 *  bare fetch). A kind's module keeps at most one WebGL context and shares it between its renderers. */
export interface AvatarRenderer {
  readonly kind: AvatarKind;
  mount(options: AvatarRendererMountOptions): Promise<void>;
  /** Draw one frame. Called by the stage's loop at the budget frame rate, never while paused. */
  update(frame: AvatarFrameInput, dtMs: number): void;
  /** CSS pixel size of the canvas and the capped device pixel ratio. */
  resize(width: number, height: number, devicePixelRatio: number): void;
  /** Paused renderers draw nothing and hold no timers. */
  setPaused(paused: boolean): void;
  /** Release GPU resources, listeners and object URLs. The renderer is unusable afterwards. */
  dispose(): void;
}

export interface AvatarRendererModule {
  createAvatarRenderer(): AvatarRenderer;
}

const AVATAR_RENDERER_MODULES: Readonly<Record<AvatarKind, () => Promise<AvatarRendererModule>>> = {
  pngtuber: () => import("./renderers/pngtuber/pngtuber-renderer"),
  "mesh-avatar": () => import("./renderers/mesh-avatar/mesh-avatar-renderer"),
  vrm: () => import("./renderers/vrm/vrm-renderer"),
};

/** Loads a kind's renderer chunk on first use and creates a renderer. */
export async function loadAvatarRenderer(kind: AvatarKind): Promise<AvatarRenderer> {
  const module = await AVATAR_RENDERER_MODULES[kind]();
  return module.createAvatarRenderer();
}

// ── Director (lane director) and audio (lane TTS) ──

export type AvatarDirectorMode = Extract<ChatMode, "roleplay" | "game">;

export interface AvatarParticipant {
  owner: AvatarOwnerRef;
  /** Display name, matched against Game Master speaker names. */
  name: string;
}

export interface AvatarStreamUpdate {
  chatId: string;
  messageId: string | null;
  /** Visible reply text so far (cumulative), as the chat shows it. */
  text: string;
  /** The speaking owner when the Engine knows it (group individual mode), otherwise null. */
  speakerOwnerId: string | null;
  done: boolean;
}

/** The Expression Engine's post-reply pick: a sprite label. It is the final face for that reply. */
export interface AvatarExpressionPick {
  ownerId: string;
  expression: string;
}

/** Game mode: the Game Master line now on screen, with its per-line expression. */
export interface AvatarGameLine {
  speakerName: string;
  ownerId: string | null;
  expression: string | null;
  text: string;
}

/** Live loudness of a voice that is playing for one owner (text-to-speech). */
export interface AvatarAudioLevelSource {
  readonly ownerId: string;
  /** 0..1 loudness now; 0 when silent. */
  level(): number;
  /** Mouth shape guessed from the audio, when the source can tell. */
  viseme?(): AvatarViseme | null;
  isPlaying(): boolean;
}

/** Called with a source when voice starts for an owner and with null when it ends. */
export type AvatarAudioListener = (ownerId: string, source: AvatarAudioLevelSource | null) => void;

export interface AvatarDirectorOptions {
  chatId: string;
  mode: AvatarDirectorMode;
  reducedMotion: boolean;
}

/** Turns chat activity into frames. The director subscribes to its own feeds when created (chat stream
 *  buffers, Expression Engine results, Game Master lines, `subscribeAvatarAudio`); the push methods are
 *  that feed surface, also used by tests. The stage only creates it, sets participants, reads frames and
 *  disposes it. Roleplay faces come from the streaming classifier, Game faces from the Game Master's
 *  per-line expressions, and an Expression Engine pick, when present, is the final face after the reply.
 *  Lip sync follows the visible text while streaming (speech clock) and the audio level when TTS plays. */
export interface AvatarDirector {
  setParticipants(participants: readonly AvatarParticipant[]): void;
  pushStreamText(update: AvatarStreamUpdate): void;
  pushExpressionPicks(picks: readonly AvatarExpressionPick[]): void;
  pushGameLine(line: AvatarGameLine): void;
  setAudioSource(ownerId: string, source: AvatarAudioLevelSource | null): void;
  setUserTyping(typing: boolean): void;
  /** The frame for one owner at `nowMs` (performance.now()). Cheap: called every frame per avatar. */
  frame(ownerId: string, nowMs: number): AvatarFrameInput;
  dispose(): void;
}

// ── Setup UI (lanes base, 2D, 3D, generation) ──

/** Props of each kind's setup panel, shown on the matching agent's Agent editor page. */
export interface AvatarKindSetupPanelProps {
  owner: AvatarOwnerRef;
  config: AvatarConfig | null;
  /** Call after saving or importing, so the setup reloads the owner's config. */
  onChanged: () => void;
}

export const AVATAR_KIND_SETUP_PANELS: Readonly<
  Record<AvatarKind, LazyExoticComponent<ComponentType<AvatarKindSetupPanelProps>>>
> = {
  pngtuber: lazy(() =>
    import("./renderers/pngtuber/PngtuberSetupPanel").then((m) => ({ default: m.PngtuberSetupPanel })),
  ),
  "mesh-avatar": lazy(() =>
    import("./renderers/mesh-avatar/MeshAvatarSetupPanel").then((m) => ({ default: m.MeshAvatarSetupPanel })),
  ),
  vrm: lazy(() => import("./renderers/vrm/VrmSetupPanel").then((m) => ({ default: m.VrmSetupPanel }))),
};

/** One-click generation from a sprite (2D agent page only). */
export const AVATAR_GENERATION_PANEL: LazyExoticComponent<ComponentType<AvatarKindSetupPanelProps>> = lazy(() =>
  import("./generation/AvatarGenerationPanel").then((m) => ({ default: m.AvatarGenerationPanel })),
);

/** Props of the setup the base lane mounts on an avatar agent's Agent editor page. */
export interface AvatarAgentSetupProps {
  agentId: AvatarAgentId;
}

/** Props of the stage the base lane mounts in Roleplay and Game chats. */
export interface AvatarStageProps {
  chatId: string;
  mode: AvatarDirectorMode;
  participants: readonly AvatarParticipant[];
  /** Avatar agents that are on in this chat; kinds whose agent is off do not show. */
  enabledAgentIds: readonly AvatarAgentId[];
}

/** React Query keys for avatar models (the base lane's hooks use them; other lanes invalidate them). */
export const avatarModelKeys = {
  all: ["avatar-models"] as const,
  list: () => [...avatarModelKeys.all, "list"] as const,
  detail: (owner: AvatarOwnerRef) => [...avatarModelKeys.all, owner.ownerType, owner.ownerId] as const,
};
