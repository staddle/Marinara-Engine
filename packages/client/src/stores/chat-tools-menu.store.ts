import type { ReactNode } from "react";
import { create } from "zustand";
import type { WindowPoint } from "../lib/floating-window-layout";

export const CHAT_TOOLS_MENU_ID = "chat-tools-menu";

export interface ChatToolsMenuEntry {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: ReactNode;
  /** The chat Help target the tool stands for, so Help can explain it inside the menu. */
  helpTarget?: string;
}

/** Content stays with its window owner; only the phone launcher is collected here. */
export const useChatToolsMenuStore = create<{
  entries: Record<string, ChatToolsMenuEntry>;
  register: (entry: ChatToolsMenuEntry) => () => void;
}>()((set, get) => ({
  entries: {},
  register: (entry) => {
    set((state) => ({ entries: { ...state.entries, [entry.id]: entry } }));
    return () => {
      if (get().entries[entry.id] !== entry) return;
      const entries = { ...get().entries };
      delete entries[entry.id];
      set({ entries });
    };
  },
}));

/** The tools in menu order: the saved order first, then saved phone rows (a familiar start), then by id. */
export function orderChatTools(
  ids: readonly string[],
  savedOrder: readonly string[],
  points: Readonly<Record<string, WindowPoint | undefined>>,
): string[] {
  return [...ids].sort((left, right) => {
    const leftIndex = savedOrder.indexOf(left);
    const rightIndex = savedOrder.indexOf(right);
    if (leftIndex >= 0 || rightIndex >= 0)
      return (leftIndex < 0 ? Infinity : leftIndex) - (rightIndex < 0 ? Infinity : rightIndex);
    const a = points[left];
    const b = points[right];
    if (a && b) return a.y - b.y || a.x - b.x || left.localeCompare(right);
    return Number(!a) - Number(!b) || left.localeCompare(right);
  });
}
