import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { TacticalCombatState, TacticalTerrain } from "../packages/shared/src/index.js";
import { seedUIState } from "./ui-state-fixture.js";

// Line of sight on the tactical board (combat C6): the board offers a skill only the targets the
// server will accept, so a foe behind a wall is not highlighted, while the same foe in the open is.

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const party = [
  {
    id: "sight-caster",
    name: "Sight Caster",
    hp: 30,
    maxHp: 30,
    mp: 30,
    maxMp: 30,
    attack: 8,
    defense: 5,
    speed: 7,
    level: 1,
    side: "player" as const,
    skills: [{ id: "bolt", name: "Bolt", mpCost: 5, power: 1, type: "attack" as const, range: 5 }],
  },
];

const enemies = [
  {
    id: "sight-guard",
    name: "Sight Guard",
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

for (const walled of [false, true]) {
  test(`a skill highlights a foe ${walled ? "behind a wall: none" : "in the open"}`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    let chatId: string | undefined;
    try {
      const created = await request.post("/api/game/create", {
        data: {
          name: `Sight ${walled ? "walled" : "open"}`,
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
      // A bare board: the caster three cells from the guard on one row, a wall between them or not.
      state.grid.tiles = state.grid.tiles.map((row) => row.map(() => "plains" as TacticalTerrain));
      // A bare board is level ground too: clear the generated foothills (combat C6b).
      delete state.grid.elevation;
      if (walled) state.grid.tiles[2]![2] = "wall";
      for (const unit of state.units) {
        Object.assign(
          unit,
          unit.side === "party" ? { x: 1, y: 2, attackRange: { min: 1, max: 1 }, hasMoved: true } : { x: 4, y: 2 },
        );
      }
      const message = await request.post(`/api/chats/${chatId}/messages`, {
        data: { role: "assistant", content: "The guard waits at the gate. [state: combat]" },
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
      await battle
        .getByRole("button", { name: /Sight Caster/ })
        .first()
        .click({ timeout: 40_000 });
      await battle.getByRole("button", { name: "Skills", exact: true }).click();
      await battle.getByRole("button", { name: /Bolt/ }).click();
      const none = battle.getByText(/^No targets in range/);
      if (walled) await expect(none).toBeVisible();
      else {
        await expect(battle.getByText("Select a target", { exact: false }).first()).toBeVisible();
        await expect(none).toHaveCount(0);
      }
    } finally {
      if (chatId) await request.delete(`/api/chats/${chatId}?force=true`).catch(() => undefined);
    }
  });
}
