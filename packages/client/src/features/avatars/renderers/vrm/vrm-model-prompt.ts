// The "Copy prompt" text on the 3D Avatars page: a short English description of the owner, posed for 3D, to
// paste into an outside image or 3D tool. It reads only the name and the look (the image appearance override
// when it is on, then the appearance, then the description, as readAvatarOwnerInfo does on the server), never
// other card fields or chat text.
import { readImageAppearanceOverride, type AvatarOwnerRef } from "@marinara-engine/shared";

/** The server's avatar generation limit for the look (MAX_APPEARANCE_CHARS in generation-context.ts). */
const MAX_LOOK_CHARS = 1500;
const MAX_NAME_CHARS = 120;

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Trimmed, so a blank field falls through to the next one. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** One line of plain text: no control characters or line breaks, at most `maxChars`. */
function oneLine(value: string, maxChars: number): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f\s]+/gu, " ")
      .trim()
      .slice(0, maxChars)
      .trim()
  );
}

/** `card` is the character row from `/characters/:id` or the persona from `/characters/personas/:id`. */
export function vrmModelPrompt(owner: AvatarOwnerRef, card: unknown): string {
  let name: string;
  let look: string | null;
  if (owner.ownerType === "persona") {
    const persona = record(card);
    name = text(persona.name);
    look = readImageAppearanceOverride(persona, text(persona.appearance) || text(persona.description));
  } else {
    const data = record(record(card).data);
    const extensions = record(data.extensions);
    name = text(data.name);
    look = readImageAppearanceOverride(
      extensions,
      text(extensions.appearance) || text(data.appearance) || text(data.description),
    );
  }
  name = oneLine(name, MAX_NAME_CHARS);
  // Macros mean nothing to an outside tool: the owner's own name macro becomes the name, any other is dropped.
  const macro = owner.ownerType === "persona" ? /\{\{\s*user\s*\}\}/giu : /\{\{\s*char\s*\}\}/giu;
  const description = oneLine((look ?? "").replace(macro, name).replace(/\{\{[^{}]*\}\}/gu, ""), MAX_LOOK_CHARS);
  return [
    `Full-body anime-style 3D character${name ? `: ${name}` : ""}.`,
    "Standing in a T-pose, front view, neutral face with the mouth closed, plain white background.",
    description ? `Look: ${description}` : "",
    "Show the hair style and colour, eye colour, body type, outfit and its colours, and accessories clearly.",
  ]
    .filter(Boolean)
    .join("\n");
}
