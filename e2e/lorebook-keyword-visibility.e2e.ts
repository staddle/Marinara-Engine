import { test, expect, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const keywords = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => prefix + "-" + (index + 1));

for (const surface of ["library", "chat settings"] as const) {
  test(surface + " keyword disclosure preserves drafts and all saved keys", async ({ page, request }, info) => {
    const chatResponse = await request.post("/api/chats", {
      data: { name: "Keyword disclosure " + info.project.name, mode: "conversation", characterIds: [] },
    });
    expect(chatResponse.ok()).toBeTruthy();
    const chat = await chatResponse.json();
    const bookResponse = await request.post("/api/lorebooks", {
      data: { name: "Keyword disclosure " + surface, scope: { mode: "specific", chatIds: [chat.id] } },
    });
    expect(bookResponse.ok()).toBeTruthy();
    const book = await bookResponse.json();
    const mobile = info.project.name !== "desktop-chromium";
    const previousFocus = info.project.name === "mobile-webkit" ? "Alt+Shift+Tab" : "Shift+Tab";
    const nextFocus = info.project.name === "mobile-webkit" ? "Alt+Tab" : "Tab";
    const activate = (control: Locator) => (mobile ? control.tap() : control.click());
    const entries: Array<{ id: string; count: number }> = [];
    try {
      const metadataResponse = await request.patch("/api/chats/" + chat.id + "/metadata", {
        data: { activeLorebookIds: [book.id] },
      });
      expect(metadataResponse.ok()).toBeTruthy();
      for (const count of [0, 10, 11]) {
        const response = await request.post("/api/lorebooks/" + book.id + "/entries", {
          data: {
            name: "Boundary " + count,
            keys: keywords("primary", count),
            secondaryKeys: keywords("secondary", count),
          },
        });
        expect(response.ok()).toBeTruthy();
        entries.push({ id: (await response.json()).id, count });
      }
      const messageResponse = await request.post("/api/chats/" + chat.id + "/messages", {
        data: { role: "assistant", content: "Keyword editing fixture." },
      });
      expect(messageResponse.ok()).toBeTruthy();
      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        sidebarOpen: false,
        rightPanelOpen: false,
        chatHelpSeenModes: ["conversation"],
        theme: info.project.name === "desktop-chromium" ? "light" : "dark",
      });
      await page.addInitScript(
        ({ chatId, version }) => {
          localStorage.setItem("marinara-active-chat-id", chatId);
          localStorage.setItem("marinara:whats-new:seen-version", version);
        },
        { chatId: chat.id, version },
      );
      const openSurface = async () => {
        if (surface === "library") {
          await page.evaluate(async (id) => {
            const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
            useUIStore.getState().openLorebookDetail(id);
          }, book.id);
        } else {
          await page.getByRole("button", { name: "Chat Settings", exact: true }).filter({ visible: true }).click();
          const drawer = page.locator(".mari-chat-settings-drawer");
          await drawer.getByText("Lorebooks", { exact: true }).first().click();
          await drawer.getByRole("button", { name: "Edit lorebook entries", exact: true }).click();
        }
      };
      await page.goto("/");
      await openSurface();
      let patches = 0;
      page.on("request", (request) => {
        if (request.method() === "PATCH" && request.url().includes("/api/lorebooks/" + book.id + "/entries/")) {
          patches++;
        }
      });

      for (const entry of entries) {
        const row = page.locator('[data-lorebook-entry-row-id="' + entry.id + '"]');
        await row.getByRole("button", { name: "Expand entry", exact: true }).click();
        for (const label of ["Primary Keys", "Secondary Keys"]) {
          const field = row.getByText(label, { exact: true }).locator("..");
          await expect(field.locator(".mari-editor-chip")).toHaveCount(Math.min(entry.count, 10));
          await expect(field.locator("input")).toBeVisible();
          const toggle = field.getByRole("button", { name: /^Show \d+ more$/ });
          if (entry.count > 10) {
            await expect(toggle).toHaveText("Show 1 more");
            await expect(toggle).toHaveAttribute("aria-expanded", "false");
            const controlledId = await toggle.getAttribute("aria-controls");
            await expect(field.locator('[id="' + controlledId + '"]')).toBeVisible();
          } else {
            await expect(toggle).toHaveCount(0);
          }
        }
        await expect(row.getByText("Logic:", { exact: true })).toBeVisible();
        if (entry.count === 10) {
          const primary = row.getByText("Primary Keys", { exact: true }).locator("..");
          await primary.locator("input").fill("eleventh-key");
          await primary.getByRole("button", { name: "Add", exact: true }).click();
          await expect(primary.locator(".mari-editor-chip")).toHaveCount(11);
          await expect(primary.getByRole("button", { name: "Collapse", exact: true })).toHaveAttribute(
            "aria-expanded",
            "true",
          );
          await expect
            .poll(async () => {
              const saved = await (await request.get("/api/lorebooks/" + book.id + "/entries")).json();
              return saved.find((candidate: { id: string }) => candidate.id === entry.id).keys;
            })
            .toEqual([...keywords("primary", 10), "eleventh-key"]);
        }
        await row.getByRole("button", { name: "Collapse entry", exact: true }).click();
      }
      patches = 0;
      const entry = entries.find((item) => item.count === 11)!;
      const row = page.locator('[data-lorebook-entry-row-id="' + entry.id + '"]');
      const primary = row.getByText("Primary Keys", { exact: true }).locator("..");
      const secondary = row.getByText("Secondary Keys", { exact: true }).locator("..");
      const input = primary.locator("input");
      const readEntry = async () =>
        (await (await request.get("/api/lorebooks/" + book.id + "/entries")).json()).find(
          (candidate: { id: string }) => candidate.id === entry.id,
        );
      await row.getByRole("button", { name: "Expand entry", exact: true }).click();
      await input.fill("new-primary");
      await activate(primary.getByRole("button", { name: "Show 1 more", exact: true }));
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("new-primary");
      await expect(primary.locator(".mari-editor-chip")).toHaveCount(11);
      await expect(secondary.locator(".mari-editor-chip")).toHaveCount(10);
      await expect(primary.getByRole("button", { name: "Collapse", exact: true })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await activate(primary.getByRole("button", { name: "Collapse", exact: true }));
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("new-primary");
      await expect(primary.locator(".mari-editor-chip")).toHaveCount(10);
      await page.waitForTimeout(1200);
      expect(patches).toBe(0);
      expect((await readEntry()).keys).toEqual(keywords("primary", 11));
      await activate(primary.getByRole("button", { name: "Show 1 more", exact: true }));

      // Keyboard blur commits the draft, even when navigation continues beyond the disclosure.
      await input.press(previousFocus);
      const collapse = primary.getByRole("button", { name: "Collapse", exact: true });
      await expect(collapse).toBeFocused();
      await expect(input).toHaveValue("");
      await collapse.press(previousFocus);
      await row.getByRole("button", { name: "Collapse entry", exact: true }).click();
      await expect.poll(async () => (await readEntry()).keys).toEqual([...keywords("primary", 11), "new-primary"]);
      await row.getByRole("button", { name: "Expand entry", exact: true }).click();
      await activate(primary.getByRole("button", { name: "Show 2 more", exact: true }));
      await expect(primary.locator(".mari-editor-chip")).toHaveCount(12);
      await collapse.focus();
      await collapse.press("Space");
      await expect(primary.locator(".mari-editor-chip")).toHaveCount(10);
      await primary.getByRole("button", { name: "Show 2 more", exact: true }).press("Enter");
      await expect(primary.locator(".mari-editor-chip")).toHaveCount(12);
      await secondary.locator("input").fill("new-secondary");
      // Ordinary blur toward Add retains the existing auto-add behavior.
      await secondary.locator("input").press(nextFocus);
      await expect(secondary.locator(".mari-editor-chip")).toHaveCount(12);
      await expect
        .poll(async () => (await readEntry()).secondaryKeys)
        .toEqual([...keywords("secondary", 11), "new-secondary"]);
      await primary.getByRole("button", { name: "Collapse", exact: true }).click();
      await input.fill("primary-2");
      await input.press("Enter");
      await expect(input).toHaveValue("");
      await expect(primary.locator(".mari-editor-chip")).toHaveCount(10);
      // Removing a visible key while collapsed must preserve the hidden suffix.
      await primary.locator(".mari-editor-chip").first().getByRole("button").click();
      const remaining = [...keywords("primary", 11).slice(1), "new-primary"];
      await expect.poll(async () => (await readEntry()).keys).toEqual(remaining);
      await activate(primary.getByRole("button", { name: "Show 1 more", exact: true }));
      await primary.locator(".mari-editor-chip").filter({ hasText: "new-primary" }).getByRole("button").click();
      await expect(primary.locator(".mari-editor-chip")).toHaveCount(10);
      await expect(primary.getByRole("button", { name: "Collapse", exact: true })).toHaveCount(0);
      await expect.poll(async () => (await readEntry()).keys).toEqual(keywords("primary", 11).slice(1));

      await row.getByRole("button", { name: "Collapse entry", exact: true }).click();
      await row.getByRole("button", { name: "Expand entry", exact: true }).click();
      await expect(primary.locator(".mari-editor-chip")).toHaveCount(10);
      await expect(secondary.getByRole("button", { name: "Show 2 more", exact: true })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await page.reload();
      await openSurface();
      await row.getByRole("button", { name: "Expand entry", exact: true }).click();
      await secondary.getByRole("button", { name: "Show 2 more", exact: true }).click();
      await expect(secondary.locator(".mari-editor-chip")).toHaveCount(12);
      expect((await readEntry()).keys).toEqual(keywords("primary", 11).slice(1));
      expect((await readEntry()).secondaryKeys).toEqual([...keywords("secondary", 11), "new-secondary"]);
    } finally {
      await page.close();
      await request.delete("/api/lorebooks/" + book.id);
      await request.delete("/api/chats/" + chat.id);
    }
  });
}
