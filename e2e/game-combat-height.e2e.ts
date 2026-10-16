import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { TacticalCombatState, TacticalTerrain } from "../packages/shared/src/index.js";
import { seedUIState } from "./ui-state-fixture.js";

// Height on the tactical board (combat C6b): raised ground is drawn and said, its height in the tile's
// own description and the inspector; a foe two cells off the archer's range is a target only from above.

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

for (const raised of [false, true]) {
  test(`raised ground is said, and a shot carries further from it: ${raised ? "from above" : "level"}`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    let chatId: string | undefined;
    try {
      const created = await request.post("/api/game/create", {
        data: {
          name: `Height ${raised ? "raised" : "level"}`,
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
      // A bare board, the caster on a two-level rise (or not) three cells from the guard, with a range of 2.
      state.grid.tiles = state.grid.tiles.map((row) => row.map(() => "plains" as TacticalTerrain));
      state.grid.elevation = state.grid.tiles.map((row, y) => row.map((_, x) => (raised && y === 2 && x <= 1 ? 2 : 0)));
      for (const unit of state.units) {
        Object.assign(
          unit,
          unit.side === "party" ? { x: 1, y: 2, attackRange: { min: 1, max: 2 }, hasMoved: true } : { x: 4, y: 2 },
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
      // The tile beside the caster says its height, or nothing about one on level ground.
      const tile = battle.getByRole("button", { name: /^Plains, (height 2, )?row 3, column 1$/ });
      await expect(tile).toHaveAccessibleName(
        raised ? "Plains, height 2, row 3, column 1" : "Plains, row 3, column 1",
        {
          timeout: 40_000,
        },
      );
      await battle
        .getByRole("button", { name: /Sight Caster/ })
        .first()
        .click();
      const attack = battle.getByRole("button", { name: "Attack", exact: true });
      if (raised) await expect(attack).toBeVisible();
      else await expect(attack).toHaveCount(0);
    } finally {
      if (chatId) await request.delete(`/api/chats/${chatId}?force=true`).catch(() => undefined);
    }
  });
}
