import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import {
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  readWorldLedger,
  worldCast,
  worldPresent,
  worldWhereYouAreText,
  type GameNpc,
} from "@marinara-engine/shared";
import { openGame } from "./game-ruleset-fight-fixture.js";

/** A local model that answers by what the player just said, and keeps every prompt it was sent. */
async function fakeModel(
  replies: Array<[said: string, reply: string]>,
): Promise<{ server: Server; baseUrl: string; prompts: string[] }> {
  const prompts: string[] = [];
  const server = createServer(async (incoming, response) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    if (incoming.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    prompts.push(body);
    let last = body;
    try {
      const messages = (JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
      const said = [...messages].reverse().find((message) => message.role === "user")?.content;
      last = typeof said === "string" ? said : JSON.stringify(said ?? "");
    } catch {
      // Not a chat request: answer from the whole body.
    }
    const reply = replies.find(([said]) => last.includes(said))?.[1] ?? "The road is quiet.";
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

const parsedKit = parseWorldKit(WORLD_STARTER_KITS[0]!);
if (!parsedKit.ok) throw new Error("The high fantasy kit does not read");
const kit = parsedKit.kit;
const brief = {
  briefVersion: 1 as const,
  premise: "The old king is dying and the river provinces quarrel over the succession.",
  places: [
    { name: "Aldmark", layer: "realm", tags: [] },
    { name: "The Fenlands", layer: "province", parent: "Aldmark", tags: [] },
    { name: "Hollin", layer: "settlement", parent: "The Fenlands", size: "village", tags: [], start: true as const },
    {
      name: "Thornmere",
      layer: "settlement",
      parent: "The Fenlands",
      size: "city",
      tags: ["port"],
      note: "A river port of tall houses.",
    },
  ],
  placeNames: [{ culture: kit.cultures[0]!.id, names: ["Ashby", "Wending", "Calder", "Ravel", "Brennock", "Sallow"] }],
  groups: [],
  peopleNames: [] as Array<{ culture: string; given: string[]; family: string[]; order: "given-family" }>,
  events: [],
};
const gameWorld = { seed: 20261001, generatorVersion: WORLD_GENERATOR_VERSION, grounding: "expand" as const, brief };

test("the Game Master is told where the party is in its world, and a place it names takes the world's size", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const world = compileGameWorld({ kit, seed: gameWorld.seed, grounding: "expand", brief });
  const thornmere = world.places.find((place) => place.name === "Thornmere")!;
  const neighbour = world.links.find((link) => link.from === thornmere.id || link.to === thornmere.id)!;
  const neighbourName = world.places.find(
    (place) => place.id === (neighbour.from === thornmere.id ? neighbour.to : neighbour.from),
  )!.name;
  const model = await fakeModel([
    // The Game Master writes the wrong size: the world's own wins.
    // It also asks for the past of a place (worldgen W3), answered on its next turn.
    [
      "I take the boat to Thornmere.",
      'The boat noses into Thornmere. [place: name="thornmere" size="hamlet"] [history: place="hollin"]',
    ],
    ["I look around the docks.", "Gulls wheel over the tall houses."],
  ]);
  let connectionId = "";
  let chatId = "";
  try {
    const connection = await request.post("/api/connections", {
      data: {
        name: "Local world fixture",
        provider: "custom",
        baseUrl: model.baseUrl,
        apiKey: "synthetic-test-key",
        model: "world-fixture",
        maxContext: 32768,
        treatAsLocalEndpoint: true,
      },
    });
    expect(connection.ok()).toBeTruthy();
    connectionId = (await connection.json()).id;
    const created = await request.post("/api/chats", {
      data: { name: "World", mode: "game", characterIds: [], connectionId },
    });
    expect(created.ok()).toBeTruthy();
    chatId = ((await created.json()) as { id: string }).id;
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `world-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldKit: kit,
        gameWorld,
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    expect(
      (
        await request.post(`/api/chats/${chatId}/messages`, {
          data: { role: "assistant", content: "Mist lies on the reeds around Hollin." },
        })
      ).ok(),
    ).toBeTruthy();
    await openGame(page, chatId);
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
      "Mist lies on the reeds around Hollin.",
      { timeout: 30_000 },
    );

    // Before the Game Master has said where, the party is where the world starts it.
    await page.getByPlaceholder("What do you do?", { exact: true }).fill("I take the boat to Thornmere.");
    await page.getByRole("button", { name: "Send game turn", exact: true }).click();
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
      "The boat noses into Thornmere.",
      { timeout: 30_000 },
    );
    const first = model.prompts.find((body) => body.includes("I take the boat to Thornmere."))!;
    expect(first).toContain("<world_places>");
    expect(first).toContain("- Now: The old king is dying and the river provinces quarrel over the succession.");
    expect(first).toContain("<where_you_are>\\nThe party is in Hollin (village, ");
    const saved = (await (await request.get(`/api/chats/${chatId}/messages`)).json()) as Array<{
      role: string;
      content: string;
    }>;
    expect(saved.filter((message) => message.role === "assistant").at(-1)!.content).toContain(
      '[place: name="Thornmere" size="city" result="ok"]',
    );
    expect(saved.filter((message) => message.role === "assistant").at(-1)!.content).toContain(
      '[history: place="Hollin" result="ok"]',
    );
    // The where-you-are block tells who keeps a place and its past; the tag never shows as narration.
    expect(first).toContain("- Its past: ");
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).not.toContainText("[history:");

    // The next turn: the party is where the Game Master said, and can see where it can go.
    const before = model.prompts.length;
    await page.getByPlaceholder("What do you do?", { exact: true }).fill("I look around the docks.");
    await page.getByRole("button", { name: "Send game turn", exact: true }).click();
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
      "Gulls wheel over the tall houses.",
      { timeout: 30_000 },
    );
    const second = model.prompts.slice(before).find((body) => body.includes("I look around the docks."))!;
    expect(second).toContain("<where_you_are>\\nThe party is in Thornmere (city, ");
    expect(second).toContain("The Fenlands (province), Aldmark (realm).");
    expect(second).toContain("- Known for: port.");
    expect(second).toContain("- A river port of tall houses.");
    expect(second).toContain(`- From here: `);
    expect(second).toContain(`${neighbourName} (`);
    expect(second).toContain("<history_asked>\\nThe past you asked for:\\n- Hollin:");
    await page.screenshot({ path: testInfo.outputPath("world-turn.png") });
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});

test("the Game Master meets the world's people: offered by name, brought in once, and named by id", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const peopleBrief = {
    ...brief,
    peopleNames: [
      {
        culture: kit.cultures[0]!.id,
        given: ["Ama", "Tobin", "Hesk", "Mira", "Oswin", "Bryn", "Cato", "Tamsin", "Wren", "Edda"],
        family: ["Arnwald", "Fennick", "Holt", "Marrow", "Drey", "Callow"],
        order: "given-family" as const,
      },
    ],
  };
  const checked = checkWorldBrief(kit, peopleBrief);
  if (!checked.ok) throw new Error(checked.issues.join("; "));
  const inputs = { kit, seed: gameWorld.seed, grounding: "expand" as const, brief: checked.brief };
  const world = compileGameWorld(inputs);
  const hollin = world.places.find((place) => place.name === "Hollin")!;
  const [first, second] = worldCast({ ...inputs, world }, hollin.id).filter((person) => person.named);
  const model = await fakeModel([
    [
      "I knock on the first door.",
      // The tag names them by id only: the name it carries is no one's.
      `${first!.name} opens the door. [reputation: id="${first!.id}" npc="the stranger" action="helped"]`,
    ],
    ["I ask about the mist.", `The mist thickens around ${first!.name}.`],
  ]);
  let connectionId = "";
  let chatId = "";
  try {
    const connection = await request.post("/api/connections", {
      data: {
        name: "Local people fixture",
        provider: "custom",
        baseUrl: model.baseUrl,
        apiKey: "synthetic-test-key",
        model: "people-fixture",
        maxContext: 32768,
        treatAsLocalEndpoint: true,
      },
    });
    connectionId = (await connection.json()).id;
    const created = await request.post("/api/chats", {
      data: { name: "People", mode: "game", characterIds: [], connectionId },
    });
    chatId = ((await created.json()) as { id: string }).id;
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `people-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldKit: kit,
        gameWorld: { ...gameWorld, brief: peopleBrief },
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "assistant", content: "Mist lies on the reeds around Hollin." },
    });
    await openGame(page, chatId);
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
      "Mist lies on the reeds around Hollin.",
      { timeout: 30_000 },
    );

    // The Game Master is offered the place's people, by name.
    await page.getByPlaceholder("What do you do?", { exact: true }).fill("I knock on the first door.");
    await page.getByRole("button", { name: "Send game turn", exact: true }).click();
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
      `${first!.name} opens the door.`,
      { timeout: 30_000 },
    );
    const firstPrompt = model.prompts.find((body) => body.includes("I knock on the first door."))!;
    expect(firstPrompt).toContain("People here the party has not met.");
    expect(firstPrompt).toContain(`  - ${first!.name}: ${first!.role};`);

    // The reply brought them in, once, with the world's id; the reputation tag named them by id.
    const npcs = async () => {
      const row = await (await request.get(`/api/chats/${chatId}`)).json();
      const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      return (metadata.gameNpcs ?? []) as GameNpc[];
    };
    await expect.poll(async () => (await npcs()).filter((npc) => npc.worldId === first!.id).length).toBe(1);
    await expect
      .poll(async () => (await npcs()).find((npc) => npc.worldId === first!.id)?.reputation ?? 0)
      .toBeGreaterThan(0);
    const met = (await npcs()).find((npc) => npc.worldId === first!.id)!;
    expect(met).toMatchObject({ name: first!.name, role: first!.role, descriptionSource: "world", location: "Hollin" });

    // The next turn offers only people not yet met, and the tracked list knows what they do.
    const before = model.prompts.length;
    await page.getByPlaceholder("What do you do?", { exact: true }).fill("I ask about the mist.");
    await page.getByRole("button", { name: "Send game turn", exact: true }).click();
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText("The mist thickens", {
      timeout: 30_000,
    });
    // Named again, they are not brought in twice.
    expect((await npcs()).filter((npc) => npc.worldId === first!.id)).toHaveLength(1);
    const second_ = model.prompts.slice(before).find((body) => body.includes("I ask about the mist."))!;
    expect(second_).not.toContain(`  - ${first!.name}:`);
    expect(second_).toContain(`  - ${second!.name}:`);
    expect(second_).toContain(`- ${first!.name} (${first!.role}) @ Hollin`);
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});

