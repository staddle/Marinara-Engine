/** A Markdown thematic break on its own line: 3+ of one of `*`, `-`, `_`, spaced or not, indented up to 3 spaces. */
const SCENE_BREAK = /^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/**
 * Block HTML elements that can hold a break line of their own, such as a `<details>` status panel. Inline tags are
 * not counted: models often leave one like `<b>` or a `<name>` placeholder unclosed, which would stop every later
 * split. `/>` never stays open.
 */
const HTML_TAG =
  /<(\/?)(address|article|aside|blockquote|center|details|dialog|div|dl|fieldset|figure|footer|form|header|main|nav|ol|pre|section|table|ul)\b[^<>]*?(\/?)>/giu;

/**
 * Split a reply at its scene or POV break lines (`***`, `---`, `___`, `* * *`), outside fenced code and open HTML
 * elements such as a `<details>` status panel. Each break line opens the part after it. A part never lacks text: a
 * break before any text, after the last text or next to another break joins the part that has text. Text without a
 * break comes back unchanged as the only part.
 */
export function splitAtSceneBreaks(text: string): string[] {
  const parts: Array<{ lines: string[]; hasText: boolean }> = [{ lines: [], hasText: false }];
  let fence: string | null = null;
  let openElements = 0;
  for (const line of text.split("\n")) {
    const bare = line.replace(/\r$/, "");
    const current = parts.at(-1)!;
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`).test(bare)) fence = null;
    } else {
      fence = FENCE.exec(bare)?.[1] ?? null;
      if (!fence && !openElements && SCENE_BREAK.test(bare)) {
        if (current.hasText) parts.push({ lines: [line], hasText: false });
        else current.lines.push(line);
        continue;
      }
      if (!fence)
        for (const [, closing, , selfClosing] of bare.matchAll(HTML_TAG))
          if (!selfClosing) openElements = Math.max(0, openElements + (closing ? -1 : 1));
    }
    current.lines.push(line);
    if (bare.trim()) current.hasText = true;
  }
  // Breaks after the last text stay at the end of the part before them.
  if (parts.length > 1 && !parts.at(-1)!.hasText) parts.at(-2)!.lines.push(...parts.pop()!.lines);
  return parts.length > 1 ? parts.map((part) => part.lines.join("\n").trim()) : [text];
}

/** The break lines a split part opens with, and the blank lines after them; "" when the part opens with text. */
export function leadingSceneBreak(part: string): string {
  let length = 0;
  for (const line of part.split("\n")) {
    const bare = line.replace(/\r$/, "");
    if (bare.trim() && !SCENE_BREAK.test(bare)) return part.slice(0, length);
    length += line.length + 1;
  }
  return "";
}
