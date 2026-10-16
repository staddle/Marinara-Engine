/** Capability API 1.154: named rows the player adds, edits and removes in a guided builder step. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRulesetBuilder,
  defaultRulesetSheetBuild,
  parseRulesetDefinition,
  readRulesetBuilderState,
  rulesetBuilderOwnRows,
  rulesetBuilderRemaining,
  RULESET_CATALOG_ROW_KEY,
  type RulesetCatalogEntriesById,
  type RulesetDefinition,
  type RulesetSheetBuild,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-builder-rows-"));
const previous = { DATA_DIR: process.env.DATA_DIR, MARINARA_DATA_DIR: process.env.MARINARA_DATA_DIR };
process.env.DATA_DIR = dataDir;
process.env.MARINARA_DATA_DIR = dataDir;
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");
const base = () =>
  JSON.parse(readFileSync(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url), "utf8"));
const parse = (doc: unknown) => {
  const result = parseRulesetDefinition(doc);
  assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
  return result.definition;
};
const issuesOf = (doc: unknown) => {
  const result = parseRulesetDefinition(doc);
  return result.ok ? [] : result.issues;
};
const catalogsOf = (definition: RulesetDefinition): RulesetCatalogEntriesById =>
  Object.fromEntries((definition.catalogs ?? []).map((catalog) => [catalog.id, catalog.entries ?? []]));
const fixture = () => {
  const doc = base();
  doc.sheet.lists.push({
    id: "retainers",
    label: "Retainers",
    maxItems: 6,
    columns: [
      { id: "name", label: "Name", type: "text", maxLength: 80 },
      { id: "role", label: "Role", type: "text", maxLength: 80 },
      { id: "loyalty", label: "Loyalty", type: "number", min: 0, max: 12, default: 7 },
    ],
  });
  doc.sheet.builder = {
    steps: [
      { id: "feats", label: "Features", kind: "catalog", catalog: "feats", min: 0, max: 2 },
      {
        id: "retainers",
        label: "Retainers",
        kind: "rows",
        list: "retainers",
        required: ["name"],
        min: 2,
        max: 4,
        defaults: { role: "Hireling" },
      },
      { id: "notes", label: "Notes", kind: "rows", list: "features", columns: ["name", "text"] },
    ],
  };
  return doc;
};

try {
  const doc = fixture();
  const definition = parse(doc);
  const catalogs = catalogsOf(definition);
  const state = readRulesetBuilderState(undefined);
  const rowsOf = (build: RulesetSheetBuild, list: string) => (build.lists[list] ?? []) as Record<string, unknown>[];
  const withRows = (build: RulesetSheetBuild, list: string, rows: Record<string, unknown>[]) =>
    ({ ...build, lists: { ...build.lists, [list]: rows } }) as RulesetSheetBuild;

  // Nothing added yet: the step waits on two whole rows.
  let build = defaultRulesetSheetBuild(definition);
  assert.equal(rulesetBuilderRemaining(definition, build, state, catalogs).retainers, 2);
  assert.equal(rulesetBuilderRemaining(definition, build, state, catalogs).notes, 0);

  // Two retainers with the same name stay two rows through the builder.
  build = withRows(build, "retainers", [
    { name: "Ser Ash", role: "Hireling", loyalty: 7 },
    { name: "Ser Ash", role: "Torchbearer", loyalty: 9 },
  ]);
  let applied = applyRulesetBuilder(definition, build, state, catalogs);
  assert.equal(rowsOf(applied.build, "retainers").length, 2);
  assert.equal(rulesetBuilderRemaining(definition, applied.build, applied.state, catalogs).retainers, 0);

  // Rename one and reorder: each row is its own, found by where it sits.
  const renamed = rowsOf(applied.build, "retainers").map((row, index) =>
    index === 1 ? { ...row, name: "Brin" } : row,
  );
  applied = applyRulesetBuilder(
    definition,
    withRows(applied.build, "retainers", renamed.reverse()),
    applied.state,
    catalogs,
  );
  assert.deepEqual(
    rowsOf(applied.build, "retainers").map((row) => row.name),
    ["Brin", "Ser Ash"],
  );

  // Removing one keeps the other, and the step waits on a row again.
  applied = applyRulesetBuilder(
    definition,
    withRows(applied.build, "retainers", rowsOf(applied.build, "retainers").slice(1)),
    applied.state,
    catalogs,
  );
  assert.deepEqual(rowsOf(applied.build, "retainers"), [{ name: "Ser Ash", role: "Hireling", loyalty: 7 }]);
  assert.equal(rulesetBuilderRemaining(definition, applied.build, applied.state, catalogs).retainers, 1);

  // A row whose required cell is empty counts for nothing and is one more thing to do.
  applied = applyRulesetBuilder(
    definition,
    withRows(applied.build, "retainers", [...rowsOf(applied.build, "retainers"), { name: "", role: "Hireling" }]),
    applied.state,
    catalogs,
  );
  assert.equal(rulesetBuilderRemaining(definition, applied.build, applied.state, catalogs).retainers, 2);

  // Rows a pick wrote are the pick's: they are not the player's own, and unpicking takes back only them.
  const picked = applyRulesetBuilder(
    definition,
    withRows(applied.build, "features", [{ name: "Old wound", text: "Aches in the cold." }]),
    { ...applied.state, picks: { feats: ["second-effort"] } },
    catalogs,
  );
  const features = rowsOf(picked.build, "features");
  assert.equal(features.length, 2);
  assert.ok(features.some((row) => row[RULESET_CATALOG_ROW_KEY] === "feats/second-effort"));
  assert.deepEqual(
    rulesetBuilderOwnRows(picked.build, "features").map(({ row, index }) => [row.name, index]),
    [["Old wound", 0]],
  );
  const unpicked = applyRulesetBuilder(definition, picked.build, { ...picked.state, picks: { feats: [] } }, catalogs);
  assert.deepEqual(rowsOf(unpicked.build, "features"), [{ name: "Old wound", text: "Aches in the cold." }]);

  // The step is checked against the list it edits.
  const broken = (change: (step: Record<string, unknown>) => void) => {
    const next = fixture();
    change(next.sheet.builder.steps[1]);
    return issuesOf(next).join("; ");
  };
  assert.match(
    broken((step) => (step.list = "missing")),
    /Unknown list "missing"/,
  );
  assert.match(
    broken((step) => (step.columns = ["name", "missing"])),
    /Unknown column "missing"/,
  );
  assert.match(
    broken((step) => (step.columns = ["role"])),
    /"name" is not one of this step's columns/,
  );
  assert.match(
    broken((step) => (step.max = 7)),
    /holds at most 6 rows/,
  );
  assert.match(
    broken((step) => (step.min = 5)),
    /more rows than it lets the player add/,
  );
  assert.match(
    broken((step) => (step.defaults = { loyalty: "high" })),
    /takes a number/,
  );
  assert.match(
    broken((step) => (step.defaults = { missing: 1 })),
    /Unknown column "missing"/,
  );

  const manifest = (minor: number) => ({
    schemaVersion: 2,
    capabilityApi: { major: 1, minor },
    builtAgainst: { engineVersion: "2.4.6", engineCommit: "0".repeat(40) },
    id: "builder-rows",
    name: "Builder rows",
    version: "1.0.0",
    description: "Named rows proof",
    engine: { min: "2.4.6", maxExclusive: "4.0.0" },
    kind: ["ruleset"],
    entrypoints: {},
    contributions: { assets: { paths: ["ruleset.json"] } },
    files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
    permissions: [],
    restartRequired: false,
  });
  const issue = (minor: number, value: unknown) => getCapabilityPackageInstallIssue(manifest(minor) as any, value);
  assert.match(issue(153, doc) ?? "", /1\.154/);
  assert.equal(issue(154, doc), null);
  console.log("game-ruleset-builder-rows: passed");
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
}
