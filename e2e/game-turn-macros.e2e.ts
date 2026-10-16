import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { seedUIState } from "./ui-state-fixture.js";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

type GameChat = { chatId: string; prompts: string[][]; storedTurns: () => Promise<string[]> };

// Opens a Game chat with the persona "Pat Persona" and the chat variable gold = 12. The persona list
// request goes through `personaList`, so a test can hold it back or fail it.
async function withGameChat(
  page: Page,
  request: APIRequestContext,
  personaList: (route: Route) => Promise<void>,
  run: (chat: GameChat) => Promise<void>,
) {
  const prompts: string[][] = [];
  const provider = createServer(async (incoming, response) => {
    if (incoming.method !== "POST") {
      incoming.resume();
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    prompts.push((body.messages ?? []).map((message: { content?: unknown }) => String(message.content ?? "")));
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "The gate creaks open." }, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const cleanup: string[] = [];
  try {
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Game fixture did not bind");
    const create = async (path: string, data: unknown) => {
      const response = await request.post(path, { data });
      expect(response.ok(), await response.text()).toBeTruthy();
      const value = await response.json();
      cleanup.unshift(`${path}/${value.id}`);
      return value as { id: string };
    };
    const connection = await create("/api/connections", {
      name: "Game macro fixture",
      provider: "custom",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "synthetic-test-key",
      model: "game-macro-fixture",
      maxContext: 32768,
      treatAsLocalEndpoint: true,
    });
    const persona = await create("/api/characters/personas", { name: "Pat Persona" });
    const chat = await create("/api/chats", {
      name: "Game turn macros",
      mode: "game",
      characterIds: [],
      connectionId: connection.id,
      personaId: persona.id,
    });
    const metadata = await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: {
        gameId: chat.id,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
      },
    });
    expect(metadata.ok(), await metadata.text()).toBeTruthy();
    // Chat variables are their own metadata patch: the route takes macroVariables only on its own.
    const variables = await request.patch(`/api/chats/${chat.id}/metadata`, {
      data: { macroVariables: { gold: "12" } },
    });
    expect(variables.ok(), await variables.text()).toBeTruthy();
    const opening = await request.post(`/api/chats/${chat.id}/messages`, {
      data: { role: "assistant", content: "A gate blocks the path." },
    });
    expect(opening.ok(), await opening.text()).toBeTruthy();
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await page.route("**/api/characters/personas/list", personaList);
    await seedUIState(page, {
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chatHelpSeenModes: ["game"],
      gameInstantTextReveal: true,
      debugMode: false,
    });
    await page.addInitScript(
      ({ id, version }) => {
        localStorage.setItem("marinara-active-chat-id", id);
        localStorage.setItem("marinara:whats-new:seen-version", version);
      },
      { id: chat.id, version },
    );
    await page.goto("/");
    await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText("A gate blocks the path.");
    await run({
      chatId: chat.id,
      prompts,
      storedTurns: async () =>
        (
          (await (await request.get(`/api/chats/${chat.id}/messages`)).json()) as Array<{
            role: string;
            content: string;
          }>
        )
          .filter((message) => message.role === "user")
          .map((message) => message.content),
    });
  } finally {
    // The provider closes first, so a failed delete cannot leave it open.
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    for (const path of cleanup) await request.delete(path);
  }
}

async function sendTurn(page: Page, text: string) {
  await page.getByPlaceholder("What do you do?", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send game turn", exact: true }).click();
}

// A Game turn is stored with its macros filled in, as a Roleplay or Conversation send is (#7585).
// Left raw, the Game log rolled {{random}} with one seed and the model's prompt with another.
test("a Game turn stores its macros resolved, and the log and the model read that text", async ({ page, request }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  // Hold the persona list, as on a slow first load: the turn must wait for it, not store "User" for {{user}}.
  let releasePersonas = () => {};
  const personasHeld = new Promise<void>((resolve) => (releasePersonas = resolve));
  const holdPersonas = async (route: Route) => {
    await personasHeld;
    await route.continue();
  };
  const lorebookResponse = await request.post("/api/lorebooks", { data: { name: "Game Turn Signs" } });
  expect(lorebookResponse.ok(), await lorebookResponse.text()).toBeTruthy();
  const lorebook = (await lorebookResponse.json()) as { id: string };
  try {
    const entry = await request.post(`/api/lorebooks/${lorebook.id}/entries`, {
      data: { name: "Gate", content: "Open to {{user}} at {{random::dawn::dusk}}" },
    });
    expect(entry.ok(), await entry.text()).toBeTruthy();
    await withGameChat(page, request, holdPersonas, async ({ chatId, prompts, storedTurns }) => {
      await sendTurn(page, "I shout {{random::red::green}}, I am {{user}} with {{getvar::gold}} gold.");
      releasePersonas();

      // A Game turn reads the chat's variables, as the server did when it filled the raw turn in.
      await expect
        .poll(storedTurns)
        .toEqual([expect.stringMatching(/^I shout (red|green), I am Pat Persona with 12 gold\.$/u)]);
      const [turn] = await storedTurns();
      await expect.poll(() => prompts.length).toBeGreaterThan(0);
      expect(prompts[0]!.some((content) => content.includes(turn!))).toBe(true);
      expect(prompts[0]!.join("\n")).not.toContain("{{random");

      const narration = page.locator('[data-component="GameNarration.ActivePanel"]');
      await expect(narration).toContainText(/The gate creaks open\.|I shout/u);
      await page.getByRole("button", { name: "Logs", exact: true }).click();
      const logs = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Session Logs" }) });
      await expect(logs).toContainText(turn!);
      await logs.getByRole("button", { name: "Close logs", exact: true }).click();
      await expect(logs).toHaveCount(0);

      // A turn that writes a chat variable stays raw, so the server still applies the write.
      await sendTurn(page, "{{setvar::met::yes}}I wave.");
      await expect.poll(storedTurns).toEqual([turn, "{{setvar::met::yes}}I wave."]);
      await expect
        .poll(async () => {
          const saved = (await (await request.get(`/api/chats/${chatId}`)).json()) as { metadata?: unknown };
          const meta = typeof saved.metadata === "string" ? JSON.parse(saved.metadata) : saved.metadata;
          return (meta as { macroVariables?: Record<string, string> } | undefined)?.macroVariables;
        })
        .toEqual({ gold: "12", met: "yes" });

      // A lorebook include goes in when the turn is sent, and its macros are filled in with the rest (#7607).
      await sendTurn(page, "I read the sign: {{include::Game Turn Signs::Gate}}");
      await expect
        .poll(async () => (await storedTurns()).at(-1))
        .toMatch(/^I read the sign: Open to Pat Persona at (dawn|dusk)$/u);
    });
  } finally {
    await request.delete(`/api/lorebooks/${lorebook.id}`);
  }
});

// With no persona list to read, filling the turn in would store "User"; the server knows the persona.
test("a Game turn stays raw for the server when the persona list fails to load", async ({ page, request }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(10_000);
  const failPersonas = (route: Route) => route.fulfill({ status: 500, json: { error: "Persona list is down" } });
  await withGameChat(page, request, failPersonas, async ({ prompts, storedTurns }) => {
    await sendTurn(page, "I am {{user}}.");
    await expect.poll(storedTurns, { timeout: 20_000 }).toEqual(["I am {{user}}."]);
    await expect.poll(() => prompts.length).toBeGreaterThan(0);
    expect(prompts[0]!.some((content) => content.includes("I am Pat Persona."))).toBe(true);
  });
});
