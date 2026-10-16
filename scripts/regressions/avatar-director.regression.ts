/**
 * The avatar director turns chat activity into avatar frames:
 *   - the visible reply is cut into sentences (long ones at a clause), each paragraph gets an owner, and dialogue
 *     is collected per owner with the text-to-speech extractor, including a quote that is still open;
 *   - the speech clock speaks dialogue at about 14 characters a second, speeds up to 1.5x and then skips when
 *     the typewriter runs ahead, squeezes a whole line into 8 s, reads kana by vowel row, and closes the mouth
 *     150 ms after the last character with a 50 ms attack and an 80 ms release;
 *   - classifier calls go out at most every 1.2 s with a per-sentence cache; faces switch only on a 0.45 score
 *     with a 0.15 lead, hold 2 s, need two neutral sentences, and relax 4 s after the reply unless the Expression
 *     Engine settled them; a reply that arrives whole is classified whole and spoken within 8 s;
 *   - a more specific feeling inside the same emotion changes on a 0.45 score and holds 2 s on its own clock, so it
 *     never delays the emotion; an emotion change takes its result's feeling, relaxing clears it, and Expression
 *     Engine and Game Master labels carry the feeling they name when it belongs to their emotion;
 *   - text-to-speech audio drives the mouth while it plays; Game mode faces and mouths follow the Game Master's
 *     lines (a thought sets the face only) and never call the classifier; states are thinking, talking, listening
 *     and idle;
 *   - a reply ends with its generation, not at message-ready, whatever the typewriter still shows; streaming off is
 *     the setting, not a guess; Merged group replies are split by name, and a paragraph's dialogue waits for its
 *     speaker's name; an Expression Engine pick for an earlier reply never lands on this one;
 *   - a Roleplay stage asks the server for its local model, again while it answers with keywords, never once the
 *     server cannot run it.
 * Runs on the real chat, agent and UI stores with a stubbed classifier; time is the frame time passed in.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type {
  AvatarClassification,
  AvatarClassifyRequest,
  AvatarEmotion,
  AvatarFrameInput,
} from "@marinara-engine/shared";

// The UI store persists the streaming setting; keep it in memory here.
const savedSettings = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => savedSettings.get(key) ?? null,
    setItem: (key: string, value: string) => savedSettings.set(key, value),
    removeItem: (key: string) => savedSettings.delete(key),
  },
});

const { useChatStore } = await import("../../packages/client/src/stores/chat.store.js");
const { useAgentStore } = await import("../../packages/client/src/stores/agent.store.js");
const { useUIStore } = await import("../../packages/client/src/stores/ui.store.js");
const { TTS_AUTOPLAY_MESSAGE_READY_EVENT } = await import("../../packages/client/src/lib/tts-autoplay.js");
const director = await import("../../packages/client/src/features/avatars/director/avatar-director.js");
const { createSpeechClock, followMouthEnvelope } =
  await import("../../packages/client/src/features/avatars/director/speech-clock.js");
const replyText = await import("../../packages/client/src/features/avatars/director/reply-text.js");
const { publishAvatarGameLine } = await import("../../packages/client/src/features/avatars/director/game-line-feed.js");

// ── Reading the visible reply ──
const segmentTexts = (text: string, from: number, done: boolean) => {
  const read = replyText.readReplySegments(text, from, done);
  return { texts: read.segments.map((segment) => segment.text), next: read.next };
};
let read = segmentTexts("Hello there. How are", 0, false);
assert.deepEqual(read.texts, ["Hello there."], "only finished sentences are read");
read = segmentTexts("Hello there. How are you? Fine", read.next, false);
assert.deepEqual(read.texts, ["How are you?"], "reading continues where it stopped");
assert.deepEqual(
  segmentTexts("Hello there. How are you? Fine", read.next, true).texts,
  ["Fine"],
  "done reads the rest",
);
assert.deepEqual(segmentTexts("It costs 3.5 coins.", 0, false).texts, [], "a sentence waits for the next word");
assert.deepEqual(segmentTexts("嬉しい。悲しい", 0, false).texts, ["嬉しい。"], "Japanese full stops end sentences");
assert.deepEqual(
  segmentTexts('*She smiles.* "Hi!"\n', 0, false).texts,
  ["She smiles.", '"Hi!"'],
  "markup is removed and line breaks end sentences",
);
const runOn = `${"word ".repeat(30)}, and then ${"more ".repeat(20)}`;
const cut = segmentTexts(runOn, 0, false).texts;
assert.ok(cut.length >= 1 && cut[0]!.endsWith(","), "a run-on sentence is cut at a clause");
assert.ok(cut.every((text) => text.length <= replyText.MAX_SEGMENT_CHARS));

assert.equal(replyText.closeOpenQuote('She said "Hel'), 'She said "Hel"');
assert.equal(replyText.closeOpenQuote("“Hi"), "“Hi”");
assert.equal(replyText.closeOpenQuote("“Hi” she said."), "“Hi” she said.");

const alice = { ownerId: "alice", name: "Alice Moon" };
const bob = { ownerId: "bob", name: "Bob" };
const reply = 'Alice smiles. "Hi there!"\n[Bob]: Get lost.\nBobby waves.\n\nAlice laughs. "Fine';
const paragraphs = replyText.attributeReplyParagraphs(reply, [alice, bob], null, "alice");
assert.deepEqual(
  paragraphs.map((paragraph) => paragraph.ownerId),
  ["alice", "bob", "bob", "alice"],
  "a paragraph belongs to the first participant it names (whole names only), else the one before",
);
assert.ok(
  replyText.attributeReplyParagraphs(reply, [alice, bob], "bob", "alice").every((p) => p.ownerId === "bob"),
  "the Engine's streaming character wins",
);
assert.deepEqual(
  Object.fromEntries(replyText.collectReplyDialogue(reply, paragraphs, [alice, bob])),
  { alice: "Hi there! Fine", bob: "Get lost." },
  "dialogue per owner, with [Name]: lines and an open quote",
);

// ── The speech clock ──
const run = (clock: ReturnType<typeof createSpeechClock>, from: number, to: number, stepMs = 10) => {
  const samples: Array<{ t: number; open: number; viseme: string | null; speaking: boolean }> = [];
  for (let t = from; t <= to; t += stepMs) samples.push({ t, ...clock.sample(t) });
  return samples;
};
const lastSpeaking = (samples: ReturnType<typeof run>) => samples.filter((s) => s.speaking).at(-1)?.t ?? -1;

assert.ok(Math.abs(followMouthEnvelope(0, 1, 50) - (1 - Math.exp(-1))) < 1e-9, "50 ms attack");
assert.ok(Math.abs(followMouthEnvelope(1, 0, 80) - Math.exp(-1)) < 1e-9, "80 ms release");

let clock = createSpeechClock();
clock.push("Hello world");
let samples = run(clock, 0, 1300);
assert.ok(
  samples.some((s) => s.open > 0.5 && s.viseme),
  "vowels open the mouth with a viseme",
);
const helloEnd = lastSpeaking(samples);
assert.ok(helloEnd >= 900 && helloEnd <= 950, `11 characters at 14/s close 150 ms after the last (${helloEnd})`);
assert.deepEqual([samples.at(-1)!.open, samples.at(-1)!.viseme], [0, null], "the mouth rests afterwards");

clock = createSpeechClock();
clock.push("la".repeat(25));
samples = run(clock, 0, 3200);
const catchUpEnd = lastSpeaking(samples);
assert.ok(catchUpEnd > 2700 && catchUpEnd < 3000, `3.6 s of text runs at up to 1.5x (${catchUpEnd})`);

clock = createSpeechClock();
clock.push("la".repeat(150));
assert.ok(lastSpeaking(run(clock, 0, 3000)) < 1700, "far behind the typewriter, the clock skips to the newest text");

clock = createSpeechClock();
clock.speakAll("la".repeat(150), 8_000);
samples = run(clock, 0, 8600, 20);
const wholeEnd = lastSpeaking(samples);
assert.ok(wholeEnd > 7900 && wholeEnd <= 8200, `a whole line is squeezed into 8 s, never skipped (${wholeEnd})`);

clock = createSpeechClock();
clock.push("あいうえお");
samples = run(clock, 0, 700, 5);
const visemeAt = (t: number) => samples.find((s) => s.t === t)?.viseme;
assert.deepEqual(
  [visemeAt(60), visemeAt(180), visemeAt(300), visemeAt(425), visemeAt(545)],
  ["aa", "ih", "ou", "ee", "oh"],
  "kana go by vowel row",
);
clock = createSpeechClock();
clock.push("мама");
samples = run(clock, 0, 200, 5);
assert.equal(samples.find((s) => s.t === 30)?.open, 0, "lips close on м");
assert.equal(samples.find((s) => s.t === 110)?.viseme, "aa", "Cyrillic vowels pick visemes");

// ── The director ──
(globalThis as { window?: EventTarget }).window ??= new EventTarget();
const chatId = "avatar-director-chat";
useChatStore.setState({ activeChatId: chatId });

const SCORES: Array<[RegExp, AvatarEmotion, number, Partial<Record<AvatarEmotion, number>>]> = [
  [/beams|wonderful/u, "happy", 0.8, { neutral: 0.2 }],
  [/sobs|miss him/u, "sad", 0.7, { happy: 0.2, neutral: 0.1 }],
  [/sighs/u, "sad", 0.5, { happy: 0.4, neutral: 0.1 }],
  [/quiet/iu, "neutral", 0.9, { sad: 0.05, happy: 0.05 }],
];
const answer = (text: string): AvatarClassification => {
  const row = SCORES.find(([pattern]) => pattern.test(text));
  const [emotion, weight, rest] = row ? [row[1], row[2], row[3]] : (["neutral", 0.6, { happy: 0.4 }] as const);
  const scores = { neutral: 0, happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, ...rest, [emotion]: weight };
  return { emotion, weight, scores };
};
let t = 1_000;
const calls: Array<{ at: number; texts: string[] }> = [];
const classify = async (request: AvatarClassifyRequest) => {
  calls.push({ at: t, texts: request.texts });
  assert.equal(request.tier, "local-model", "the director asks for the best tier");
  return { results: request.texts.map(answer), tier: "local-model" as const, model: "stub", latencyMs: 1 };
};
const prepared: string[] = [];
const prepareModel = async (id: string) => {
  prepared.push(id);
  return { unsupported: null };
};
const roleplay = director.createAvatarDirector(
  { chatId, mode: "roleplay", reducedMotion: false },
  { classify, prepareModel },
);
assert.deepEqual(prepared, [chatId], "a Roleplay stage asks the server to get its local model ready");
roleplay.setParticipants([
  { owner: { ownerType: "character", ownerId: "alice" }, name: "Alice" },
  { owner: { ownerType: "persona", ownerId: "me" }, name: "Sam" },
]);
const flush = () => new Promise((resolve) => setImmediate(resolve));
let frames: Record<string, AvatarFrameInput> = {};
const step = async (ms: number, onFrame?: () => void) => {
  const end = t + ms;
  while (t < end) {
    t += 16;
    frames = { alice: roleplay.frame("alice", t), me: roleplay.frame("me", t) };
    onFrame?.();
    await flush();
  }
  return frames;
};
const store = () => useChatStore.getState();
const setText = (text: string) => store().setStreamBuffer(text, chatId);
const messageReady = (content: string) =>
  window.dispatchEvent(
    new CustomEvent(TTS_AUTOPLAY_MESSAGE_READY_EVENT, {
      detail: { chatId, message: { id: `m${t}`, role: "assistant", content, characterId: "alice" } },
    }),
  );
const endReply = (content: string) => {
  messageReady(content);
  store().clearStreamBuffer(chatId);
  store().setStreamedMessageId(chatId, null);
  store().setAbortController(chatId, null);
};
const waitFor = async (what: string, test: () => boolean, maxMs = 4_000) => {
  const deadline = t + maxMs;
  while (!test()) {
    assert.ok(t < deadline, `timed out waiting for ${what}`);
    await step(16);
  }
  return t;
};

// Send: thinking until the first word.
store().setAbortController(chatId, new AbortController());
await step(32);
assert.equal(frames.alice!.state, "thinking", "the character thinks from send to the first word");
assert.equal(frames.me!.state, "idle", "the persona never thinks for the character");

// Typing out a reply: dialogue moves the mouth, narration does not; the persona listens.
const typed = 'Alice beams at you. "This is so wonderful, really!" She looks away.';
let sawTalking = false;
let sawListening = false;
let maxOpen = 0;
for (let index = 1; index <= typed.length; index += 1) {
  setText(typed.slice(0, index));
  await step(32, () => {
    if (frames.alice!.state === "talking") sawTalking = true;
    if (frames.me!.state === "listening") sawListening = true;
    maxOpen = Math.max(maxOpen, frames.alice!.mouthOpen);
  });
}
assert.ok(sawTalking && maxOpen > 0.5, "the character talks while its dialogue appears");
assert.ok(sawListening, "the persona listens while the character talks");
const happyAt = await waitFor("the classifier's happy face", () => frames.alice!.emotion === "happy");
for (let index = 1; index < calls.length; index += 1) {
  assert.ok(calls[index]!.at - calls[index - 1]!.at >= 1_200, "classifier calls are at least 1.2 s apart");
}
assert.ok(
  calls.flatMap((call) => call.texts).includes("Alice beams at you."),
  "sentences reach the classifier as plain text",
);

// Hysteresis: a face holds 2 s, needs a 0.15 lead, and neutral needs two sentences.
let shown = typed;
const say = (sentence: string) => {
  shown = `${shown} ${sentence} `;
  setText(shown);
};
say("Alice sobs.");
const sadAt = await waitFor("the sad face", () => frames.alice!.emotion === "sad");
assert.ok(sadAt > happyAt);
say("Alice beams again.");
await step(1_700);
assert.equal(frames.alice!.emotion, "sad", "a new face waits until the current one has held 2 s");
const heldUntil = await waitFor("the held happy face", () => frames.alice!.emotion === "happy", 1_500);
assert.ok(heldUntil - sadAt >= 2_000, "the waiting face shows once the 2 s are up");
say("Alice sighs.");
await step(3_000);
assert.equal(frames.alice!.emotion, "happy", "a 0.1 lead is not enough to switch");
say("Quiet one.");
await step(2_500);
assert.equal(frames.alice!.emotion, "happy", "one neutral sentence does not reset the face");
say("Quiet two.");
await waitFor("two neutral sentences", () => frames.alice!.emotion === "neutral", 2_500);

// The reply ends: the face relaxes 4 s later.
say("Alice beams once more.");
await waitFor("a happy face before the end", () => frames.alice!.emotion === "happy");
endReply("(final)");
const endedAt = t;
await step(3_000);
assert.equal(frames.alice!.emotion, "happy", "the face holds right after the reply");
await waitFor("the relaxed face", () => frames.alice!.emotion === "neutral", 4_000);
assert.ok(t - endedAt >= 4_000, "the face relaxes no sooner than 4 s after the reply");
assert.equal(frames.alice!.state, "idle");

// Next reply: cached sentences skip the request; the Expression Engine's pick is final.
const callsBefore = calls.length;
store().setAbortController(chatId, new AbortController());
setText("Alice beams at you. ");
await waitFor("the cached happy face", () => frames.alice!.emotion === "happy");
assert.equal(calls.length, callsBefore, "a sentence classified before is answered from the cache");
const expressionPick = (messageId: string, expression: string) =>
  useAgentStore.getState().addResult("expression", {
    agentId: "expression",
    agentType: "expression",
    type: "sprite_change",
    data: { expressions: [{ characterId: "alice", expression }] },
    tokensUsed: 0,
    durationMs: 1,
    success: true,
    error: null,
    messageId,
  });
// The previous reply's Expression Engine finishes after this message was sent (Roleplay frees the composer).
expressionPick("reply-1", "angry");
await step(16);
assert.equal(frames.alice!.emotion, "happy", "a pick for an earlier reply does not land on this one");
store().setStreamedMessageId(chatId, "reply-2");
expressionPick("reply-2", "crying");
await step(16);
assert.deepEqual(
  [frames.alice!.emotion, frames.alice!.label],
  ["sad", "crying"],
  "the Expression Engine sets the face and its sprite label",
);
setText("Alice beams at you. It is wonderful. ");
await step(2_500);
assert.equal(frames.alice!.label, "crying", "later sentences do not override the Expression Engine");
endReply("(final)");
await step(6_000);
assert.equal(frames.alice!.emotion, "sad", "a settled face does not relax");

// Streaming off: the reply arrives whole, is classified whole, and its dialogue is spoken within 8 s.
useUIStore.setState({ enableStreaming: false });
store().setAbortController(chatId, new AbortController());
await step(32);
const longLine = "I miss him so much. ".repeat(12).trim();
const wholeCalls = calls.length;
messageReady(`Alice sobs quietly by the window.\n\n"${longLine}"`);
store().setAbortController(chatId, null);
await step(1_000);
assert.equal(frames.alice!.state, "talking", "a whole reply is spoken");
await waitFor("the whole-reply request", () => calls.length > wholeCalls, 1_500);
assert.equal(calls.at(-1)!.texts.length, 1, "a whole reply is classified once, as a whole");
assert.ok(calls.at(-1)!.texts[0]!.includes("sobs quietly"));
await step(6_600);
assert.equal(frames.alice!.state, "talking", "still speaking just before 8 s");
await step(600);
assert.notEqual(frames.alice!.state, "talking", "done speaking by 8 s even though the line is longer");
useUIStore.setState({ enableStreaming: true });

// Text-to-speech: the voice level drives the mouth while it plays.
roleplay.setAudioSource("alice", { ownerId: "alice", level: () => 0.8, isPlaying: () => true, viseme: () => "oh" });
await step(300);
assert.ok(frames.alice!.mouthOpen > 0.75, "the mouth follows the voice level");
assert.deepEqual([frames.alice!.viseme, frames.alice!.state, frames.me!.state], ["oh", "talking", "listening"]);
roleplay.setAudioSource("alice", null);
await step(300);
assert.equal(frames.alice!.mouthOpen, 0, "the mouth rests when the voice stops");

// The user typing: characters listen.
useChatStore.setState({ hasCurrentInput: true });
await step(32);
assert.deepEqual([frames.alice!.state, frames.me!.state], ["listening", "idle"]);
useChatStore.setState({ hasCurrentInput: false });

// Group chats: the streaming character speaks, the others do not.
roleplay.setParticipants([
  { owner: { ownerType: "character", ownerId: "alice" }, name: "Alice" },
  { owner: { ownerType: "character", ownerId: "bob" }, name: "Bob" },
]);
store().setAbortController(chatId, new AbortController());
store().setStreamingCharacterId("bob");
let bobOpen = 0;
let aliceOpen = 0;
for (const text of ['"Hey', '"Hey there', '"Hey there, Alice!"']) {
  setText(text);
  for (let index = 0; index < 20; index += 1) {
    t += 16;
    bobOpen = Math.max(bobOpen, roleplay.frame("bob", t).mouthOpen);
    aliceOpen = Math.max(aliceOpen, roleplay.frame("alice", t).mouthOpen);
    await flush();
  }
}
assert.ok(bobOpen > 0.5 && aliceOpen === 0, "only the streaming character's mouth moves");
store().setStreamingCharacterId(null);
endReply("(final)");
roleplay.dispose();
const afterDispose = calls.length;
store().setAbortController(chatId, new AbortController());
setText("Alice beams wonderfully after the end. ");
await step(1_500);
assert.equal(calls.length, afterDispose, "a disposed director stops listening");
store().setAbortController(chatId, null);

// ── Game mode: the Game Master's line on screen ──
const gameChatId = "avatar-director-game";
const game = director.createAvatarDirector(
  { chatId: gameChatId, mode: "game", reducedMotion: false },
  {
    classify: async () => {
      throw new Error("Game mode must not call the classifier");
    },
  },
);
game.setParticipants([
  { owner: { ownerType: "character", ownerId: "alice" }, name: "Alice" },
  { owner: { ownerType: "persona", ownerId: "me" }, name: "Sam" },
]);
store().setAbortController(gameChatId, new AbortController());
store().setStreamBuffer("The tavern goes quiet. Alice beams.", gameChatId);
t += 16;
assert.equal(game.frame("alice", t).state, "thinking", "Game characters think until the first line shows");
publishAvatarGameLine("other-chat", { id: "x", type: "dialogue", speaker: "Alice", sprite: "happy", content: "Hi" });
publishAvatarGameLine(gameChatId, { id: "n1", type: "narration", content: "The fire crackles." });
t += 16;
assert.equal(game.frame("alice", t).emotion, "neutral", "other chats and narration lines do not reach avatars");
publishAvatarGameLine(gameChatId, {
  id: "s1",
  type: "dialogue",
  speaker: "Alice",
  sprite: "furious_glare",
  content: "Get out of my tavern!",
});
t += 16;
let gameFrame = game.frame("alice", t);
assert.deepEqual([gameFrame.emotion, gameFrame.label], ["angry", "furious_glare"], "the line's expression is the face");
t += 200;
gameFrame = game.frame("alice", t);
assert.equal(gameFrame.state, "talking", "the line is spoken");
assert.equal(game.frame("me", t).state, "listening");
store().setAbortController(gameChatId, null);
game.dispose();

// The stage usually mounts after the line it should show: the line on screen arrives with the participants.
const late = director.createAvatarDirector(
  { chatId: gameChatId, mode: "game", reducedMotion: false },
  { classify: async () => Promise.reject(new Error("unused")) },
);
late.setParticipants([{ owner: { ownerType: "character", ownerId: "alice" }, name: "Alice" }]);
t += 16;
gameFrame = late.frame("alice", t);
assert.deepEqual(
  [gameFrame.emotion, gameFrame.label],
  ["angry", "furious_glare"],
  "a stage that mounts after the line still shows it",
);
late.dispose();
await flush();

// Once narration follows that line, a stage that mounts later keeps the face but does not speak the old line.
publishAvatarGameLine(gameChatId, { id: "n2", type: "narration", content: "The fire crackles." });
const afterNarration = director.createAvatarDirector(
  { chatId: gameChatId, mode: "game", reducedMotion: false },
  { classify: async () => Promise.reject(new Error("unused")) },
);
afterNarration.setParticipants([{ owner: { ownerType: "character", ownerId: "alice" }, name: "Alice" }]);
let staleTalking = 0;
for (let index = 0; index < 60; index += 1) {
  t += 16;
  gameFrame = afterNarration.frame("alice", t);
  if (gameFrame.state === "talking") staleTalking += 16;
}
assert.equal(gameFrame.label, "furious_glare", "the last line's face stays");
assert.equal(staleTalking, 0, "an old line is not spoken while narration shows");
afterNarration.dispose();
await flush();

// A Game thought (or the player's own input) changes the face, never the mouth: Game voices skip those lines too.
const thoughts = director.createAvatarDirector(
  { chatId: gameChatId, mode: "game", reducedMotion: false },
  { classify: async () => Promise.reject(new Error("unused")), prepareModel },
);
thoughts.setParticipants([{ owner: { ownerType: "character", ownerId: "alice" }, name: "Alice" }]);
publishAvatarGameLine(gameChatId, {
  id: "s2",
  type: "dialogue",
  speaker: "Alice",
  sprite: "worried",
  partyType: "thought",
  content: "I hope he never finds out what I did.",
});
let thoughtTalking = 0;
for (let index = 0; index < 60; index += 1) {
  t += 16;
  if (thoughts.frame("alice", t).state === "talking") thoughtTalking += 16;
}
assert.equal(thoughtTalking, 0, "a thought line does not move the mouth");
assert.equal(thoughts.frame("alice", t).label, "worried", "a thought line still sets the face");
thoughts.dispose();
assert.equal(prepared.filter((id) => id === gameChatId).length, 0, "Game mode never asks for the local model");

// ── How a reply ends, who speaks, and whose pick it is ──
const answerOf = (request: AvatarClassifyRequest) => ({
  results: request.texts.map(answer),
  tier: "local-model" as const,
  model: "stub",
  latencyMs: 1,
});
const scene = (id: string, names: string[]) => {
  const texts: string[] = [];
  const scened = director.createAvatarDirector(
    { chatId: id, mode: "roleplay", reducedMotion: false },
    {
      classify: async (request) => {
        texts.push(...request.texts);
        return answerOf(request);
      },
      prepareModel,
    },
  );
  const ids = names.map((name) => name.toLowerCase());
  scened.setParticipants(
    names.map((name) => ({ owner: { ownerType: "character", ownerId: name.toLowerCase() }, name })),
  );
  const talking: Record<string, number> = Object.fromEntries(ids.map((id2) => [id2, 0]));
  const last: Record<string, AvatarFrameInput> = {};
  const play = async (ms: number) => {
    const end = t + ms;
    while (t < end) {
      t += 16;
      for (const owner of ids) {
        last[owner] = scened.frame(owner, t);
        if (last[owner]!.state === "talking") talking[owner]! += 16;
      }
      await flush();
    }
  };
  /** Types `text` at about 50 characters a second, like the default typewriter. */
  const type = async (text: string, onChar?: (index: number) => void) => {
    for (let index = 1; index <= text.length; index += 1) {
      store().setStreamBuffer(text.slice(0, index), id);
      onChar?.(index);
      await play(20);
    }
  };
  const ready = (content: string, characterId: string) =>
    window.dispatchEvent(
      new CustomEvent(TTS_AUTOPLAY_MESSAGE_READY_EVENT, {
        detail: { chatId: id, message: { id: `${id}-m${t}`, role: "assistant", content, characterId } },
      }),
    );
  const start = () => store().setAbortController(id, new AbortController());
  const end = () => {
    store().clearStreamBuffer(id);
    store().setAbortController(id, null);
  };
  return { scened, texts, talking, last, play, type, ready, start, end };
};

