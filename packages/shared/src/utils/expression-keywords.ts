// ──────────────────────────────────────────────
// Expression keywords: words in reply text that suggest a sprite expression
// ──────────────────────────────────────────────
// One word list for every keyword guess the Engine makes about a face:
//   - the Roleplay sprite fallback when no Expression Engine result is there (client, detectExpressionKeyword);
//   - the Expression Engine's fallback pick for a character the model skipped (server, inferExpressionCandidates);
//   - the avatar classifier's instant tier (server and client, classifyExpressionKeywords).
// Words match whole words, ignoring case and accents; a trailing `*` matches every word that starts with the
// stem, and a space matches any run of spaces. Chinese, Japanese and Korean words match anywhere, since those
// scripts do not separate words. Other languages carry only words that cannot be read as something else.
import {
  AVATAR_EMOTIONS,
  AVATAR_FEELING_EMOTIONS,
  SPRITE_EXPRESSION_AVATAR_EMOTIONS,
  mapSpriteExpressionToAvatarFeeling,
  type AvatarClassification,
  type AvatarEmotion,
  type SpriteExpressionLabel,
} from "../types/avatars.js";

export interface ExpressionKeywordGroup {
  /** The sprite label the words point at. */
  label: SpriteExpressionLabel;
  /** Other sprite names to try, in order, when an owner has no sprite called `label`. */
  aliases: readonly string[];
  words: readonly string[];
}

/** In priority order: the first group that matches is the single-label guess. General emotions come before the
 *  specific labels they contain (`laugh` reads as happy, `crying` as sad), because every sprite set has them. */
