// #7407: app_data lorebook.entries pages like instruction.list. It used to ignore offset and
// return one bare array, so a 190-entry lorebook always came back as Session 1..100 (and over
// the read budget), leaving every later entry unreachable. Reported by bahaynes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mari-lorebook-entries-paging-"));
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = dir;
const { createFileNativeDB } = await import("../../../packages/server/src/db/file-backed-store.js");
const { MariDbService } = await import("../../../packages/server/src/services/mari-db/mari-db.service.js");
const { collectMariReferencedResources, countMariListOutput, mariBatchItems } =
  await import("../../../packages/client/src/lib/mari-referenced-resources.js");

// Mirrors MARI_READ_OUTPUT_BUDGET in mari-db.service.ts (pretty-printed chars).
const READ_BUDGET = 24_000;
const TOTAL = 190;
type EntryPage = {
  items: Array<{ id: string; name: string; description: string; keys: string[]; keysTruncated?: boolean }>;
  total: number;
  offset: number;
  nextOffset: number | null;
};

const db = await createFileNativeDB();
try {
  const mari = new MariDbService(db);
  const created = await mari.executeAction({
    action: "lorebook.create",
    lorebookId: "book",
    data: {
      name: "Campaign",
      entries: Array.from({ length: TOTAL }, (_, i) => ({
        name: `Session ${i + 1}`,
        content: `Revelation ${i + 1}. `.repeat(60).trim(),
        order: i,
      })),
    },
    apply: true,
  });
  assert.equal(created.ok, true, "the 190-entry lorebook is created");
  await mari.keepAppliedReview(created.approval?.id ?? "");

  const read = async (args: Record<string, unknown>) => {
    const result = await mari.executeAction({ action: "lorebook.entries", lorebookId: "book", ...args });
    assert.equal(result.ok, true, `lorebook.entries ${JSON.stringify(args)} succeeds`);
    assert.ok(!result.truncation?.truncated, `lorebook.entries ${JSON.stringify(args)} is not elided`);
    const page = result.output as EntryPage;
    assert.ok(Array.isArray(page.items), "the page is an { items, total, offset, nextOffset } envelope");
    assert.ok(
      JSON.stringify(page, null, 2).length <= READ_BUDGET,
      `lorebook.entries ${JSON.stringify(args)} stays under the read budget`,
    );
    return page;
  };

  const first = await read({});
  assert.equal(first.total, TOTAL, "the page reports the lorebook's true entry count");
  assert.equal(first.offset, 0, "the first page starts at offset 0");
  assert.equal(first.items[0]?.name, "Session 1", "the first page starts at the first entry");
  assert.ok(first.items.length > 1 && first.items.length < TOTAL, "a big lorebook needs more than one page");
  assert.equal(first.nextOffset, first.items.length, "a partial first page names where the next one starts");
  assert.ok(
    first.items.every((item) => !("keysTruncated" in item)),
    "an entry whose keys fit the index is not flagged",
  );

  // The chat's work card and entry links read the page's items.
  const step = {
    name: "app_data",
    status: "done",
    input: { action: "lorebook.entries", lorebookId: "book" },
    output: `stdout:\n${JSON.stringify(first, null, 2)}`,
  };
  assert.equal(countMariListOutput(step.output), first.items.length, "the work card counts the entries on the page");
  // A book created with its entries in one call: the step row counts them and names the first few.
  const batchOf = (names: unknown[]) => ({
    action: "lorebook.create",
    data: { entries: names.map((name) => ({ name })) },
  });
  assert.deepEqual(mariBatchItems(batchOf(["The Docks", "The Market", "The Keep", 4, "", "Old Town"])), {
    count: 6,
    names: "The Docks, The Market, …",
  });
  assert.deepEqual(mariBatchItems(batchOf([" The Docks "])), { count: 1, names: "The Docks" });
  assert.deepEqual(mariBatchItems(batchOf([1, 2])), { count: 2, names: "" });
  // The saved trace compacts the input (ten items, then "… N more"): the row reads the same after a reload.
  const { compactTraceValue } =
    await import("../../../packages/server/src/services/professor-mari/workspace-agent.service.js");
  const saved = compactTraceValue({
    action: "lorebook.create",
    data: {
      name: "Harbor Town",
      entries: Array.from({ length: 14 }, (_, i) => ({ name: `Place ${i + 1}`, content: "x" })),
    },
  });
  assert.deepEqual(mariBatchItems(saved), { count: 14, names: "Place 1, Place 2, …" });
  assert.equal(mariBatchItems({ action: "lorebook.create", data: { name: "Empty", entries: [] } }), null);
  assert.equal(mariBatchItems(step.input), null, "a call without a batch adds no fact");
  const entryRefs = collectMariReferencedResources([step]).filter((ref) => ref.kind === "lorebookEntry");
  assert.equal(entryRefs.length, first.items.length, "every entry on the page can be linked");
  assert.equal(entryRefs[0]?.name, "Session 1", "a linked entry keeps its name");
  assert.equal(entryRefs[0]?.parentId, "book", "a linked entry keeps its lorebook");

  // Walk every page to the end: each entry comes back exactly once, in order.
  const walked: string[] = [];
  const ids = new Set<string>();
  let cursor: number | null = 0;
  let pages = 0;
  while (cursor !== null) {
    const page = await read({ offset: cursor });
    assert.equal(page.offset, cursor, "each page reports the offset it starts at");
    assert.ok(page.items.length > 0, "every page before the end makes progress");
    for (const item of page.items) {
      walked.push(item.name);
      ids.add(item.id);
    }
    cursor = page.nextOffset;
    pages += 1;
    assert.ok(pages <= TOTAL, "paging terminates");
  }
  assert.deepEqual(
    walked,
    Array.from({ length: TOTAL }, (_, i) => `Session ${i + 1}`),
    "paging reaches every entry, in order, through the last one",
  );
  assert.equal(ids.size, TOTAL, "every entry across all pages has its own id");

  // The reporter's other calls: an explicit limit and offset are both honored.
  const tail = await read({ limit: 50, offset: 150 });
  assert.equal(tail.items[0]?.name, "Session 151", "offset skips to the requested entry");
  assert.equal(tail.items.at(-1)?.name, `Session ${TOTAL}`, "the last page ends at the last entry");
  assert.equal(tail.nextOffset, null, "the last page reports no next offset");
  const window = await read({ limit: 5, offset: 10 });
  assert.deepEqual(
    window.items.map((item) => item.name),
    ["Session 11", "Session 12", "Session 13", "Session 14", "Session 15"],
    "a small limit returns exactly that many entries from the offset",
  );
  assert.equal(window.nextOffset, 15, "a limited page names where the next one starts");
  // A fraction below 1 used to floor to an empty page whose nextOffset pointed back at itself.
  const fractional = await read({ limit: 0.5, offset: 10 });
  assert.equal(fractional.items[0]?.name, "Session 11", "a fractional limit still returns entries");
  assert.ok((fractional.nextOffset ?? TOTAL) > 10, "a fractional limit still moves paging forward");
  const pastEnd = await read({ offset: TOTAL + 10 });
  assert.deepEqual(pastEnd.items, [], "an offset past the end returns no entries");
  assert.equal(pastEnd.nextOffset, null, "an offset past the end reports no next offset");

  // The shell command `mari lorebooks entries` pages the same way.
  const cliFirst = await mari.executeCli({ argv: ["lorebooks", "entries", "book"] });
  assert.deepEqual(cliFirst.output, first, "the shell command returns the same first page");
  const cliTail = (
    await mari.executeCli({ argv: ["lorebooks", "entries", "book", "--offset", "150", "--limit", "50"] })
  ).output as EntryPage;
  assert.equal(cliTail.items[0]?.name, "Session 151", "the shell command honors --offset");
  assert.equal(cliTail.items.at(-1)?.name, `Session ${TOTAL}`, "the shell command reaches the last entry");
  assert.equal(cliTail.nextOffset, null, "the shell command's last page reports no next offset");
  const cliHelp = await mari.executeCli({ argv: ["lorebooks", "help"] });
  assert.match(String(cliHelp.output), /entries <lorebook-id> [^\n]*--offset <n>/, "the shell help lists --offset");

  // One entry with a huge description still fits the page: the index keeps a short preview.
  const heavy = await mari.executeAction({
    action: "lorebook.create",
    lorebookId: "heavy",
    data: {
      name: "Heavy",
      entries: [
        { name: "Long notes", description: "Notes. ".repeat(6_000), content: "Body.", order: 0 },
        {
          name: "Many keys",
          keys: Array.from({ length: 400 }, (_, i) => `key ${i} `.padEnd(120, "x")),
          content: "Body.",
          order: 1,
        },
        { name: "Long key", keys: ["k".repeat(140)], content: "Body.", order: 2 },
        {
          name: "Keys that fit",
          keys: Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(100, "y")),
          content: "Body.",
          order: 3,
        },
      ],
    },
    apply: true,
  });
  await mari.keepAppliedReview(heavy.approval?.id ?? "");
  const heavyPage = (await mari.executeAction({ action: "lorebook.entries", lorebookId: "heavy" })).output as EntryPage;
  assert.equal(heavyPage.items[0]?.name, "Long notes", "the heavy entry is listed with its name");
  assert.ok(heavyPage.items[0]!.description.length <= 200, "the index shortens a long description");
  assert.ok(JSON.stringify(heavyPage, null, 2).length <= READ_BUDGET, "a heavy entry's page stays under budget");
  const keyed = (
    (await mari.executeAction({ action: "lorebook.entries", lorebookId: "heavy", offset: 1 })).output as EntryPage
  ).items[0];
  assert.equal(keyed?.name, "Many keys", "an entry with a huge key list is listed with its name");
  assert.ok(keyed!.id, "an entry with a huge key list keeps its id");
  assert.ok(keyed!.keys.length <= 50, "the index shows a short preview of a long key list");
  assert.equal(keyed!.keysTruncated, true, "a key list cut short in the index is flagged");
  const [longKey, fitting] = (
    (await mari.executeAction({ action: "lorebook.entries", lorebookId: "heavy", offset: 2 })).output as EntryPage
  ).items;
  assert.equal(longKey?.name, "Long key");
  assert.equal(longKey!.keysTruncated, true, "a key shortened in the index is flagged");
  assert.equal(fitting?.name, "Keys that fit");
  assert.equal(fitting!.keys.length, 50, "50 keys of 100 characters are all shown");
  assert.ok(!("keysTruncated" in fitting!), "a key list shown in full is not flagged");
  const lastKey = await mari.executeAction({ action: "lorebook.getEntry", entryId: keyed!.id, field: "keys[399]" });
  assert.match(String(lastKey.output), /^key 399 /, "lorebook.getEntry still returns every key");
} finally {
  await db._fileStore.close();
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(dir, { recursive: true, force: true });
}
