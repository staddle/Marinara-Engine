// ──────────────────────────────────────────────
// STT Configuration Card (Connections Panel)
// ──────────────────────────────────────────────
import { useState, useEffect, useRef } from "react";
import { Mic, Key, Globe, Check, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../../lib/utils";
import { toast } from "sonner";
import { useSTTConfig, useUpdateSTTConfig } from "../../../hooks/use-stt";
import type { STTConfig } from "@marinara-engine/shared";
import { STT_API_KEY_MASK } from "@marinara-engine/shared";
import { HelpTooltip } from "../../ui/HelpTooltip";
import { SettingsSwitch } from "./SettingControls";

function FieldRow({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <span className="text-xs font-medium text-[var(--foreground)]">{label}</span>
        {help && <HelpTooltip text={help} />}
      </div>
      {children}
    </div>
  );
}

const INPUT_CLS = "mari-chrome-field w-full px-3 py-2.5 text-sm placeholder:text-[var(--muted-foreground)]";

export function STTConfigCard() {
  const { data: savedConfig, isLoading } = useSTTConfig();
  const updateConfig = useUpdateSTTConfig();

  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("whisper-1");
  const [language, setLanguage] = useState("");

  const [expanded, setExpanded] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!savedConfig) return;
    setEnabled(savedConfig.enabled);
    setBaseUrl(savedConfig.baseUrl);
    setApiKey(savedConfig.apiKey);
    setModel(savedConfig.model);
    setLanguage(savedConfig.language ?? "");
    setSaveStatus("idle");
  }, [savedConfig]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    },
    [],
  );

  const buildPayload = (overrides?: Partial<STTConfig>): STTConfig => ({
    enabled,
    baseUrl,
    apiKey: apiKey === STT_API_KEY_MASK ? STT_API_KEY_MASK : apiKey,
    model,
    language,
    ...overrides,
  });

  const mark = (overrides?: Partial<STTConfig>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus("idle");
    const payload = buildPayload(overrides);
    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus("saving");
      try {
        await updateConfig.mutateAsync(payload);
        setSaveStatus("saved");
        if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
        statusTimerRef.current = setTimeout(() => {
          setSaveStatus((s) => (s === "saved" ? "idle" : s));
          statusTimerRef.current = null;
        }, 2000);
      } catch {
        setSaveStatus("error");
        toast.error("Failed to save speech-to-text settings.");
      }
    }, 600);
  };

  if (isLoading) return null;

  return (
    <div
      className={cn(
        "rounded-xl border border-sky-400/20 bg-gradient-to-br from-sky-400/5 to-blue-500/5 p-3 transition-all",
        expanded && "border-sky-400/30",
      )}
    >
      {/* ── Header ── */}
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-500 text-white shadow-sm">
          <Mic size="1rem" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Speech to Text</div>
          <div className="truncate text-[0.6875rem] text-[var(--muted-foreground)]">
            {enabled ? `${model || "whisper-1"} · ${baseUrl || "No server configured"}` : "Talk to characters via a self-hosted Whisper server"}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <SettingsSwitch
            checked={enabled}
            onChange={(checked) => {
              setEnabled(checked);
              mark({ enabled: checked });
            }}
            ariaLabel={enabled ? "Disable speech to text" : "Enable speech to text"}
            title={enabled ? "Disable speech to text" : "Enable speech to text"}
            className="rounded-lg p-1 hover:bg-[var(--secondary)]"
          />

          <button
            onClick={() => setExpanded((v) => !v)}
            className="mari-chrome-control mari-chrome-control--small h-8 min-h-0 w-8 p-0"
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <ChevronUp size="0.875rem" /> : <ChevronDown size="0.875rem" />}
          </button>
        </div>
      </div>

      {/* ── Expanded body ── */}
      {expanded && (
        <div className="mt-3 space-y-4 border-t border-sky-400/10 pt-3">
          <FieldRow
            label="Base URL"
            help="Root URL of an OpenAI-Whisper-API-compatible transcription server (must serve POST {baseUrl}/audio/transcriptions), e.g. a self-hosted faster-whisper-server or whisper-asr-webservice instance."
          >
            <div className="relative">
              <Globe size="0.875rem" className="absolute left-3 top-1/2 -translate-y-1/2 text-sky-400" />
              <input
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  mark({ baseUrl: e.target.value });
                }}
                className={cn(INPUT_CLS, "pl-8 font-mono")}
                placeholder="http://localhost:9000/v1"
              />
            </div>
          </FieldRow>

          <FieldRow
            label="API Key"
            help="Optional API key for the transcription server. Encrypted at rest. Keep the masked value to preserve the current key, or clear the field to remove it."
          >
            <div className="relative">
              <Key size="0.875rem" className="absolute left-3 top-1/2 -translate-y-1/2 text-sky-400" />
              <input
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  mark({ apiKey: e.target.value === STT_API_KEY_MASK ? STT_API_KEY_MASK : e.target.value });
                }}
                type="password"
                className={cn(INPUT_CLS, "pl-8")}
                placeholder="Enter API key or leave blank"
              />
            </div>
          </FieldRow>

          <FieldRow label="Model" help="Whisper model name to request from the server, e.g. whisper-1, base, small, medium, large-v3.">
            <input
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                mark({ model: e.target.value });
              }}
              className={INPUT_CLS}
              placeholder="whisper-1"
            />
          </FieldRow>

          <FieldRow
            label="Language"
            help="Optional ISO-639-1 language hint (e.g. en, de, ja). Leave blank to let the server auto-detect."
          >
            <input
              value={language}
              onChange={(e) => {
                setLanguage(e.target.value);
                mark({ language: e.target.value });
              }}
              className={INPUT_CLS}
              placeholder="Auto-detect"
            />
          </FieldRow>

          <p className="rounded-lg border border-dashed border-sky-400/20 bg-sky-400/5 px-2.5 py-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
            Once enabled, a mic button appears in the roleplay chat input — click to record, click again to stop; your
            recording is transcribed here and sent as your message.
          </p>

          <div className="flex items-center gap-2 pt-1">
            <div className="flex-1" />
            {saveStatus === "saving" && (
              <span className="flex items-center gap-1 text-[0.6875rem] text-[var(--muted-foreground)]">
                <Loader2 size="0.625rem" className="animate-spin" />
                Saving…
              </span>
            )}
            {saveStatus === "saved" && (
              <span className="flex items-center gap-1 text-[0.6875rem] text-emerald-400">
                <Check size="0.625rem" />
                Saved
              </span>
            )}
            {saveStatus === "error" && <span className="text-[0.6875rem] text-[var(--destructive)]">Save failed</span>}
          </div>
        </div>
      )}
    </div>
  );
}