export const EXPRESSION_KEYWORD_GROUPS: readonly ExpressionKeywordGroup[] = [
  {
    label: "angry",
    aliases: ["annoyed", "irritated"],
    words: [
      "anger*",
      "angry",
      "angrily",
      "furious*",
      "rage",
      "raged",
      "rages",
      "raging",
      "enraged",
      "livid",
      "fuming",
      "yell",
      "yells",
      "yelled",
      "yelling",
      "shout*",
      "snarl*",
      "growl*",
      "seeth*",
      "annoyed",
      "annoyance",
      "irritated",
      "irritation",
      "frustrated",
      "frustration",
      "glare*",
      "glaring",
      "scowl*",
      // de, es/it/pt, fr, pl, ru
      "wütend*",
      "zornig*",
      "enfadad*",
      "enojad*",
      "furios*",
      "arrabbiat*",
      "raiva",
      "colère",
      "furieu*",
      "wściek*",
      "gniew*",
      "złość*",
      "гнев*",
      "ярост*",
      "сердит*",
      "злится",
      // ja/zh, ko
      "怒",
      "生气",
      "生氣",
      "화났",
      "분노",
    ],
  },
  {
    label: "sad",
    aliases: ["crying", "melancholy"],
    words: [
      "sad",
      "sadly",
      "sadness",
      "sadder",
      "saddest",
      "saddened",
      "unhappy",
      "sorrow*",
      "cry",
      "cries",
      "cried",
      "crying",
      "tears",
      "teary",
      "tearful*",
      "weep*",
      "wept",
      "sob",
      "sobs",
      "sobbed",
      "sobbing",
      "mourn*",
      "grief",
      "griev*",
      "melanchol*",
      "heartbroken",
      "depressed",
      // de, es/fr/it/pt, pl, ru
      "traurig*",
      "tränen*",
      "weint",
      "weinte",
      "weinen",
      "weinend",
      "triste*",
      "llor*",
      "lágrima*",
      "pleur*",
      "larme*",
      "piang*",
      "lacrim*",
      "chorar",
      "chorando",
      "chorou",
      "smutn*",
      "smutek",
      "smutku",
      "płacz*",
      "płak*",
      "łzy",
      "łzami",
      "грус*",
      "печал*",
      "плач*",
      "плак*",
      "слез*",
      // ja, zh, ko
      "泣",
      "涙",
      "悲し",
      "哭",
      "伤心",
      "傷心",
      "难过",
      "難過",
      "眼泪",
      "眼淚",
      "눈물",
      "슬프",
      "슬퍼",
    ],
  },
  {
    label: "happy",
    aliases: ["smile", "joy", "excited"],
    words: [
      "happy",
      "happily",
      "happier",
      "happiest",
      "happiness",
      "joy",
      "joyful*",
      "joyous*",
      "overjoyed",
      "elated",
      "laugh*",
      "smile*",
      "smiling",
      "grin",
      "grins",
      "grinned",
      "grinning",
      "cheer*",
      "delight*",
      "beam",
      "beams",
      "beamed",
      "beaming",
      "giggl*",
      "glee*",
      "excited",
      "excitedly",
      "excitement",
      // de, es/pt, fr, it/pt, pl, ru
      "glücklich*",
      "lächel*",
      "lacht",
      "lachte",
      "lachen",
      "lachend",
      "feliz",
      "felices",
      "alegre*",
      "alegría",
      "sonris*",
      "sonríe*",
      "sonrió",
      "sonreír",
      "sonriendo",
      "carcajada*",
      "heureu*",
      "sourire",
      "sourit",
      "souriant*",
      "joie",
      "felice",
      "sorrid*",
      "sorris*",
      "risata*",
      "szczęśliw*",
      "radosn*",
      "uśmiech*",
      "śmia*",
      "śmieje",
      "śmiech*",
      "счастлив*",
      "радост*",
      "улыб*",
      "смея*",
      "смех*",
      "хохот*",
      // ja/zh, ko
      "笑",
      "嬉し",
      "楽し",
      "开心",
      "開心",
      "高兴",
      "高興",
      "웃었",
      "웃으",
      "웃는",
      "웃음",
      "미소",
      "기뻐",
      "기쁘",
      "행복",
    ],
  },
  {
    label: "surprised",
    aliases: ["shocked", "startled"],
    words: [
      "surpris*",
      "shock*",
      "astonish*",
      "gasp*",
      "wide-eyed",
      "wide eyed",
      "wide eyes",
      "eyes wide",
      "eyes widen*",
      "startl*",
      "stunned",
      "amazed",
      "amazement",
      "baffled",
      "dumbfounded",
      "flabbergast*",
      // de, es/it/pt, pl, ru
      "überrasch*",
      "erstaunt*",
      "sorprend*",
      "sorpres*",
      "surpres*",
      "boquiabiert*",
      "zaskocz*",
      "zdziw*",
      "zdumi*",
      "удивл*",
      "изумл*",
      "ахнул*",
      // ja, zh, ko
      "驚",
      "びっくり",
      "惊讶",
      "驚訝",
      "吃惊",
      "吃驚",
      "震惊",
      "震驚",
      "놀라",
      "놀랐",
    ],
  },
  {
    label: "scared",
    aliases: ["afraid", "frightened"],
    words: [
      "scare*",
      "fear",
      "fears",
      "feared",
      "fearful*",
      "afraid",
      "terrified",
      "terrifies",
      "terrifying",
      "frighten*",
      "fright",
      "trembl*",
      "shiver*",
      "shudder*",
      "panic*",
      "horrified",
      // de, es/pt, fr, it, pl, ru
      "ängstlich*",
      "miedo",
      "asustad*",
      "peur",
      "effray*",
      "paura",
      "spaventat*",
      "medo",
      "assustad*",
      "strach*",
      "przeraż*",
      "страх*",
      "испуг*",
      "боится",
      "боялась",
      "боялся",
      // ja, zh, ko
      "怖",
      "害怕",
      "恐惧",
      "恐懼",
      "무서",
      "두려",
    ],
  },
  {
    label: "embarrassed",
    aliases: ["blush", "blushing", "shy", "flustered"],
    words: [
      "embarrass*",
      "blush*",
      "fluster*",
      "sheepish*",
      "shy",
      "shyly",
      "shyness",
      "bashful*",
      "avert*",
      // de, es, fr, it, pt, pl, ru
      "erröt*",
      "avergonzad*",
      "sonroj*",
      "ruboriz*",
      "rougi*",
      "imbarazzat*",
      "arross*",
      "envergonhad*",
      "rumieni*",
      "zarumieni*",
      "zawstydz*",
      "zakłopota*",
      "покрасне*",
      "смущ*",
      // ja, zh, ko
      "照れ",
      "赤面",
      "恥ずかし",
      "脸红",
      "臉紅",
      "害羞",
      "부끄",
    ],
  },
  {
    label: "love",
    aliases: ["loving", "affectionate"],
    words: [
      "love*",
      "loving*",
      "adore*",
      "adoring*",
      "affection*",
      "kiss*",
      "embrace*",
      "cherish*",
      "smitten",
      "heart racing",
      "heart pound*",
      "heart flutter*",
      "heart skip*",
      // de, es/pt, fr, it, pl, ru
      "liebe",
      "kuss*",
      "amor",
      "amour",
      "amore",
      "beso*",
      "bacio",
      "baci",
      "beijo*",
      "kocham",
      "kocha*",
      "miłość*",
      "pocał*",
      "любл*",
      "люби*",
      "любов*",
      "поцел*",
      // ja, zh, ko
      "好き",
      "爱",
      "喜欢",
      "喜歡",
      "사랑",
    ],
  },
  {
    label: "thinking",
    aliases: ["thoughtful", "ponder"],
    words: [
      "think*",
      "thoughtful*",
      "ponder*",
      "consider",
      "considers",
      "considered",
      "considering",
      "contemplat*",
      "muse",
      "muses",
      "mused",
      "musing*",
      "hmm*",
      "wonder",
      "wonders",
      "wondered",
      "wondering",
      "pensive*",
    ],
  },
  {
    label: "laughing",
    aliases: ["laugh"],
    words: ["laugh*", "haha*", "lol", "chuckl*", "cackl*", "snicker*", "giggl*"],
  },
  {
    label: "worried",
    aliases: ["nervous", "anxious", "scared", "afraid"],
    words: [
      "worr*",
      "anxious*",
      "anxiety",
      "nervous*",
      "uneas*",
      "fret",
      "frets",
      "fretted",
      "fretting",
      "concern",
      "concerned",
      "dread*",
    ],
  },
  {
    label: "disgusted",
    aliases: ["disgust"],
    words: ["disgust*", "repuls*", "revolted", "revolting", "gross", "grossed", "nause*", "sicken*"],
  },
  {
    label: "smirk",
    aliases: ["smug", "teasing"],
    words: [
      "smirk*",
      "sly",
      "slyly",
      "mischiev*",
      "devious*",
      "wink*",
      "tease",
      "teases",
      "teased",
      "teasing*",
      "smug*",
    ],
  },
  {
    label: "crying",
    aliases: ["cry", "tears"],
    words: ["crying", "cried", "weeping", "tears stream*", "sobbing"],
  },
  {
    label: "determined",
    aliases: ["serious", "resolute"],
    words: ["determin*", "resolv*", "steadfast*", "unwaver*", "resolute*", "clench*"],
  },
  {
    label: "hurt",
    aliases: ["pain", "sad"],
    words: [
      "hurt*",
      "pain",
      "pains",
      "painful*",
      "wound",
      "wounds",
      "wounded",
      "winc*",
      "grimac*",
      "ache",
      "aches",
      "ached",
      "aching",
      "suffer*",
    ],
  },
];

