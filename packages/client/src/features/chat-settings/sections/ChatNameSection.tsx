import { Check, LetterText } from "lucide-react";
import { ChatSettingsSection } from "../ChatSettingsSection";
import { useTranslation as useUiTranslation } from "react-i18next";

interface ChatNameSectionProps {
  chatName: string;
  editingName: boolean;
  nameValue: string;
  onBeginEdit: () => void;
  onNameValueChange: (value: string) => void;
  onSaveName: () => void;
}

export function ChatNameSection({
  chatName,
  editingName,
  nameValue,
  onBeginEdit,
  onNameValueChange,
  onSaveName,
}: ChatNameSectionProps) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <ChatSettingsSection
      id="chat-name"
      label={localizeUi("ui.chatSettings.chatnamesection.chatName")}
      icon={<LetterText size="0.875rem" />}
      help={localizeUi("ui.chatSettings.chatnamesection.thisNameIsOnlyVisibleToYouItWon")}
    >
      {editingName ? (
        <div className="flex gap-2">
          <input
            value={nameValue}
            onChange={(e) => onNameValueChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSaveName()}
            autoFocus
            className="flex-1 rounded-lg bg-[var(--secondary)] px-3 py-2 text-xs outline-none ring-1 ring-[var(--primary)]/40"
          />
          <button
            type="button"
            aria-label={localizeUi("ui.chatSettings.chatnamesection.saveChatName")}
            onClick={onSaveName}
            className="rounded-lg bg-[var(--primary)] px-3 py-2 text-xs text-white"
          >
            <Check size="0.75rem" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onBeginEdit}
          className="w-full rounded-lg bg-[var(--secondary)] px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--accent)]"
        >
          {chatName}
        </button>
      )}
    </ChatSettingsSection>
  );
}
