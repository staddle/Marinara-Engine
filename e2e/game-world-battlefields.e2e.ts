import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { WORLD_GENERATOR_VERSION, WORLD_STARTER_KITS, checkWorldBrief, parseWorldKit } from "@marinara-engine/shared";
import { prepareViteFixtureDependencies } from "./vite-fixture-dependencies.js";
import { seedUIState } from "./ui-state-fixture.js";

/**
 * A battlefield painted for a world's place (worldgen W9g), on screen: a tactical fight that starts
 * where the party is, at that place, draws the board exactly as painted and names it, and a restart
 * keeps it.
 */

declare global {
  interface Window {
    __madeBattlefieldFixture?: { unmount: () => void };
  }
}

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
});
if (!read.ok) throw new Error(read.issues.join("; "));
const world = {
  seed: 20261003,
  generatorVersion: WORLD_GENERATOR_VERSION,
  grounding: "expand" as const,
  brief: read.brief,
};

// A wall down the middle with a way round at the bottom, water, mountains, woods and ruins.
const rows = ["ffpp#ppp", "ffpp#pww", "pppp#pww", "prrp#ppp", "pppp#mpp", "pfpp#mmp", "pfpppppp", "pppppppp"].map(
  (row) => `pp${row}pp`,
);
const WORDS: Record<string, string> = { p: "Plains", f: "Forest", m: "Mountain", r: "Ruins", w: "Water", "#": "Wall" };

const party = [
  { id: "hero", name: "Hero", hp: 30, maxHp: 30, attack: 8, defense: 5, speed: 8, level: 1, side: "player" },
];
const enemies = [
  { id: "guard", name: "Guard", hp: 30, maxHp: 30, attack: 6, defense: 4, speed: 5, level: 1, side: "enemy" },
];

async function createGame(request: APIRequestContext) {
  const created = await request.post("/api/game/create", {
    data: {
      name: "Hand-made battlefield browser proof",
      setupConfig: {
        genre: "Fantasy",
        setting: "The river provinces",
        tone: "Adventure",
        difficulty: "normal",
        playerGoals: "Hold the mill",
        gmMode: "standalone",
        rating: "sfw",
        partyCharacterIds: [],
        combatStyle: "tactical",
        worldKit: kit,
        world,
      },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const chatId = (await created.json()).sessionChat.id as string;
  const edit = await (await request.get(`/api/game/${chatId}/world/edit`)).json();
  const hollin = (edit.world.places as Array<{ id: string; name: string }>).find((place) => place.name === "Hollin")!;
  const saved = await request.put(`/api/game/${chatId}/world/edits`, {
    data: {
      edits: {
        editsVersion: 1,
        battlefields: [{ id: "b1", name: "Mill yard", place: hollin.id, size: "small", scene: "ruins", rows }],
      },
    },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  return chatId;
}

/** Mount the actual battle surface; start and persistence use the real local API. */
async function mountBattle(page: Page, testInfo: TestInfo, chatId: string) {
  await seedUIState(page, {
    hasCompletedOnboarding: true,
    sidebarOpen: false,
    rightPanelOpen: false,
    theme: testInfo.project.name === "desktop-chromium" ? "light" : "dark",
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What shall we cook tonight?", exact: true })).toBeVisible({
    timeout: 40_000,
  });
  await prepareViteFixtureDependencies(page);
  await page.evaluate(
    async (props) => {
      const { TacticalCombatUI } = await import("/src/components/game/TacticalCombatUI.tsx" as string);
      const dependencyUrl = window.__viteFixtureDependencyUrl;
      const { default: React } = await import(dependencyUrl("react"));
      const { default: ReactDOM } = await import(dependencyUrl("react-dom_client"));
      const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
      const container = document.createElement("div");
      container.style.cssText = "position:fixed;inset:0;z-index:99999;background:#111827";
      document.body.append(container);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const root = ReactDOM.createRoot(container);
      window.__madeBattlefieldFixture = {
        unmount: () => {
          root.unmount();
          container.remove();
        },
      };
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(TacticalCombatUI, { ...props, onBattlefieldReady: () => {}, onCombatEnd: () => {} }),
        ),
      );
    },
    { chatId, party, enemies, environment: "forest", formation: "line", playerCombatantId: "hero" },
  );
}

/** The board as its tiles are labelled on screen, a row of characters each. */
async function boardOnScreen(page: Page): Promise<string[]> {
  const letters = Object.fromEntries(Object.entries(WORDS).map(([letter, word]) => [word, letter]));
  const labels = await page
    .getByRole("button", { name: /^(Plains|Forest|Mountain|Ruins|Water|Wall), row \d+, column \d+$/ })
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
  const board: string[][] = [];
  for (const label of labels) {
    const [, word, row, column] = /^(\w+), row (\d+), column (\d+)$/.exec(label)!;
    (board[Number(row) - 1] ??= [])[Number(column) - 1] = letters[word!]!;
  }
  return board.map((row) => row.join(""));
}

test("A tactical fight at a place with a hand-made battlefield is fought on it as painted", async ({
  page,
  request,
}, testInfo) => {
  const chatId = await createGame(request);
  const starts: Array<Record<string, unknown>> = [];
  page.on("request", (sent) => {
    if (sent.url().endsWith("/api/game/combat/tactical/start")) starts.push(sent.postDataJSON());
  });
  try {
    await mountBattle(page, testInfo, chatId);
    await expect(page.getByRole("button", { name: "End Turn", exact: true })).toBeVisible({ timeout: 20_000 });
    // Named in the battlefield line (shown on wide screens, read out on every one).
    await expect(page.locator('[aria-label^="Battlefield:"]')).toHaveAttribute(
      "aria-label",
      /Hand-made map: Mill yard$/,
    );
    await expect.poll(() => boardOnScreen(page)).toEqual(rows);

    // Kept with the game as it was started.
    const kept = async () => {
      const row = await (await request.get(`/api/chats/${chatId}`)).json();
      const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      return metadata.gameTacticalCombatSnapshot?.battlefield;
    };
    await expect.poll(kept).toEqual({ kind: "hand-made", size: "small", id: "b1", name: "Mill yard", scene: "ruins" });

    // A restart is fought on the same board, never on a brief.
    await page.getByTitle("Restart the battle", { exact: true }).click();
    await page.getByRole("button", { name: "Restart", exact: true }).last().click();
    await expect.poll(() => starts.length).toBe(2);
    expect(starts[1]?.battlefield).toBeUndefined();
    await expect(page.getByRole("button", { name: "End Turn", exact: true })).toBeVisible();
    // Named in the battlefield line (shown on wide screens, read out on every one).
    await expect(page.locator('[aria-label^="Battlefield:"]')).toHaveAttribute(
      "aria-label",
      /Hand-made map: Mill yard$/,
    );
    await expect.poll(() => boardOnScreen(page)).toEqual(rows);
  } finally {
    await page.evaluate(() => window.__madeBattlefieldFixture?.unmount()).catch(() => {});
    await request.delete(`/api/chats/${chatId}`).catch(() => {});
  }
});