/** Sprite names tried after every keyword guess, so an owner always gets a calm face. */
export const EXPRESSION_KEYWORD_NEUTRAL_CANDIDATES = ["neutral", "default", "normal", "calm", "idle"] as const;

const NO_WORD_BREAK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Accents on Latin and Cyrillic letters. Japanese voicing marks stay, so びっくり never folds to ひっくり. */
const LATIN_CYRILLIC_ACCENTS = /[\u0300-\u036f]+/gu;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** Lower case without accents, so `Wütend`, `wütend` and `wutend` read the same. Applied to words and text. Composed
 *  again afterwards, so a Korean syllable stays one syllable (무서 never matches inside 무성한). */
function foldForKeywords(value: string): string {
  return value.normalize("NFD").replace(LATIN_CYRILLIC_ACCENTS, "").normalize("NFC").toLowerCase();
}

function compileGroup(words: readonly string[]): RegExp {
  const bounded: string[] = [];
  const anywhere: string[] = [];
  for (const word of words) {
    const stem = word.endsWith("*");
    const folded = foldForKeywords(stem ? word.slice(0, -1) : word);
    const source = folded.replace(REGEX_SPECIAL, "\\$&").replace(/ /g, "\\s+") + (stem ? "[\\p{L}\\p{N}]*" : "");
    (NO_WORD_BREAK_SCRIPT.test(folded) ? anywhere : bounded).push(source);
  }
  const alternatives = [
    ...(bounded.length > 0 ? [`(?<![\\p{L}\\p{N}])(?:${bounded.join("|")})(?![\\p{L}\\p{N}])`] : []),
    ...anywhere,
  ];
  return new RegExp(alternatives.join("|"), "u");
}

