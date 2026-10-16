// ──────────────────────────────────────────────
// Avatar director: the speech clock (lip sync from visible dialogue text)
// ──────────────────────────────────────────────
// Dialogue characters go in as they appear on screen; the clock "speaks" them at about 14 characters a second
// and turns each one into a mouth opening and a VRM viseme. When the typewriter runs ahead, the clock speeds up
// to 1.5x, and past that it skips to the newest text, so the mouth never lags far behind what is shown. The
// mouth closes 150 ms after the last dialogue character, with a 50 ms attack and an 80 ms release.
// ponytail: letters, not phonemes. Latin and Cyrillic vowels pick the viseme, Japanese kana go by vowel row and
// other scripts move rhythmically. The upgrade path is a phoneme lip sync per language, such as TalkingHead's
// lipsync-en (met4citizen/TalkingHead, MIT).
import type { AvatarViseme } from "@marinara-engine/shared";

/** One character's worth of speech: how far the mouth opens, its shape, and how long it lasts. */
interface SpeechUnit {
  open: number;
  /** null keeps the previous vowel's shape (consonants), unless the mouth closes. */
  viseme: AvatarViseme | null;
  durationMs: number;
}

export const SPEECH_CLOCK = Object.freeze({
  charsPerSecond: 14,
  /** Fastest catch-up speed while the typewriter runs ahead. */
  maxSpeedUp: 1.5,
  /** Queued speech (at normal speed) before the clock speeds up, and before it skips ahead. */
  speedUpAfterMs: 1_200,
  skipAfterMs: 4_500,
  /** What is left after a skip: the newest text. */
  skipToMs: 1_500,
  closeAfterMs: 150,
  attackMs: 50,
  releaseMs: 80,
});

const UNIT_MS = 1000 / SPEECH_CLOCK.charsPerSecond;
const VISEME_OPEN: Readonly<Record<AvatarViseme, number>> = { aa: 1, oh: 0.8, ee: 0.65, ou: 0.55, ih: 0.5 };
const LATIN_CYRILLIC_VOWELS: Readonly<Record<string, AvatarViseme>> = {
  a: "aa",
  e: "ee",
  i: "ih",
  y: "ih",
  o: "oh",
  u: "ou",
  а: "aa",
  я: "aa",
  е: "ee",
  э: "ee",
  и: "ih",
  ы: "ih",
  о: "oh",
  ё: "oh",
  у: "ou",
  ю: "ou",
};
/** Lips meet on these, so the mouth shuts for a moment. */
const LABIALS = new Set(["m", "b", "p", "м", "б", "п"]);
const KANA_ROWS: ReadonlyArray<readonly [AvatarViseme, string]> = [
  ["aa", "あぁかがさざただなはばぱまやゃらわゎアァカガサザタダナハバパマヤャラワヮヵ"],
  ["ih", "いぃきぎしじちぢにひびぴみりゐイィキギシジチヂニヒビピミリヰ"],
  ["ou", "うぅくぐすずつづぬふぶぷむゆゅるゔウゥクグスズツヅヌフブプムユュルヴ"],
  ["ee", "えぇけげせぜてでねへべぺめれゑエェケゲセゼテデネヘベペメレヱヶ"],
  ["oh", "おぉこごそぞとどのほぼぽもよょろをオォコゴソゾトドノホボポモヨョロヲ"],
];
const KANA_VISEMES: ReadonlyMap<string, AvatarViseme> = new Map(
  KANA_ROWS.flatMap(([viseme, row]) => [...row].map((kana) => [kana, viseme] as const)),
);
/** ん and the small っ close the mouth; ー holds the previous vowel. */
const KANA_CLOSED = new Set(["ん", "ン", "っ", "ッ"]);
const RHYTHM: readonly AvatarViseme[] = ["aa", "oh", "ee", "aa", "ou"];
const SYLLABIC = /[\p{Script=Han}\p{Script=Hangul}\p{N}]/u;
const LATIN_OR_CYRILLIC = /[\p{Script=Latin}\p{Script=Cyrillic}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;
const PAUSE_SHORT = /[,;:—–、，；：]/u;
const PAUSE_LONG = /[.!?…。！？]/u;

function speechUnit(char: string, previous: SpeechUnit | undefined, nextRhythm: () => AvatarViseme): SpeechUnit | null {
  const lower = char.toLowerCase();
  const vowel = LATIN_CYRILLIC_VOWELS[lower] ?? LATIN_CYRILLIC_VOWELS[lower.normalize("NFD").charAt(0)];
  if (vowel) return { open: VISEME_OPEN[vowel], viseme: vowel, durationMs: UNIT_MS };
  const kana = KANA_VISEMES.get(char);
  if (kana) return { open: VISEME_OPEN[kana], viseme: kana, durationMs: UNIT_MS * 1.7 };
  if (KANA_CLOSED.has(char)) return { open: 0, viseme: null, durationMs: UNIT_MS * 1.7 };
  if (char === "ー") return { open: previous?.open ?? 0.5, viseme: null, durationMs: UNIT_MS * 1.7 };
  if (LABIALS.has(lower)) return { open: 0, viseme: null, durationMs: UNIT_MS };
  if (LATIN_OR_CYRILLIC.test(char)) return { open: 0.2, viseme: null, durationMs: UNIT_MS };
  if (LETTER_OR_DIGIT.test(char)) {
    const viseme = nextRhythm();
    return { open: VISEME_OPEN[viseme] * 0.8, viseme, durationMs: UNIT_MS * (SYLLABIC.test(char) ? 2 : 1) };
  }
  if (PAUSE_LONG.test(char)) return { open: 0, viseme: null, durationMs: UNIT_MS * 4 };
  if (PAUSE_SHORT.test(char)) return { open: 0, viseme: null, durationMs: UNIT_MS * 2 };
  return null;
}

/** Eases a value toward its target: quick to open, a little slower to close. */
export function followMouthEnvelope(current: number, target: number, dtMs: number): number {
  const tau = target > current ? SPEECH_CLOCK.attackMs : SPEECH_CLOCK.releaseMs;
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dtMs) / tau));
}

