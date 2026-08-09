import { useCallback } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../../lib/utils";
import { useMicRecorder } from "../../hooks/use-mic-recorder";
import { useTranscribeAudio } from "../../hooks/use-stt";
import { useTranslation as useUiTranslation } from "react-i18next";
import { classifyMicAccessError } from "../../lib/mic-access-error";

interface PushToTalkButtonProps {
  disabled?: boolean;
  /** Called with the transcribed text once recording stops and transcription succeeds. */
  onTranscribed: (text: string) => void;
  className?: string;
  iconSize?: number;
}

/**
 * Toggle-style voice input: click to start recording, click again to stop, transcribe via the
 * configured self-hosted Whisper server, and hand the transcript back for the caller to send.
 */
export function PushToTalkButton({ disabled, onTranscribed, className, iconSize = 16 }: PushToTalkButtonProps) {
  const { t: localizeUi } = useUiTranslation();
  const { state, start, stop } = useMicRecorder();
  const transcribeAudio = useTranscribeAudio();
  const recording = state === "recording";
  const busy = state === "stopping" || transcribeAudio.isPending;

  const handleClick = useCallback(async () => {
    if (disabled || busy) return;

    if (recording) {
      try {
        const blob = await stop();
        const { text } = await transcribeAudio.mutateAsync(blob);
        if (text.trim()) {
          onTranscribed(text.trim());
        } else {
          toast.info(localizeUi("ui.ui.pushtotalkbutton.didnTCatchAnySpeechInThatRecording"));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Transcription failed.";
        toast.error(message);
      }
      return;
    }

    try {
      await start();
    } catch (error) {
      console.error("[push-to-talk] getUserMedia failed:", error);
      const kind = classifyMicAccessError(error);
      const message =
        kind === "insecure-context"
          ? localizeUi("ui.hooks.usecallvoicesession.microphoneAccessRequiresHttpsOrLocalhostThisPage")
          : kind === "permission-denied"
            ? localizeUi("ui.hooks.usecallvoicesession.microphonePermissionWasDeniedCheckYourBrowsers")
            : kind === "not-found"
              ? localizeUi("ui.hooks.usecallvoicesession.noMicrophoneWasFoundOnThisDevice")
              : localizeUi("ui.ui.pushtotalkbutton.couldNotAccessTheMicrophone");
      toast.error(message);
    }
  }, [busy, disabled, localizeUi, onTranscribed, recording, start, stop, transcribeAudio]);

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={disabled || busy}
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-all duration-200 active:scale-90 sm:h-8 sm:w-8",
        recording
          ? "bg-red-500/15 text-red-400 ring-1 ring-red-400/40"
          : "text-foreground/40 hover:bg-foreground/10 hover:text-foreground/70",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      title={
        recording
          ? localizeUi("ui.ui.pushtotalkbutton.stopRecordingAndSend")
          : localizeUi("ui.ui.pushtotalkbutton.talkToCharacter")
      }
      aria-pressed={recording}
      aria-label={
        recording
          ? localizeUi("ui.ui.pushtotalkbutton.stopRecordingAndSend")
          : localizeUi("ui.ui.pushtotalkbutton.talkToCharacter")
      }
    >
      {busy ? (
        <Loader2 size={iconSize} className="animate-spin" />
      ) : recording ? (
        <Square size={iconSize} />
      ) : (
        <Mic size={iconSize} />
      )}
    </button>
  );
}