// The server says the reply is saved while the typewriter still shows it: the reply goes on until the generation
// ends, so the classifier gets whole sentences, never one letter per frame.
{
  const drain = scene("director-drain", ["Alice"]);
  const reply = 'Alice beams at first. Then she sobs into her sleeve. "I miss him so much, I cannot stop crying."';
  drain.start();
  await drain.type(reply, (index) => {
    if (index === Math.floor(reply.length * 0.4)) drain.ready(reply, "alice");
  });
  drain.end();
  await drain.play(4_000);
  assert.ok(
    drain.texts.every((text) => text.length > 12),
    `no fragments reach the classifier: ${JSON.stringify(drain.texts)}`,
  );
  assert.ok(drain.texts.some((text) => text.includes("sobs into her sleeve")));
  assert.equal(drain.last.alice!.emotion, "sad", "the sad sentences shown after message-ready still set the face");
  drain.scened.dispose();
}

// Message-ready before the first paint (a reply that arrived in one chunk) with streaming on: the typewriter still
// shows it, so the mouth follows the typed dialogue once and sentences are read once.
{
  const early = scene("director-early", ["Alice"]);
  const line = "I am so glad you came back, I missed you every single day.";
  const reply = `Alice smiles. "${line}" She hugs you.`;
  early.start();
  early.ready(reply, "alice");
  await early.play(64);
  await early.type(reply);
  early.end();
  await early.play(3_000);
  const clock = createSpeechClock();
  clock.speakAll(line, 8_000);
  const onePass = lastSpeaking(run(clock, 0, 8_000, 16));
  assert.ok(early.talking.alice! <= onePass + 500, `the line is mouthed once (${early.talking.alice} ms)`);
  assert.ok(early.talking.alice! > 1_000, "and it is mouthed");
  assert.ok(
    early.texts.every((text, index) => early.texts.every((other, at) => at === index || !other.startsWith(text))),
    `no growing prefixes reach the classifier: ${JSON.stringify(early.texts)}`,
  );
  early.scened.dispose();
}

