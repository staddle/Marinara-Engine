import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Brain } from "lucide-react";
import { Modal } from "../ui/Modal";

export function MessageThinkingModal({
  thinking,
  onClose,
  restoreFocusRef,
}: {
  thinking: string;
  onClose: () => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const title = t("chat.message.thoughts.title");

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width="max-w-xl"
      panelClassName="max-h-[70vh]"
      chatFloatingPanel
      restoreFocusRef={restoreFocusRef}
    >
      <div className="flex items-start gap-2.5">
        <Brain
          size="0.875rem"
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-[var(--marinara-chat-chrome-button-text-active)]"
        />
        <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[0.8125rem] leading-relaxed text-[var(--marinara-chat-chrome-panel-text)]">
          {thinking}
        </pre>
      </div>
    </Modal>
  );
}
