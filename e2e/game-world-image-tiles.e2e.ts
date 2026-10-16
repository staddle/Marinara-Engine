import { expect, test } from "@playwright/test";
import { deflateSync, crc32 } from "node:zlib";
import { createServer, type Server } from "node:http";
import { WORLD_GENERATOR_VERSION, WORLD_STARTER_KITS, compileGameWorld, parseWorldKit } from "@marinara-engine/shared";
import { openGame } from "./game-ruleset-fight-fixture.js";

/**
 * Image tile packs (Pixelforge image tiles), on screen: a pack of PNG sheets imported into the library and
 * chosen for its setting draws the overworld and the town, whole houses as sprites over their lots.
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
const gameWorld = { seed: 20261002, generatorVersion: WORLD_GENERATOR_VERSION, grounding: "expand" as const, brief };

/** A PNG of `width` by `height`, each pixel's RGBA from `colour(x, y)`. */
function pngOf(width: number, height: number, colour: (x: number, y: number) => number[]): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(colour(x, y), y * (width * 4 + 1) + 1 + x * 4);
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("an image pack chosen for its setting draws the overworld and the town", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  let chatId = "";
  let packId = "";
  try {
    // Grass, a street and the square in single cells; a house four cells by three.
    const sheet = pngOf(336, 144, (x, y) =>
      x < 48
        ? [70, 150, 70, 255]
        : x < 96
          ? [150, 130, 100, 255]
          : x < 144
            ? [180, 175, 165, 255]
            : y < 48 && x >= 288
              ? [0, 0, 0, 0]
              : [190, 80, 60, 255],
    );
    const people = pngOf(144, 384, (x, y) =>
      x % 48 < 8 || x % 48 >= 40 ? [0, 0, 0, 0] : y < 96 ? [20, 200, 220, 255] : [220, 200, 20, 255],
    );
    const edges = pngOf(384, 1440, (x) => (x < 192 ? [10, 60, 250, 255] : [240, 120, 10, 255]));
    // A town ground pattern two cells across, each cell a colour of its own.
    const PATTERN = [
      [60, 200, 60],
      [200, 60, 200],
    ];
    const ground = pngOf(96, 48, (x) => [...PATTERN[x >= 48 ? 1 : 0]!, 255]);
    const pack = {
      tilePackVersion: 2,
      id: "e2e-art",
      name: "E2E art",
      family: "fantasy",
      version: 1,
      tileSize: 48,
      sheets: [
        { id: "town", png: `data:image/png;base64,${sheet.toString("base64")}`, width: 336, height: 144 },
        // One walking person: its facing-down row a colour of its own, the other rows another.
        { id: "people", png: `data:image/png;base64,${people.toString("base64")}`, width: 144, height: 384 },
        // Edge blocks: water (left) and streets (right), each four cells by thirty (with the slanted corners and
        // curved runs) in a colour of its own.
        { id: "edges", png: `data:image/png;base64,${edges.toString("base64")}`, width: 384, height: 1440 },
        { id: "ground", png: `data:image/png;base64,${ground.toString("base64")}`, width: 96, height: 48 },
      ],
      characters: [{ id: "walker", sheet: "people", x: 0, y: 0 }],
      tiles: {
        grass: [{ sheet: "town", x: 0, y: 0 }],
        // A pattern: laid over the town's ground by position, not drawn as a sprite.
        town_ground: [{ sheet: "ground", x: 0, y: 0, w: 2, h: 1 }],
        street: [{ sheet: "town", x: 1, y: 0 }],
        square: [{ sheet: "town", x: 2, y: 0 }],
        house: [{ sheet: "town", x: 3, y: 0, w: 4, h: 3 }],
        edge_water: [{ sheet: "edges", x: 0, y: 0, w: 4, h: 30 }],
        edge_street: [{ sheet: "edges", x: 4, y: 0, w: 4, h: 30 }],
      },
    };
    const imported = await request.post("/api/game-tile-packs/import", { data: { definition: JSON.stringify(pack) } });
    expect(imported.ok(), await imported.text()).toBeTruthy();
    packId = (await imported.json()).pack.id as string;
    expect(
      (await request.put("/api/game-tile-packs/selection", { data: { family: "fantasy", packId } })).ok(),
    ).toBeTruthy();

    const created = await request.post("/api/chats", { data: { name: "Image town", mode: "game", characterIds: [] } });
    expect(created.ok()).toBeTruthy();
    chatId = ((await created.json()) as { id: string }).id;
    const meta = await request.patch(`/api/chats/${chatId}/metadata`, {
      data: {
        gameId: `image-${chatId}`,
        gameSessionStatus: "active",
        gameIntroPresented: true,
        gameImageAutoGenerationEnabled: false,
        enableAgents: false,
        enableTools: false,
        gameWorldKit: kit,
        gameWorld,
        gameTime: { day: 1, hour: 12, minute: 0 },
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
    await openGame(page, chatId);
    const overworld = page.getByRole("region", { name: "Overworld", exact: true });
    await expect(overworld).toHaveAttribute("data-tiles", "image", { timeout: 40_000 });
    await page.screenshot({ path: testInfo.outputPath("image-overworld.png") });
    const hasColour = (region: typeof overworld, rgb: number[]) =>
      region
        .locator("canvas")
        .first()
        .evaluate((canvas: HTMLCanvasElement, [r, g, b]) => {
          const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
          for (let at = 0; at < data.length; at += 4 * 3)
            if (Math.abs(data[at]! - r!) < 6 && Math.abs(data[at + 1]! - g!) < 6 && Math.abs(data[at + 2]! - b!) < 6)
              return true;
          return false;
        }, rgb);
    // The water drawn by its edge pieces.
    await expect.poll(() => hasColour(overworld, [10, 60, 250])).toBe(true);
    await page.getByRole("button", { name: /^Thornmere, .*: the party is here$/u }).click();
    await page.getByRole("button", { name: "Enter Thornmere", exact: true }).click();
    const town = page.getByRole("region", { name: "Town", exact: true });
    await expect(town).toHaveAttribute("data-tiles", "image");
    await page.screenshot({ path: testInfo.outputPath("image-town.png") });
    // The streets drawn by their edge pieces.
    await expect.poll(() => hasColour(town, [240, 120, 10])).toBe(true);
    // With street edges but no square edges, the square keeps its own tile.
    await expect.poll(() => hasColour(town, [180, 175, 165])).toBe(true);
    // The town's ground laid as its pattern, by position: every other column of ground cells one colour, the
    // rest the other, so the two show about as much (drawn as a sprite, one would cover nearly all).
    const counts = await town
      .locator("canvas")
      .first()
      .evaluate((canvas: HTMLCanvasElement, colours) => {
        const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
        const found = colours.map(() => 0);
        for (let at = 0; at < data.length; at += 4 * 3)
          colours.forEach(([r, g, b], index) => {
            if (Math.abs(data[at]! - r!) < 6 && Math.abs(data[at + 1]! - g!) < 6 && Math.abs(data[at + 2]! - b!) < 6)
              found[index]!++;
          });
        return found;
      }, PATTERN);
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(Math.max(...counts) / Math.min(...counts)).toBeLessThan(1.6);
    // Townsfolk drawn as the pack's walking person, facing down.
    await expect
      .poll(async () =>
        town
          .locator("canvas")
          .first()
          .evaluate((canvas: HTMLCanvasElement) => {
            const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
            for (let at = 0; at < data.length; at += 4 * 3)
              if (
                Math.abs(data[at]! - 20) < 6 &&
                Math.abs(data[at + 1]! - 200) < 6 &&
                Math.abs(data[at + 2]! - 220) < 6
              )
                return true;
            return false;
          }),
      )
      .toBe(true);
    // The house sprite's colour is on the town's canvas.
    await expect
      .poll(async () =>
        town
          .locator("canvas")
          .first()
          .evaluate((canvas: HTMLCanvasElement) => {
            const ctx = canvas.getContext("2d")!;
            const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
            for (let at = 0; at < data.length; at += 4 * 7)
              if (Math.abs(data[at]! - 190) < 6 && Math.abs(data[at + 1]! - 80) < 6 && Math.abs(data[at + 2]! - 60) < 6)
                return true;
            return false;
          }),
      )
      .toBe(true);
  } finally {
    if (chatId) await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    await request
      .put("/api/game-tile-packs/selection", { data: { family: "fantasy", packId: null } })
      .catch(() => undefined);
    if (packId) await request.delete(`/api/game-tile-packs?id=${encodeURIComponent(packId)}`).catch(() => undefined);
  }
});

test("a fringe spills a ground look past its cells onto the ground beside it", async ({ page, request }) => {
  test.setTimeout(180_000);
  const ids: string[] = [];
  const chats: string[] = [];
  try {
    const GRASS = [70, 150, 70];
    const sheet = pngOf(48, 48, () => [...GRASS, 255]);
    // A fringe whose every mask is whole: around any corner where grass meets other ground, the grass covers it.
    const masks = pngOf(192, 192, () => [255, 255, 255, 255]);
    const packOf = (id: string, fringe: boolean) => ({
      tilePackVersion: 2,
      id,
      name: id,
      family: "fantasy",
      version: 1,
      tileSize: 48,
      sheets: [
        { id: "grass", png: `data:image/png;base64,${sheet.toString("base64")}`, width: 48, height: 48 },
        ...(fringe
          ? [{ id: "masks", png: `data:image/png;base64,${masks.toString("base64")}`, width: 192, height: 192 }]
          : []),
      ],
      tiles: {
        grass: [{ sheet: "grass", x: 0, y: 0 }],
        ...(fringe ? { fringe_grass: [{ sheet: "masks", x: 0, y: 0, w: 4, h: 4 }] } : {}),
      },
    });
    // How much of the overworld is grass, drawn with each pack.
    const grassShare = async (pack: object) => {
      const imported = await request.post("/api/game-tile-packs/import", {
        data: { definition: JSON.stringify(pack) },
      });
      expect(imported.ok(), await imported.text()).toBeTruthy();
      const packId = (await imported.json()).pack.id as string;
      ids.push(packId);
      await request.put("/api/game-tile-packs/selection", { data: { family: "fantasy", packId } });
      const created = await request.post("/api/chats", { data: { name: "Fringe", mode: "game", characterIds: [] } });
      const chatId = ((await created.json()) as { id: string }).id;
      chats.push(chatId);
      await request.patch(`/api/chats/${chatId}/metadata`, {
        data: {
          gameId: `fringe-${chatId}`,
          gameSessionStatus: "active",
          gameIntroPresented: true,
          gameImageAutoGenerationEnabled: false,
          enableAgents: false,
          enableTools: false,
          gameWorldKit: kit,
          gameWorld,
          gameTime: { day: 1, hour: 12, minute: 0 },
        },
      });
      await openGame(page, chatId);
      const overworld = page.getByRole("region", { name: "Overworld", exact: true });
      await expect(overworld).toHaveAttribute("data-tiles", "image", { timeout: 40_000 });
      await page.waitForTimeout(500);
      return overworld
        .locator("canvas")
        .first()
        .evaluate((canvas: HTMLCanvasElement, [r, g, b]) => {
          const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
          let grass = 0;
          let all = 0;
          for (let at = 0; at < data.length; at += 4 * 5) {
            all++;
            if (Math.abs(data[at]! - r!) < 6 && Math.abs(data[at + 1]! - g!) < 6 && Math.abs(data[at + 2]! - b!) < 6)
              grass++;
          }
          return grass / all;
        }, GRASS);
    };
    const without = await grassShare(packOf("e2e-no-fringe", false));
    const withFringe = await grassShare(packOf("e2e-fringe", true));
    expect(without).toBeGreaterThan(0.05);
    expect(withFringe).toBeGreaterThan(without * 1.1);
  } finally {
    for (const chatId of chats) await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    await request
      .put("/api/game-tile-packs/selection", { data: { family: "fantasy", packId: null } })
      .catch(() => undefined);
    for (const id of ids)
      await request.delete(`/api/game-tile-packs?id=${encodeURIComponent(id)}`).catch(() => undefined);
  }
});

test("a seasonal tile is drawn in its season, the plain one otherwise", async ({ page, request }) => {
  test.setTimeout(180_000);
  const chats: string[] = [];
  let packId = "";
  try {
    const [SUMMER, WINTER] = [
      [70, 150, 70],
      [235, 240, 245],
    ];
    const sheet = pngOf(96, 48, (x) => [...(x < 48 ? SUMMER : WINTER)!, 255]);
    const pack = {
      tilePackVersion: 2,
      id: "e2e-seasons",
      name: "e2e-seasons",
      family: "fantasy",
      version: 1,
      tileSize: 48,
      sheets: [{ id: "grass", png: `data:image/png;base64,${sheet.toString("base64")}`, width: 96, height: 48 }],
      tiles: { grass: [{ sheet: "grass", x: 0, y: 0 }], "grass@winter": [{ sheet: "grass", x: 1, y: 0 }] },
    };
    const imported = await request.post("/api/game-tile-packs/import", { data: { definition: JSON.stringify(pack) } });
    expect(imported.ok(), await imported.text()).toBeTruthy();
    packId = (await imported.json()).pack.id as string;
    await request.put("/api/game-tile-packs/selection", { data: { family: "fantasy", packId } });
    const colours = async (day: number) => {
      const created = await request.post("/api/chats", { data: { name: "Seasons", mode: "game", characterIds: [] } });
      const chatId = ((await created.json()) as { id: string }).id;
      chats.push(chatId);
      await request.patch(`/api/chats/${chatId}/metadata`, {
        data: {
          gameId: `seasons-${chatId}`,
          gameSessionStatus: "active",
          gameIntroPresented: true,
          gameImageAutoGenerationEnabled: false,
          enableAgents: false,
          enableTools: false,
          gameWorldKit: kit,
          gameWorld,
          gameTime: { day, hour: 12, minute: 0 },
        },
      });
      await openGame(page, chatId);
      const overworld = page.getByRole("region", { name: "Overworld", exact: true });
      await expect(overworld).toHaveAttribute("data-tiles", "image", { timeout: 40_000 });
      await page.waitForTimeout(500);
      return overworld
        .locator("canvas")
        .first()
        .evaluate(
          (canvas: HTMLCanvasElement, wanted) => {
            const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
            const found = wanted.map(() => 0);
            for (let at = 0; at < data.length; at += 4 * 5)
              wanted.forEach(([r, g, b], index) => {
                if (
                  Math.abs(data[at]! - r!) < 6 &&
                  Math.abs(data[at + 1]! - g!) < 6 &&
                  Math.abs(data[at + 2]! - b!) < 6
                )
                  found[index]!++;
              });
            return found;
          },
          [SUMMER, WINTER],
        );
    };
    const [summerGrass, summerSnow] = await colours(1);
    expect(summerGrass).toBeGreaterThan(0);
    expect(summerSnow).toBe(0);
    const [winterGrass, winterSnow] = await colours(300);
    expect(winterSnow).toBeGreaterThan(0);
    expect(winterGrass).toBe(0);
  } finally {
    for (const chatId of chats) await request.delete(`/api/chats/${chatId}`).catch(() => undefined);
    await request
      .put("/api/game-tile-packs/selection", { data: { family: "fantasy", packId: null } })
      .catch(() => undefined);
    if (packId) await request.delete(`/api/game-tile-packs?id=${encodeURIComponent(packId)}`).catch(() => undefined);
  }
});
