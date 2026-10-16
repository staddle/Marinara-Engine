import { expect, test, type APIRequestContext } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { WORLD_GENERATOR_VERSION, WORLD_STARTER_KITS, compileGameWorld, parseWorldKit } from "@marinara-engine/shared";
import { openGame } from "./game-ruleset-fight-fixture.js";

/**
 * Maps for places (map editor Phase 3, the Game Mode side), on screen: a mine the story put in town is
 * gone down into from where the party stands, its map shown, and left by the way in back to the town.
 */

/** A local model that answers every turn the same, and keeps every prompt it was sent. */
async function fakeModel(reply: string): Promise<{ server: Server; baseUrl: string; prompts: string[] }> {
  const prompts: string[] = [];
  const server = createServer(async (incoming, response) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    if (incoming.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    prompts.push(body);
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const write = (delta: unknown, finishReason: string | null = null) =>
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    write({ content: reply });
    write({}, "stop");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The model fixture did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, prompts };
}

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
const gameWorld = { seed: 20261002, generatorVersion: WORLD_GENERATOR_VERSION, grounding: "expand" as const, brief };

async function metadataOf(request: APIRequestContext, chatId: string) {
  const row = await (await request.get(`/api/chats/${chatId}`)).json();
  return (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) as Record<string, any>;
}

test("the party goes down into a mine in town and comes back up", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const model = await fakeModel("Dust and lamplight.");
  let connectionId = "";
  let chatId = "";
  try {
    const connection = await request.post("/api/connections", {
      data: {
        name: "Local mine fixture",
        provider: "custom",
        baseUrl: model.baseUrl,
        apiKey: "synthetic-test-key",
        model: "mine-fixture",
        maxContext: 32768,
        treatAsLocalEndpoint: true,
      },
    });
    expect(connection.ok()).toBeTruthy();
    connectionId = (await connection.json()).id;
    const created = await request.post("/api/chats", {
      data: { name: "Mine", mode: "game", characterIds: [], connectionId },
    });
    expect(created.ok()).toBeTruthy();
    chatId = ((await created.json()) as { id: string }).id;
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `mine-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldKit: kit,
        gameWorld,
        gameWorldView: "town",
        gameTime: { day: 1, hour: 10, minute: 0 },
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    // The party is in Thornmere, where the story put an old mine.
    const told = await request.post(`/api/chats/${chatId}/messages`, {
      data: {
        role: "assistant",
        content:
          'The gates of Thornmere. [place: name="Thornmere" result="ok"] ' +
          '[world: fact="place" name="The Old Mine" in="Thornmere" result="ok"]',
      },
    });
    expect(told.ok()).toBeTruthy();
    const town = (await (await request.get(`/api/game/${chatId}/town`)).json()).town;
    const mine = town.buildings.find((building: { name?: string }) => building.name === "The Old Mine");
    expect(mine, "the mine is a building in town").toBeTruthy();
    expect((await request.post(`/api/game/${chatId}/town/visit`, { data: { to: mine.id } })).ok()).toBeTruthy();

    await openGame(page, chatId);
    await expect(page.getByRole("region", { name: "Town", exact: true })).toBeVisible({ timeout: 40_000 });
    await page.getByRole("button", { name: "Places in town", exact: true }).click();
    await page
      .getByRole("list", { name: "Places in town" })
      .getByRole("button", { name: /The Old Mine/u })
      .click();
    const card = page.locator('[data-component="TownView.Card"]');
    await expect(card).toContainText("The Old Mine");
    await card.getByRole("button", { name: "Go down", exact: true }).click();

    const view = page.locator('[data-component="DungeonMapView"]');
    await expect(view).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/The Old Mine · area 1/u)).toBeVisible();
    const kept = (await metadataOf(request, chatId)).gameDungeonMap;
    expect(kept.name).toBe("The Old Mine");
    expect(kept.set).toBe("cave_rock");
    await page.screenshot({ path: testInfo.outputPath("mine-map.png") });

    // In at the way in, so out by it: back in town at the mine.
    await page.getByRole("button", { name: "Leave by the ladder", exact: true }).click();
    await expect(view).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Town", exact: true })).toBeVisible();
    await expect.poll(async () => (await metadataOf(request, chatId)).gameDungeonMap).toBeNull();
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});

test("a place with a map made for it by hand is gone down into on that map", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const model = await fakeModel("Dust and lamplight.");
  let connectionId = "";
  let chatId = "";
  try {
    const connection = await request.post("/api/connections", {
      data: {
        name: "Local mine fixture",
        provider: "custom",
        baseUrl: model.baseUrl,
        apiKey: "synthetic-test-key",
        model: "mine-fixture",
        maxContext: 32768,
        treatAsLocalEndpoint: true,
      },
    });
    expect(connection.ok()).toBeTruthy();
    connectionId = (await connection.json()).id;
    const created = await request.post("/api/chats", {
      data: { name: "Mine", mode: "game", characterIds: [], connectionId },
    });
    expect(created.ok()).toBeTruthy();
    chatId = ((await created.json()) as { id: string }).id;
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `mine-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldKit: kit,
        gameWorld,
        gameWorldView: "town",
        gameTime: { day: 1, hour: 10, minute: 0 },
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    // The party is in Thornmere, where the story put an old mine.
    const told = await request.post(`/api/chats/${chatId}/messages`, {
      data: {
        role: "assistant",
        content: 'The gates of Thornmere. [place: name="Thornmere" result="ok"]',
      },
    });
    expect(told.ok()).toBeTruthy();
    // A place added by hand in Thornmere, with a small map made for it.
    const world = (await (await request.get(`/api/game/${chatId}/world`)).json()) as any;
    const thornmere = world.world.world.places.find((place: { name: string }) => place.name === "Thornmere");
    const rows = ["######", "#....#", "#.~~.#", "#....#", "######"];
    const saved = await request.put(`/api/game/${chatId}/world/edits`, {
      data: {
        edits: {
          editsVersion: 3,
          added: [{ id: "e1", name: "Old Granary", layer: "quarter", parentId: thornmere.id, at: thornmere.at }],
          maps: [{ id: "m1", place: "e1", width: 6, height: 5, ground: rows.join(""), entry: { x: 1, y: 3 } }],
        },
      },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    const town = (await (await request.get(`/api/game/${chatId}/town`)).json()).town;
    const mine = town.buildings.find((building: { placeId?: string }) => building.placeId === "e1");
    expect(mine, "the added place is a building in town").toBeTruthy();
    expect((await request.post(`/api/game/${chatId}/town/visit`, { data: { to: mine.id } })).ok()).toBeTruthy();

    await openGame(page, chatId);
    await expect(page.getByRole("region", { name: "Town", exact: true })).toBeVisible({ timeout: 40_000 });
    await page.getByRole("button", { name: "Places in town", exact: true }).click();
    await page
      .getByRole("list", { name: "Places in town" })
      .getByRole("button", { name: /Old Granary/u })
      .click();
    const card = page.locator('[data-component="TownView.Card"]');
    await expect(card).toContainText("Old Granary");
    await card.getByRole("button", { name: "Go down", exact: true }).click();

    const view = page.locator('[data-component="DungeonMapView"]');
    await expect(view).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Old Granary/u)).toBeVisible();
    const kept = (await metadataOf(request, chatId)).gameDungeonMap;
    expect(kept.name).toBe("Old Granary");
    expect(kept.hand).toBe(true);
    expect(kept.ground).toBe(rows.join(""));
    await page.screenshot({ path: testInfo.outputPath("hand-map.png") });

    // In at the way in, so out by it: back in town at the mine.
    await page.getByRole("button", { name: "Leave by the stairs", exact: true }).click();
    await expect(view).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Town", exact: true })).toBeVisible();
    await expect.poll(async () => (await metadataOf(request, chatId)).gameDungeonMap).toBeNull();
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});
