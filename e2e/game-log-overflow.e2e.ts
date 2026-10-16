import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// #7606: a model's reasoning leaked into a Game reply (here behind an unclosed tag) and echoed the
// Game line format. A run joined by `|`, `/` or `,` with no spaces has no place a browser will
// wrap it, so it stretched the session log far past the window and the log scrolled sideways.
const EXPRESSIONS =
  "neutral|happy|sad|angry|surprised|scared|disgusted|thinking|laughing|crying|blushing|smirking|determined|confused|exhausted";
const LEAKED_REASONING = [
  "<think>",
  "If the frontend joins my output onto `((Absolutely! Let's proceed))\\nCharacter: Princess Luna))` the scene breaks.",
  "Let's review the required format carefully.",
  `Lines: \`[Name] [main|side|whisper:target|thought] [${EXPRESSIONS}]: "Dialogue"\``,
  "Source: https://example.com/marinara/engine/game/session/log/overflow/check?with=a&very=long&query=string&that=keeps&going",
  `<pre>${"wide_preformatted_token_".repeat(6)}</pre>`,
  `|${"column".repeat(4)}|${"another_cell".repeat(4)}|${"third_cell".repeat(4)}|`,
  "Let's plan the beat.",
].join("\n");
const DIALOGUE = `[Princess Luna] [main] [neutral]: "Read the list back to me: ${EXPRESSIONS}."`;
// The same run parsed as a speaker name, and inside a note that opens in its own reader.
const LIST_SPEAKER = `[${EXPRESSIONS}]: "Who am I now?"`;
const NOTE = `[Note: Scrawled in the margin: ${EXPRESSIONS}]`;

async function seedLeakedReasoningTurn(request: APIRequestContext) {
  const created = await request.post("/api/chats", {
    data: { name: "Leaked reasoning overflow", mode: "game", characterIds: [] },
  });
  expect(created.ok()).toBeTruthy();
  const chat = (await created.json()) as { id: string };
  const meta = await request.patch(`/api/chats/${chat.id}/metadata`, {
    data: { gameId: "log-overflow-fixture", gameSessionStatus: "active", gameIntroPresented: true },
  });
  expect(meta.ok()).toBeTruthy();
  const base = Date.now();
  for (const [step, content] of [
    "Lantern light pools at the gatehouse.",
    `${LEAKED_REASONING}\n\nThe gate creaks open.\n${DIALOGUE}\n${LIST_SPEAKER}\n${NOTE}`,
  ].entries()) {
    const saved = await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content, createdAt: new Date(base + step * 1000).toISOString() },
    });
    expect(saved.ok()).toBeTruthy();
  }
  return chat.id;
}

async function openGameChat(page: Page, chatId: string, stacked: boolean) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    rightPanelOpen: false,
    sidebarOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
    gameInstantTextReveal: true,
    gameDialogueDisplayMode: stacked ? "stacked" : "classic",
  });
  await page.addInitScript(
    ({ id, appVersion }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", appVersion);
    },
    { id: chatId, appVersion: version },
  );
  await page.goto("/");
}

/** Every element inside `root` that reaches past its right edge, even where it would be clipped. */
async function pastRightEdge(root: Locator) {
  return root.evaluate((element) => {
    const edge = element.getBoundingClientRect().right;
    return [...element.querySelectorAll("*")]
      .filter((node) => node.getBoundingClientRect().right > edge + 1)
      .map((node) => `${node.tagName} ${(node.textContent ?? "").slice(0, 60)}`);
  });
}

/** Every scrolling box inside `root` that is wider inside than out, by how far. */
async function sidewaysOverflow(root: Locator) {
  return root.evaluate((element) =>
    [element, ...element.querySelectorAll("*")]
      .filter((node) => /auto|scroll/.test(getComputedStyle(node).overflowX))
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => `${node.className}: ${node.scrollWidth} > ${node.clientWidth}`),
  );
}

for (const stacked of [false, true]) {
  test(`leaked reasoning stays inside the ${stacked ? "stacked" : "classic"} Game log and dialogue box`, async ({
    page,
    request,
    isMobile,
  }, testInfo) => {
    test.skip(!isMobile, "#7606 was reported on a phone; the mobile projects carry the proof.");
    const chatId = await seedLeakedReasoningTurn(request);
    try {
      await openGameChat(page, chatId, stacked);
      const panel = page.locator('[data-component="GameNarration.ActivePanel"]');
      await expect(panel).toBeVisible({ timeout: 30_000 });
      // The turn opens on the leaked reasoning, then steps on to a dialogue line carrying the same run.
      await expect(panel).toContainText("Let's review the required format carefully.");
      expect.soft(await sidewaysOverflow(panel), "narration box scrolls sideways").toEqual([]);
      const next = page.getByRole("button", { name: "Next", exact: true }).filter({ visible: true });
      const stepTo = (text: string) =>
        expect(async () => {
          if (!((await panel.textContent()) ?? "").includes(text)) await next.click();
          await expect(panel).toContainText(text, { timeout: 1_000 });
        }).toPass({ timeout: 20_000 });
      await stepTo("Read the list back to me");
      await expect(panel).toContainText(EXPRESSIONS);
      expect.soft(await sidewaysOverflow(panel), "dialogue box scrolls sideways").toEqual([]);
      await stepTo("Who am I now?");
      expect.soft(await pastRightEdge(panel), "speaker name past the dialogue box's edge").toEqual([]);
      await stepTo("You find a note...");
      const reader = page.locator("div.fixed.inset-y-0").filter({ hasText: "Scrawled in the margin" });
      await expect(reader).toContainText(EXPRESSIONS);
      expect.soft(await sidewaysOverflow(reader), "note reader scrolls sideways").toEqual([]);
      await reader.getByRole("button").click();
      await expect(reader).toBeHidden();

      let log: Locator;
      if (stacked) {
        log = page.locator(".mari-game-stacked-log");
      } else {
        await page.getByRole("button", { name: "Logs", exact: true }).filter({ visible: true }).first().click();
        log = page
          .getByRole("dialog")
          .filter({ has: page.getByRole("heading", { name: "Session Logs" }) })
          .locator('[data-game-section="logs"]');
      }
      await expect(log).toContainText("Let's review the required format carefully.");
      await expect(log).toContainText(EXPRESSIONS);
      await page.screenshot({ path: testInfo.outputPath(`game-log-overflow-${stacked ? "stacked" : "classic"}.png`) });
      expect.soft(await sidewaysOverflow(log), "session log scrolls sideways").toEqual([]);
      // Nothing may poke out past the log's right edge either, even where it would be clipped.
      expect(await pastRightEdge(log), "log text past the log's right edge").toEqual([]);
    } finally {
      await request.delete(`/api/chats/${chatId}?force=true`);
    }
  });
}
