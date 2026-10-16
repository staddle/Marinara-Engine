// ──────────────────────────────────────────────
// Avatar stage: when avatars draw nothing (lane: base)
// ──────────────────────────────────────────────
// Avatars run at 0 fps while the tab is hidden, the window is unfocused or the Appearance settings are open
// (the app's own "effects paused" state from App.tsx), while their stage is off screen, and while a panel or
// editor covers the chat.
import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

function subscribeEffectsPaused(onChange: () => void) {
  window.addEventListener("marinara:effects-paused", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("marinara:effects-paused", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

function readEffectsPaused() {
  return document.visibilityState !== "visible" || document.documentElement.dataset.marinaraEffectsPaused === "true";
}

export function useAvatarEffectsPaused(): boolean {
  return useSyncExternalStore(subscribeEffectsPaused, readEffectsPaused, () => true);
}

/** Whether the element is at least partly on screen. `watchKey` re-attaches when the element appears. */
export function useOnScreen(ref: RefObject<Element | null>, watchKey: unknown): boolean {
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, watchKey]);
  return onScreen;
}

/** Whether a panel, editor or browser covers the chat the element sits in. Phones keep the chat mounted
 *  under them, where it still counts as on screen; AppShell marks its root with data-chat-surface-active
 *  only while the chat is what the user sees. */
export function useChatCovered(ref: RefObject<Element | null>, watchKey: unknown): boolean {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    const shell = ref.current?.closest('[data-component="AppShell"]');
    if (!shell || typeof MutationObserver === "undefined") return;
    const read = () => setCovered(shell.getAttribute("data-chat-surface-active") !== "true");
    read();
    const observer = new MutationObserver(read);
    observer.observe(shell, { attributes: true, attributeFilter: ["data-chat-surface-active"] });
    return () => observer.disconnect();
  }, [ref, watchKey]);
  return covered;
}
