// ──────────────────────────────────────────────
// Trackers button for chats using the Tracker Panel
//
// This replaces the standard tracker window's button while the panel is selected.
// It opens the panel or closes it, and its place saves with the chat like every other bubble.
// ──────────────────────────────────────────────
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TrackerPanelIcon } from "../ui/TrackerPanelIcon";
import { WindowBubble } from "../ui/WindowBubble";
import { usePhoneBubbleBounds, useWindowBubbleBounds } from "../ui/FloatingWindow";
import {
  PHONE_BUBBLE_SIZE_PX,
  WINDOW_BUBBLE_SIZE_PX,
  getBubbleRowSlot,
  getPhoneBubbleSlot,
} from "../../lib/floating-window-layout";
import { BUBBLE_SNAP_GAP_PX } from "../../lib/window-bubble-snap";
import { useMatchMedia } from "../../hooks/use-match-media";
import { closeTrackerPanel } from "../../lib/tracker-panel-surface";
import { useUIStore } from "../../stores/ui.store";
import {
  FLOATING_WINDOW_Z_BASE,
  PHONE_BUBBLE_Z_INDEX,
  TRACKER_PANEL_BUBBLE_ID,
  useFloatingWindowStore,
} from "../../stores/floating-window.store";

export function TrackerPanelBubble({ chatId, phoneSlot = 0 }: { chatId: string; phoneSlot?: number }) {
  const { t } = useTranslation();
  const phoneLayout = useMatchMedia("(max-width: 767px)");
  const phoneBounds = usePhoneBubbleBounds(phoneLayout);
  const windowBounds = useWindowBubbleBounds(!phoneLayout);
  const bounds = phoneLayout ? phoneBounds : windowBounds;
  const saved = useFloatingWindowStore(
    (state) => (phoneLayout ? state.phoneBubbles : state.bubbles)[TRACKER_PANEL_BUBBLE_ID],
  );
  const open = useFloatingWindowStore((state) => state.open[TRACKER_PANEL_BUBBLE_ID] === true);
  const panelOnLeft = useUIStore((state) => state.trackerPanelSide === "left");
  const bubbleRef = useRef<HTMLButtonElement | null>(null);
  const [size, setSize] = useState(PHONE_BUBBLE_SIZE_PX);
  const wasOpenRef = useRef(open);

  // The panel closed: focus comes back to the bubble unless the user moved it elsewhere.
  useEffect(() => {
    if (wasOpenRef.current && !open && (!document.activeElement || document.activeElement === document.body)) {
      bubbleRef.current?.focus({ preventScroll: true });
    }
    wasOpenRef.current = open;
  }, [open]);

  // Desktop opens the selected panel initially; phones begin at the button.
  // Keep opening and cleanup together so remounts and chat switches restore the right surface.
  useEffect(() => {
    const windows = useFloatingWindowStore.getState();
    if (!phoneLayout) windows.openWindow(TRACKER_PANEL_BUBBLE_ID, null, { focus: false });
    return () => windows.closeWindow(TRACKER_PANEL_BUBBLE_ID);
  }, [chatId, phoneLayout]);

  // On a computer it starts in the top corner away from the panel, so it never covers the panel's header.
  const desktopPoint = panelOnLeft
    ? getBubbleRowSlot(bounds, 0, { size: WINDOW_BUBBLE_SIZE_PX, gap: BUBBLE_SNAP_GAP_PX })
    : { x: bounds.left, y: bounds.top };

  return (
    <WindowBubble
      buttonRef={bubbleRef}
      id={TRACKER_PANEL_BUBBLE_ID}
      point={
        saved ?? {
          ...(phoneLayout ? getPhoneBubbleSlot(bounds, phoneSlot, size) : desktopPoint),
          automatic: true,
        }
      }
      bounds={bounds}
      size={phoneLayout ? PHONE_BUBBLE_SIZE_PX : WINDOW_BUBBLE_SIZE_PX}
      onSizeChange={setSize}
      icon={<TrackerPanelIcon size="1.05rem" className="shrink-0" />}
      label={t("chat.trackerWindow.title")}
      ariaLabel={t("chat.trackerWindow.title")}
      tooltip={t("chat.trackerWindow.title")}
      expanded={open}
      zIndex={phoneLayout ? PHONE_BUBBLE_Z_INDEX : FLOATING_WINDOW_Z_BASE}
      attributes={{
        "data-presentation": phoneLayout ? "sheet" : "window",
        "data-tracker-panel-toggle": "bubble",
      }}
      onMove={(point) => {
        const state = useFloatingWindowStore.getState();
        if (phoneLayout) state.savePhoneBubble(TRACKER_PANEL_BUBBLE_ID, point);
        else state.saveBubble(TRACKER_PANEL_BUBBLE_ID, point);
      }}
      onOpen={(bubble) => {
        // Like the Chat Settings button: a second press closes what the first one opened.
        if (open) closeTrackerPanel();
        else useFloatingWindowStore.getState().openWindow(TRACKER_PANEL_BUBBLE_ID, bubble, { focus: false });
      }}
    />
  );
}
