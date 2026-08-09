import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatDocumentationRead,
  formatDocumentationSearch,
  readCanonicalDocumentation,
  searchCanonicalDocumentation,
} from "../../packages/server/src/services/professor-mari/documentation-tools.js";
import { parseAssistantWorkspaceAction } from "../../packages/server/src/services/professor-mari/workspace-agent.service.js";

const workspaceRoot = await mkdtemp(join(tmpdir(), "marinara-doc-tools-"));

try {
  await mkdir(join(workspaceRoot, "docs", "connections"), { recursive: true });
  await mkdir(join(workspaceRoot, "docs", "connections", "examples"), { recursive: true });
  await mkdir(join(workspaceRoot, "docs", "examples"), { recursive: true });
  await mkdir(join(workspaceRoot, "outside-docs"), { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "# Marinara Engine\n\nInstall the engine with pnpm.\n", "utf8");
  await writeFile(
    join(workspaceRoot, "docs", "connections", "proxy.md"),
    [
      "# Provider connections",
      "",
      "## Proxy timeout",
      "",
      "Increase the proxy timeout when a local provider needs longer to answer.",
      "Keep the connection URL unchanged.",
      "",
      "### Windows launcher",
      "",
      "The packaged launcher uses the same timeout setting.",
      "",
      "## API keys",
      "",
      "Store keys in the connection editor.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, "docs", "examples", "ignored.md"),
    "# Proxy timeout\n\nThis internal example must not be searched.",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, "docs", "connections", "examples", "nested-ignored.md"),
    "# Proxy timeout\n\nThis nested internal example must not be searched.",
    "utf8",
  );
  await writeFile(join(workspaceRoot, "outside-docs", "secret.md"), "# Internal secret\n", "utf8");
  await symlink(
    join(workspaceRoot, "outside-docs"),
    join(workspaceRoot, "docs", "connections", "linked-outside"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const searchResponse = await searchCanonicalDocumentation(workspaceRoot, "proxy timeout", 3);
  const results = searchResponse.results;
  assert.equal(searchResponse.truncated, false);
  assert.equal(results[0]?.path, "docs/connections/proxy.md");
  assert.equal(results[0]?.heading, "Proxy timeout");
  assert.match(results[0]?.excerpt ?? "", /local provider/u);
  assert.ok(results.every((result) => !result.path.includes("examples")));

  const formattedSearch = formatDocumentationSearch("proxy timeout", searchResponse);
  assert.match(formattedSearch, /Source: docs\/connections\/proxy\.md/u);
  assert.match(formattedSearch, /Heading: Proxy timeout/u);
  assert.doesNotMatch(formattedSearch, /safe corpus limit/u);

  const secretSearch = await searchCanonicalDocumentation(workspaceRoot, "internal secret", 3);
  assert.equal(secretSearch.results.length, 0);

  const section = await readCanonicalDocumentation(workspaceRoot, "docs/connections/proxy.md", "Proxy timeout", 1_000);
  assert.match(section.content, /Increase the proxy timeout/u);
  assert.match(section.content, /packaged launcher/u);
  assert.doesNotMatch(section.content, /Store keys/u);
  assert.match(formatDocumentationRead(section), /Source: docs\/connections\/proxy\.md/u);

  const readmeResults = await searchCanonicalDocumentation(workspaceRoot, "install engine", 3);
  assert.equal(readmeResults.results[0]?.path, "README.md");

  await writeFile(join(workspaceRoot, "README.md"), "x".repeat(1024 * 1024 + 1), "utf8");
  const oversizedReadmeSearch = await searchCanonicalDocumentation(workspaceRoot, "local provider timeout", 3);
  assert.equal(oversizedReadmeSearch.results[0]?.path, "docs/connections/proxy.md");
  assert.equal(oversizedReadmeSearch.truncated, true);
  assert.match(formatDocumentationSearch("local provider timeout", oversizedReadmeSearch), /safe corpus limit/u);

  await assert.rejects(() => readCanonicalDocumentation(workspaceRoot, "../outside.md"), /must be README\.md/u);
  await assert.rejects(
    () => readCanonicalDocumentation(workspaceRoot, "docs/connections/proxy.md", "Missing heading"),
    /Heading not found/u,
  );
  await assert.rejects(
    () => readCanonicalDocumentation(workspaceRoot, "docs/connections/examples/nested-ignored.md"),
    /outside the canonical user documentation set/u,
  );
  await assert.rejects(
    () => readCanonicalDocumentation(workspaceRoot, "docs/connections/linked-outside/secret.md"),
    /escapes the canonical documentation boundary/u,
  );

  const jsonAction = parseAssistantWorkspaceAction(
    JSON.stringify({
      say: "",
      commands: [{ name: "docs_search", arguments: { query: "proxy timeout" } }],
      stop: false,
    }),
  );
  assert.equal(jsonAction.commands[0]?.name, "docs_search");
  assert.deepEqual(jsonAction.commands[0]?.arguments, { query: "proxy timeout" });

  const textualAction = parseAssistantWorkspaceAction(
    '<docs_read>{"path":"docs/connections/proxy.md","heading":"Proxy timeout"}</docs_read>',
  );
  assert.equal(textualAction.commands[0]?.name, "docs_read");
  assert.equal(textualAction.commands[0]?.arguments.heading, "Proxy timeout");

  const linkedWorkspaceRoot = await mkdtemp(join(tmpdir(), "marinara-doc-tools-linked-workspace-"));
  const externalDocsRoot = await mkdtemp(join(tmpdir(), "marinara-doc-tools-external-docs-"));
  try {
    await writeFile(join(linkedWorkspaceRoot, "README.md"), "# Linked docs test\n", "utf8");
    await writeFile(join(externalDocsRoot, "secret.md"), "# External corpus secret\n", "utf8");
    await symlink(
      externalDocsRoot,
      join(linkedWorkspaceRoot, "docs"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const linkedDocsSearch = await searchCanonicalDocumentation(linkedWorkspaceRoot, "external corpus secret", 3);
    assert.equal(linkedDocsSearch.results.length, 0);
    assert.equal(linkedDocsSearch.truncated, true);
  } finally {
    await rm(linkedWorkspaceRoot, { recursive: true, force: true });
    await rm(externalDocsRoot, { recursive: true, force: true });
  }

  console.log("Professor Mari documentation regression passed");
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
