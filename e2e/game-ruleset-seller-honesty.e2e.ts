import { expect, test } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { inventoryButton } from "./game-inventory-fixture.js";
import { openGame, savedInventory, withImports } from "./game-ruleset-fight-fixture.js";

/**
 * Honest and dishonest sellers (P1-7, Capability API 1.79), on real turns. The Game Master buys a
 * warming tonic from a fence whose stock is a fake one: the bag, the notification and the narration
 * show a warming tonic and never the bitter tonic it truly is, while the next prompt tells the Game
 * Master the truth. Sold to the honest chandler, it is seen through: the notification says what it
 * really was and what it fetched, and it leaves the bag.
 */

function gravewatch(id: string): string {
  const doc = JSON.parse(readFileSync(new URL("../docs/examples/rulesets/gravewatch.json", import.meta.url), "utf8"));
  doc.id = id;
  const kit = doc.catalogs.find((catalog: { id: string }) => catalog.id === "kit");
  kit.entries.push({
    id: "bitter-tonic",
    label: "Bitter tonic",
    item: { category: "tonic", passesFor: "kit/warming-tonic", cost: { amount: 1, unit: "penny" } },
  });
  doc.items.lootTables.push({
    id: "fences_lot",
    label: "A fence's lot",
    rolls: 1,
    entries: [{ item: "kit/bitter-tonic", weight: 1, count: 2 }],
  });
  doc.items.market.sellers.push({
    id: "fence",
    label: "fence",
    sells: [{ category: "tonic" }],
    place: "town",
    honest: false,
    stock: { table: "fences_lot" },
  });
  return JSON.stringify(doc);
}

/** A local model that answers by what the player just said, and keeps every prompt it was sent. No
 *  paid provider is called. */
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
    // Only what the player said last: a later prompt carries the whole history before it.
    let last = body;
    try {
      const messages = (JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
      const said = [...messages].reverse().find((message) => message.role === "user")?.content;
      last = typeof said === "string" ? said : JSON.stringify(said ?? "");
    } catch {
      // Not a chat request: answer from the whole body.
    }
    const reply = replies.find(([said]) => last.includes(said))?.[1] ?? "The night is quiet.";
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

test("a fence's fake looks real in the bag until an honest buyer sees through it", async ({ page, request }) => {
  test.setTimeout(150_000);
  const model = await fakeModel([
    [
      "I buy a tonic from the fence.",
      'We reach Barrowmere. [place: name="Barrowmere" size="market town"] ' +
        '[inventory: action="buy" item="Warming tonic" seller="fence"]',
    ],
    [
      "I sell the tonic to the chandler.",
      'The chandler squints. [inventory: action="sell" item="Warming tonic" seller="chandler"]',
    ],
  ]);
  let connectionId = "";
  try {
    await withImports(request, async (cleanup) => {
      const imported = await request.post("/api/game-rulesets/import", {
        data: { definition: gravewatch("gravewatch-honesty-e2e") },
      });
      expect(imported.ok(), await imported.text()).toBeTruthy();
      const rulesetId = (await imported.json()).rulesetId as string;
      const connection = await request.post("/api/connections", {
        data: {
          name: "Local honesty fixture",
          provider: "custom",
          baseUrl: model.baseUrl,
          apiKey: "synthetic-test-key",
          model: "honesty-fixture",
          maxContext: 32768,
          treatAsLocalEndpoint: true,
        },
      });
      expect(connection.ok()).toBeTruthy();
      connectionId = (await connection.json()).id;
      const created = await request.post("/api/chats", {
        data: { name: "Honesty", mode: "game", characterIds: [], connectionId },
      });
      expect(created.ok()).toBeTruthy();
      const chatId = ((await created.json()) as { id: string }).id;
      cleanup.push({ chatId, rulesetId, anchor: "" });
      const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
        data: {
          gameId: `honesty-${chatId}`,
          gameSessionStatus: "active",
          gameIntroPresented: true,
          gameImageAutoGenerationEnabled: false,
          enableAgents: false,
          enableTools: false,
          gameRuleset: { id: rulesetId, version: 1, packageId: null, options: {} },
          gameInventory: [{ id: "st-crowns", name: "crowns", item: "coin:crown", quantity: 2 }],
        },
      });
      expect(meta.ok(), await meta.text()).toBeTruthy();
      expect(
        (
          await request.post(`/api/chats/${chatId}/messages`, {
            data: { role: "assistant", content: "The road bends toward the lights of a town." },
          })
        ).ok(),
      ).toBeTruthy();
      await openGame(page, chatId);
      await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(
        "The road bends toward the lights of a town.",
        { timeout: 30_000 },
      );
      const turn = async (said: string, shown: string, notices: RegExp[]) => {
        const before = model.prompts.length;
        await page.evaluate(() => {
          const seen = new Set<string>();
          (window as unknown as { notices: Set<string> }).notices = seen;
          new MutationObserver(() => {
            for (const line of document.body.innerText.match(/(?:You bought|The buyer saw) [^\n]*/g) ?? [])
              seen.add(line.trim());
          }).observe(document.body, { childList: true, subtree: true, characterData: true });
        });
        await page.getByPlaceholder("What do you do?", { exact: true }).fill(said);
        await page.getByRole("button", { name: "Send game turn", exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => [...(window as unknown as { notices: Set<string> }).notices]), {
            timeout: 30_000,
          })
          .toEqual(expect.arrayContaining(notices.map((notice) => expect.stringMatching(notice))));
        await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText(shown, {
          timeout: 30_000,
        });
        return model.prompts.slice(before).find((body) => body.includes(said));
      };

      // Bought from the fence: a warming tonic, as far as the player can tell.
      await turn("I buy a tonic from the fence.", "We reach Barrowmere.", [/^You bought Warming tonic/]);
      await expect
        .poll(async () =>
          (await savedInventory(request, chatId))
            .filter((stack) => stack.item?.startsWith("kit/"))
            .map((stack) => `${stack.name} <${stack.item}> ${stack.quantity} ${stack.truly ?? ""}`),
        )
        .toEqual(["Warming tonic <kit/warming-tonic> 1 kit/bitter-tonic"]);
      await inventoryButton(page).click();
      await expect(page.getByText("Warming tonic", { exact: false }).first()).toBeVisible();
      await expect(page.locator("body")).not.toContainText("Bitter");
      // The inventory panel does not close on Escape; opening the game again leaves it.
      await openGame(page, chatId);
      await expect(page.locator('[data-component="GameNarration.ActivePanel"]')).toContainText("We reach Barrowmere.", {
        timeout: 30_000,
      });

      // The Game Master is told the truth on the next turn, and sells it to the honest chandler.
      const prompt = await turn("I sell the tonic to the chandler.", "The chandler squints.", [
        /^The buyer saw it was really Bitter tonic and paid 1 pennies\./,
      ]);
      expect(prompt).toContain("(FAKE: really Bitter tonic)");
      expect(prompt).toContain("A line marked FAKE is not what the party thinks it is");
      await expect
        .poll(
          async () => (await savedInventory(request, chatId)).filter((stack) => stack.item?.startsWith("kit/")).length,
        )
        .toBe(0);
    });
  } finally {
    if (connectionId) await request.delete(`/api/connections/${connectionId}`).catch(() => undefined);
    model.server.closeAllConnections();
    await new Promise<void>((resolve) => model.server.close(() => resolve()));
  }
});
