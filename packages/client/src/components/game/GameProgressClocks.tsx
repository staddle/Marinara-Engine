import type { RulesetClocks } from "@marinara-engine/shared";
import { useTranslation } from "react-i18next";

/** Scene clocks live beside the party status, with text carrying the same information as the ring. */
export function GameProgressClocks({ clocks }: { clocks: RulesetClocks }) {
  const { t } = useTranslation();
  if (!clocks.length) return null;
  return (
    <section
      aria-label={t("game.ruleset.clocks.title")}
      className="pointer-events-auto max-h-40 w-full max-w-full overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--background)] p-2 text-[var(--foreground)] shadow-lg"
    >
      <h3 className="mb-1 text-xs font-semibold text-[var(--muted-foreground)]">{t("game.ruleset.clocks.title")}</h3>
      <ul className="space-y-2">
        {clocks.map((clock) => (
          <li key={clock.name} className="flex items-center gap-2">
            <svg viewBox="0 0 36 36" className="h-8 w-8 shrink-0" aria-hidden="true">
              {Array.from({ length: clock.size }, (_, index) => {
                const start = (index / clock.size) * Math.PI * 2 - Math.PI / 2;
                const end = ((index + 1) / clock.size) * Math.PI * 2 - Math.PI / 2;
                return (
                  <path
                    key={index}
                    d={`M 18 18 L ${18 + 16 * Math.cos(start)} ${18 + 16 * Math.sin(start)} A 16 16 0 0 1 ${18 + 16 * Math.cos(end)} ${18 + 16 * Math.sin(end)} Z`}
                    className={index < clock.filled ? "fill-[var(--primary)]" : "fill-[var(--muted)]"}
                    stroke="var(--background)"
                    strokeWidth="1.5"
                  />
                );
              })}
            </svg>
            <div className="min-w-0 text-xs">
              <div className="break-words font-medium">{clock.name}</div>
              <div className="text-[var(--muted-foreground)]">
                {clock.filled}/{clock.size}
                {clock.filled === clock.size && <span className="ml-1">{t("game.ruleset.clocks.done")}</span>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
