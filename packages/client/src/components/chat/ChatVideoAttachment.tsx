import { X } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

/** A generated video attached to a chat message, played inline with the browser's own controls. */
export function ChatVideoAttachment({
  src,
  prompt,
  onRemove,
  className,
}: {
  src: string;
  prompt?: string | null;
  onRemove?: () => void;
  className?: string;
}) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <div className={cn("group/att relative inline-block max-w-full", className)}>
      <video
        src={src}
        controls
        playsInline
        loop
        preload="metadata"
        title={prompt ?? undefined}
        aria-label={localizeUi("ui.chat.chatvideoattachment.generatedVideo")}
        onClick={(event) => event.stopPropagation()}
        className="block max-h-[70vh] max-w-full rounded-lg bg-black/90 sm:max-h-[32rem]"
      />
      {onRemove && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          aria-label={localizeUi("ui.chat.chatvideoattachment.removeVideoFromMessage")}
          title={localizeUi("ui.chat.chatmessage.removeFromMessage")}
          className="absolute top-1.5 right-1.5 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white/80 transition-opacity hover:bg-black/80 hover:text-white/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] [@media(pointer:fine)]:h-6 [@media(pointer:fine)]:w-6 [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover/att:opacity-100 [@media(pointer:fine)]:group-focus-within/att:opacity-100"
        >
          <X size="0.875rem" />
        </button>
      )}
    </div>
  );
}

export function isVideoAttachment(att: { type?: string } | null | undefined): boolean {
  return att?.type === "video" || !!att?.type?.startsWith("video/");
}

/** A message whose text is an image link already shows that picture, so only its videos still show below it. */
export function isAttachmentHiddenByImageText(att: { type?: string } | null | undefined, textIsImageUrl: boolean) {
  return textIsImageUrl && !isVideoAttachment(att);
}
