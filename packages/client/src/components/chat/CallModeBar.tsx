import { Mic, MicOff, PhoneOff } from "lucide-react";
import { cn } from "../../lib/utils";
import type { CallVoiceState } from "../../hooks/use-call-voice-session";
import { useTranslation as useUiTranslation } from "react-i18next";

export type CallModePhase = "listening" | "thinking" | "speaking";

interface CallModeBarProps {
  phase: CallModePhase;
  voiceState: CallVoiceState;
  muted: boolean;
  onToggleMute: () => void;
  onEndCall: () => void;
}

function callStatusLabel(phase: CallModePhase, voiceState: CallVoiceState, muted: boolean): string {
  if (muted) return "Mic muted";
  if (phase === "thinking") return "Thinking…";
  if (phase === "speaking") return "Speaking…";
  if (voiceState === "speech-detected") return "Listening — go ahead…";
  return "Listening…";
}

export function CallModeBar({ phase, voiceState, muted, onToggleMute, onEndCall }: CallModeBarProps) {
  const { t: localizeUi } = useUiTranslation();
  const pulsing = !muted && phase === "listening" && voiceState === "speech-detected";
  const thinking = phase === "thinking";
  const speaking = phase === "speaking";

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-sky-400/20 bg-gradient-to-br from-sky-400/10 to-blue-500/10 px-4 py-3">
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-all",
          muted
            ? "bg-foreground/10 text-foreground/40"
            : speaking
              ? "bg-sky-400/25 text-sky-300"
              : thinking
                ? "bg-foreground/10 text-foreground/60"
                : pulsing
                  ? "bg-sky-400/30 text-sky-300 scale-110"
                  : "bg-sky-400/15 text-sky-400",
        )}
      >
        {muted ? <MicOff size="1.125rem" /> : <Mic size="1.125rem" className={cn(pulsing && "animate-pulse")} />}
      </span>

      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground/90">{callStatusLabel(phase, voiceState, muted)}</div>
        <div className="text-[0.6875rem] text-foreground/50">
          {localizeUi("ui.chat.callmodebar.callModeChatHistoryStaysInteractiveAbove")}
        </div>
      </div>

      <button
        type="button"
        onClick={onToggleMute}
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors",
          muted
            ? "bg-foreground/15 text-foreground/70 hover:bg-foreground/20"
            : "text-foreground/40 hover:bg-foreground/10 hover:text-foreground/70",
        )}
        title={
          muted ? localizeUi("ui.chat.callmodebar.unmuteMicrophone") : localizeUi("ui.chat.callmodebar.muteMicrophone")
        }
        aria-pressed={muted}
      >
        {muted ? <MicOff size="1rem" /> : <Mic size="1rem" />}
      </button>

      <button
        type="button"
        onClick={onEndCall}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-400 transition-colors hover:bg-red-500/25"
        title={localizeUi("ui.chat.callmodebar.endCall")}
      >
        <PhoneOff size="1rem" />
      </button>
    </div>
  );
}
