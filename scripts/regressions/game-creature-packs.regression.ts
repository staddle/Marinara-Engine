/**
 * Creature packs in the library (design-game-creature-art.md):
 *
 *   - A pack is read strictly before it is kept: one id per sheet and per creature, every sheet a PNG of
 *     the size it says, every look's block (frames across, the four facings down) inside its sheet, and a
 *     sheet only ever its own picture (a data URL of base64). A name two creatures match is noted.
 *   - Saved from the maker or imported from a file, a pack is filed under `local/`; a version is never
 *     rewritten (the same bytes again are unchanged, different ones a conflict); the latest is served.
 *   - One pack is chosen for every fight; `GET /api/game-tile-packs/creatures` answers it, or none, and
 *     removing the chosen pack goes back to none.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCreaturePack, type CreaturePack } from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-creature-packs-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameCreaturePacksRoutes } = await import("../../packages/server/src/routes/game-creature-packs.routes.js");

/** A PNG's signature and header for a picture of this size (all the checks read). */
const png = (width: number, height: number) => {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt8(8, 24);
  bytes.writeUInt8(6, 25);
  return `data:image/png;base64,${bytes.toString("base64")}`;
};
const creature = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  match: [`5e-2014/creatures/${id}`, id],
  size: "medium",
  w: 1,
  h: 2,
  frames: 1,
  variants: [{ sheet: "s1", x: 0, y: 0 }],
  ...extra,
});
// One sheet 4 cells wide by 8 tall (48 px cells): a goblin's column (1 x 2 frames, 4 facings) at x 0, a
// wolf's (1 x 1) at x 1, an owlbear's (2 x 2) at x 2.
const pack = (extra: Record<string, unknown> = {}) =>
  ({
    creaturePackVersion: 1,
    id: "monsters",
    name: "Monsters",
    version: 1,
    tileSize: 48,
    sheets: [{ id: "s1", png: png(192, 384), width: 192, height: 384 }],
    creatures: [
      creature("goblin"),
      creature("wolf", { w: 1, h: 1, variants: [{ sheet: "s1", x: 1, y: 0 }] }),
      creature("owlbear", { size: "large", w: 2, h: 2, variants: [{ sheet: "s1", x: 2, y: 0 }] }),
    ],
    ...extra,
  }) as CreaturePack;
const issuesOf = (value: unknown) => {
  const read = parseCreaturePack(value);
  return read.ok ? [] : read.issues;
};