// Streaming off with a held rewrite agent: the rewritten text lands in the buffer before message-ready, and its
// dialogue is still spoken within 8 s, not skipped down to the last second and a half.
{
  useUIStore.setState({ enableStreaming: false });
  const held = scene("director-held", ["Alice"]);
  const longLine = "I miss him so much. ".repeat(12).trim();
  const reply = `Alice sobs quietly by the window.\n\n"${longLine}"`;
  held.start();
  await held.play(32);
  store().setStreamBuffer(reply, "director-held");
  await held.play(100);
  held.ready(reply, "alice");
  held.end();
  await held.play(9_000);
  assert.ok(held.talking.alice! > 6_500, `a held rewrite's dialogue is spoken whole (${held.talking.alice} ms)`);
  useUIStore.setState({ enableStreaming: true });
  held.scened.dispose();
}

// A Merged group reply with streaming off is saved under the first character: each paragraph goes to the
// character it names. In an Individual group the message's own character speaks it all.
{
  useUIStore.setState({ enableStreaming: false });
  const merged = scene("director-merged", ["Alice", "Bob"]);
  merged.start();
  await merged.play(32);
  merged.ready('Bob slams the mug down. "Get out of my tavern!"\n\nAlice raises an eyebrow. "Fine, fine."', "alice");
  merged.end();
  await merged.play(4_000);
  assert.ok(
    merged.talking.bob! > 0 && merged.talking.alice! > 0,
    `both speak their lines ${JSON.stringify(merged.talking)}`,
  );
  assert.ok(
    merged.texts.some((text) => text.includes("slams") && !text.includes("eyebrow")),
    "Bob's paragraph is classified as Bob's",
  );
  merged.scened.dispose();

  useChatStore.setState({
    activeChat: { id: "director-individual", metadata: { groupChatMode: "individual" } } as never,
  });
  const individual = scene("director-individual", ["Alice", "Bob"]);
  individual.start();
  await individual.play(32);
  individual.ready('He slams the mug down and glares at Alice. "Get out!"', "bob");
  individual.end();
  await individual.play(3_000);
  assert.ok(
    individual.talking.bob! > 0 && individual.talking.alice === 0,
    `an Individual member's message is theirs ${JSON.stringify(individual.talking)}`,
  );
  individual.scened.dispose();
  useChatStore.setState({ activeChat: null });
  useUIStore.setState({ enableStreaming: true });
}

