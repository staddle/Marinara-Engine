import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { TacticalCombatState, TacticalTerrain } from "../packages/shared/src/index.js";
import { seedUIState } from "./ui-state-fixture.js";

// Individual initiative on the tactical board (combat C6c): a game set to take turns one unit at a time
// shows the order along the top with the current unit marked, names whose turn it is, and lets only that
// unit be chosen. A game by side shows no order.

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const party = [
  {
    id: "turn-scout",
    name: "Turn Scout",
    hp: 30,
    maxHp: 30,
    attack: 8,
    defense: 5,
    speed: 7,
    level: 1,
    side: "player" as const,
  },
  {
    id: "turn-guard",
    name: "Turn Guard",
    hp: 30,
    maxHp: 30,
    attack: 8,
    defense: 5,
    speed: 7,
    level: 1,
    side: "player" as const,
  },
];
const enemies = [
  {
    id: "turn-raider",
    name: "Turn Raider",
    hp: 30,
    maxHp: 30,
    attack: 6,
    defense: 4,
    speed: 4,
    level: 1,
    side: "enemy" as const,
  },
];

async function openGame(page: Page, chatId: string, testInfo: TestInfo) {
  await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    chatHelpSeenModes: ["game"],
    gameInstantTextReveal: true,
    theme: testInfo.project.name === "desktop-chromium" ? "light" : "dark",
  });
  await page.addInitScript(
    ({ id, version }) => {
      localStorage.setItem("marinara-active-chat-id", id);
      localStorage.setItem("marinara:whats-new:seen-version", version);
    },
    { id: chatId, version },
  );
  await page.goto("/");
}

