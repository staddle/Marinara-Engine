// Browser extensions such as Grammarly show their suggestion cards in their own elements outside the app:
// a custom element with a shadow root, added to <body> or <html>. Accepting a suggestion there is a press
// outside every chat window, and it used to close Chat Settings, taking the expanded Chat Summary editor
// and the unsaved edit with it. Presses, focus and keys in such extension UI now leave our windows alone, and
// Escape there no longer closes the conversation Edit Summaries editor or a preset variable's value editor.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createChatSummaryEntry, type ChatSummaryEntry } from "@marinara-engine/shared";
import { seedUIState } from "./ui-state-fixture.js";
import { chatSettingsWindow, openChatSettings, openChatSettingsTool } from "./chat-settings-tools.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const EXPANDED_SUMMARY_FIELD = '[data-component="ExpandedMacroEditor"] textarea';

async function seedApp(page: Page, activeChatId = "") {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["conversation", "roleplay", "game"],
  });
  await page.addInitScript(
    ({ id, version }) => {
      if (id) localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", version);
    },
    { id: activeChatId, version },
  );
  await page.goto("/");
}

async function openSummaryChat(page: Page, request: APIRequestContext, entry: ChatSummaryEntry) {
  const created = await request.post("/api/chats", { data: { name: "Extension suggestions", mode: "roleplay" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };
  expect((await request.patch(`/api/chats/${id}/metadata`, { data: { summaryEntries: [entry] } })).ok()).toBeTruthy();
  await seedApp(page, id);
  return id;
}

/**
 * Adds a suggestion card the way a grammar extension does, under <body> or <html>, and returns its accept
 * button. Accepting puts the fix for the first "teh" into the field, as the extension would.
 */
async function addExtensionCard(page: Page, parent: "body" | "html", fieldSelector = EXPANDED_SUMMARY_FIELD) {
  await page.evaluate(
    ({ parent, fieldSelector }) => {
      document.querySelector("grammarly-popups")?.remove();
      const host = document.createElement("grammarly-popups");
      host.style.cssText = "position: fixed; left: 1rem; bottom: 1rem; z-index: 2147483647; display: block;";
      const accept = document.createElement("button");
      accept.type = "button";
      accept.textContent = "Accept suggestion";
      accept.addEventListener("click", () => {
        const field = document.querySelector<HTMLTextAreaElement>(fieldSelector);
        const start = field?.value.indexOf("teh") ?? -1;
        if (!field || start < 0) return;
        field.focus();
        field.setSelectionRange(start, start + 3);
        document.execCommand("insertText", false, "the");
      });
      host.attachShadow({ mode: "open" }).append(accept);
      (parent === "html" ? document.documentElement : document.body).append(host);
    },
    { parent, fieldSelector },
  );
  return page.locator("grammarly-popups").getByRole("button", { name: "Accept suggestion", exact: true });
}

test("accepting a browser extension's suggestion keeps the expanded summary editor and its edit", async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== "desktop-chromium", "Grammar extensions show their suggestion cards on a computer.");
  const entry = createChatSummaryEntry({
    id: "extension-memory",
    title: "Extension memory",
    content: "Mari found teh key and opened teh door.",
    enabled: true,
    rangeStartIndex: 0,
    rangeEndIndex: 0,
  });
  const id = await openSummaryChat(page, request, entry);
  try {
    const panel = await openChatSettingsTool(page, "chat-summary");
    const settings = chatSettingsWindow(page);
    const row = panel.locator(`[data-summary-entry-id="${entry.id}"]`);
    await row.getByRole("button", { name: "Edit summary entry", exact: true }).click();
    await row.getByRole("button", { name: "Expand editor", exact: true }).click();
    const editor = page.locator('[data-component="ExpandedMacroEditor"]');
    const field = editor.getByRole("textbox");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(entry.content);

    // Accepting the suggestion is a real press on the card, outside Chat Settings.
    const acceptInBody = await addExtensionCard(page, "body");
    await acceptInBody.click();
    await expect(field).toHaveValue("Mari found the key and opened teh door.");
    await expect(editor).toBeVisible();
    await expect(settings).toBeVisible();

    // The card takes focus and Escape goes to it: neither is the user leaving the editor. The window blur is
    // only a smoke check, since a synthetic one fires no blur or focusout on the field the way a real loss of
    // focus to another app would.
    await acceptInBody.focus();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await expect(settings).toBeVisible();

    const acceptInHtml = await addExtensionCard(page, "html");
    await acceptInHtml.click();
    await expect(field).toHaveValue("Mari found the key and opened the door.");
    await expect(editor).toBeVisible();
    await expect(settings).toBeVisible();

    // Escape in the editor itself still closes it, and the edit is kept.
    await field.press("Escape");
    await expect(editor).toHaveCount(0);
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(
        async () =>
          ((await (await request.get(`/api/chats/${id}`)).json()).metadata.summaryEntries as ChatSummaryEntry[])[0]
            ?.content,
      )
      .toBe("Mari found the key and opened the door.");

    // A press on the chat itself still closes Chat Settings, as before.
    await page.evaluate(() => document.querySelector("grammarly-popups")?.remove());
    await page.locator("[data-chat-scroll]").click({ position: { x: 40, y: 200 } });
    await expect(settings).toHaveCount(0);
  } finally {
    await request.delete(`/api/chats/${id}?force=true`);
  }
});

