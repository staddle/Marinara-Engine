// A native character or persona export streams its whole gallery into one .marinara.json (#7115), so it can be
// larger than the 256 MiB JSON import request. Such a file is uploaded to /api/import/marinara-package instead,
// where it is read in pieces no larger than one JavaScript string has to hold.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
const dataDir = process.env.DATA_DIR!;
assert.ok(dataDir, "the regression runner provides a throwaway DATA_DIR");

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { default: multipart } = await import("../../packages/server/node_modules/@fastify/multipart/index.js");
const { characterDataSchema } = await import("../../packages/shared/src/index.ts");
const { closeDB, getDB } = await import("../../packages/server/src/db/connection.js");
const { errorHandler } = await import("../../packages/server/src/middleware/error-handler.js");
const { charactersRoutes } = await import("../../packages/server/src/routes/characters.routes.js");
const { importRoutes } = await import("../../packages/server/src/routes/import.routes.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { createCharacterGalleryStorage } =
  await import("../../packages/server/src/services/storage/character-gallery.storage.js");
const { parseJsonBytes } = await import("../../packages/server/src/utils/large-json.js");

// ── The piecewise parser gives JSON.parse's result, including when every container is split. ──
const samples = [
  { a: 'quote " and backslash \\ and , : { } [ ] inside strings', b: [1, -2.5e3, true, false, null, "é ✓ 🎲"] },
  [[[]], {}, [{ "": "" }], "\u0000\u001f", { nested: { deeper: [{ x: "y" }, [1, [2, [3]]]] } }],
  { __proto__: { polluted: true }, constructor: "plain", type: "marinara_character", data: { gallery: [] } },
];
for (const sample of samples) {
  for (const space of [0, 2]) {
    const text = JSON.stringify(sample, null, space);
    for (const piece of [1, 8, 64, 1 << 20]) {
      const parsed = parseJsonBytes(Buffer.from(text), piece);
      assert.deepEqual(parsed, JSON.parse(text), `pieces of ${piece} bytes: ${text.slice(0, 40)}`);
    }
  }
}
const protoKey = parseJsonBytes(Buffer.from('{"__proto__":{"polluted":true},"x":1}'), 4) as Record<string, unknown>;
assert.equal(Object.getPrototypeOf(protoKey), Object.prototype, "a __proto__ key stays data");
assert.deepEqual(Object.keys(protoKey), ["__proto__", "x"]);
assert.equal(({} as Record<string, unknown>).polluted, undefined);
assert.deepEqual(parseJsonBytes(Buffer.from('﻿ {"a": [1, 2]} \n'), 4), { a: [1, 2] }, "a BOM is ignored");
for (const broken of [
  '{"a":1,}',
  '{"a" 1, "b": 2}',
  "[1,,2]",
  '{"a":[1,2}',
  '{"a":"1}',
  "[1,2]]",
  '{"a":1} x',
  "{a:1}",
]) {
  assert.throws(() => JSON.parse(broken), SyntaxError);
  assert.throws(() => parseJsonBytes(Buffer.from(broken), 2), SyntaxError, `rejects ${broken}`);
}

// ── A real native export imports back through the package route with every gallery image. ──
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const db = await getDB();
const app = Fastify();
app.decorate("db", db);
app.setErrorHandler(errorHandler);
await app.register(multipart);
await app.register(charactersRoutes, { prefix: "/api/characters" });
await app.register(importRoutes, { prefix: "/api/import" });
const upload = (bytes: Buffer, filename: string) => {
  const boundary = "marinara-large-native-json";
  return app.inject({
    method: "POST",
    url: "/api/import/marinara-package",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="timestampOverrides"\r\n\r\n` +
          `{"createdAt":1700000000000,"updatedAt":1700000000000}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          "Content-Type: application/json\r\n\r\n",
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
};
try {
  const characters = createCharactersStorage(db);
  const gallery = createCharacterGalleryStorage(db);
  const character = (await characters.create(characterDataSchema.parse({ name: "Gallery Keeper" })))!;
  const folder = join(dataDir, "gallery", "characters", character.id);
  await mkdir(folder, { recursive: true });
  const hashes = new Set<string>();
  for (let index = 0; index < 3; index++) {
    const bytes = Buffer.concat([PNG_SIGNATURE, randomBytes(32 * 1024)]);
    await writeFile(join(folder, `image-${index}.png`), bytes);
    hashes.add(sha(bytes));
    await gallery.create({ characterId: character.id, filePath: `characters/${character.id}/image-${index}.png` });
  }

  const exported = await app.inject({ method: "GET", url: `/api/characters/${character.id}/export` });
  assert.equal(exported.statusCode, 200, exported.body);
  const exportBytes = exported.rawPayload;
  // Split down to single gallery items, as a file over the string limit would be read.
  assert.deepEqual(parseJsonBytes(exportBytes, 1024), JSON.parse(exportBytes.toString("utf8")));

  const imported = await upload(exportBytes, "Gallery Keeper.marinara.json");
  assert.equal(imported.statusCode, 200, imported.body);
  const result = imported.json();
  assert.equal(result.success, true, imported.body);
  const importedChar = (await characters.getById(result.id))!;
  assert.equal(JSON.parse(importedChar.data).name, "Gallery Keeper");
  assert.equal(importedChar.createdAt, new Date(1700000000000).toISOString(), "upload timestamps still apply");
  const rows = await gallery.listByCharacterId(result.id);
  assert.equal(rows.length, 3, "every gallery image comes back");
  for (const row of rows) assert.ok(hashes.has(sha(await readFile(join(dataDir, "gallery", row.filePath)))));

  const notJson = await upload(Buffer.from("plain text"), "notes.txt");
  assert.equal(notJson.statusCode, 400);
  assert.match(notJson.json().error, /zip signature missing/);
  const brokenJson = await upload(Buffer.from('{"type":"marinara_character",'), "broken.marinara.json");
  assert.equal(brokenJson.statusCode, 400);
  console.info("Large native JSON import regression passed");
} finally {
  await app.close();
  await closeDB();
}
