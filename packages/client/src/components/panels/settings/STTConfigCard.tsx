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
import { useTranslation as useUiTranslation } from "react-i18next";

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
  const { t: localizeUi } = useUiTranslation();
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
        toast.error(localizeUi("ui.panels.sttconfigcard.failedToSaveSpeechToTextSettings"));
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
          <div className="text-sm font-medium">{localizeUi("ui.panels.sttconfigcard.speechToText")}</div>
          <div className="truncate text-[0.6875rem] text-[var(--muted-foreground)]">
            {enabled
              ? localizeUi("ui.agents.featureagentdetailhost.value1Value2", {
                  value1: model || localizeUi("ui.panels.sttconfigcard.whisper1"),
                  value2: baseUrl || localizeUi("ui.panels.sttconfigcard.noServerConfigured"),
                })
              : localizeUi("ui.panels.sttconfigcard.talkToCharactersViaASelfHostedWhisperServer")}
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
            title={
              enabled
                ? localizeUi("ui.panels.sttconfigcard.disableSpeechToText")
                : localizeUi("ui.panels.sttconfigcard.enableSpeechToText")
            }
            className="rounded-lg p-1 hover:bg-[var(--secondary)]"
          />

          <button
            onClick={() => setExpanded((v) => !v)}
            className="mari-chrome-control mari-chrome-control--small h-8 min-h-0 w-8 p-0"
            title={
              expanded ? localizeUi("ui.panels.ttsconfigcard.collapse") : localizeUi("ui.panels.ttsconfigcard.expand")
            }
          >
            {expanded ? <ChevronUp size="0.875rem" /> : <ChevronDown size="0.875rem" />}
          </button>
        </div>
      </div>

      {/* ── Expanded body ── */}
      {expanded && (
        <div className="mt-3 space-y-4 border-t border-sky-400/10 pt-3">
          <FieldRow
            label={localizeUi("ui.panels.ttsconfigcard.baseUrl")}
            help={localizeUi("ui.panels.sttconfigcard.rootUrlOfAnOpenaiWhisperApiCompatibleTranscription")}
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
                placeholder={localizeUi("ui.panels.sttconfigcard.httpLocalhost9000V1")}
              />
            </div>
          </FieldRow>

          <FieldRow
            label={localizeUi("ui.panels.ttsconfigcard.apiKey")}
            help={localizeUi("ui.panels.sttconfigcard.optionalApiKeyForTheTranscriptionServerEncryptedAt")}
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
                placeholder={localizeUi("ui.panels.sttconfigcard.enterApiKeyOrLeaveBlank")}
              />
            </div>
          </FieldRow>

          <FieldRow
            label={localizeUi("ui.panels.ttsconfigcard.model")}
            help={localizeUi("ui.panels.sttconfigcard.whisperModelNameToRequestFromTheServerE")}
          >
            <input
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                mark({ model: e.target.value });
              }}
              className={INPUT_CLS}
              placeholder={localizeUi("ui.panels.sttconfigcard.whisper1")}
            />
          </FieldRow>

          <FieldRow
            label={localizeUi("settings.application.language.label")}
            help={localizeUi("ui.panels.sttconfigcard.optionalIso6391LanguageHintEGEn")}
          >
            <input
              value={language}
              onChange={(e) => {
                setLanguage(e.target.value);
                mark({ language: e.target.value });
              }}
              className={INPUT_CLS}
              placeholder={localizeUi("ui.panels.sttconfigcard.autoDetect")}
            />
          </FieldRow>

          <p className="rounded-lg border border-dashed border-sky-400/20 bg-sky-400/5 px-2.5 py-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
            {localizeUi("ui.panels.sttconfigcard.onceEnabledAMicButtonAppearsInTheRoleplay")}
          </p>

          <div className="flex items-center gap-2 pt-1">
            <div className="flex-1" />
            {saveStatus === "saving" && (
              <span className="flex items-center gap-1 text-[0.6875rem] text-[var(--muted-foreground)]">
                <Loader2 size="0.625rem" className="animate-spin" />
                {localizeUi("chat.settings.inlineEditor.saving")}
              </span>
            )}
            {saveStatus === "saved" && (
              <span className="flex items-center gap-1 text-[0.6875rem] text-emerald-400">
                <Check size="0.625rem" />
                {localizeUi("chat.settings.inlineEditor.saved")}
              </span>
            )}
            {saveStatus === "error" && (
              <span className="text-[0.6875rem] text-[var(--destructive)]">
                {localizeUi("ui.panels.ttsconfigcard.saveFailed")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