test("a browser extension's card keeps the conversation Edit Summaries editor and its drafts", async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== "desktop-chromium", "Grammar extensions show their suggestion cards on a computer.");
  const created = await request.post("/api/chats", {
    data: { name: "Extension day summaries", mode: "conversation", characterIds: [] },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };
  const day = "01.09.2026";
  try {
    await seedApp(page, id);
    const settings = await openChatSettings(page);
    const section = settings.locator('[data-chat-settings-section="conversation-automatic-summarization"]');
    const sectionToggle = section.locator('[role="button"][aria-expanded]');
    if ((await sectionToggle.getAttribute("aria-expanded")) === "false") await sectionToggle.click();
    // Added only now, so the day appears once the editor's refetch on open has landed. That refetch also
    // collapses every entry, and would fold one opened before it.
    const seeded = await request.patch(`/api/chats/${id}/summaries`, {
      data: { daySummaries: { [day]: { summary: "Mari found teh key.", keyDetails: [] } } },
    });
    expect(seeded.ok()).toBeTruthy();
    await section.getByRole("button", { name: "Edit Summaries" }).click();
    const editor = page.getByRole("dialog", { name: "Automatic Summarization", exact: true });
    await editor.getByRole("button", { name: day }).click();
    const field = editor.getByRole("textbox").first();
    await expect(field).toHaveValue("Mari found teh key.");

    const accept = await addExtensionCard(page, "html", '[aria-labelledby="summaries-editor-title"] textarea');
    await accept.click();
    await expect(field).toHaveValue("Mari found the key.");
    await expect(settings).toBeVisible();

    // Escape in the card closes the card, not the editor with its unsaved draft.
    await accept.focus();
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await expect(field).toHaveValue("Mari found the key.");

    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/chats/${id}`)).json()).metadata.daySummaries?.[day]?.summary)
      .toBe("Mari found the key.");
  } finally {
    await request.delete(`/api/chats/${id}?force=true`);
  }
});

test("Escape in a browser extension's card keeps a preset variable's value editor open", async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== "desktop-chromium", "Grammar extensions show their suggestion cards on a computer.");
  const preset = (await (
    await request.post("/api/prompts", { data: { name: "Extension variable fixture" } })
  ).json()) as {
    id: string;
  };
  const variable = await request.post(`/api/prompts/${preset.id}/variables`, {
    data: {
      variableName: "EXTENSION_TONE",
      question: "Choose a tone",
      options: [{ id: "extension_tone_a", label: "Option A", value: "Mari found teh key." }],
    },
  });
  expect(variable.ok()).toBeTruthy();
  try {
    await seedApp(page);
    await page.evaluate(async (presetId) => {
      const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
      useUIStore.getState().openPresetDetail(presetId);
    }, preset.id);
    const sections = page.locator('.mari-editor-shell [data-editor-section="sections"]');
    await sections.getByText("EXTENSION_TONE", { exact: true }).click();
    await sections.getByRole("button", { name: "Expand value editor", exact: true }).click();
    const heading = page.getByRole("heading", { name: "Edit Value: Option A", exact: true });
    const fieldSelector = 'textarea[placeholder^="Prompt content"]';
    const field = page.locator(fieldSelector);
    await expect(field).toHaveValue("Mari found teh key.");
    // The editor focuses its field shortly after opening; wait for it so that cannot take focus from the card.
    await expect(field).toBeFocused();

    const accept = await addExtensionCard(page, "html", fieldSelector);
    await accept.click();
    await expect(field).toHaveValue("Mari found the key.");
    await accept.focus();
    await page.keyboard.press("Escape");
    await expect(heading).toBeVisible();

    // Escape in the editor itself still closes it, and the edit is kept.
    await field.press("Escape");
    await expect(heading).toHaveCount(0);
    await expect
      .poll(async () => {
        const [block] = (await (await request.get(`/api/prompts/${preset.id}/variables`)).json()) as Array<{
          options: string | Array<{ value: string }>;
        }>;
        const options = typeof block?.options === "string" ? JSON.parse(block.options) : block?.options;
        return options?.[0]?.value;
      })
      .toBe("Mari found the key.");
  } finally {
    await request.delete(`/api/prompts/${preset.id}`);
  }
});