try {
  // ── The format ──
  const good = parseCreaturePack(pack());
  assert.ok(good.ok, JSON.stringify(good));
  assert.deepEqual(good.notes, []);
  assert.ok(parseCreaturePack(JSON.stringify(pack())).ok, "read from a file's text");
  assert.ok(issuesOf("{not json")[0]!.includes("not JSON"));
  const [sheet] = pack().sheets;
  assert.ok(
    issuesOf(
      pack({ sheets: [{ ...sheet, png: "data:image/png;base64,aGVsbG8gd29ybGQgaGVsbG8gd29ybGQ=" }] }),
    )[0]!.includes("is not a PNG"),
    "a sheet that is not a PNG",
  );
  assert.ok(
    issuesOf(pack({ sheets: [{ ...sheet, png: png(96, 384) }] }))[0]!.includes("is 96 by 384 pixels, not 192 by 384"),
    "a sheet not the size it says",
  );
  assert.ok(
    issuesOf(pack({ sheets: [{ ...sheet, png: "https://example.com/goblin.png" }] })).length,
    "an outside picture",
  );
  assert.ok(
    issuesOf(pack({ sheets: [{ ...sheet, png: `${png(192, 384)}"onerror="x` }] })).length,
    "anything after the base64",
  );
  assert.ok(issuesOf(pack({ sheets: [sheet, sheet] }))[0]!.includes('Two sheets are called "s1"'));
  assert.ok(
    issuesOf(pack({ creatures: [creature("goblin"), creature("goblin")] }))[0]!.includes(
      'Two creatures are called "goblin"',
    ),
  );
  assert.ok(
    issuesOf(pack({ creatures: [creature("goblin", { variants: [{ sheet: "s2", x: 0, y: 0 }] })] }))[0]!.includes(
      'no sheet "s2"',
    ),
  );
  // The block: frames across, four facings down. The owlbear's two cells wide fit at x 2, not at x 3;
  // four facings two cells tall fit from y 0, not from y 1; three walking frames do not fit at x 2.
  const past = (extra: Record<string, unknown>) =>
    issuesOf(pack({ creatures: [creature("owlbear", { size: "large", w: 2, h: 2, ...extra })] }));
  assert.deepEqual(past({ variants: [{ sheet: "s1", x: 2, y: 0 }] }), []);
  assert.ok(past({ variants: [{ sheet: "s1", x: 3, y: 0 }] })[0]!.includes("reaches past the edge"));
  assert.ok(past({ variants: [{ sheet: "s1", x: 2, y: 1 }] })[0]!.includes("reaches past the edge"));
  assert.ok(past({ frames: 3, variants: [{ sheet: "s1", x: 0, y: 0 }] })[0]!.includes("reaches past the edge"));
  assert.ok(
    past({
      variants: [
        { sheet: "s1", x: 2, y: 0 },
        { sheet: "s1", x: 3, y: 0 },
      ],
    })[0]!.includes("(look 2)"),
    "names the look",
  );
  const twice = parseCreaturePack(
    pack({ creatures: [creature("goblin"), creature("wolf", { match: ["Goblin!"], w: 1, h: 1 })] }),
  );
  assert.ok(twice.ok && twice.notes[0]!.includes('"Goblin!" is matched by "goblin" first'), "a name matched twice");
  assert.ok(issuesOf("x".repeat(32_000_001))[0]!.includes("too large"));

  // ── The library ──
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameCreaturePacksRoutes, { prefix: "/api/game-tile-packs/creatures" });
  try {
    const library = async () =>
      (await app.inject({ method: "GET", url: "/api/game-tile-packs/creatures/library" })).json();
    const chosen = async () => (await app.inject({ method: "GET", url: "/api/game-tile-packs/creatures" })).json();
    assert.deepEqual(await library(), { packs: [], selection: null });
    assert.deepEqual(await chosen(), { pack: null }, "no pack: fights keep their tokens");

    const save = (body: unknown) =>
      app.inject({ method: "POST", url: "/api/game-tile-packs/creatures", payload: { pack: body } });
    const saved = await save(pack());
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().pack, { id: "local/monsters", version: 1, name: "Monsters", creatures: 3 });
    assert.equal((await save(pack())).json().status, "unchanged");
    assert.equal((await save(pack({ name: "Other" }))).statusCode, 409, "a version is never rewritten");
    assert.equal((await save(pack({ version: 2, creatures: [creature("goblin")] }))).json().status, "added");
    const served = (
      await app.inject({ method: "GET", url: "/api/game-tile-packs/creatures/pack?id=local/monsters" })
    ).json().pack;
    assert.deepEqual([served.version, served.creatures.length], [2, 1], "the latest version");
    assert.equal((await save(served)).json().status, "unchanged", "saved back as it was read");
    assert.equal(
      (await save(pack({ sheets: [{ ...sheet, width: 96 }] }))).statusCode,
      400,
      "a pack that does not read",
    );
    assert.equal((await save(pack({ id: "a".repeat(78) }))).statusCode, 400, "an id too long to file");

    const file = JSON.stringify(pack({ id: "shared-monsters", name: "Shared" }), null, 2);
    const imported = await app.inject({
      method: "POST",
      url: "/api/game-tile-packs/creatures/import",
      payload: { definition: file },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().pack.id, "local/shared-monsters");
    assert.equal((await library()).packs.length, 2);

    // One pack for every fight, and back to none when it is removed.
    const choose = (packId: string | null) =>
      app.inject({ method: "PUT", url: "/api/game-tile-packs/creatures/selection", payload: { packId } });
    assert.equal((await choose("local/nothing")).statusCode, 404, "only a stored pack");
    assert.equal((await choose("local/shared-monsters")).json().selection, "local/shared-monsters");
    assert.equal((await library()).selection, "local/shared-monsters");
    const fight = (await chosen()).pack;
    assert.deepEqual(
      [fight.id, fight.creatures.map((each: { id: string }) => each.id)],
      ["local/shared-monsters", ["goblin", "wolf", "owlbear"]],
    );
    assert.equal((await choose(null)).json().selection, null);
    assert.deepEqual(await chosen(), { pack: null });
    await choose("local/shared-monsters");
    const removed = await app.inject({
      method: "DELETE",
      url: "/api/game-tile-packs/creatures?id=local/shared-monsters",
    });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(await chosen(), { pack: null }, "removing the chosen pack goes back to none");
    assert.equal((await library()).selection, null);
    assert.equal(
      (await app.inject({ method: "DELETE", url: "/api/game-tile-packs/creatures?id=local/shared-monsters" }))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
    await closeDB();
  }
  console.log("Creature packs: packs read strictly, and the library keeps, serves and chooses one for every fight.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
