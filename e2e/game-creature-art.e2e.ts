import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import type { TacticalCombatState, TacticalTerrain } from "../packages/shared/src/index.js";
import { seedUIState } from "./ui-state-fixture.js";

// Creature art on the tactical board (design-game-creature-art.md): with a creature pack chosen, an enemy
// the pack has ("Goblin 2" is a goblin) is drawn with its art, standing on its cell and facing a way; one it
// does not have keeps its token. Without a pack, every enemy keeps its token.

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** A small PNG sheet: one 48 x 96 creature block of 4 facings (a column), each facing its own colour. */
function sheetPng(): string {
  const [width, height] = [48, 384];
  const colours = [
    [60, 160, 70],
    [60, 120, 200],
    [200, 120, 60],
    [160, 60, 160],
  ];
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    const [r, g, b] = colours[Math.floor(y / 96)]!;
    for (let x = 0; x < width; x++) {
      const at = y * (width * 4 + 1) + 1 + x * 4;
      const inside = x > 8 && x < 40 && y % 96 > 12;
      raw.set([r!, g!, b!, inside ? 255 : 0], at);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const pack = {
  creaturePackVersion: 1,
  id: "monsters",
  name: "Monsters",
  version: 1,
  tileSize: 48,
  sheets: [{ id: "s1", png: sheetPng(), width: 48, height: 384 }],
  creatures: [
    {
      id: "goblin",
      match: ["goblin"],
      size: "small",
      w: 1,
      h: 2,
      frames: 1,
      variants: [{ sheet: "s1", x: 0, y: 0 }],
    },
  ],
};

const party = [
  {
    id: "art-scout",
    name: "Art Scout",
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
    id: "art-goblin",
    name: "Goblin 2",
    hp: 20,
    maxHp: 20,
    attack: 6,
    defense: 4,
    speed: 4,
    level: 1,
    side: "enemy" as const,
  },
  {
    id: "art-skeleton",
    name: "Skeleton",
    hp: 20,
    maxHp: 20,
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

for (const chosen of [true, false]) {
  test(`creature art ${chosen ? "stands in for a token the pack has" : "is never drawn without a pack"}`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(120_000);
    let chatId: string | undefined;
    try {
      // The library's creature pack (Pixelforge's storage): the route answered here.
      await page.route("**/api/game-tile-packs/creatures", (route) =>
        route.fulfill({ json: { pack: chosen ? pack : null } }),
      );
      const created = await request.post("/api/game/create", {
        data: {
          name: "Creature art",
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
      state.grid.tiles = state.grid.tiles.map((row) => row.map(() => "plains" as TacticalTerrain));
      delete state.grid.elevation;
      state.phase = "player";
      for (const unit of state.units) {
        unit.hasActed = false;
        unit.sprite = "";
      }
      const message = await request.post(`/api/chats/${chatId}/messages`, {
        data: { role: "assistant", content: "A goblin and a skeleton bar the gate. [state: combat]" },
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
      await expect(battle.getByRole("button", { name: /^Goblin 2/ }).first()).toBeVisible({ timeout: 40_000 });
      const goblinArt = battle.locator('[data-creature-art="goblin"]');
      if (!chosen) {
        await expect(battle.locator("[data-creature-art]")).toHaveCount(0);
        await expect(battle.getByRole("button", { name: /^Goblin 2/ }).first()).toContainText("G2");
        return;
      }
      await expect(goblinArt).toHaveCount(1);
      await expect(goblinArt).toHaveAttribute("data-facing", /^(down|left|right|up)$/u);
      await expect(goblinArt).toHaveAttribute("aria-label", "Goblin 2");
      // Standing on its cell and a cell taller than it (a 1 x 2 frame).
      const box = (await goblinArt.boundingBox())!;
      const token = (await battle
        .getByRole("button", { name: /^Goblin 2/ })
        .first()
        .boundingBox())!;
      expect(box.height).toBeGreaterThan(box.width * 1.8);
      expect(box.x + box.width / 2).toBeCloseTo(token.x + token.width / 2, 0);
      // The skeleton has no art: its token.
      await expect(battle.getByRole("button", { name: /^Skeleton/ }).first()).toContainText("SK");
      await page.screenshot({ path: testInfo.outputPath("creature-art.png") });
    } finally {
      if (chatId) await request.delete(`/api/chats/${chatId}?force=true`).catch(() => undefined);
    }
  });
}