// Streaming a Merged group reply whose speech tag follows the quote: the line waits for its speaker's name, so
// the previous paragraph's character never mouths it first.
{
  const tagged = scene("director-tagged", ["Alice", "Bob"]);
  tagged.start();
  await tagged.type('Alice wipes the bar.\n"Get out of my tavern, and take your mangy dog with you," Bob growls.');
  tagged.end();
  await tagged.play(4_000);
  assert.equal(tagged.talking.alice, 0, "Alice never mouths Bob's line");
  assert.ok(tagged.talking.bob! > 1_000, "Bob says it");
  tagged.scened.dispose();
}

// The server's model: asked for once per Roleplay stage, again (at most once a minute) while it answers with
// keywords, and never again once the server says it cannot run it.
{
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  const asks: string[] = [];
  const keywordTier = director.createAvatarDirector(
    { chatId: "director-model", mode: "roleplay", reducedMotion: false },
    {
      classify: async (request) => ({ ...answerOf(request), tier: "keywords" as const, model: null }),
      prepareModel: async (id) => {
        asks.push(id);
        return { unsupported: asks.length >= 2 ? "low-memory" : null };
      },
    },
  );
  keywordTier.setParticipants([{ owner: { ownerType: "character", ownerId: "alice" }, name: "Alice" }]);
  assert.equal(asks.length, 1, "asked once when the stage mounts");
  const sayAndWait = async (text: string) => {
    store().setAbortController("director-model", new AbortController());
    store().setStreamBuffer(text, "director-model");
    for (let index = 0; index < 120; index += 1) {
      t += 16;
      keywordTier.frame("alice", t);
      await flush();
    }
    store().clearStreamBuffer("director-model");
    store().setAbortController("director-model", null);
  };
  await sayAndWait("Alice beams at you. ");
  assert.equal(asks.length, 1, "not again within the minute");
  fakeNow += 61_000;
  await sayAndWait("Alice sobs quietly. ");
  assert.equal(asks.length, 2, "again after a minute of keyword answers");
  fakeNow += 61_000;
  await sayAndWait("Alice beams again. ");
  assert.equal(asks.length, 2, "never again once the server cannot run the model");
  Date.now = realNow;
  keywordTier.dispose();
}

