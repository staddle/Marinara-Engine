import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../lib/utils";
import { useTranslation as useUiTranslation } from "react-i18next";

type TranscriptWindowControlsProps = {
  hiddenBeforeCount: number;
  hiddenAfterCount: number;
  onShowOlder?: () => void;
  onShowNewer?: () => void;
  onJumpToLatest?: () => void;
  className?: string;
  buttonClassName?: string;
};

/** Buttons that page through chat history, such as Load More and Show older. They follow the chat style switches. */
export const HISTORY_PAGER_BUTTON_CLASS =
  "mari-chat-history-pager mari-chat-style-control mari-chrome-control mari-chrome-control--small px-3 text-xs";

export function TranscriptWindowControls({
  hiddenBeforeCount,
  hiddenAfterCount,
  onShowOlder,
  onShowNewer,
  onJumpToLatest,
  className,
  buttonClassName,
}: TranscriptWindowControlsProps) {
  const { t: localizeUi } = useUiTranslation();
  if (!onShowOlder && !onShowNewer && !onJumpToLatest) return null;

  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-2 px-3 py-2", className)}>
      {onShowOlder && hiddenBeforeCount > 0 && (
        <button type="button" onClick={onShowOlder} className={cn(HISTORY_PAGER_BUTTON_CLASS, buttonClassName)}>
          <ChevronUp size="0.75rem" />
          {localizeUi("ui.chat.transcriptwindowcontrols.showOlder")}
          {hiddenBeforeCount})
        </button>
      )}
      {onShowNewer && hiddenAfterCount > 0 && (
        <button type="button" onClick={onShowNewer} className={cn(HISTORY_PAGER_BUTTON_CLASS, buttonClassName)}>
          <ChevronDown size="0.75rem" />
          {localizeUi("ui.chat.transcriptwindowcontrols.showNewer")}
          {hiddenAfterCount})
        </button>
      )}
      {onJumpToLatest && hiddenAfterCount > 0 && (
        <button type="button" onClick={onJumpToLatest} className={cn(HISTORY_PAGER_BUTTON_CLASS, buttonClassName)}>
          {localizeUi("ui.chat.transcriptwindowcontrols.latest")}
        </button>
      )}
    </div>
  );
}
