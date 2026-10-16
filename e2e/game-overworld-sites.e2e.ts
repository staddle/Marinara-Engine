import { expect, test, type APIRequestContext } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { WORLD_GENERATOR_VERSION, WORLD_STARTER_KITS, compileGameWorld, parseWorldKit } from "@marinara-engine/shared";
import { openGame } from "./game-ruleset-fight-fixture.js";

/**
 * Sites on the overworld, on screen (design-game-overworld-sites.md): a cave a few steps out of the
 * village is on the map, a trip there leaves the road, and the party goes in from its card and comes back
 * out onto the overworld. A barrow the story names is shown closed.
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
const world = compileGameWorld({ kit, seed: gameWorld.seed, grounding: "expand", brief });
const hollin = world.places.find((place) => place.name === "Hollin")!;

async function metadataOf(request: APIRequestContext, chatId: string) {
  const row = await (await request.get(`/api/chats/${chatId}`)).json();
  return (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata) as Record<string, any>;
}

const taken = new Set(world.places.map((place) => `${place.at.x},${place.at.y}`));
const near = (dx: number) => {
  for (let step = 2; step < 12; step++) {
    const at = { x: hollin.at.x + dx * step, y: hollin.at.y };
    if (at.x > 0 && at.x < world.width - 1 && !taken.has(`${at.x},${at.y}`)) return at;
  }
  throw new Error("no free cell near Hollin");
};
const added = [
  { id: "e1", name: "Wolf Den Caves", layer: "quarter", parentId: hollin.id, at: near(1) },
  { id: "e2", name: "Old Barrow", layer: "quarter", parentId: hollin.id, at: near(-1) },
];

test("the party travels to a cave out of the village, goes in and comes back out", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const model = await fakeModel("The wind drops.");
  let connectionId = "";
  let chatId = "";
  try {
    const connection = await request.post("/api/connections", {
      data: {
        name: "Local sites fixture",
        provider: "custom",
        baseUrl: model.baseUrl,
        apiKey: "synthetic-test-key",
        model: "sites-fixture",
        maxContext: 32768,
        treatAsLocalEndpoint: true,
      },
    });
    expect(connection.ok()).toBeTruthy();
    connectionId = (await connection.json()).id;
    const created = await request.post("/api/chats", {
      data: { name: "Sites", mode: "game", characterIds: [], connectionId },
    });
    expect(created.ok()).toBeTruthy();
    chatId = ((await created.json()) as { id: string }).id;
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `sites-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldKit: kit,
        gameWorld,
        gameTime: { day: 1, hour: 8, minute: 0 },
        // The story names the barrow: it is closed until the Game Master opens it.
        gameStory: {
          storyVersion: 1,
          events: [{ id: "barrow", when: { on: "arrive", place: "e2" }, do: [{ tell: "The barrow breathes." }] }],
        },
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    const saved = await request.put(`/api/game/${chatId}/world/edits`, { data: { edits: { editsVersion: 1, added } } });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    expect(
      (
        await request.post(`/api/chats/${chatId}/messages`, {
          data: { role: "assistant", content: "Mist lies on the reeds around Hollin." },
        })
      ).ok(),
    ).toBeTruthy();
    await openGame(page, chatId);
    await expect(page.getByRole("region", { name: "Overworld", exact: true })).toBeVisible({ timeout: 40_000 });

    // The barrow is on the map, closed.
    const card = page.locator('[data-component="WorldOverworld.Card"]');
    await page.getByRole("button", { name: "Places", exact: true }).click();
    await page
      .getByRole("list", { name: "Places" })
      .getByRole("button", { name: /^Old Barrow/u })
      .click();
    await expect(card).toContainText("Closed to the party for now.");
    await expect(card.getByRole("button", { name: "Walk there", exact: true })).toHaveCount(0);
    await card.getByRole("button", { name: "Close", exact: true }).click();

    // To the cave: off the road from Hollin.
    await page.getByRole("button", { name: "Places", exact: true }).click();
    await page
      .getByRole("list", { name: "Places" })
      .getByRole("button", { name: /^Wolf Den Caves/u })
      .click();
    await expect(card).toContainText("Wolf Den Caves");
    await card.getByRole("button", { name: "Walk there", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Walked to Wolf Den Caves." })).toBeVisible({
      timeout: 20_000,
    });
    const here = page.getByRole("button", { name: /^Wolf Den Caves, .*: the party is here$/u });
    await expect(here).toBeAttached();
    await page.screenshot({ path: testInfo.outputPath("site-walked.png") });

    // In from its card, and back out onto the overworld.
    await here.click();
    await card.getByRole("button", { name: "Enter Wolf Den Caves", exact: true }).click();
    const view = page.locator('[data-component="DungeonMapView"]');
    await expect(view).toBeVisible({ timeout: 30_000 });
    expect((await metadataOf(request, chatId)).gameDungeonMap.place).toBe("e1");
    await page.screenshot({ path: testInfo.outputPath("site-map.png") });
    await page.getByRole("button", { name: "Leave by the ladder", exact: true }).click();
    await expect(view).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Overworld", exact: true })).toBeVisible();
    await expect(here).toBeAttached();
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});
