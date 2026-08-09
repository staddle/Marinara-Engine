# UI localization

Marinara Engine localizes application interface text while leaving model prompts, user content, generated chat
content, identifiers, protocol values, file paths, and persisted machine values unchanged.

English is the canonical locale and the runtime fallback. A missing community translation therefore displays the
English text instead of a translation key or an empty control.

Users select their interface language in **Settings > General > App Behavior > Language**. The selection changes
Marinara's controls and guidance, not model prompts, authored content, or chat messages.

## Supported interface languages

| Language | Locale file | Direction |
| --- | --- | --- |
| Arabic | `ar.json` | Right to left |
| Chinese, Simplified | `zh-Hans.json` | Left to right |
| English | `en.json` | Left to right |
| French | `fr.json` | Left to right |
| German | `de.json` | Left to right |
| Hindi | `hi.json` | Left to right |
| Japanese | `ja.json` | Left to right |
| Korean | `ko.json` | Left to right |
| Polish | `pl.json` | Left to right |
| Portuguese, Brazil | `pt-BR.json` | Left to right |
| Russian | `ru.json` | Left to right |
| Spanish | `es.json` | Left to right |

English is maintained as the source catalog. The other bundled catalogs began as machine-assisted translations and
are open to corrections from fluent speakers. UI extraction is still in progress, so text without a translated key
continues to appear in English.

## Locale files

Client locale files live in:

```text
packages/client/src/localization/locales/
```

Each BCP-47 locale uses one JSON file named after its canonical locale, such as `pl.json`, `ko.json`, or
`pt-BR.json`. Vite discovers these files automatically, so adding a locale does not require editing a registry.
English loads with the application; other locales load only when selected.

```json
{
  "_meta": {
    "locale": "pl",
    "direction": "ltr"
  },
  "chat.input.placeholder": "Napisz odpowiedź…",
  "common.actions.save": "Zapisz"
}
```

Use semantic keys organized by interface area. Do not use an English sentence as the key because ordinary copy
editing would then invalidate every translation.

## Translation rules

- Translate values only. Do not rename semantic keys.
- Preserve interpolation tokens such as `{{name}}` and rich-text tags such as `<strong>`.
- Keep translation keys alphabetically sorted.
- Keep product names such as Marinara Engine unchanged unless the project adopts an official localized name.
- Match the meaning and tone of `en.json`; avoid adding behavior or promises that the English source does not make.
- Check that translated labels fit on desktop and mobile.

Community locales may temporarily omit keys while a feature-area translation is being prepared. Missing keys fall
back to English. Unknown keys, empty translations, malformed metadata, and changed interpolation tokens fail the
localization check.

Feature PRs must add or update the canonical English key, but they do not need to modify every community locale.
Translate a community value only when the contributor can supply a useful translation. Do not duplicate the English
value across locale files merely to keep their key lists equal: the runtime fallback already provides that English
text, and leaving the key absent prevents needless merge conflicts for translators.

Machine-produced translations are welcome as an initial draft when the PR identifies them as such. A fluent speaker
should review terminology, tone, truncation, and mobile layout before the locale is described as reviewed.

## Submit a correction to an existing translation

For a small wording correction, GitHub's web editor is enough:

1. Open the locale in
   [`packages/client/src/localization/locales/`](../../packages/client/src/localization/locales/).
2. Select the pencil icon to edit the file. GitHub will offer to create a fork if needed.
3. Change only the translated value. Preserve its key, punctuation-sensitive tokens such as `{{name}}`, and JSON
   syntax.
4. Commit the change to a focused branch in your fork.
5. Open a pull request against the Marinara Engine **`staging`** branch, not `main`.
6. In the PR description, name the language, explain the corrected meaning, and say whether you are a fluent speaker
   or used machine assistance.

Use a title such as `Improve French UI translation`. Several related corrections to one locale can share one PR.
Keep unrelated code changes separate.

## Submit a new localization

For a new language, work from the latest `staging` branch:

```bash
git clone https://github.com/YOUR-NAME/Marinara-Engine.git
cd Marinara-Engine
git checkout staging
git pull
git checkout -b translation/LOCALE
pnpm install
```

Then:

1. Copy `en.json` to a canonically named BCP-47 locale file, such as `it.json` or `pt-PT.json`.
2. Keep `_meta.locale` equal to the filename without `.json`.
3. Set `_meta.direction` to `ltr` or `rtl`.
4. Translate the values according to the rules above. Copying the complete English catalog is preferred for a new
   locale, although an incomplete catalog can fall back to English.
5. Run the locale validator and repository baseline:

   ```bash
   pnpm localization:check
   pnpm check
   ```

6. Select the language in **Settings > General** and review it on both desktop and mobile. Check long labels,
   tooltips, loading and error states, and text direction.
7. Push the branch to your fork and
   [open a pull request](https://github.com/Pasta-Devs/Marinara-Engine/compare), selecting
   `Pasta-Devs/Marinara-Engine:staging` as the base.

The PR description should identify the locale, translation source, fluency or review level, validation commands, and
any areas that still need a native-speaker review. Complete the PR template honestly and only check manual items you
personally verified.

## Using translations in client code

React components use `useTranslation`:

```tsx
import { useTranslation } from "react-i18next";

const { t } = useTranslation();
return <button>{t("common.actions.save")}</button>;
```

Store translation keys rather than translated values in module-level UI configuration. This keeps language changes
live without a page reload. Non-React client helpers can use the exported `translate` function from
`packages/client/src/localization/i18n.ts`.

Translate visible text, including labels, placeholders, tooltips, accessibility names, alternative text, loading and
empty states, toasts, confirmations, and static tutorials. Do not route prompts or authored content through the UI
translator.

Shared legacy primitives such as Settings controls, help tooltips, and modal titles also recognize exact
canonical-English catalog values while older call sites are being migrated. This is a compatibility bridge, not the
preferred API: new and substantially edited components must still use semantic `t("area.control.label")` keys
directly. An English sentence that is not present in `en.json` is not translatable.

The repository localization check also audits client TSX for untranslated interface copy:

```bash
pnpm localization:ui-check
```

It covers visible JSX, directly interpolated labels and notices, accessible names, placeholders, loading and empty
states, toasts, and confirmations. Literal content inside `code`, `pre`, `script`, and `style` elements is
intentionally excluded so commands, configuration, URLs, macros, and other machine-facing examples remain exact.
Dynamic user-authored, generated, persisted, prompt, and protocol values must likewise remain outside the interface
translator.

## Downloadable Agent interfaces

Engine-owned Agent screens use the Engine locale files. Downloadable capability clients own their translated copy in
the Marinara-Agents repository.

Every capability custom element receives the selected locale through both its `lang` and `dir` attributes and:

```ts
capabilityProps.localization = {
  locale: "pl",
  direction: "ltr",
};
```

The existing `marinara-capability-props` event fires when the locale changes. Package UI should select its bundled
locale, fall back to package English, and rerender after that event.
