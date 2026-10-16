// ──────────────────────────────────────────────
// Avatar director: the local emotion model's download, on the avatar agents' pages (lane: director)
// ──────────────────────────────────────────────
// Shows whether the mood reader is downloaded, its download progress and a failed download. The download itself
// starts on its own when a Roleplay chat with the agent on opens (avatar-director.ts), so there is nothing to click.
import { useTranslation } from "react-i18next";
import { useAvatarEmotionModelStatus } from "../../../hooks/use-avatar-emotion-model";

const MB = 1024 * 1024;

export function AvatarModelStatus() {
  const { t } = useTranslation();
  const { data: status } = useAvatarEmotionModelStatus();
  if (!status) return null;

  const percent =
    status.totalBytes > 0 ? Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100)) : 0;
  const message = status.unsupported
    ? t("avatars.director.model.unsupported")
    : status.state === "downloading"
      ? t("avatars.director.model.downloading", { percent })
      : status.state === "loading"
        ? t("avatars.director.model.loading")
        : status.state === "downloaded"
          ? t("avatars.director.model.ready")
          : status.state === "failed"
            ? t("avatars.director.model.failed")
            : t("avatars.director.model.notDownloaded", { size: `${Math.round(status.totalBytes / MB)} MB` });

  return (
    <div
      className="space-y-2 rounded-xl bg-[var(--secondary)]/55 p-3 ring-1 ring-[var(--border)]"
      data-avatar-model-status={status.unsupported ? "unsupported" : status.state}
    >
      <p className="text-xs font-semibold text-[var(--foreground)]">{t("avatars.director.model.title")}</p>
      <p role="status" aria-live="polite" className="text-xs leading-snug text-[var(--muted-foreground)]">
        {message}
      </p>
      {!status.unsupported && status.state === "downloading" && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
          <div
            role="progressbar"
            aria-label={t("avatars.director.model.progressLabel")}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-full rounded-full bg-[var(--primary)] transition-all duration-300 motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}
