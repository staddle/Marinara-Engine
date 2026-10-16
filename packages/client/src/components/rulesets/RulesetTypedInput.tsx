// One sheet value's input, typed by the ruleset: a number within its bounds, a checkbox, a choice, text.
// Shared by the full sheet form and the guided builder.
import type { RulesetField, RulesetListColumn } from "@marinara-engine/shared";
import { DraftNumberInput } from "../ui/DraftNumberInput";
import { DraftTextarea } from "../ui/DraftTextarea";

export type Scalar = number | string | boolean;

export const inputClass =
  "w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--input)] px-2 py-1 text-xs text-[var(--foreground)]";
export const labelClass = "text-[0.6875rem] font-medium text-[var(--muted-foreground)]";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function TypedInput({
  spec,
  value,
  onChange,
  ariaLabel,
  disabled = false,
  title,
  describedBy,
}: {
  spec: RulesetField | RulesetListColumn;
  value: Scalar | undefined;
  onChange: (value: Scalar) => void;
  ariaLabel: string;
  /** Set for a cell the ruleset keeps itself. The control stays in place and stops taking edits. */
  disabled?: boolean;
  /** The hint behind such a cell, for a pointer. */
  title?: string;
  /** The id of the visible text that says the same thing. A disabled control cannot be focused, so
   *  a `title` alone never reaches a keyboard or a screen reader. */
  describedBy?: string;
}) {
  if (spec.type === "number") {
    return (
      <DraftNumberInput
        value={
          typeof value === "number" && Number.isFinite(value) ? value : (spec.default ?? clamp(0, spec.min, spec.max))
        }
        onCommit={(next) => onChange(clamp(next, spec.min, spec.max))}
        min={spec.min}
        max={spec.max}
        integer={spec.integer}
        disabled={disabled}
        title={title}
        ariaLabel={ariaLabel}
        ariaDescribedBy={describedBy}
        className={`${inputClass} text-center`}
      />
    );
  }
  if (spec.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        className="h-4 w-4 accent-[var(--primary)]"
      />
    );
  }
  if (spec.type === "enum") {
    // On purpose the control shows the value the sheet EVALUATES to. A stored string the ruleset
    // no longer offers reads as the default in the sheet math, so showing the stale string beside
    // modifiers computed from the default would misreport them. The stored string itself is left
    // untouched until the user picks a value.
    const current = typeof value === "string" && spec.values.includes(value) ? value : (spec.default ?? spec.values[0]);
    return (
      <select
        value={current}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        className={inputClass}
      >
        {spec.values.map((option) => (
          <option key={option} value={option}>
            {spec.valueLabels?.[option] ?? option}
          </option>
        ))}
      </select>
    );
  }
  if (spec.type === "longtext") {
    return (
      <DraftTextarea
        value={typeof value === "string" ? value : ""}
        onCommit={(next) => onChange(next.slice(0, spec.maxLength))}
        maxLength={spec.maxLength}
        rows={2}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        className={inputClass}
      />
    );
  }
  const maxLength = spec.type === "text" ? spec.maxLength : 40;
  return (
    <input
      type="text"
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value.slice(0, maxLength))}
      maxLength={maxLength}
      placeholder={spec.type === "dice" ? spec.example : undefined}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      className={inputClass}
    />
  );
}
