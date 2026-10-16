// The Game setup wizard's field and button classes, shared with the choosers it renders so their
// fields look like the wizard's own.
export const GAME_SETUP_FIELD_LABEL = "mb-1.5 block text-xs font-medium text-[var(--foreground)]";
export const GAME_SETUP_INPUT_CLASS =
  "w-full rounded-lg bg-[var(--secondary)] px-3 py-2 text-xs text-[var(--foreground)] outline-none ring-1 ring-[var(--border)] transition-all placeholder:text-[var(--muted-foreground)] focus:ring-[var(--primary)]/40";
export const GAME_SETUP_GHOST_BUTTON_CLASS =
  "flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]";
export const GAME_SETUP_PRIMARY_BUTTON_CLASS =
  "flex items-center gap-1 rounded-lg bg-[var(--primary)] px-4 py-1.5 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
