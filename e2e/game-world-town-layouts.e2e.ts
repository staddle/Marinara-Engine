import { expect, test } from "@playwright/test";
import {
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  compileGameWorld,
  parseWorldKit,
  worldTown,
  worldTownMinutes,
  type GameWorld,
} from "@marinara-engine/shared";
import { openGame } from "./game-ruleset-fight-fixture.js";

/**
 * A town laid out by hand (worldgen W9h), on screen: the hall moved to another lot stands there, a walk
 * to it is timed from its new door, and the ground painted with a tree is drawn from the hand layout.
 */

const parsedKit = parseWorldKit(WORLD_STARTER_KITS.find((kit) => kit.id === "high_fantasy")!);
if (!parsedKit.ok) throw new Error("The high fantasy kit does not read");
const kit = parsedKit.kit;
const brief = {
  briefVersion: 1 as const,
  premise: "The old king is dying and the river provinces quarrel over the succession.",
  places: [
    { name: "Aldmark", layer: "realm", tags: [] },
    { name: "The Fenlands", layer: "province", parent: "Aldmark", tags: [] },
    { name: "Hollin", layer: "settlement", parent: "The Fenlands", size: "village", tags: [], start: true as const },
    { name: "Thornmere", layer: "settlement", parent: "The Fenlands", size: "city", tags: ["port"] },
  ],
  placeNames: [{ culture: kit.cultures[0]!.id, names: ["Ashby", "Wending", "Calder", "Ravel", "Brennock", "Sallow"] }],
  groups: [],
  peopleNames: [] as Array<{ culture: string; given: string[]; family: string[]; order: "given-family" }>,
  events: [],
};
const stored = { seed: 20261002, generatorVersion: WORLD_GENERATOR_VERSION, grounding: "expand" as const, brief };
const plain: GameWorld = { kit, ...stored, world: compileGameWorld({ kit, ...stored }) };
const thornmere = plain.world.places.find((place) => place.name === "Thornmere")!;
const asMade = worldTown(plain, thornmere.id)!;
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const lot = asMade.lots.filter((each) => asMade.buildings.every((building) => !overlaps(building, each))).at(-1)!;
const treeAt = [...asMade.ground].findIndex(
  (cell, index) =>
    cell === "." &&
    asMade.buildings.every(
      (building) => !overlaps(building, { x: index % asMade.width, y: Math.floor(index / asMade.width), w: 1, h: 1 }),
    ),
);
const edits = {
  editsVersion: 1 as const,
  towns: [
    {
      settlement: thornmere.id,
      moves: [{ building: "hall", x: lot.x, y: lot.y, w: lot.w }],
      ground: Array.from({ length: asMade.ground.length }, (_, index) => (index === treeAt ? "t" : ".")).join(""),
    },
  ],
};
const byHand: GameWorld = { ...plain, edits, world: compileGameWorld({ kit, ...stored, edits }) };
const minutes = worldTownMinutes(worldTown(byHand, thornmere.id)!, "square", "hall");

test("a town laid out by hand stands as laid out, and its walks are timed from there", async ({ page, request }) => {
  test.setTimeout(120_000);
  const created = await request.post("/api/chats", { data: { name: "Town by hand", mode: "game", characterIds: [] } });
  expect(created.ok()).toBeTruthy();
  const chatId = ((await created.json()) as { id: string }).id;
  try {
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `town-by-hand-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldKit: kit,
        gameWorld: { ...stored, edits },
        gameTime: { day: 1, hour: 10, minute: 0 },
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    expect(
      (
        await request.post(`/api/chats/${chatId}/messages`, {
          data: { role: "assistant", content: 'The gates of Thornmere. [place: name="Thornmere" result="ok"]' },
        })
      ).ok(),
    ).toBeTruthy();
    // The town the game plays is laid out by hand, the tree with it.
    const played = (await (await request.get(`/api/game/${chatId}/town`)).json()).town;
    expect(played.ground[treeAt]).toBe("t");

    await openGame(page, chatId);
    await expect(page.getByRole("region", { name: "Overworld", exact: true })).toBeVisible({ timeout: 40_000 });
    await page.getByRole("button", { name: /^Thornmere, .*: the party is here$/u }).click();
    await page.getByRole("button", { name: "Enter Thornmere", exact: true }).click();
    await expect(page.getByRole("region", { name: "Town", exact: true })).toBeVisible();

    // The hall stands on the lot it was moved to.
    const hall = page.getByRole("button", { name: "The hall", exact: true });
    const placed = await hall.evaluate((node) => {
      const style = (node as HTMLElement).style;
      return { left: parseFloat(style.left), top: parseFloat(style.top), width: parseFloat(style.width) };
    });
    const cell = placed.width / lot.w;
    expect([placed.left / cell, placed.top / cell]).toEqual([lot.x, lot.y]);
    // And nothing stands where it stood.
    const oldHall = asMade.buildings.find((building) => building.id === "hall")!;
    const corners = await page
      .locator('[data-component="TownView"] button[aria-pressed]')
      .evaluateAll((nodes) => nodes.map((node) => [(node as HTMLElement).style.left, (node as HTMLElement).style.top]));
    expect(corners).not.toContainEqual([`${oldHall.x * cell}px`, `${oldHall.y * cell}px`]);
    expect(corners.length).toBeGreaterThan(asMade.buildings.length - 1);

    // A walk there is timed from its new door (picked from the list: the town's edges sit under the bar).
    await page.getByRole("button", { name: "Places in town", exact: true }).click();
    await page
      .getByRole("list", { name: "Places in town" })
      .getByRole("button", { name: /The hall/u })
      .click();
    await expect(page.locator('[data-component="TownView.Card"]')).toContainText(
      `${minutes} minute${minutes === 1 ? "" : "s"} away`,
    );
  } finally {
    await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
  }
});
