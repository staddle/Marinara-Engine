// ──────────────────────────────────────────────
// Color Picker — supports single colors & gradients
// ──────────────────────────────────────────────
import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { Pipette, Sparkles, X, Plus, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { isCssGradient, RAINBOW_GRADIENT_PRESET } from "../../lib/css-colors";
import { useTranslation as useUiTranslation } from "react-i18next";

interface ColorPickerProps {
  value: string;
  onChange: (value: string) => void;
  /** Allow gradient mode (for name colors) */
  gradient?: boolean;
  /** Use tighter spacing for narrow settings drawers. */
  compact?: boolean;
  /** Label displayed above the picker */
  label: string;
  /** Help text beneath the label */
  helpText?: string;
  /** Text shown when no color is set. */
  emptyText?: string;
  /** Optional color/gradient shown in the preview when no explicit value is set. */
  emptyPreviewValue?: string;
  /** Text shown for the clear/reset action. */
  clearLabel?: string;
  /** Value restored by the clear/reset action. Defaults to empty string. */
  clearValue?: string;
  /** Optional compact control shown beside the label. */
  headerAction?: ReactNode;
  /** Prevent editing while still showing the current preview. */
  disabled?: boolean;
}

/** Preset palette colors */
const PRESETS = [
  "#ff6b6b",
  "#ee5a24",
  "#f0932b",
  "#ffd93d",
  "#6ab04c",
  "#22a6b3",
  "#4834d4",
  "#6c5ce7",
  "#e056fd",
  "#fd79a8",
  "#fdcb6e",
  "#00cec9",
  "#2ed573",
  "#1e90ff",
  "#a29bfe",
  "#ff7979",
  "#badc58",
  "#7ed6df",
  "#e17055",
  "#d63031",
];

/** Preset gradients */
const GRADIENT_PRESETS = [
  RAINBOW_GRADIENT_PRESET,
  "linear-gradient(90deg, #ff6b6b, #ffd93d)",
  "linear-gradient(90deg, #a29bfe, #fd79a8)",
  "linear-gradient(90deg, #6c5ce7, #00cec9)",
  "linear-gradient(90deg, #e056fd, #4834d4)",
  "linear-gradient(90deg, #f0932b, #ee5a24)",
  "linear-gradient(90deg, #22a6b3, #6ab04c)",
  "linear-gradient(90deg, #1e90ff, #a29bfe)",
  "linear-gradient(90deg, #ff7979, #e056fd)",
  "linear-gradient(135deg, #667eea, #764ba2)",
  "linear-gradient(135deg, #f093fb, #f5576c)",
  "linear-gradient(135deg, #4facfe, #00f2fe)",
  "linear-gradient(135deg, #43e97b, #38f9d7)",
];

/** Parse gradient into stops: "linear-gradient(90deg, #ff6b6b, #ffd93d)" → ["#ff6b6b","#ffd93d"] */
function parseGradientStops(value: string): string[] {
  const match = value.match(/linear-gradient\([^,]+,\s*(.+)\)/);
  if (!match) return ["#ff6b6b", "#ffd93d"];
  return match[1].split(",").map((s) => s.trim());
}

function buildGradient(angle: number, stops: string[]): string {
  return `linear-gradient(${angle}deg, ${stops.join(", ")})`;
}

function getNativeColorValue(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#6c5ce7";
}

export function ColorPicker({
  value,
  onChange,
  gradient = false,
  compact = false,
  label,
  helpText,
  emptyText = "No color set — uses default",
  emptyPreviewValue = "",
  clearLabel = "Clear",
  clearValue = "",
  headerAction,
  disabled = false,
}: ColorPickerProps) {
  const { t: localizeUi } = useUiTranslation();
  const isGradient = isCssGradient(value);
  const [mode, setMode] = useState<"solid" | "gradient">(isGradient ? "gradient" : "solid");
  const [gradientStops, setGradientStops] = useState<string[]>(
    isGradient ? parseGradientStops(value) : ["#ff6b6b", "#ffd93d"],
  );
  const [gradientAngle, setGradientAngle] = useState(90);
  const [expanded, setExpanded] = useState(false);
  const nativeRef = useRef<HTMLInputElement>(null);
  const activeStopRef = useRef<number>(0);
  const onChangeRef = useRef(onChange);
  const pendingChangeRef = useRef<string | null>(null);
  const pendingFrameRef = useRef<number | null>(null);

  // Sync value → local state when value changes externally
  useEffect(() => {
    if (isCssGradient(value)) {
      setMode("gradient");
      setGradientStops(parseGradientStops(value));
      const angleMatch = value.match(/linear-gradient\((\d+)deg/);
      if (angleMatch) setGradientAngle(parseInt(angleMatch[1]));
    } else if (value) {
      setMode("solid");
    }
  }, [value]);

  useEffect(() => {
    if (disabled) {
      setExpanded(false);
    }
  }, [disabled]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const flushPendingChange = useCallback(() => {
    if (pendingFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }
    const pending = pendingChangeRef.current;
    pendingChangeRef.current = null;
    if (pending !== null) {
      onChangeRef.current(pending);
    }
  }, []);

  const cancelPendingChange = useCallback(() => {
    if (pendingFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingFrameRef.current);
      pendingFrameRef.current = null;
    }
    pendingChangeRef.current = null;
  }, []);

  useEffect(
    () => () => {
      flushPendingChange();
    },
    [flushPendingChange],
  );

  const commitChange = useCallback((nextValue: string, defer = false) => {
    if (!defer) {
      cancelPendingChange();
      onChangeRef.current(nextValue);
      return;
    }

    pendingChangeRef.current = nextValue;
    if (pendingFrameRef.current !== null) return;
    pendingFrameRef.current = window.requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      const pending = pendingChangeRef.current;
      pendingChangeRef.current = null;
      if (pending !== null) {
        onChangeRef.current(pending);
      }
    });
  }, [cancelPendingChange]);

  const handleSolidChange = useCallback(
    (color: string, defer = false) => {
      commitChange(color, defer);
    },
    [commitChange],
  );

  const handleGradientStopChange = useCallback(
    (index: number, color: string, defer = false) => {
      const updated = gradientStops.map((stop, i) => (i === index ? color : stop));
      setGradientStops(updated);
      commitChange(buildGradient(gradientAngle, updated), defer);
    },
    [commitChange, gradientAngle, gradientStops],
  );

  const addStop = useCallback(() => {
    const updated = [...gradientStops, "#ffffff"];
    setGradientStops(updated);
    commitChange(buildGradient(gradientAngle, updated));
  }, [commitChange, gradientAngle, gradientStops]);

  const removeStop = useCallback(
    (index: number) => {
      if (gradientStops.length <= 2) return;
      const updated = gradientStops.filter((_, i) => i !== index);
      setGradientStops(updated);
      commitChange(buildGradient(gradientAngle, updated));
    },
    [commitChange, gradientAngle, gradientStops],
  );

  const handleAngleChange = useCallback(
    (angle: number, defer = false) => {
      setGradientAngle(angle);
      commitChange(buildGradient(angle, gradientStops), defer);
    },
    [commitChange, gradientStops],
  );

  const clearColor = useCallback(() => {
    commitChange(clearValue);
    setExpanded(false);
  }, [clearValue, commitChange]);

  const previewValue = value || emptyPreviewValue;
  const showClear = clearValue ? value !== clearValue : !!value;
  const displayStyle = previewValue
    ? isCssGradient(previewValue)
      ? { background: previewValue }
      : { backgroundColor: previewValue }
    : { backgroundColor: "transparent" };

  return (
    <div className={cn("space-y-2", compact && "space-y-1.5")}>
      {/* Label */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-xs font-medium text-[var(--muted-foreground)]">{label}</span>
          {headerAction}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {showClear && (
            <button
              type="button"
              onClick={clearColor}
              disabled={disabled}
              className="flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)] transition-all hover:bg-[var(--destructive)]/15 hover:text-[var(--destructive)]"
            >
              <X size="0.625rem" />
              {clearLabel}
            </button>
          )}
        </div>
      </div>
      {helpText && <p className="text-[0.625rem] text-[var(--muted-foreground)]/70">{helpText}</p>}

      {/* Preview + trigger */}
      <button
        type="button"
        onClick={() => {
          if (!disabled) setExpanded(!expanded);
        }}
        disabled={disabled}
        className={cn(
          "flex w-full items-center rounded-xl border border-[var(--border)] bg-[var(--secondary)] transition-all hover:border-[var(--primary)]/30",
          compact ? "gap-2 rounded-lg p-1.5" : "gap-3 p-2.5",
          expanded && "border-[var(--primary)]/40 ring-1 ring-[var(--primary)]/20",
          disabled && "cursor-not-allowed opacity-60 hover:border-[var(--border)]",
        )}
      >
        <div
          className={cn("shrink-0 rounded-lg ring-1 ring-[var(--border)]", compact ? "h-6 w-6" : "h-8 w-8")}
          style={{
            ...displayStyle,
            ...(!previewValue && {
              backgroundImage: "repeating-conic-gradient(var(--border) 0% 25%, transparent 0% 50%)",
              backgroundSize: "0.5rem 0.5rem",
            }),
          }}
        />
        <span className="flex-1 text-left text-xs text-[var(--muted-foreground)] truncate">{value || emptyText}</span>
        <Pipette size="0.8125rem" className="shrink-0 text-[var(--muted-foreground)]" />
      </button>

      {/* Expanded picker */}
      {expanded && (
        <div
          className={cn(
            "rounded-xl border border-[var(--border)] bg-[var(--card)] animate-in slide-in-from-top-2 duration-200",
            compact ? "space-y-2 p-2" : "space-y-3 p-3",
          )}
        >
          {/* Mode toggle (only if gradient is allowed) */}
          {gradient && (
            <div className="flex rounded-lg bg-[var(--secondary)] p-0.5">
              <button
                type="button"
                onClick={() => {
                  setMode("solid");
                  if (gradientStops[0]) handleSolidChange(gradientStops[0]);
                }}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-[0.6875rem] font-medium transition-all",
                  mode === "solid"
                    ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                )}
              >
                <Pipette size="0.6875rem" className="mr-1 inline" />{localizeUi("ui.ui.colorpicker.solid")}</button>
              <button
                type="button"
                onClick={() => {
                  setMode("gradient");
                  onChange(buildGradient(gradientAngle, gradientStops));
                }}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 text-[0.6875rem] font-medium transition-all",
                  mode === "gradient"
                    ? "bg-[var(--background)] text-[var(--foreground)] shadow-sm"
                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                )}
              >
                <Sparkles size="0.6875rem" className="mr-1 inline" />{localizeUi("ui.ui.colorpicker.gradient")}</button>
            </div>
          )}

          {/* Solid color mode */}
          {mode === "solid" && (
            <>
              {/* Native color picker + typed CSS value */}
              <div className="grid gap-2">
                <label className="group relative flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-2.5 transition-all hover:border-[var(--primary)]/35 hover:bg-[var(--accent)]/25">
                  <span
                    className="h-6 w-6 shrink-0 rounded-md ring-1 ring-[var(--border)]"
                    style={{
                      backgroundColor: previewValue && !isCssGradient(previewValue) ? previewValue : "#6c5ce7",
                    }}
                  />
                  <span className="min-w-0 text-xs font-medium text-[var(--foreground)]">{localizeUi("ui.ui.colorpicker.pickColor")}</span>
                  <Pipette size="0.75rem" className="ml-auto shrink-0 text-[var(--muted-foreground)]" />
                  <input
                    ref={nativeRef}
                    type="color"
                    aria-label={localizeUi("ui.ui.colorpicker.pickValue1Color", { value1: label })}
                    value={!isCssGradient(previewValue) ? getNativeColorValue(previewValue) : "#6c5ce7"}
                    onInput={(e) => handleSolidChange(e.currentTarget.value, true)}
                    onChange={(e) => handleSolidChange(e.currentTarget.value, true)}
                    onBlur={flushPendingChange}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>

                <label className="min-w-0 space-y-1">
                  <span className="block text-[0.625rem] font-medium text-[var(--muted-foreground)]">{localizeUi("ui.ui.colorpicker.hexCss")}</span>
                  <input
                    aria-label={localizeUi("ui.ui.colorpicker.value1HexOrCssColor", { value1: label })}
                    value={value && !isCssGradient(value) ? value : ""}
                    onChange={(e) => handleSolidChange(e.target.value)}
                    placeholder={localizeUi("ui.ui.colorpicker.hexOrColorName")}
                    className="w-full rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-2.5 py-1.5 font-mono text-xs outline-none transition-colors focus:border-[var(--primary)]/50"
                  />
                </label>
              </div>

              {/* Preset palette */}
              <div>
                <p className="mb-1.5 text-[0.625rem] text-[var(--muted-foreground)]">{localizeUi("navigation.topbar.presets")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => handleSolidChange(color)}
                      className={cn(
                        "h-6 w-6 rounded-md ring-1 ring-[var(--border)] transition-all hover:scale-110 hover:ring-2 hover:ring-[var(--primary)]/50",
                        value === color && "ring-2 ring-[var(--primary)] scale-110",
                      )}
                      style={{ backgroundColor: color }}
                      title={color}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Gradient mode */}
          {mode === "gradient" && (
            <>
              {/* Gradient preview bar */}
              <div
                className="h-8 w-full rounded-lg ring-1 ring-[var(--border)]"
                style={{ background: buildGradient(gradientAngle, gradientStops) }}
              />

              {/* Stops */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[0.625rem] font-medium text-[var(--muted-foreground)]">{localizeUi("ui.ui.colorpicker.colorStops")}</p>
                  <button
                    type="button"
                    onClick={addStop}
                    className="flex items-center gap-0.5 rounded-md bg-[var(--secondary)] px-2 py-0.5 text-[0.625rem] text-[var(--muted-foreground)] transition-all hover:text-[var(--foreground)]"
                  >
                    <Plus size="0.625rem" /> {localizeUi("ui.characters.metadatatab.add")}</button>
                </div>
                {gradientStops.map((stop, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="color"
                      value={stop}
                      onInput={(e) => {
                        activeStopRef.current = i;
                        handleGradientStopChange(i, e.currentTarget.value, true);
                      }}
                      onChange={(e) => {
                        activeStopRef.current = i;
                        handleGradientStopChange(i, e.currentTarget.value, true);
                      }}
                      onBlur={flushPendingChange}
                      className="h-7 w-7 cursor-pointer rounded-md border-0 bg-transparent p-0"
                    />
                    <input
                      value={stop}
                      onChange={(e) => handleGradientStopChange(i, e.target.value)}
                      className="flex-1 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2 py-1 font-mono text-[0.6875rem] outline-none focus:border-[var(--primary)]/40"
                    />
                    {gradientStops.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeStop(i)}
                        className="rounded-md p-1 text-[var(--muted-foreground)] hover:bg-[var(--destructive)]/15 hover:text-[var(--destructive)]"
                      >
                        <Trash2 size="0.6875rem" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Angle */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.625rem] text-[var(--muted-foreground)]">{localizeUi("ui.ui.colorpicker.angle")}</span>
                  <span className="min-w-[2.75rem] text-right font-mono text-[0.625rem] tabular-nums text-[var(--muted-foreground)]">
                    {gradientAngle}°
                  </span>
                </div>
                <input
                  aria-label={localizeUi("ui.ui.colorpicker.gradientAngle")}
                  type="range"
                  min={0}
                  max={360}
                  value={gradientAngle}
                  onChange={(e) => handleAngleChange(parseInt(e.target.value), true)}
                  onPointerUp={flushPendingChange}
                  onKeyUp={flushPendingChange}
                  onBlur={flushPendingChange}
                  className="h-1.5 w-full cursor-pointer accent-[var(--primary)]"
                />
              </div>

              {/* Gradient presets */}
              <div>
                <p className="mb-1.5 text-[0.625rem] text-[var(--muted-foreground)]">{localizeUi("navigation.topbar.presets")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {GRADIENT_PRESETS.map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => {
                        setGradientStops(parseGradientStops(g));
                        const angleMatch = g.match(/linear-gradient\((\d+)deg/);
                        if (angleMatch) setGradientAngle(parseInt(angleMatch[1]));
                        onChange(g);
                      }}
                      className={cn(
                        "h-6 w-6 rounded-md ring-1 ring-[var(--border)] transition-all hover:scale-110 hover:ring-2 hover:ring-[var(--primary)]/50",
                        value === g && "ring-2 ring-[var(--primary)] scale-110",
                      )}
                      style={{ background: g }}
                      title={g === RAINBOW_GRADIENT_PRESET ?localizeUi("ui.ui.colorpicker.gayRgbRainbow") : g}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
