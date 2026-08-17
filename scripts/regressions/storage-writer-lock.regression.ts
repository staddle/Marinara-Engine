import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDB, getDB } from "../../packages/server/src/db/connection.js";
import {
  createFileNativeDB,
  STORAGE_WRITER_LEASE_FILENAME,
  STORAGE_WRITER_OWNER_FILENAME,
  StorageWriterLeaseError,
} from "../../packages/server/src/db/file-backed-store.js";
import { appSettings, lorebookEntries, lorebooks } from "../../packages/server/src/db/schema/index.js";
import { getMariDbService } from "../../packages/server/src/services/mari-db/mari-db.service.js";

type LeaseRecord = {
  version: 1;
  pid: number;
  hostId: string | null;
  hostname: string;
  token: string;
  acquiredAt: string;
};

const previousStorageDir = process.env.FILE_STORAGE_DIR;
const tempDirs: string[] = [];

function useTempStorage(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `marinara-${label}-`));
  tempDirs.push(dir);
  process.env.FILE_STORAGE_DIR = dir;
  return dir;
}

function leasePath(dir: string) {
  return join(dir, STORAGE_WRITER_LEASE_FILENAME);
}

function ownerPath(dir: string) {
  return join(leasePath(dir), STORAGE_WRITER_OWNER_FILENAME);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function exitedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(child.pid);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return child.pid!;
}

try {
  // The ordinary lorebook path remains durable, while a second live writer
  // for the exact same root fails before loading or mutating any data.
  {
    const dir = useTempStorage("writer-lock");
    const db = await createFileNativeDB();
    const leaseTemplate = readJson<LeaseRecord>(ownerPath(dir));
    await assert.rejects(
      createFileNativeDB(),
      (error: unknown) =>
        error instanceof StorageWriterLeaseError &&
        error.message.includes(String(process.pid)) &&
        error.message.includes(dir),
      "a second live writer is rejected with owner and data-directory details",
    );

    const timestamp = "2026-08-14T00:00:00.000Z";
    await db
      .insert(lorebooks)
      .values({ id: "durable-book", name: "Durable Book", createdAt: timestamp, updatedAt: timestamp });
    await db.insert(lorebookEntries).values({
      id: "durable-entry",
      lorebookId: "durable-book",
      name: "Durable Entry",
      content: "Must survive",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db._fileStore.flush();
    await db._fileStore.close();
    assert.equal(existsSync(leasePath(dir)), false, "a clean close removes its verified lease");

    const externallyReleased = await createFileNativeDB();
    rmSync(leasePath(dir), { recursive: true });
    await externallyReleased._fileStore.close();

    // A same-host stale lock is reclaimed only after its PID is definitely
    // absent. Restricted hosts without a stable host ID deliberately require
    // manual stale-lock removal instead.
    if (leaseTemplate.hostId) {
      mkdirSync(leasePath(dir));
      writeFileSync(
        ownerPath(dir),
        JSON.stringify({
          ...leaseTemplate,
          pid: await exitedPid(),
          token: "stale-owner-token",
          acquiredAt: "2026-08-13T00:00:00.000Z",
        }),
      );
      const afterCrash = await createFileNativeDB();
      assert.notEqual(readJson<LeaseRecord>(ownerPath(dir)).token, "stale-owner-token");
      await afterCrash._fileStore.close();
    }

    // Counts are diagnostics only: a stale value cannot hide a valid row and
    // startup heals it from the rows actually loaded from disk.
    const manifestPath = join(dir, "manifest.json");
    const staleManifest = readJson<{ tables: Record<string, number> }>(manifestPath);
    staleManifest.tables.lorebook_entries = 0;
    writeFileSync(manifestPath, JSON.stringify(staleManifest, null, 2));
    const reopened = await createFileNativeDB();
    try {
      const entries = await reopened.select().from(lorebookEntries);
      assert.deepEqual(
        entries.map((entry) => entry.id),
        ["durable-entry"],
      );
      assert.equal(
        readJson<{ tables: Record<string, number> }>(manifestPath).tables.lorebook_entries,
        1,
        "startup repairs the stale diagnostic count",
      );
    } finally {
      await reopened._fileStore.close();
    }
  }

  // Closing rejects new writes, waits for a transaction that already started,
  // and lets that transaction finish while the lease is still held.
  {
    useTempStorage("writer-close-transaction");
    const db = await createFileNativeDB();
    let finishTransaction!: () => void;
    let transactionStarted!: () => void;
    const finishGate = new Promise<void>((resolve) => {
      finishTransaction = resolve;
    });
    const startedGate = new Promise<void>((resolve) => {
      transactionStarted = resolve;
    });
    const transaction = db.transaction(async (tx) => {
      await tx.insert(appSettings).values({ key: "tx-before-close", value: "one", updatedAt: "2026-08-14" });
      transactionStarted();
      await finishGate;
      await tx.insert(appSettings).values({ key: "tx-after-close", value: "two", updatedAt: "2026-08-14" });
    });
    await startedGate;
    const closing = db._fileStore.close();
    await assert.rejects(
      db.insert(appSettings).values({ key: "new-after-close", value: "blocked", updatedAt: "2026-08-14" }),
      /closing or closed/,
    );
    finishTransaction();
    await transaction;
    await closing;
    const reopened = await createFileNativeDB();
    assert.deepEqual((await reopened.select().from(appSettings)).map((row) => row.key).sort(), [
      "tx-after-close",
      "tx-before-close",
    ]);
    await reopened._fileStore.close();
  }

  // A shutdown write failure still removes the process-owned lease so the
  // next clean start is not blocked by a store that has already detached.
  {
    const dir = useTempStorage("writer-close-failure");
    let failWrites = false;
    const db = await createFileNativeDB({
      beforeTableWrite: () => {
        if (failWrites) throw new Error("forced shutdown write failure");
      },
    });
    await db.insert(appSettings).values({ key: "local", value: "two", updatedAt: "2026-08-14" });
    failWrites = true;
    await assert.rejects(db._fileStore.close(), /forced shutdown write failure/);
    assert.equal(existsSync(leasePath(dir)), false, "a failed close still releases its writer lease");
    await assert.rejects(
      db.insert(appSettings).values({ key: "after-close", value: "blocked", updatedAt: "2026-08-14" }),
      /closing or closed/,
    );
    await assert.rejects(db._fileStore.flush(), /closing or closed/);
    const reopened = await createFileNativeDB();
    await reopened._fileStore.close();
  }

  // The Professor Mari service follows the current DB identity after a clean
  // close/reopen instead of retaining a service bound to the closed store.
  {
    useTempStorage("mari-db-rebind");
    const firstDb = await getDB();
    const firstService = getMariDbService(firstDb);
    assert.strictEqual(getMariDbService(firstDb), firstService, "the same DB keeps one Mari service");
    await closeDB();
    const secondDb = await getDB();
    const secondService = getMariDbService(secondDb);
    assert.notStrictEqual(secondService, firstService, "Mari rebinds to the reopened DB");
    await closeDB();
  }

  console.info("Storage writer-lock regressions passed.");
} finally {
  await closeDB();
  if (previousStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageDir;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