// ── Specific feelings inside an emotion ──
{
  const FEELINGS: Array<[RegExp, AvatarEmotion, number, AvatarClassification["feeling"]]> = [
    [/giggles/u, "happy", 0.8, "amusement"],
    [/thanks/u, "happy", 0.7, "gratitude"],
    [/sobs/u, "sad", 0.7, null],
    [/frets/u, "sad", 0.4, "nervousness"],
    [/regrets/u, "sad", 0.7, "remorse"],
    [/wonders/u, "neutral", 0.9, "curiosity"],
  ];
  const feelingAnswer = (text: string): AvatarClassification => {
    const [, emotion, weight, feeling] = FEELINGS.find(([pattern]) => pattern.test(text)) ?? [
      null,
      "neutral",
      0.6,
      null,
    ];
    const scores = { neutral: 1 - weight, happy: 0, angry: 0, sad: 0, relaxed: 0, surprised: 0, [emotion]: weight };
    return { emotion, weight, scores, feeling };
  };
  const id = "director-feelings";
  const sent: Array<{ at: number; text: string }> = [];
  const feelings = director.createAvatarDirector(
    { chatId: id, mode: "roleplay", reducedMotion: false },
    {
      classify: async (request) => {
        for (const text of request.texts) sent.push({ at: t, text });
        return { results: request.texts.map(feelingAnswer), tier: "local-model" as const, model: "stub", latencyMs: 1 };
      },
      prepareModel,
    },
  );
  feelings.setParticipants([{ owner: { ownerType: "character", ownerId: "alice" }, name: "Alice" }]);
  let alice = feelings.frame("alice", t);
  const play = async (ms: number) => {
    const end = t + ms;
    while (t < end) {
      t += 16;
      alice = feelings.frame("alice", t);
      await flush();
    }
  };
  const until = async (what: string, test: () => boolean, maxMs = 4_000) => {
    const deadline = t + maxMs;
    while (!test()) {
      assert.ok(t < deadline, `timed out waiting for ${what}`);
      await play(16);
    }
    return t;
  };
  let text = "";
  const tell = (sentence: string) => {
    text = `${text}${sentence} `;
    store().setStreamBuffer(text, id);
  };
  const begin = () => {
    text = "";
    store().setAbortController(id, new AbortController());
  };
  const finish = () => {
    store().clearStreamBuffer(id);
    store().setAbortController(id, null);
  };

  begin();
  tell("Alice giggles.");
  const amusedAt = await until("happy with amusement", () => alice.emotion === "happy");
  assert.equal(alice.feeling, "amusement", "a new emotion comes with its result's feeling");

  tell("Alice thanks you.");
  const gratefulAt = await until("gratitude", () => alice.feeling === "gratitude");
  const thanksSentAt = sent.find((entry) => entry.text.includes("thanks"))!.at;
  assert.ok(thanksSentAt < amusedAt + 2_000, "the new feeling was read while the first one was still holding");
  assert.ok(gratefulAt - amusedAt >= 2_000, "a new feeling waits until the current one has held 2 s");
  assert.equal(alice.emotion, "happy");

  tell("Alice sobs.");
  const sadAt = await until("the sad face", () => alice.emotion === "sad");
  assert.ok(sadAt - gratefulAt < 2_000, "a feeling change never holds the next emotion change");
  assert.equal(alice.feeling, null, "the new emotion takes its result's feeling, here none");

  tell("Alice frets.");
  await play(2_500);
  assert.equal(alice.feeling, null, "a weak feeling is not enough to change it");
  tell("Alice regrets it.");
  await until("remorse", () => alice.feeling === "remorse");
  tell("Alice sobs again.");
  await play(2_500);
  assert.deepEqual([alice.emotion, alice.feeling], ["sad", "remorse"], "a result with no feeling keeps the feeling");

  finish();
  await until("the relaxed face", () => alice.emotion === "neutral", 7_000);
  assert.equal(alice.feeling, null, "relaxing clears the feeling");
  await play(2_500);

  begin();
  tell("Alice wonders.");
  await until("curiosity", () => alice.feeling === "curiosity");
  assert.equal(alice.emotion, "neutral", "a calm face can have a feeling too");
  finish();
  const calmEnd = t;
  await until("plain calm", () => alice.feeling === null, 7_000);
  assert.ok(t - calmEnd >= 4_000, "a calm face with a feeling relaxes like any other, no sooner than 4 s");
  assert.equal(alice.emotion, "neutral");

  // Expression Engine picks: the label's feeling when it belongs to the label's emotion.
  feelings.pushExpressionPicks([{ ownerId: "alice", expression: "embarrassed" }]);
  await play(16);
  assert.deepEqual(
    [alice.emotion, alice.label, alice.feeling],
    ["happy", "embarrassed", "embarrassment"],
    "a pick names its feeling",
  );
  feelings.pushExpressionPicks([{ ownerId: "alice", expression: "kind_of_happy" }]);
  await play(16);
  assert.deepEqual(
    [alice.emotion, alice.feeling],
    ["happy", null],
    "a feeling of another emotion (caring) is left out",
  );

  // A pick from the last reply gives way to a newer feeling of the same emotion, whether the feeling lands at once
  // or waits out the pick's 2 s hold.
  const { buildPngtuberLayersFromSprites, pickPngtuberLayerKey } =
    await import("../../packages/client/src/features/avatars/renderers/pngtuber/pngtuber-layers.js");
  const head = buildPngtuberLayersFromSprites(
    ["neutral", "happy", "smirk", "gratitude"].map((expression) => ({ expression })),
  )!;
  for (const holdMs of [2_500, 0]) {
    feelings.pushExpressionPicks([{ ownerId: "alice", expression: "smirk" }]);
    await play(16);
    assert.equal(pickPngtuberLayerKey(head, alice), "smirk");
    await play(holdMs);
    begin();
    tell("Alice thanks you.");
    await until("gratitude after a pick", () => alice.feeling === "gratitude");
    assert.deepEqual([alice.emotion, alice.label], ["happy", null], "the earlier pick's label gives way");
    assert.equal(pickPngtuberLayerKey(head, alice), "gratitude", "the talking head shows the new feeling's face");
    finish();
    await play(16);
  }
  feelings.dispose();

  // Game Master lines: a feeling's own name no longer reads as neutral.
  const gm = director.createAvatarDirector(
    { chatId: "director-feelings-game", mode: "game", reducedMotion: false },
    { classify: async () => Promise.reject(new Error("unused")) },
  );
  gm.setParticipants([{ owner: { ownerType: "character", ownerId: "alice" }, name: "Alice" }]);
  const gmFace = (expression: string) => {
    gm.pushGameLine({ speakerName: "Alice", ownerId: "alice", expression, text: "Well." });
    t += 16;
    const frame = gm.frame("alice", t);
    return [frame.emotion, frame.feeling];
  };
  assert.deepEqual(gmFace("amused"), ["happy", "amusement"]);
  assert.deepEqual(gmFace("pride"), ["happy", "pride"], "pride is happy, not neutral");
  assert.deepEqual(gmFace("scared"), ["surprised", "fear"]);
  assert.deepEqual(gmFace("angry"), ["angry", null]);
  gm.dispose();
}

