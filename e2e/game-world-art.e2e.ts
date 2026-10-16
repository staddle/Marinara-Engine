import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { WORLD_STARTER_KITS, parseWorldKit } from "@marinara-engine/shared";
import { openGame } from "./game-ruleset-fight-fixture.js";
import { seedUIState } from "./ui-state-fixture.js";

/**
 * A setting's art and music (worldgen W6f), on screen. A cyberpunk fight makes none of the bundled
 * fantasy sounds while a game without a setting kit still does, and the Game Assets panel names the
 * open game's family.
 */

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const fighter = (id: string, side: "player" | "enemy") => ({
  id,
  name: id,
  side,
  hp: 30,
  maxHp: 30,
  attack: 5,
  defense: 5,
  speed: 5,
  level: 1,
  skills: [],
});

/** A game, with the setting kit named or none, in a classic fight. */
async function classicFight(request: APIRequestContext, kitId?: string): Promise<string> {
  const kit = kitId ? parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === kitId)!) : null;
  if (kit && !kit.ok) throw new Error(kit.issues.join("; "));
  const created = await request.post("/api/game/create", {
    data: {
      name: "Sounds",
      setupConfig: {
        ...(kit?.ok ? { worldKit: kit.kit } : {}),
        genre: "Cyberpunk",
        setting: "A megacity",
        tone: "Gritty",
        difficulty: "normal",
        playerGoals: "Get the data",
        gmMode: "standalone",
        rating: "sfw",
        partyCharacterIds: [],
        combatStyle: "classic",
        combatDirector: false,
        gmBossControl: false,
      },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const chatId = (await created.json()).sessionChat.id as string;
  const message = await request.post(`/api/chats/${chatId}/messages`, {
    data: { role: "assistant", content: "The crew draws on you. [state: combat]" },
  });
  expect(message.ok()).toBeTruthy();
  const patched = await request.patch(`/api/chats/${chatId}/metadata`, {
    data: {
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameActiveState: "combat",
      gameImageAutoGenerationEnabled: false,
      gameStoryboardAutoIllustrationsEnabled: false,
      gameCombatStyle: "classic",
      gameCombatState: {
        party: [fighter("Hero", "player")],
        enemies: [fighter("Fixer", "enemy")],
        itemEffects: [],
        mechanics: [],
        dialogueCues: [],
        startMessageId: (await message.json()).id,
        combatStyle: "classic",
      },
    },
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  return chatId;
}

/** Defends once, and returns the sound files the screen asked for. */
async function defendSounds(page: Page, chatId: string): Promise<string[]> {
  const sounds: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/sfx/")) sounds.push(request.url());
  });
  await openGame(page, chatId);
  await page.getByRole("button", { name: "Defend", exact: true }).first().click({ timeout: 40_000 });
  // The interface's own sound is shared, so it plays in every game: the screen did ask for sounds.
  await expect.poll(() => sounds.some((url) => url.includes("menu-confirm")), { timeout: 15_000 }).toBe(true);
  // The defend sound is asked for in the same moment; a beat more covers a slow request.
  await page.waitForTimeout(1_000);
  return sounds;
}

test("a game without a setting kit still defends to the bundled chainmail sound", async ({ page, request }) => {
  test.setTimeout(120_000);
  const chatId = await classicFight(request);
  try {
    expect((await defendSounds(page, chatId)).some((url) => url.includes("chainmail"))).toBe(true);
  } finally {
    await request.delete(`/api/chats/${chatId}`);
  }
});

test("a cyberpunk fight makes none of the bundled fantasy sounds", async ({ page, request }) => {
  test.setTimeout(120_000);
  const chatId = await classicFight(request, "cyberpunk");
  try {
    expect((await defendSounds(page, chatId)).some((url) => url.includes("chainmail"))).toBe(false);
  } finally {
    await request.delete(`/api/chats/${chatId}`);
  }
});

test("the Game Assets panel names the open game's setting family", async ({ page, request }) => {
  test.setTimeout(120_000);
  const chatId = await classicFight(request, "space_opera");
  try {
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["game"],
      gameInstantTextReveal: true,
      weatherEffects: false,
      gameAssetsBrowserOpen: true,
    });
    await page.addInitScript(
      ({ id, appVersion }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", appVersion);
      },
      { id: chatId, appVersion: version },
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Select assets for this game" }).click({ timeout: 40_000 });
    await expect(page.getByText("This game's setting uses the scifi folders", { exact: false })).toBeVisible();
  } finally {
    await request.delete(`/api/chats/${chatId}`);
  }
});

/** A game, with the setting kit named or none, exploring a scene whose background matches no file. */
async function sceneWithoutBackground(request: APIRequestContext, kitId?: string): Promise<string> {
  const kit = kitId ? parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === kitId)!) : null;
  if (kit && !kit.ok) throw new Error(kit.issues.join("; "));
  const created = await request.post("/api/game/create", {
    data: {
      name: "Scenery",
      setupConfig: {
        ...(kit?.ok ? { worldKit: kit.kit } : {}),
        genre: "Cyberpunk",
        setting: "A megacity",
        tone: "Gritty",
        difficulty: "normal",
        playerGoals: "Get the data",
        gmMode: "standalone",
        rating: "sfw",
        partyCharacterIds: [],
        combatStyle: "classic",
        combatDirector: false,
        gmBossControl: false,
      },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const chatId = (await created.json()).sessionChat.id as string;
  const message = await request.post(`/api/chats/${chatId}/messages`, {
    data: { role: "assistant", content: "You step into a glade of old light." },
  });
  expect(message.ok()).toBeTruthy();
  const patched = await request.patch(`/api/chats/${chatId}/metadata`, {
    data: {
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameActiveState: "exploration",
      gameImageAutoGenerationEnabled: false,
      gameStoryboardAutoIllustrationsEnabled: false,
      enableAgents: true,
      gameSceneBackground: "enchanted glade",
    },
  });
  expect(patched.ok(), await patched.text()).toBeTruthy();
  return chatId;
}

const shownBackgrounds = (page: Page) =>
  page.evaluate(() => document.documentElement.outerHTML.match(/\/backgrounds\/[^"')\s&]+/g) ?? []);

test("a game without a setting kit falls back to the bundled enchanted forest for a glade", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const chatId = await sceneWithoutBackground(request);
  try {
    await openGame(page, chatId);
    await expect
      .poll(async () => (await shownBackgrounds(page)).some((url) => url.includes("enchanted_forest")), {
        timeout: 40_000,
      })
      .toBe(true);
  } finally {
    await request.delete(`/api/chats/${chatId}`);
  }
});

test("a cyberpunk game never falls back to the bundled fantasy backgrounds", async ({ page, request }) => {
  test.setTimeout(120_000);
  const chatId = await sceneWithoutBackground(request, "cyberpunk");
  try {
    await openGame(page, chatId);
    // It still shows a background, just never a fantasy one.
    await expect.poll(async () => (await shownBackgrounds(page)).length, { timeout: 40_000 }).toBeGreaterThan(0);
    const shown = await shownBackgrounds(page);
    for (const fantasy of ["enchanted_forest", "castle_cliff", "ancient_library"]) {
      expect(
        shown.some((url) => url.includes(fantasy)),
        fantasy,
      ).toBe(false);
    }
  } finally {
    await request.delete(`/api/chats/${chatId}`);
  }
});