export interface SpeechSample {
  /** 0..1 smoothed mouth opening. */
  open: number;
  viseme: AvatarViseme | null;
  /** True while text is being spoken, including the short hold before the mouth closes. */
  speaking: boolean;
}

export interface SpeechClock {
  /** Dialogue characters that just appeared on screen. */
  push(text: string): void;
  /** A whole line at once (a reply that did not stream, a Game line): spoken at the normal pace, squeezed to
   *  fit `maxMs`, never skipped. */
  speakAll(text: string, maxMs: number): void;
  clear(): void;
  sample(nowMs: number): SpeechSample;
}

export function createSpeechClock(): SpeechClock {
  let queue: SpeechUnit[] = [];
  /** Sum of the queued units' durations, and the time already spent on queue[0]. */
  let queuedTotal = 0;
  let elapsedInUnit = 0;
  /** speakAll() queues are scheduled, not followed: no speed-up or skipping. */
  let scheduled = false;
  let lastSampleMs: number | null = null;
  let lastUnit: SpeechUnit | null = null;
  let lastViseme: AvatarViseme | null = null;
  let silentSince: number | null = null;
  let lastWasSpace = false;
  let open = 0;
  let rhythm = 0;
  const nextRhythm = () => RHYTHM[rhythm++ % RHYTHM.length]!;

  const pending = () => queuedTotal - elapsedInUnit;
  const reset = () => {
    queue = [];
    queuedTotal = 0;
    elapsedInUnit = 0;
    scheduled = false;
  };
  const shift = () => {
    const unit = queue.shift()!;
    queuedTotal -= unit.durationMs;
    elapsedInUnit = 0;
    return unit;
  };
  const enqueue = (text: string) => {
    for (const char of text) {
      if (SPACE.test(char)) {
        if (!lastWasSpace) queue.push({ open: 0.1, viseme: null, durationMs: UNIT_MS });
        else continue;
        lastWasSpace = true;
      } else {
        lastWasSpace = false;
        const unit = speechUnit(char, queue.at(-1) ?? lastUnit ?? undefined, nextRhythm);
        if (!unit) continue;
        queue.push(unit);
      }
      queuedTotal += queue.at(-1)!.durationMs;
    }
  };

  return {
    push(text) {
      if (!text) return;
      if (scheduled) reset();
      enqueue(text);
    },
    speakAll(text, maxMs) {
      reset();
      enqueue(text);
      if (queuedTotal > maxMs) {
        const scale = maxMs / queuedTotal;
        for (const unit of queue) unit.durationMs *= scale;
        queuedTotal = maxMs;
      }
      scheduled = queue.length > 0;
    },
    clear: reset,
    sample(nowMs) {
      const dt = lastSampleMs === null ? 0 : Math.max(0, nowMs - lastSampleMs);
      lastSampleMs = nowMs;
      if (!scheduled && pending() > SPEECH_CLOCK.skipAfterMs) {
        while (queue.length > 1 && pending() > SPEECH_CLOCK.skipToMs) shift();
      }
      const speed = !scheduled && pending() > SPEECH_CLOCK.speedUpAfterMs ? SPEECH_CLOCK.maxSpeedUp : 1;
      let budget = dt * speed;
      while (queue.length > 0 && budget > 0) {
        const left = queue[0]!.durationMs - elapsedInUnit;
        if (budget < left) {
          elapsedInUnit += budget;
          budget = 0;
        } else {
          budget -= left;
          lastUnit = shift();
          if (queue.length === 0) silentSince = nowMs - budget / speed;
        }
      }
      const current = queue[0] ?? null;
      if (current) silentSince = null;
      else scheduled = false;
      const holding = !current && silentSince !== null && nowMs - silentSince < SPEECH_CLOCK.closeAfterMs;
      const unit = current ?? (holding ? lastUnit : null);
      const target = unit?.open ?? 0;
      if (unit?.viseme) lastViseme = unit.viseme;
      open = followMouthEnvelope(open, target, dt);
      if (target === 0 && open < 0.02) open = 0;
      if (open === 0 && !current) lastViseme = null;
      return { open, viseme: open > 0.05 ? lastViseme : null, speaking: current !== null || holding };
    },
  };
}