// A swipe in an Individual group gets no group_turn from the server; use-generate names the swiped member as the
// streaming character, so the director's group test above ("only the streaming character's mouth moves") applies.
const generateSource = readFileSync(
  new URL("../../packages/client/src/hooks/use-generate.ts", import.meta.url),
  "utf8",
);
assert.match(
  generateSource,
  /setRegenerateMessageId\(params\.regenerateMessageId \?\? null\);\s+const swipeSpeaker = getIndividualGroupSwipeSpeaker\(qc, params\.chatId, params\.regenerateMessageId\);\s+if \(swipeSpeaker\) setStreamingCharacterId\(swipeSpeaker\);/u,
  "a swipe names its member as the streaming character",
);
assert.match(
  generateSource,
  /function getIndividualGroupSwipeSpeaker[\s\S]{0,400}normalizeGroupChatMode\(parseChatMetadata\(chat\?\.metadata\)\.groupChatMode\) !== "individual"/u,
  "only in Individual groups: a Merged reply is saved under its first character",
);
// The Expression Engine's pick keeps the message it was for, so a late pick finds its reply.
assert.equal(
  (generateSource.match(/addResult\(result\.agentType, \{[^}]*messageId: result\.messageId \?\? null,/gu) ?? []).length,
  2,
  "both agent-result paths keep the result's message",
);

// Both avatar agents' pages show the mood reader's download (Mari, 2026-10-13); whichever lane fills the setup
// page must keep this mount.
const setupSource = readFileSync(
  new URL("../../packages/client/src/features/avatars/setup/AvatarAgentSetup.tsx", import.meta.url),
  "utf8",
);
assert.match(setupSource, /import \{ AvatarModelStatus \} from "\.\.\/director\/AvatarModelStatus";/u);
assert.match(setupSource, /<AvatarModelStatus \/>/u, "the agent page shows the mood reader's download");

console.log("avatar director regression passed");
