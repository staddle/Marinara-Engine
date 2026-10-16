// ──────────────────────────────────────────────
// Game: Classic Game Mode or the Overworld RPG, chosen once for a new game
// ──────────────────────────────────────────────
import { useRef, type KeyboardEvent } from "react";
import { Globe2, ScrollText } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { GameStyle } from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import { GAME_SETUP_FIELD_LABEL } from "./game-setup-classes";

const STYLES = [
  {
    id: "overworld",
    icon: Globe2,
    title: "game.style.overworld.title",
    description: "game.style.overworld.description",
  },
  { id: "classic", icon: ScrollText, title: "game.style.classic.title", description: "game.style.classic.description" },
] as const satisfies ReadonlyArray<{ id: GameStyle; icon: typeof Globe2; title: string; description: string }>;

const ARROW_STEPS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function GameSetupStyleChooser({
  value,
  onChange,
  disabled,
  overworldLocked = false,
}: {
  value: GameStyle;
  onChange: (style: GameStyle) => void;
  disabled?: boolean;
  /** Overworld games are locked on this server (MARINARA_OVERWORLD_GAMES): its card is greyed out. */
  overworldLocked?: boolean;
}) {
  const { t } = useUiTranslation();
  const buttons = useRef<Partial<Record<GameStyle, HTMLButtonElement | null>>>({});
  const open = STYLES.filter(({ id }) => !(overworldLocked && id === "overworld")).map(({ id }) => id);
  // A radio group: one tab stop (the chosen style), and the arrow keys move the choice.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: GameStyle) => {
    const step = ARROW_STEPS[event.key];
    if (!step || disabled || open.length < 2) return;
    event.preventDefault();
    const at = open.indexOf(id);
    const next = open[(at + step + open.length) % open.length]!;
    onChange(next);
    buttons.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-labelledby="game-setup-style-label" data-testid="game-style-chooser">
      <span id="game-setup-style-label" className={GAME_SETUP_FIELD_LABEL}>
        {t("game.style.label")}
      </span>
      <p className="mb-1.5 text-[0.6875rem] text-[var(--muted-foreground)]">{t("game.style.help")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {STYLES.map(({ id, icon: Icon, title, description }) => {
          const selected = value === id;
          const locked = overworldLocked && id === "overworld";
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              ref={(element) => {
                buttons.current[id] = element;
              }}
              tabIndex={selected || (!open.includes(value) && id === open[0]) ? 0 : -1}
              disabled={disabled || locked}
              onClick={() => onChange(id)}
              onKeyDown={(event) => onKeyDown(event, id)}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-lg p-3 text-left text-xs ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                selected
                  ? "bg-[var(--primary)]/10 ring-[var(--primary)]/40"
                  : "bg-[var(--secondary)] ring-[var(--border)] hover:ring-[var(--primary)]/20",
              )}
            >
              <Icon
                size={16}
                className={cn("mt-0.5 shrink-0", selected ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]")}
              />
              <span className="min-w-0">
                <span className="block font-medium text-[var(--foreground)]">{t(title)}</span>
                <span className="mt-1 block leading-relaxed text-[var(--muted-foreground)]">
                  {t(locked ? "game.worldKit.setup.overworldLocked" : description)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
