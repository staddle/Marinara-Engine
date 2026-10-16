import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

// Load More and Show older follow the chat style switches like every other chat control (#7561).
const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
// 95 messages at 45 per page: one Load More leaves one more page, and 90 loaded passes the 80-message render window.
const PAGE_SIZE = 45;
const MESSAGE_COUNT = 95;
const GRADIENTS = {
  background: "linear-gradient(135deg, #667eea, #764ba2)",
  border: "linear-gradient(90deg, #ff6b6b, #ffd93d)",
  text: "linear-gradient(90deg, #6c5ce7, #00cec9)",
};
type Axis = "font" | "shape" | "colors";

async function createFixture(request: APIRequestContext) {
  const chats: { id: string; mode: "roleplay" | "conversation" }[] = [];
  const response = await request.post("/api/characters", { data: { data: { name: "Pager guide" } } });
  expect(response.ok()).toBeTruthy();
  const characterId = ((await response.json()) as { id: string }).id;
  const remove = async () => {
    for (const chat of chats) await request.delete(`/api/chats/${chat.id}?force=true`);
    await request.delete(`/api/characters/${characterId}`);
  };
  try {
    for (const mode of ["roleplay", "conversation"] as const) {
      const created = await request.post("/api/chats", {
        data: { name: `History pager ${mode}`, mode, characterIds: [characterId] },
      });
      expect(created.ok()).toBeTruthy();
      const chat = { id: ((await created.json()) as { id: string }).id, mode };
      chats.push(chat);
      expect(
        (
          await request.patch(`/api/chats/${chat.id}/metadata`, {
            data: {
              windowLayout: null,
              chatSettingsHintDismissed: true,
              enableAgents: false,
              conversationSetupComplete: true,
              roleplayDisplayStyle: "classic",
            },
          })
        ).ok(),
      ).toBeTruthy();
      for (let index = 0; index < MESSAGE_COUNT; index += 1) {
        const message = await request.post(`/api/chats/${chat.id}/messages`, {
          data:
            index % 2
              ? { role: "user", content: `Pager line ${index + 1}.` }
              : { role: "assistant", characterId, content: `Pager line ${index + 1}.` },
        });
        expect(message.ok()).toBeTruthy();
      }
    }
    return { chats, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

async function appearance(target: Locator) {
  return target.evaluate(async (element) => {
    getComputedStyle(element).backgroundColor;
    await Promise.all(
      element
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    const host = getComputedStyle(element);
    const after = getComputedStyle(element, "::after");
    const fill = after.content !== "none" && after.clipPath.includes("polygon") ? after : host;
    return {
      background: fill.backgroundColor,
      image: fill.backgroundImage,
      color: host.color,
      font: host.fontFamily,
      radius: host.borderRadius,
      clip: after.clipPath,
    };
  });
}

// The keyboard focus ring's colour (#7572). The pagers sit on the open chat, so a faint ring would vanish there.
// Call it after the font step reads the composer: on a phone, focus in the chat folds that composer away.
async function focusRing(page: Page, target: Locator) {
  await target.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect.poll(() => target.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  const ring = await target.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    const shadow = getComputedStyle(element).boxShadow;
    (element as HTMLElement).blur();
    return shadow;
  });
  expect(ring).toMatch(/ 0px 0px 0px [\d.]+px$/);
  return ring.replace(/ 0px 0px 0px [\d.]+px$/, "");
}

async function resolvedStyle(page: Page, property: string, value: string) {
  return page.evaluate(
    ({ property, value }) => {
      const probe = document.createElement("span");
      probe.style.setProperty(property, value);
      document.body.append(probe);
      const resolved = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return resolved;
    },
    { property, value },
  );
}

async function setStyle(page: Page, preset: "default" | "dottore" | "mari", axes: Axis[], colors = false) {
  await page.evaluate(
    async ({ preset, axes, colors, gradients }) => {
      const { useUIStore } = await import("/src/stores/ui.store.ts" as string);
      const ui = useUIStore.getState();
      ui.setChatWidgetPreset(preset);
      ui.setChatWidgetApplyFont(axes.includes("font"));
      ui.setChatWidgetApplyShape(axes.includes("shape"));
      ui.setChatWidgetApplyColors(axes.includes("colors"));
      ui.setChatWidgetBackgroundColor(colors ? gradients.background : "");
      ui.setChatWidgetBorderColor(colors ? gradients.border : "");
      ui.setChatWidgetTextColor(colors ? gradients.text : "");
    },
    { preset, axes, colors, gradients: GRADIENTS },
  );
  const html = page.locator("html");
  for (const axis of ["font", "shape", "colors"] as const) {
    if (axes.includes(axis)) await expect(html).toHaveAttribute(`data-chat-widget-apply-${axis}`, "true");
    else await expect(html).not.toHaveAttribute(`data-chat-widget-apply-${axis}`);
  }
  if (colors) await expect(html).toHaveAttribute("data-chat-widget-colors", /background/);
  else await expect(html).not.toHaveAttribute("data-chat-widget-colors");
  // Leave hover to the checks that ask for it.
  await page.mouse.move(1, 1);
}

for (const [preset, theme] of [
  ["dottore", "dark"],
  ["mari", "light"],
] as const) {
  test(`Load More and Show older follow ${preset} chat styling in ${theme} mode`, async ({
    page,
    request,
    isMobile,
  }, info) => {
    test.setTimeout(180_000);
    const fixture = await createFixture(request);
    try {
      await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
      await seedUIState(page, {
        hasCompletedOnboarding: true,
        sidebarOpen: false,
        rightPanelOpen: false,
        chatHelpSeenModes: ["conversation", "roleplay", "game"],
        appAccentPulseMode: false,
        appAccentRgbMode: false,
        // A gradient accent repaints chrome controls; the preset must still win on hover.
        appAccentColor: "linear-gradient(90deg, #ff0000, #0000ff)",
        messagesPerPage: PAGE_SIZE,
        theme,
        chatWidgetApplyFont: false,
        chatWidgetApplyShape: false,
        chatWidgetApplyColors: false,
      });
      await page.addInitScript(
        ({ id, version }) => {
          localStorage.setItem("marinara-active-chat-id", id);
          localStorage.setItem("marinara:whats-new:seen-version", version);
        },
        { id: fixture.chats[0]!.id, version: APP_VERSION },
      );
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-marinara-chat-chrome-accent-mode", "gradient");
      let reference: Awaited<ReturnType<typeof appearance>> | undefined;
      for (const chat of fixture.chats) {
        await test.step(chat.mode, async () => {
          await setStyle(page, "default", []);
          await page.evaluate(async (id) => {
            const { useChatStore } = await import("/src/stores/chat.store.ts" as string);
            useChatStore.getState().setActiveChatId(id);
          }, chat.id);
          const area = page.locator(`[data-chat-mode="${chat.mode}"]`);
          const loadMore = area.getByRole("button", { name: "Load More", exact: true });
          await loadMore.scrollIntoViewIfNeeded();
          await loadMore.click();
          const showOlder = area.getByRole("button", { name: /^Show older \(\d+\)$/ });
          const latest = area.getByRole("button", { name: "Latest", exact: true });
          // Roleplay reveals the page it loaded; Latest returns to the newest window.
          await expect(showOlder.or(latest)).toBeVisible();
          if (await latest.isVisible()) await latest.click();
          await expect(showOlder).toBeVisible();
          await expect(loadMore).toBeEnabled();
          const pagers = [loadMore, showOlder];

          const baseline = await appearance(loadMore);
          // Load More shares Show older's look, so the pair reads as one control set.
          expect(await appearance(showOlder)).toEqual(baseline);
          await setStyle(page, preset, []);
          for (const pager of pagers) expect(await appearance(pager)).toEqual(baseline);

          await setStyle(page, preset, ["font"]);
          const composer = area.locator("textarea[data-chat-composer]").first();
          const lettering = await composer.evaluate((element) => getComputedStyle(element).fontFamily);
          expect(lettering).not.toBe(baseline.font);
          for (const pager of pagers) expect(await appearance(pager)).toEqual({ ...baseline, font: lettering });

          await setStyle(page, preset, ["shape"]);
          for (const pager of pagers) {
            const shaped = await appearance(pager);
            expect(shaped.background).toBe(baseline.background);
            expect(shaped.color).toBe(baseline.color);
            if (preset === "dottore") expect(shaped.clip).toContain("polygon(");
            else expect(shaped.radius).not.toBe(baseline.radius);
          }

          await setStyle(page, preset, ["colors"]);
          const paint = await resolvedStyle(page, "background-color", "var(--mari-widget-bg)");
          const ink = await resolvedStyle(page, "color", "var(--mari-widget-accent)");
          for (const pager of pagers) {
            const colored = await appearance(pager);
            expect([colored.radius, colored.clip]).toEqual([baseline.radius, baseline.clip]);
            expect([colored.background, colored.color]).toEqual([paint, ink]);
          }
          expect(await focusRing(page, loadMore)).toBe(ink);
          if (!isMobile) {
            await loadMore.hover();
            await expect
              .poll(async () => (await appearance(loadMore)).background)
              .toBe(await resolvedStyle(page, "background-color", "var(--mari-widget-soft)"));
          }

          await setStyle(page, preset, ["font", "shape", "colors"]);
          const styled = await appearance(loadMore);
          expect(await appearance(showOlder)).toEqual(styled);
          if (reference) expect(styled).toEqual(reference);
          else reference = styled;
          await loadMore.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: info.outputPath(`history-pager-${preset}-${theme}-${chat.mode}.png`),
            animations: "disabled",
          });

          await setStyle(page, preset, ["font", "shape", "colors"], true);
          for (const pager of pagers) {
            const painted = await appearance(pager);
            expect(painted.image).toContain("102, 126, 234");
            await expect(pager.locator("svg")).toHaveCSS("color", "rgb(255, 107, 107)");
          }
          expect(await focusRing(page, loadMore)).toBe("rgb(255, 107, 107)");
          await loadMore.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: info.outputPath(`history-pager-${preset}-${theme}-${chat.mode}-custom.png`),
            animations: "disabled",
          });

          await setStyle(page, "default", []);
          for (const pager of pagers) expect(await appearance(pager)).toEqual(baseline);
          expect(await focusRing(page, loadMore)).toBe(
            await resolvedStyle(page, "color", "var(--marinara-chat-chrome-accent)"),
          );
        });
      }
    } finally {
      await page.close();
      await fixture.remove();
    }
  });
}
