import { Camera, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";

interface EditorAvatarTileActionsProps {
  generationAvailable: boolean;
  onGenerate: () => void;
}

export function EditorAvatarTileActions({ generationAvailable, onGenerate }: EditorAvatarTileActionsProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="absolute inset-0 flex items-end justify-start bg-black/40 p-1 opacity-0 transition-opacity group-hover:opacity-100">
        <Camera size="0.875rem" className="text-white" />
      </div>
      {generationAvailable && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onGenerate();
          }}
          className="absolute right-0 top-0 inline-flex h-3 w-3 items-center justify-center rounded-full bg-[var(--card)]/95 text-[var(--primary)] shadow-md ring-1 ring-[var(--border)] transition-colors before:absolute before:-inset-2 hover:bg-[var(--accent)]"
          title={t("editor.avatar.generate.label")}
          aria-label={t("editor.avatar.generate.label")}
        >
          <Wand2 size="0.375rem" />
        </button>
      )}
    </>
  );
}
