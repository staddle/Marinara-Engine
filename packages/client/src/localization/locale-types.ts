import type { TextDirection } from "@marinara-engine/shared";

export const DEFAULT_APP_LANGUAGE = "en";

/**
 * Locale files are discovered at build time, so community translations do not
 * require this union to be edited when a new BCP-47 locale is added.
 */
export type AppLanguage = string;

export interface LocaleMetadata {
  locale: string;
  direction: TextDirection;
}

export interface LocaleDescriptor {
  id: AppLanguage;
  label: string;
}

export interface LoadedLocale {
  metadata: LocaleMetadata;
  messages: Record<string, string>;
}