const COMPILED_GROUPS = EXPRESSION_KEYWORD_GROUPS.map((group) => ({ group, pattern: compileGroup(group.words) }));

/** Every keyword group the text mentions, in priority order. */
export function matchExpressionKeywordGroups(text: string): ExpressionKeywordGroup[] {
  if (!text) return [];
  const folded = foldForKeywords(text);
  return COMPILED_GROUPS.filter(({ pattern }) => pattern.test(folded)).map(({ group }) => group);
}

/** The single sprite label the text suggests, or `neutral`. */
export function detectExpressionKeyword(text: string): SpriteExpressionLabel {
  return matchExpressionKeywordGroups(text)[0]?.label ?? "neutral";
}

/** Sprite names to try in order for this text: each matching group's label and aliases, then calm faces. */
export function inferExpressionCandidates(text: string): string[] {
  const candidates = new Set<string>();
  for (const group of matchExpressionKeywordGroups(text)) {
    candidates.add(group.label);
    for (const alias of group.aliases) candidates.add(alias);
  }
  for (const neutral of EXPRESSION_KEYWORD_NEUTRAL_CANDIDATES) candidates.add(neutral);
  return [...candidates];
}

/** The avatar classifier's instant tier: each matching group adds its label's emotion, and whatever the
 *  matches leave of 1 stays neutral, so one strong word is confident and one mild word is not. The feeling is
 *  the first matching group's that belongs to the winning emotion (`laughs` → amusement), never on a calm reading:
 *  `think` words are too common ("I think so") to name curiosity, so the model tier reads it instead. */
export function classifyExpressionKeywords(text: string): AvatarClassification {
  const scores = Object.fromEntries(AVATAR_EMOTIONS.map((emotion) => [emotion, 0])) as Record<AvatarEmotion, number>;
  let total = 0;
  const groups = matchExpressionKeywordGroups(text);
  for (const group of groups) {
    const { emotion, weight } = SPRITE_EXPRESSION_AVATAR_EMOTIONS[group.label];
    scores[emotion] += weight;
    total += weight;
  }
  const scale = Math.max(1, total);
  for (const emotion of AVATAR_EMOTIONS) scores[emotion] /= scale;
  scores.neutral += Math.max(0, 1 - total) / scale;
  let best: AvatarEmotion = "neutral";
  for (const emotion of AVATAR_EMOTIONS) if (scores[emotion] > scores[best]) best = emotion;
  const feeling =
    best === "neutral"
      ? null
      : (groups
          .map((group) => mapSpriteExpressionToAvatarFeeling(group.label))
          .find((found) => found && AVATAR_FEELING_EMOTIONS[found].emotion === best) ?? null);
  return { emotion: best, weight: scores[best], scores, feeling };
}