for (const turnOrder of ["initiative", "side"] as const) {
  test(`the board ${turnOrder === "initiative" ? "shows the order and lets only the current unit act" : "by side shows no order"}`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    let chatId: string | undefined;
    try {
      const created = await request.post("/api/game/create", {
        data: {
          name: `Turns ${turnOrder}`,
          setupConfig: {
            genre: "Fantasy",
            setting: "A ruined gate",
            tone: "Adventure",
            difficulty: "normal",
            playerGoals: "Hold the gate",
            gmMode: "standalone",
            rating: "sfw",
            partyCharacterIds: [],
            combatStyle: "tactical",
            tacticalBattlefield: { seed: 7, size: "small" },
            tacticalTurnOrder: turnOrder,
          },
        },
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      chatId = (await created.json()).sessionChat.id as string;
      const started = await request.post("/api/game/combat/tactical/start", {
        data: { chatId, party, enemies, environment: "ruins", formation: "line" },
      });
      expect(started.ok(), await started.text()).toBeTruthy();
      const state = (await started.json()).state as TacticalCombatState;
      if (turnOrder === "initiative") {
        // The order is the server's own roll; write the one this test reads, everybody's turn still to come.
        expect([...state.initiative!.order].sort()).toEqual(["turn-guard", "turn-raider", "turn-scout"]);
        state.initiative = { order: ["turn-guard", "turn-scout", "turn-raider"] };
        for (const unit of state.units) unit.hasActed = false;
        state.phase = "player";
      } else {
        expect(state.initiative).toBeUndefined();
      }
      state.grid.tiles = state.grid.tiles.map((row) => row.map(() => "plains" as TacticalTerrain));
      // A bare board is level ground too: clear the generated foothills (combat C6b).
      delete state.grid.elevation;
      const message = await request.post(`/api/chats/${chatId}/messages`, {
        data: { role: "assistant", content: "The raider waits at the gate. [state: combat]" },
      });
      expect(message.ok(), await message.text()).toBeTruthy();
      const patched = await request.patch(`/api/chats/${chatId}/metadata`, {
        data: {
          gameSessionStatus: "active",
          gameIntroPresented: true,
          gameActiveState: "combat",
          gameImageAutoGenerationEnabled: false,
          gameStoryboardAutoIllustrationsEnabled: false,
          gameCombatStyle: "tactical",
          gameCombatState: {
            party,
            enemies,
            startMessageId: (await message.json()).id,
            combatStyle: "tactical",
            sceneEnvironmentType: "ruins",
            formation: "line",
          },
          gameTacticalCombatSnapshot: state,
        },
      });
      expect(patched.ok(), await patched.text()).toBeTruthy();

      await openGame(page, chatId, testInfo);
      const battle = page.locator('[data-component="TacticalCombatUI"]');
      const order = battle.getByRole("list", { name: "Turn order" });
      if (turnOrder === "side") {
        await expect(battle.getByText("Player Phase")).toBeVisible({ timeout: 40_000 });
        await expect(order).toHaveCount(0);
        return;
      }
      await expect(order).toBeVisible({ timeout: 40_000 });
      await expect(order.getByRole("listitem")).toHaveText(["Turn Guard", "Turn Scout", "Turn Raider"]);
      await expect(order.locator('[aria-current="step"]')).toHaveText("Turn Guard");
      await expect(battle.getByText("Turn Guard's turn")).toBeVisible();
      // Nothing of the game's own floats over the order: the map, the party and the menu sit below it.
      const strip = (await order.boundingBox())!;
      for (const float of await page.locator("[data-game-float]").all()) {
        for (const child of await float.locator(":scope > *").all()) {
          const box = await child.boundingBox();
          if (!box || box.width === 0 || box.height === 0) continue;
          const overlaps =
            box.x < strip.x + strip.width &&
            strip.x < box.x + box.width &&
            box.y < strip.y + strip.height &&
            strip.y < box.y + box.height;
          expect(overlaps, `${await float.getAttribute("data-game-float")} covers the turn order`).toBe(false);
        }
      }
      // The scout's turn has not come: choosing it opens nothing; choosing the guard opens its menu.
      await battle
        .getByRole("button", { name: /^Turn Scout/ })
        .first()
        .click();
      await expect(battle.getByRole("button", { name: "Wait", exact: true })).toHaveCount(0);
      await battle
        .getByRole("button", { name: /^Turn Guard/ })
        .first()
        .click();
      await expect(battle.getByRole("button", { name: "Wait", exact: true })).toBeVisible();
    } finally {
      if (chatId) await request.delete(`/api/chats/${chatId}?force=true`).catch(() => undefined);
    }
  });
}

test("a fight by initiative plays out the turns taken before the party's first", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  let chatId: string | undefined;
  try {
    const created = await request.post("/api/game/create", {
      data: {
        name: "Turns opening",
        setupConfig: {
          genre: "Fantasy",
          setting: "A ruined gate",
          tone: "Adventure",
          difficulty: "normal",
          playerGoals: "Hold the gate",
          gmMode: "standalone",
          rating: "sfw",
          partyCharacterIds: [],
          combatStyle: "tactical",
          tacticalBattlefield: { seed: 1, size: "small" },
          tacticalTurnOrder: "initiative",
        },
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    chatId = (await created.json()).sessionChat.id as string;
    const message = await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "assistant", content: "The raider charges the gate. [state: combat]" },
    });
    expect(message.ok(), await message.text()).toBeTruthy();
    // No saved board: the screen starts the fight itself, as a GM's [combat] does.
    const patched = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameActiveState: "combat",
        gameImageAutoGenerationEnabled: false,
        gameStoryboardAutoIllustrationsEnabled: false,
        gameCombatStyle: "tactical",
        gameCombatState: {
          party,
          // A raider this fast rolls ahead of everybody whatever the dice: a d20 plus a fifth of 100.
          enemies: [{ ...enemies[0], speed: 100 }],
          startMessageId: (await message.json()).id,
          combatStyle: "tactical",
          sceneEnvironmentType: "ruins",
          formation: "line",
        },
      },
    });
    expect(patched.ok(), await patched.text()).toBeTruthy();
    // The opening can finish playing before a locator looks, so the page notes whether it was ever shown.
    await page.addInitScript(() => {
      const seen = window as unknown as { sawResolving?: boolean };
      new MutationObserver(() => {
        if (seen.sawResolving) return;
        const battle = document.querySelector('[data-component="TacticalCombatUI"]');
        if (battle?.textContent?.includes("Resolving")) seen.sawResolving = true;
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    const started = page.waitForResponse((response) => response.url().endsWith("/api/game/combat/tactical/start"));
    await openGame(page, chatId, testInfo);
    const body = await (await started).json();
    expect(body.state.initiative.order[0]).toBe("turn-raider");
    expect(body.opening?.events.length).toBeGreaterThan(0);
    const battle = page.locator('[data-component="TacticalCombatUI"]');
    // The raider's turn is played on the board, then it is a party unit's.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { sawResolving?: boolean }).sawResolving === true), {
        timeout: 40_000,
      })
      .toBe(true);
    await expect(battle.getByText("Resolving")).toHaveCount(0, { timeout: 20_000 });
    await expect(battle.getByText(/^Turn (Scout|Guard)'s turn$/)).toBeVisible();
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}?force=true`).catch(() => undefined);
  }
});
