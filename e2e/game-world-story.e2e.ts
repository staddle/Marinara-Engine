import { expect, test, type Page } from "@playwright/test";
import {
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  checkStoryScript,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  storyTurn,
  worldCast,
} from "@marinara-engine/shared";
import { openChatTool } from "./chat-settings-tools.js";
import { openGame } from "./game-ruleset-fight-fixture.js";

/**
 * A world's story (worldgen W10), on screen: a scene the Engine showed before a reply plays in the
 * narration as written, its speaker named and its tags never shown, and the journal's World tab lists
 * the objectives the story has shown.
 */

const parsedKit = parseWorldKit(WORLD_STARTER_KITS.find((kit) => kit.id === "high_fantasy")!);
if (!parsedKit.ok) throw new Error("The high fantasy kit does not read");
const kit = parsedKit.kit;
const read = checkWorldBrief(kit, {
  briefVersion: 1,
  premise: "The river provinces quarrel over the succession.",
  places: [
    { name: "Hollin", layer: "settlement", size: "village", tags: [], start: true },
    { name: "Thornmere", layer: "settlement", size: "city", tags: ["port"] },
  ],
  peopleNames: kit.cultures.map((culture) => ({
    culture: culture.id,
    given: ["Ama", "Tobin", "Hesk", "Mira", "Elara", "Oswin", "Bryn", "Cato", "Tamsin", "Wren", "Edda", "Fenn"],
    family: ["Arnwald", "Fennick", "Holt", "Marrow", "Voss", "Drey", "Callow"],
  })),
});
if (!read.ok) throw new Error(read.issues.join("; "));
const world = {
  seed: 20261002,
  generatorVersion: WORLD_GENERATOR_VERSION,
  grounding: "expand" as const,
  brief: read.brief,
};
const game = { kit, ...world, world: compileGameWorld({ kit, ...world }) };
const thornmere = game.world.places.find((place) => place.name === "Thornmere")!;
const harbourmaster = worldCast(game, thornmere.id).find((person) => person.named)!;
const checked = checkStoryScript(game, {
  storyVersion: 1,
  flags: [
    {
      id: "key",
      kind: "bool",
      initial: false,
      quest: { title: "The harbour key", text: "Find the key", hidden: true },
    },
    { id: "ships", kind: "number", initial: 0, quest: { title: "Ships", text: "Save three ships", goal: 3 } },
    { id: "secret", kind: "bool", initial: false, quest: { title: "Never shown", text: "x", hidden: true } },
  ],
  events: [
    {
      id: "harbour",
      when: { on: "arrive", place: thornmere.id },
      do: [{ cutscene: "quay" }, { show: "key" }, { add: "ships", amount: 1 }],
    },
  ],
  cutscenes: [
    {
      id: "quay",
      kind: "pages",
      pages: [
        { text: "Gulls wheel over the quay." },
        { speaker: harbourmaster.id, expression: "surprised", text: "You came after all." },
      ],
    },
  ],
});
if (!checked.ok) throw new Error(checked.issues.join("; "));
const story = checked.story;
// The replies as the Engine wrote them: the party walks into Thornmere, and the next reply opens on the
// story's scene.
const before = [
  'Mist on the reeds. [place: name="Hollin" result="ok"]',
  'The boat noses in. [place: name="Thornmere" result="ok"]',
];
const turn = storyTurn(story, {
  game,
  replies: before,
  repliesBefore: before.length,
  latest: before.at(-1)!,
  told: [],
  day: 0,
  fight: null,
});
if (turn.tripped[0] !== "harbour") throw new Error(`The arrival did not trip: ${turn.tripped.join(", ")}`);
const opened = `${turn.prepend}The quay smells of tar.`;

/** The journal, opened from the Session window as staging's game controls do. */
async function openJournal(page: Page) {
  const session = await openChatTool(page, "control:session");
  await session.getByRole("button", { name: "Journal", exact: true }).click();
}

test("a story's scene plays as written before the reply, and the World tab lists its objectives", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const created = await request.post("/api/chats", { data: { name: "Story", mode: "game", characterIds: [] } });
  expect(created.ok()).toBeTruthy();
  const chatId = ((await created.json()) as { id: string }).id;
  try {
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `world-story-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldView: "scene",
        gameWorldKit: kit,
        gameWorld: world,
        gameStory: story,
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    for (const content of [...before, opened]) {
      expect((await request.post(`/api/chats/${chatId}/messages`, { data: { role: "assistant", content } })).ok()).toBe(
        true,
      );
    }
    await openGame(page, chatId);
    const panel = page.locator('[data-component="GameNarration.ActivePanel"]');
    const prose = panel.locator(".game-narration-prose").first();
    // The scene first, as written; never a story tag on screen.
    await expect(prose).toContainText("Gulls wheel over the quay.", { timeout: 40_000 });
    await expect(page.getByText(/\[story:/u)).toHaveCount(0);
    // On to the harbourmaster's line: spoken by them, by name.
    const next = panel.getByRole("button", { name: "Next", exact: true });
    for (let step = 0; step < 6 && !(await panel.getByText("You came after all.").isVisible()); step++) {
      await next.click();
      await page.waitForTimeout(400);
    }
    await expect(panel.getByText("You came after all.")).toBeVisible();
    await expect(panel.getByText(harbourmaster.name, { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("story-scene.png") });

    await openJournal(page);
    await page.getByRole("button", { name: "World", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Story", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("The harbour key", { exact: true })).toBeVisible();
    await expect(page.getByText("Ships", { exact: true })).toBeVisible();
    await expect(page.getByText("1 of 3", { exact: true })).toBeVisible();
    await expect(page.getByText("Never shown", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("story-journal.png") });
  } finally {
    await request.delete(`/api/chats/${chatId}`);
  }
});