test("what the story does to the world is remembered: deeds and places answered, then told back", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const checked = checkWorldBrief(kit, {
    ...brief,
    groups: [{ name: "The Reed Wardens", kind: "village_council", seat: "Hollin" }],
  });
  if (!checked.ok) throw new Error(checked.issues.join("; "));
  const model = await fakeModel([
    [
      "I help the wardens mend the dikes.",
      // A deed, a place the story brings in, and a deed on a group the world does not have (worldgen W4).
      'The wardens cheer. [world: deed="ally" group="the reed wardens" note="mended the dikes"] [world: fact="place" name="The Sunken Shrine" in="hollin"] [world: deed="destroy" group="The Grey Hand"]',
    ],
    // A place a reply brings in is a place the same reply can go.
    [
      "I follow the old stair.",
      'Steps lead down into the dark. [world: fact="place" name="The Drowned Stair" in="Hollin"] [place: name="the drowned stair"]',
    ],
    // A place added before the conversation start is still the world's after it.
    ["I light a torch.", 'Shadows jump along the wet stone. [place: name="the sunken shrine"]'],
  ]);
  let connectionId = "";
  let chatId = "";
  try {
    const connection = await request.post("/api/connections", {
      data: {
        name: "Local ledger fixture",
        provider: "custom",
        baseUrl: model.baseUrl,
        apiKey: "synthetic-test-key",
        model: "ledger-fixture",
        maxContext: 32768,
        treatAsLocalEndpoint: true,
      },
    });
    connectionId = (await connection.json()).id;
    const created = await request.post("/api/chats", {
      data: { name: "Ledger", mode: "game", characterIds: [], connectionId },
    });
    chatId = ((await created.json()) as { id: string }).id;
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `ledger-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldKit: kit,
        gameWorld: { ...gameWorld, brief: checked.brief },
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "assistant", content: "Mist lies on the reeds around Hollin." },
    });
    await openGame(page, chatId);
    const narration = page.locator('[data-component="GameNarration.ActivePanel"]');
    await expect(narration).toContainText("Mist lies on the reeds around Hollin.", { timeout: 30_000 });
    const send = async (said: string, shown: string) => {
      const before = model.prompts.length;
      await page.getByPlaceholder("What do you do?", { exact: true }).fill(said);
      await page.getByRole("button", { name: "Send game turn", exact: true }).click();
      await expect(narration).toContainText(shown, { timeout: 30_000 });
      return model.prompts.slice(before).find((body) => body.includes(said))!;
    };
    const lastReply = async () =>
      ((await (await request.get(`/api/chats/${chatId}/messages`)).json()) as Array<{ role: string; content: string }>)
        .filter((message) => message.role === "assistant")
        .at(-1)!.content;

    // The Game Master is told how to write deeds; its tags are answered in place and never shown.
    const first = await send("I help the wardens mend the dikes.", "The wardens cheer.");
    expect(first).toContain("When the party changes the world, record it in your reply");
    const answered = await lastReply();
    expect(answered).toContain('[world: deed="ally" group="The Reed Wardens" note="mended the dikes" result="ok"]');
    expect(answered).toContain('[world: fact="place" name="The Sunken Shrine" in="Hollin" result="ok"]');
    expect(answered).toContain('[world: deed="destroy" group="The Grey Hand" result="refused" reason="unknown-group"]');
    await expect(narration).not.toContainText("[world:");

    // A conversation start scopes what the Game Master reads, not what the story did to the world.
    expect(
      (
        await request.post(`/api/chats/${chatId}/messages`, {
          data: { role: "assistant", content: "A new day over Hollin.", extra: { isConversationStart: true } },
        })
      ).ok(),
    ).toBeTruthy();

    // The next turn is told the world as the story left it, and an added place is a place to go.
    const second = await send("I follow the old stair.", "Steps lead down into the dark.");
    expect(second).toContain("<where_you_are>\\nThe party is in Hollin (village, ");
    expect(second).toMatch(/- Inside it: [^\\]*The Sunken Shrine\./);
    expect(second).toContain("- The party's standing: The Reed Wardens (on good terms).");
    expect(await lastReply()).toContain('[place: name="The Drowned Stair" size="village" result="ok"]');

    const third = await send("I light a torch.", "Shadows jump along the wet stone.");
    expect(third).toContain("<where_you_are>\\nThe party is in The Drowned Stair, in Hollin (village, ");
    expect(await lastReply()).toContain('[place: name="The Sunken Shrine" size="village" result="ok"]');
    await page.screenshot({ path: testInfo.outputPath("world-ledger.png") });
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});

test("the world goes on as time passes: told in the Game Master's block as the shared world computes it", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const checked = checkWorldBrief(kit, {
    ...brief,
    groups: [
      { name: "The Reed Wardens", kind: "village_council", seat: "Hollin", rivals: ["The Tollmen"] },
      { name: "The Tollmen", kind: "merchant_company", seat: "Thornmere" },
    ],
  });
  if (!checked.ok) throw new Error(checked.issues.join("; "));
  const passing =
    'The weeks go by. [world: event="The river burst its banks" kind="everyday" place="hollin"] [world: days="30"]';
  const model = await fakeModel([
    ["I wait out the floods.", passing],
    ["I ask what news there is.", "The ferryman shrugs."],
  ]);
  let connectionId = "";
  let chatId = "";
  try {
    const connection = await request.post("/api/connections", {
      data: {
        name: "Local living fixture",
        provider: "custom",
        baseUrl: model.baseUrl,
        apiKey: "synthetic-test-key",
        model: "living-fixture",
        maxContext: 32768,
        treatAsLocalEndpoint: true,
      },
    });
    connectionId = (await connection.json()).id;
    const created = await request.post("/api/chats", {
      data: { name: "Living", mode: "game", characterIds: [], connectionId },
    });
    chatId = ((await created.json()) as { id: string }).id;
    const inputs = { ...gameWorld, brief: checked.brief };
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `living-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldKit: kit,
        gameWorld: inputs,
      },
    });
    expect(meta.ok(), await meta.text()).toBeTruthy();
    await request.post(`/api/chats/${chatId}/messages`, {
      data: { role: "assistant", content: "Mist lies on the reeds around Hollin." },
    });
    await openGame(page, chatId);
    const narration = page.locator('[data-component="GameNarration.ActivePanel"]');
    await expect(narration).toContainText("Mist lies on the reeds around Hollin.", { timeout: 30_000 });
    const send = async (said: string, shown: string) => {
      const before = model.prompts.length;
      await page.getByPlaceholder("What do you do?", { exact: true }).fill(said);
      await page.getByRole("button", { name: "Send game turn", exact: true }).click();
      await expect(narration).toContainText(shown, { timeout: 30_000 });
      return model.prompts.slice(before).find((body) => body.includes(said))!;
    };

    const first = await send("I wait out the floods.", "The weeks go by.");
    expect(first).toContain('[world: days=\\"N\\"]');
    const replies = (
      (await (await request.get(`/api/chats/${chatId}/messages`)).json()) as Array<{ role: string; content: string }>
    )
      .filter((message) => message.role === "assistant")
      .map((message) => message.content);
    expect(replies.at(-1)).toContain('[world: days="30" result="ok"]');

    // The next turn is told the world as the shared fold steps it: the same news, the same brewing.
    const second = await send("I ask what news there is.", "The ferryman shrugs.");
    const game = {
      kit,
      ...inputs,
      brief: checked.brief,
      world: compileGameWorld({ kit, ...inputs, brief: checked.brief }),
    };
    const present = worldPresent(game, readWorldLedger(replies));
    expect(present.day).toBe(30);
    const hollin = game.world.places.find((place) => place.name === "Hollin")!;
    const expected = worldWhereYouAreText(game, { place: hollin, present, met: new Set() }).split("\n");
    const told = expected.filter((line) =>
      /^(- Word that has reached here|- Brewing|- About to happen here|  - )/.test(line),
    );
    expect(told.join("\n")).toContain("30 days ago: The river burst its banks");
    for (const line of told) expect(second).toContain(JSON.stringify(line).slice(1, -1));
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});
