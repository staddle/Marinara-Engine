// ──────────────────────────────────────────────
// Professor Mari workspace tool commands
// ──────────────────────────────────────────────
import { constants, existsSync } from "node:fs";
import { copyFile, link, mkdir, readdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { executeMariDecisionAction, withMariDecisionContext } from "./decision-authoring.js";
import { getFileStorageDir, getMonorepoRoot, getPort, getServerProtocol } from "../../config/runtime-config.js";
import { DATA_DIR } from "../../utils/data-dir.js";
import { logger } from "../../lib/logger.js";
import {
  formatDocumentationRead,
  formatDocumentationSearch,
  readCanonicalDocumentation,
  searchCanonicalDocumentation,
} from "./documentation-tools.js";
import { type MariPermissionsMode } from "@marinara-engine/shared";
import type { MariWorkspaceActionResult, MariDependencyTarget, MariWorkspaceTraceItem } from "@marinara-engine/shared";
import { getMariDbService } from "../mari-db/mari-db.service.js";
import { mariWorkspaceSessionId } from "./mari-session.js";
import {
  elideDataUrls,
  listCapabilityMariActions,
  runCapabilityMariAction,
} from "../capability-packages/capability-mari-actions.service.js";
import {
  detectUnreviewedSensitiveChanges,
  restoreReplacedStoreLinks,
  getWorkspaceShellSandboxStatus,
  killSandboxedProcessTree,
  snapshotSensitiveWorkspaceFiles,
  spawnWorkspaceSandboxedShell,
  type SensitiveScanResult,
  type SensitiveWorkspaceSnapshot,
} from "./workspace-shell-sandbox.js";
import { personalServerExtensionRuntime } from "../extensions/personal-server-extension-runtime.js";
import {
  BUILD_OUTPUT_WRITE_REFUSAL,
  bashCommandTargetsSensitivePath,
  bashCommandWritesBuildOutput,
  isPackageManagerMutationCommand,
  WorkspaceChangeReviewService,
  workspacePathAccessPolicy,
} from "./workspace-change-review.service.js";

import {
  CODE_CHECK_TIMEOUT_SECONDS,
  COMMAND_FILE_READ_LIMIT,
  COMMAND_OUTPUT_LIMIT,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  MARI_DRY_RUN_SENTINEL,
  MAX_BASH_TIMEOUT_SECONDS,
  MAX_PARALLEL_READONLY_COMMANDS,
  MAX_WALK_ENTRIES,
  type PromptEventSink,
  READ_BACK_MISMATCH_SENTINEL,
  READ_BACK_VERIFIED_SENTINEL,
  RUNTIME_API_KEY,
  SKIPPED_DIRS,
  STAGED_SENSITIVE_CHANGE_PREFIX,
  type WorkspaceCommandCall,
  type WorkspaceCommandExecution,
  type WorkspaceCommandResult,
  booleanArg,
  buildMariFailedActionResult,
  buildMariWorkspaceActionResult,
  commandEmbedsMariCliMutation,
  compactMutationResult,
  compactOutput,
  engineLineText,
  formatMariReadTruncation,
  globToRegExp,
  isMariCodeCheckArgv,
  isMutatingWorkspaceCommand,
  isReadOnlyWorkspaceCommand,
  isRecord,
  isWithin,
  normalizeSlashPath,
  numberArg,
  packageServiceInput,
  parseDirectMariArgv,
  powershellQuote,
  prependPathEntry,
  shellQuote,
  stringArg,
  stringifyOutput,
  upsertTraceTool,
  windowsShellCompatibilityIssue,
  workspaceCommandValidationIssue,
  workspaceMutationTargetForPath,
} from "./workspace-agent.service.js";

export type WorkspaceRunScope = {
  permissionsMode: MariPermissionsMode;
  manualSilentMutationBlocked: boolean;
  askLatchSilentMutationBlocked: boolean;
  decisionContext: { db: FastifyInstance["db"]; chatId: string; userMessageId: string } | null;
};

/**
 * Professor Mari's workspace tool commands. Long-lived state (workspace root, change reviews and
 * the single mutation queue) lives here; run-scoped state is read through `getRun` at call time.
 */
export class WorkspaceCommands {
  workspaceRoot = getMonorepoRoot();
  readonly workspaceChangeReviews = new WorkspaceChangeReviewService(this.workspaceRoot);
  // Professor Mari is the only untrusted workspace writer. Serialize all of
  // her mutations so path validation and the operation cannot overlap another
  // agent mutation; user and host processes remain outside this sandbox boundary.
  private workspaceMutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: FastifyInstance,
    private readonly getRun: () => WorkspaceRunScope,
  ) {}

  setWorkspaceRoot(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.workspaceChangeReviews.setWorkspaceRoot(this.workspaceRoot);
  }

  async executeWorkspaceCommandBatch(
    commands: WorkspaceCommandCall[],
    signal: AbortSignal,
    trace: MariWorkspaceTraceItem[],
    onEvent: PromptEventSink,
    actionResults: MariWorkspaceActionResult[],
  ): Promise<WorkspaceCommandResult[]> {
    const results: WorkspaceCommandResult[] = [];
    for (let index = 0; index < commands.length;) {
      const command = commands[index]!;
      if (!isReadOnlyWorkspaceCommand(command)) {
        results.push(await this.executeWorkspaceCommand(command, signal, trace, onEvent, actionResults));
        index += 1;
        continue;
      }
      const group: WorkspaceCommandCall[] = [];
      while (
        index < commands.length &&
        group.length < MAX_PARALLEL_READONLY_COMMANDS &&
        isReadOnlyWorkspaceCommand(commands[index]!)
      ) {
        group.push(commands[index]!);
        index += 1;
      }
      results.push(
        ...(await Promise.all(
          group.map((entry) => this.executeWorkspaceCommand(entry, signal, trace, onEvent, actionResults)),
        )),
      );
    }
    return results;
  }

  async executeWorkspaceCommand(
    command: WorkspaceCommandCall,
    signal: AbortSignal,
    trace: MariWorkspaceTraceItem[],
    onEvent: PromptEventSink,
    actionResults: MariWorkspaceActionResult[],
  ): Promise<WorkspaceCommandResult> {
    const input = command.arguments;
    const startedAt = Date.now();
    upsertTraceTool(trace, {
      id: command.id,
      name: command.name,
      status: "running",
      input,
      output: null,
      startedAt,
      updatedAt: startedAt,
    });
    onEvent({ type: "tool_start", data: { id: command.id, name: command.name, input } });
    try {
      const run = async () => {
        signal.throwIfAborted();
        // #5725 Plan mode: a hard server-side floor, not a prompt suggestion.
        // Dry-run previews (apply:false) are read-only and stay allowed.
        if (this.getRun().permissionsMode === "plan" && isMutatingWorkspaceCommand(command)) {
          throw new Error(
            "Plan mode is active: do not stage changes. Describe the exact edits you would make in chat (app_data with apply:false is available for validated previews); the user can switch modes from the Mari panel or Settings.",
          );
        }
        // #5725 Manual mode floor: silent mutating frames need a preceding
        // approved deferral - otherwise describe-and-ask first.
        if (this.getRun().manualSilentMutationBlocked && isMutatingWorkspaceCommand(command)) {
          throw new Error(
            "Manual mode is active: describe the change you intend in say WITH the commands in the same response; Marinara will hold them and show the user an Accept action. Apply only after they approve.",
          );
        }
        // #5748 ask-latch floor: this run already asked the user whether to
        // apply, so the answer must come from them - a silent mutating frame
        // in a later round cannot be it.
        if (this.getRun().askLatchSilentMutationBlocked && isMutatingWorkspaceCommand(command)) {
          throw new Error(
            "You already asked the user for approval in this run, so only their reply or Accept can answer it. Describe the change in say WITH the commands in the same response; Marinara will hold them and show the user an Accept action.",
          );
        }
        const validationIssue = workspaceCommandValidationIssue(command);
        if (validationIssue) throw new Error(validationIssue);
        const context = this.getRun().decisionContext;
        return context
          ? withMariDecisionContext(context, () => this.runWorkspaceCommand(command, signal))
          : this.runWorkspaceCommand(command, signal);
      };
      const execution = isReadOnlyWorkspaceCommand(command) ? await run() : await this.serializeWorkspaceMutation(run);
      const output = typeof execution === "string" ? execution : execution.output;
      const compacted = compactOutput(output);
      const endedAt = Date.now();
      upsertTraceTool(trace, {
        id: command.id,
        name: command.name,
        status: "done",
        output: compacted,
        startedAt,
        updatedAt: endedAt,
      });
      onEvent({
        type: "tool_end",
        data: {
          id: command.id,
          name: command.name,
          isError: false,
          output: compacted,
          durationMs: endedAt - startedAt,
        },
      });
      if (typeof execution !== "string" && execution.actionResult) {
        actionResults.push(execution.actionResult);
        onEvent({ type: "metadata", data: { actionResult: execution.actionResult } });
      }
      return { id: command.id, name: command.name, input, output: compacted, success: true };
    } catch (err) {
      const output = err instanceof Error ? err.message : String(err);
      const endedAt = Date.now();
      // Slice 87: an apply that did not save leaves its "Not saved" card on the message.
      const failed =
        err instanceof Error ? (err as { actionResult?: MariWorkspaceActionResult }).actionResult : undefined;
      if (failed) {
        actionResults.push(failed);
        onEvent({ type: "metadata", data: { actionResult: failed } });
      }
      upsertTraceTool(trace, {
        id: command.id,
        name: command.name,
        status: "error",
        output,
        startedAt,
        updatedAt: endedAt,
      });
      onEvent({
        type: "tool_end",
        data: { id: command.id, name: command.name, isError: true, output, durationMs: endedAt - startedAt },
      });
      return { id: command.id, name: command.name, input, output, success: false };
    }
  }

  async serializeWorkspaceMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.workspaceMutationTail;
    let release!: () => void;
    this.workspaceMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async runWorkspaceCommand(
    command: WorkspaceCommandCall,
    signal: AbortSignal,
  ): Promise<WorkspaceCommandExecution | string> {
    switch (command.name) {
      case "docs_search": {
        const query = stringArg(command.arguments, "query");
        const limit = numberArg(command.arguments, "limit", 5, 1, 8);
        return formatDocumentationSearch(query, await searchCanonicalDocumentation(this.workspaceRoot, query, limit));
      }
      case "docs_read":
        return formatDocumentationRead(
          await readCanonicalDocumentation(
            this.workspaceRoot,
            stringArg(command.arguments, "path"),
            stringArg(command.arguments, "heading") || undefined,
            numberArg(command.arguments, "maxChars", 8_000, 1_000, 16_000),
          ),
        );
      case "read":
        return this.commandRead(command.arguments);
      case "ls":
        return this.commandLs(command.arguments);
      case "find":
        return this.commandFind(command.arguments);
      case "grep":
        return this.commandGrep(command.arguments);
      case "write":
        return this.commandWrite(command.arguments);
      case "edit":
        return this.commandEdit(command.arguments);
      case "copy":
        return this.commandCopy(command.arguments);
      case "move":
        return this.commandMove(command.arguments);
      case "remove":
        return this.commandRemove(command.arguments);
      case "dependency":
        return this.commandDependency(command.arguments);
      case "app_data":
        return this.commandAppData(command.arguments);
      case "package_service":
        return this.commandPackageService(command.arguments, signal);
      case "bash":
        return this.commandBash(command.arguments, signal);
      default:
        return `Unknown workspace command: ${(command as WorkspaceCommandCall).name}`;
    }
  }

  private resolveWorkspacePath(inputPath: string, options: Parameters<typeof workspaceMutationTargetForPath>[2] = {}) {
    return this.resolveWorkspaceMutationTarget(inputPath, options).absolute;
  }

  private resolveWorkspaceMutationTarget(
    inputPath: string,
    options: Parameters<typeof workspaceMutationTargetForPath>[2] = {},
  ): { absolute: string; sensitiveTarget: string | null } {
    return workspaceMutationTargetForPath(this.workspaceRoot, inputPath, options);
  }

  private displayPath(absolute: string) {
    const rel = relative(this.workspaceRoot, absolute) || ".";
    return normalizeSlashPath(rel);
  }

  private storageTableReadWarning(absolute: string): string | null {
    const tablesRoot = resolve(getFileStorageDir(), "tables");
    if (!isWithin(tablesRoot, absolute) || !absolute.endsWith(".json")) return null;
    return [
      "Warning: this is a raw file-backed storage table, not parsed app data.",
      "JSON columns in this file are intentionally serialized strings.",
      "Use mari db, mari characters get/search, mari personas, or mari lorebooks for parsed data, and never pass a storage table file to --json-file.",
    ].join(" ");
  }

  private storageTableJsonFileIssue(command: string): string | null {
    if (!/\bmari\b/i.test(command) || !/--(?:json-file|file)\b/i.test(command)) return null;
    const normalized = normalizeSlashPath(command);
    const tablesRoot = normalizeSlashPath(resolve(getFileStorageDir(), "tables"));
    const tablesRel = normalizeSlashPath(relative(this.workspaceRoot, resolve(getFileStorageDir(), "tables")));
    if (
      !normalized.includes("data/storage/tables/") &&
      !normalized.includes(tablesRoot) &&
      !normalized.includes(tablesRel)
    ) {
      return null;
    }
    return "Do not pass DATA_DIR/storage/tables/*.json to mari --json-file/--file. Those are full raw table exports; create a temp file containing one row/card payload instead.";
  }

  private async commandRead(args: Record<string, unknown>): Promise<string> {
    const filePath = this.resolveWorkspacePath(stringArg(args, "path"), { readOnly: true });
    const stats = await stat(filePath);
    if (!stats.isFile()) throw new Error("read path must be a file");
    if (stats.size > COMMAND_FILE_READ_LIMIT) {
      return `File ${this.displayPath(filePath)} is ${stats.size} bytes; refusing to read more than ${COMMAND_FILE_READ_LIMIT} bytes. Use grep or a narrower file.`;
    }
    const text = await readFile(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    const offset = numberArg(args, "offset", 1, 1, Math.max(1, lines.length));
    const limit = numberArg(args, "limit", 2000, 1, 2000);
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const endLine = offset + selected.length - 1;
    const truncated = endLine < lines.length;
    return [
      `File: ${this.displayPath(filePath)}`,
      `Lines: ${offset}-${endLine} of ${lines.length}${truncated ? " (truncated)" : ""}`,
      this.storageTableReadWarning(filePath),
      "",
      selected.map((line, index) => `${offset + index}: ${line}`).join("\n"),
    ]
      .filter((part): part is string => part !== null)
      .join("\n");
  }

  private async commandLs(args: Record<string, unknown>): Promise<string> {
    const dirPath = this.resolveWorkspacePath(stringArg(args, "path", "."), { readOnly: true });
    const stats = await stat(dirPath);
    if (!stats.isDirectory()) throw new Error("ls path must be a directory");
    const limit = numberArg(args, "limit", 500, 1, 1000);
    const entries = await readdir(dirPath, { withFileTypes: true });
    const names = entries
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, limit);
    const truncated = entries.length > names.length;
    return [
      `Directory: ${this.displayPath(dirPath)}`,
      ...names,
      truncated ? `… ${entries.length - names.length} more` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async walkFiles(root: string, limit = MAX_WALK_ENTRIES): Promise<string[]> {
    const files: string[] = [];
    const visit = async (dir: string) => {
      if (files.length >= limit) return;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= limit) return;
        if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
        const absolute = join(dir, entry.name);
        if (workspacePathAccessPolicy(this.workspaceRoot, absolute) === "forbidden") continue;
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) files.push(absolute);
      }
    };
    await visit(root);
    return files;
  }

  private matchesGlob(absolute: string, glob: string): boolean {
    const rel = normalizeSlashPath(relative(this.workspaceRoot, absolute));
    const base = normalizeSlashPath(relative(dirname(absolute), absolute));
    const pattern = glob || "**/*";
    const patterns = pattern.startsWith("**/") ? [pattern, pattern.slice(3)] : [pattern];
    return patterns.some((candidate) => {
      const matcher = globToRegExp(candidate);
      return matcher.test(rel) || matcher.test(base);
    });
  }

  private async commandFind(args: Record<string, unknown>): Promise<string> {
    const root = this.resolveWorkspacePath(stringArg(args, "path", "."), { readOnly: true });
    const stats = await stat(root);
    const pattern = stringArg(args, "pattern", "**/*");
    const limit = numberArg(args, "limit", 1000, 1, 2000);
    const files = stats.isFile() ? [root] : await this.walkFiles(root);
    const matched = files.filter((file) => this.matchesGlob(file, pattern)).slice(0, limit);
    return matched.length
      ? matched.map((file) => this.displayPath(file)).join("\n")
      : `No files matched ${pattern} under ${this.displayPath(root)}.`;
  }

  private async commandGrep(args: Record<string, unknown>): Promise<string> {
    const root = this.resolveWorkspacePath(stringArg(args, "path", "."), { readOnly: true });
    const stats = await stat(root);
    const pattern = stringArg(args, "pattern");
    if (!pattern) throw new Error("grep requires pattern");
    const glob = stringArg(args, "glob", "**/*");
    const limit = numberArg(args, "limit", 100, 1, 500);
    const context = numberArg(args, "context", 0, 0, 20);
    const ignoreCase = booleanArg(args, "ignoreCase");
    const literal = booleanArg(args, "literal");
    const matcher = literal ? null : new RegExp(pattern, ignoreCase ? "i" : "");
    const literalNeedle = ignoreCase ? pattern.toLowerCase() : pattern;
    const files = stats.isFile() ? [root] : (await this.walkFiles(root)).filter((file) => this.matchesGlob(file, glob));
    const output: string[] = [];
    for (const file of files) {
      if (output.length >= limit) break;
      const fileStats = await stat(file);
      if (fileStats.size > 1_000_000) continue;
      let text = "";
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && output.length < limit; index += 1) {
        const line = lines[index] ?? "";
        const haystack = ignoreCase ? line.toLowerCase() : line;
        const matched = literal ? haystack.includes(literalNeedle) : matcher!.test(line);
        if (!matched) continue;
        const start = Math.max(0, index - context);
        const end = Math.min(lines.length - 1, index + context);
        for (let lineIndex = start; lineIndex <= end && output.length < limit; lineIndex += 1) {
          const marker = lineIndex === index ? ":" : "-";
          output.push(`${this.displayPath(file)}${marker}${lineIndex + 1}: ${lines[lineIndex] ?? ""}`.slice(0, 1000));
        }
      }
    }
    return output.length ? output.join("\n") : `No matches for ${pattern}.`;
  }

  private async commandWrite(args: Record<string, unknown>): Promise<string> {
    // #5778: stage on where the write would really land - a symlink to a
    // sensitive file must not slip past review under a "normal" name.
    const { absolute: filePath, sensitiveTarget } = this.resolveWorkspaceMutationTarget(stringArg(args, "path"), {
      allowMissing: true,
      forbidStorageMutation: true,
    });
    const content = stringArg(args, "content");
    if (sensitiveTarget !== null) {
      const approval = await this.workspaceChangeReviews.stageSensitiveFileChange({
        absolutePath: sensitiveTarget,
        afterContent: content,
        reason: stringArg(args, "reason") || null,
        sessionId: this.runSessionId(),
      });
      return [
        `${STAGED_SENSITIVE_CHANGE_PREFIX} ${approval.path}`,
        `Approval: ${approval.id}`,
        "The file was not changed. Continue with unrelated source work, but do not claim this change is applied.",
      ].join("\n");
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${this.displayPath(filePath)}.`;
  }

  private ordinaryMutationPath(inputPath: string, options: { allowMissing?: boolean; readOnly?: boolean } = {}) {
    const filePath = this.resolveWorkspacePath(inputPath, {
      allowMissing: options.allowMissing,
      forbidStorageMutation: true,
      requireOrdinaryMutationPath: true,
      readOnly: options.readOnly,
    });
    if (resolve(filePath) === resolve(this.workspaceRoot))
      throw new Error("The workspace root cannot be moved or removed.");
    return filePath;
  }

  private async commandCopy(args: Record<string, unknown>): Promise<string> {
    // A copy only reads its source, so a build file may be copied out but never in.
    const source = this.ordinaryMutationPath(stringArg(args, "source"), { readOnly: true });
    const destination = this.ordinaryMutationPath(stringArg(args, "destination"), { allowMissing: true });
    if (!(await stat(source)).isFile()) throw new Error("copy source must be a file");
    await mkdir(dirname(destination), { recursive: true });
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("copy destination already exists");
      throw error;
    }
    return `Copied ${this.displayPath(source)} to ${this.displayPath(destination)}.`;
  }

  private async commandMove(args: Record<string, unknown>): Promise<string> {
    const source = this.ordinaryMutationPath(stringArg(args, "source"));
    const destination = this.ordinaryMutationPath(stringArg(args, "destination"), { allowMissing: true });
    if (!(await stat(source)).isFile()) throw new Error("move source must be a file");
    await mkdir(dirname(destination), { recursive: true });
    try {
      // A hard link is an atomic, no-replace claim on the destination and keeps
      // it tied to the exact source inode until the source name is removed.
      await link(source, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new Error("move destination already exists");
      if (code !== "EXDEV" && code !== "EPERM") throw error;
      try {
        await copyFile(source, destination, constants.COPYFILE_EXCL);
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("move destination already exists");
        }
        throw copyError;
      }
    }
    try {
      await unlink(source);
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    }
    return `Moved ${this.displayPath(source)} to ${this.displayPath(destination)}.`;
  }

  private async commandRemove(args: Record<string, unknown>): Promise<string> {
    const target = this.ordinaryMutationPath(stringArg(args, "path"));
    const targetStat = await stat(target);
    if (targetStat.isFile()) await unlink(target);
    else if (targetStat.isDirectory()) await rmdir(target);
    else throw new Error("remove path must be a file or empty directory");
    return `Removed ${this.displayPath(target)}.`;
  }

  private async commandEdit(args: Record<string, unknown>): Promise<string> {
    // #5778: stage on where the edit would really land (see commandWrite).
    const { absolute: filePath, sensitiveTarget } = this.resolveWorkspaceMutationTarget(stringArg(args, "path"), {
      forbidStorageMutation: true,
    });
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (edits.length === 0) throw new Error("edit requires non-empty edits array");
    const text = await readFile(filePath, "utf8");
    const ranges: Array<{ start: number; end: number; oldText: string; newText: string }> = [];
    for (const rawEdit of edits) {
      if (!isRecord(rawEdit) || typeof rawEdit.oldText !== "string" || typeof rawEdit.newText !== "string") {
        throw new Error("Each edit requires oldText and newText strings");
      }
      const start = text.indexOf(rawEdit.oldText);
      if (start < 0) throw new Error(`oldText not found in ${this.displayPath(filePath)}`);
      if (text.indexOf(rawEdit.oldText, start + rawEdit.oldText.length) >= 0) {
        throw new Error(`oldText is not unique in ${this.displayPath(filePath)}`);
      }
      ranges.push({ start, end: start + rawEdit.oldText.length, oldText: rawEdit.oldText, newText: rawEdit.newText });
    }
    ranges.sort((a, b) => a.start - b.start);
    for (let index = 1; index < ranges.length; index += 1) {
      if (ranges[index]!.start < ranges[index - 1]!.end) throw new Error("edits overlap");
    }
    let next = "";
    let cursor = 0;
    for (const range of ranges) {
      next += text.slice(cursor, range.start) + range.newText;
      cursor = range.end;
    }
    next += text.slice(cursor);
    if (sensitiveTarget !== null) {
      const approval = await this.workspaceChangeReviews.stageSensitiveFileChange({
        absolutePath: sensitiveTarget,
        afterContent: next,
        reason: stringArg(args, "reason") || null,
        sessionId: this.runSessionId(),
      });
      return [
        `${STAGED_SENSITIVE_CHANGE_PREFIX} ${approval.path}`,
        `Approval: ${approval.id}`,
        "The file was not changed. Continue with unrelated source work, but do not claim this change is applied.",
      ].join("\n");
    }
    await writeFile(filePath, next, "utf8");
    return `Applied ${ranges.length} edit${ranges.length === 1 ? "" : "s"} to ${this.displayPath(filePath)}.`;
  }

  private storageMutationIssue(command: string): string | null {
    const storageRoot = resolve(getFileStorageDir());
    const normalizedCommand = normalizeSlashPath(command);
    const storageMarkers = [
      normalizeSlashPath(storageRoot),
      normalizeSlashPath(relative(this.workspaceRoot, storageRoot)),
      "data/storage",
      "./data/storage",
    ].filter(Boolean);
    if (!storageMarkers.some((marker) => normalizedCommand.includes(marker))) return null;
    if (command.includes("mari db") || command.includes("mari storage tx")) return null;
    const looksMutating = /\b(rm|mv|cp|truncate|tee|sed\s+-i|perl\s+-i|python|node|bash|sh)\b/.test(command);
    return looksMutating
      ? "Shell command appears to mutate DATA_DIR/storage. Use mari db --apply so the browser user can approve the change."
      : null;
  }

  private async commandBash(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const command = stringArg(args, "command");
    if (!command.trim()) throw new Error("bash requires command");
    if (isPackageManagerMutationCommand(command)) {
      throw new Error(
        "Raw package-manager installs are blocked, including cached installs. Use the dependency tool so the user can approve an exact public npm version and integrity.",
      );
    }
    const compatibilityIssue = windowsShellCompatibilityIssue(command);
    if (compatibilityIssue) throw new Error(compatibilityIssue);
    const storageIssue = this.storageMutationIssue(command);
    if (storageIssue) throw new Error(storageIssue);
    const storageTableJsonIssue = this.storageTableJsonFileIssue(command);
    if (storageTableJsonIssue) throw new Error(storageTableJsonIssue);
    const directMariArgv = parseDirectMariArgv(command, this.workspaceRoot);
    const codeCheck = directMariArgv !== null && isMariCodeCheckArgv(directMariArgv);
    if (directMariArgv && !codeCheck) return this.commandMariDirect(command, directMariArgv);
    const sandboxStatus = codeCheck ? getWorkspaceShellSandboxStatus() : null;
    if (sandboxStatus && !sandboxStatus.available) {
      throw new Error(
        `mari code check runs the workspace's own scripts, so it needs the shell sandbox. ${sandboxStatus.reason} Ask the user to run pnpm check themselves.`,
      );
    }
    const timeoutSeconds = codeCheck
      ? CODE_CHECK_TIMEOUT_SECONDS
      : numberArg(args, "timeout", DEFAULT_BASH_TIMEOUT_SECONDS, 1, MAX_BASH_TIMEOUT_SECONDS);
    // #5776: past this point the command runs in the sandbox, where the mari
    // CLI can never reach the server (network denied) - a mutation embedded
    // in a compound would fail silently and still count as applied.
    if (commandEmbedsMariCliMutation(command.toLowerCase())) {
      throw new Error(
        "mari CLI mutations cannot run inside the shell sandbox (its network access is denied, so the CLI cannot reach the server). Run the mari command by itself - no ; | && or redirection around it - so it uses the direct runtime, and pass --apply when you want the change saved.",
      );
    }
    // #5777: the sandbox denies these writes SILENTLY - in a compound command
    // the denial is swallowed and exit 0 would count as an applied mutation.
    // Refuse loudly before running instead, pointing at the reviewed path.
    if (bashCommandTargetsSensitivePath(command)) {
      throw new Error(
        "This command touches a supply-chain-sensitive file (package manifests, launcher, installer, or workflow files). The shell sandbox blocks writes to those silently, so the command cannot work as intended. To change one, use the write or edit command - it stages the change for the user's approval. To copy content OUT of one, read it and write the copy to the destination instead.",
      );
    }
    // #6984: the sandbox keeps build output read-only; refuse the common write shapes loudly first.
    if (bashCommandWritesBuildOutput(command)) throw new Error(BUILD_OUTPUT_WRITE_REFUSAL);
    // #5786: the deny list is spawn-time-only, so a command can create a NEW
    // sensitive-by-name file no rule covers. Fingerprint the sensitive set
    // before the run; whatever changed unreviewed afterwards is reverted and
    // staged for approval - the net under the pre-execution heuristics above.
    const sensitiveSnapshot = await snapshotSensitiveWorkspaceFiles(this.workspaceRoot);
    const sandboxed = await spawnWorkspaceSandboxedShell({
      command: codeCheck ? "pnpm check" : command,
      workspaceRoot: this.workspaceRoot,
      env: process.env,
      codeCheck,
    });
    type SandboxRun = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };
    const ABORT_TEARDOWN_GRACE_MS = 5_000;
    const KILL_ESCALATION_MS = 2_000;
    let aborted = false;
    let run: SandboxRun;
    try {
      run = await new Promise<SandboxRun>((resolveRun, rejectRun) => {
        const child = sandboxed.child;
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let graceTimer: NodeJS.Timeout | null = null;
        let hardKillTimer: NodeJS.Timeout | null = null;
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          // A stale escalation must never fire a raw group SIGKILL at a pid
          // the OS may have recycled after the tree already died.
          if (hardKillTimer) clearTimeout(hardKillTimer);
          signal.removeEventListener("abort", abortHandler);
          void sandboxed.cleanup().finally(callback);
        };
        let killIssued = false;
        const killChild = () => {
          // #5892: group kill - the detached spawn makes the child a group
          // leader, so backgrounded grandchildren die with it (the macOS
          // teardown-survivor residual). Escalates for TERM-trapping trees.
          // Idempotent: abort and timeout can BOTH fire, and a second call
          // would overwrite hardKillTimer, orphaning the first escalation to
          // SIGKILL a possibly recycled process group after close.
          if (killIssued) return;
          killIssued = true;
          killSandboxedProcessTree(child, "SIGTERM");
          hardKillTimer = setTimeout(() => killSandboxedProcessTree(child, "SIGKILL"), KILL_ESCALATION_MS);
          hardKillTimer.unref?.();
        };
        const abortHandler = () => {
          aborted = true;
          killChild();
          // Do NOT settle here: the post-execution scan must not race a
          // dying child's final writes, so the close handler (or the grace
          // timer below, if the child ignores the kill) settles instead.
          graceTimer = setTimeout(() => {
            finish(() => resolveRun({ stdout, stderr, exitCode: null, timedOut }));
          }, ABORT_TEARDOWN_GRACE_MS);
          graceTimer.unref?.();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          killChild();
          // Same bounded settle as the abort path: without it, a child that
          // swallows the kill leaves the promise unsettled forever and the
          // post-execution scan never runs at all.
          graceTimer = setTimeout(() => {
            finish(() => resolveRun({ stdout, stderr, exitCode: null, timedOut }));
          }, ABORT_TEARDOWN_GRACE_MS);
          graceTimer.unref?.();
        }, timeoutSeconds * 1000);
        timer.unref?.();
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
        child.stdout?.on("data", (chunk) => {
          stdout += String(chunk);
          if (stdout.length > COMMAND_OUTPUT_LIMIT) stdout = stdout.slice(0, COMMAND_OUTPUT_LIMIT);
        });
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
          if (stderr.length > COMMAND_OUTPUT_LIMIT) stderr = stderr.slice(0, COMMAND_OUTPUT_LIMIT);
        });
        child.on("error", (err) => finish(() => rejectRun(err)));
        child.on("close", (exitCode) => finish(() => resolveRun({ stdout, stderr, exitCode, timedOut })));
      });
    } catch (err) {
      // Spawn failure: the round's result is discarded, but a write that
      // already landed must still be reverted and surfaced as pending.
      await this.revertAndStageSensitiveAftermath(sensitiveSnapshot);
      throw err;
    }
    if (aborted) {
      // The child has closed (or exhausted its teardown grace); revert and
      // stage the aftermath, then report the abort as before.
      await this.revertAndStageSensitiveAftermath(sensitiveSnapshot);
      throw new Error("aborted");
    }
    const stagedLines = await this.revertAndStageSensitiveAftermath(sensitiveSnapshot);
    const output = compactOutput(
      [
        `Command: ${engineLineText(command)}`,
        `Sandbox: ${sandboxed.backend} (network denied; writes confined to workspace)`,
        // Engine region: staged lines sit BEFORE the stdout/stderr markers,
        // where script text cannot reach - isStagedSensitiveMutation keys on
        // exactly this placement.
        ...stagedLines,
        `Exit code: ${run.exitCode}${run.timedOut ? ` (timeout after ${timeoutSeconds}s)` : ""}`,
        run.stdout ? `\nstdout:\n${run.stdout.trimEnd()}` : "",
        run.stderr ? `\nstderr:\n${run.stderr.trimEnd()}` : "",
      ].join("\n"),
    );
    if (run.timedOut || run.exitCode !== 0) throw new Error(output);
    return output;
  }

  /**
   * #5786: revert every sensitive file the run changed without review and
   * stage each one through the normal approval pipeline. Returns the engine
   * lines describing what happened. Capped so a hostile command cannot mint
   * unbounded approval cards; everything past the cap is still reverted.
   */
  private async revertAndStageSensitiveAftermath(snapshot: SensitiveWorkspaceSnapshot): Promise<string[]> {
    const MAX_POSTEXEC_STAGED = 5;
    let linkLines: string[] = [];
    try {
      linkLines = await restoreReplacedStoreLinks(snapshot);
    } catch (err) {
      logger.error(err, "[mari] Store-link integrity pass failed");
      linkLines = ["Store-link integrity check failed; treat package-store paths as unreviewed."];
    }
    let scan: SensitiveScanResult;
    try {
      scan = await detectUnreviewedSensitiveChanges(this.workspaceRoot, snapshot);
    } catch (err) {
      logger.error(err, "[mari] Post-execution sensitive-file scan failed");
      return ["Post-execution sensitive-file scan failed; treat this run's file changes as unreviewed."];
    }
    const lines: string[] = [...linkLines];
    if (snapshot.entryCapExceeded || scan.entryCapExceeded) {
      lines.push(
        "Post-execution scan stopped at its entry cap; part of the workspace went uninspected - treat this run's file changes as unreviewed.",
      );
    }
    for (const path of new Set([...snapshot.unscannable, ...scan.unscannable])) {
      lines.push(
        `Post-execution scan could not inspect ${engineLineText(path)}; treat its contents as unreviewed and ask the user to check it.`,
      );
    }
    let stagedCount = 0;
    for (const hit of scan.hits) {
      const shownPath = engineLineText(hit.relativePath);
      try {
        if (hit.attributionUncertain) {
          // The pre-run walk could not see this subtree, so "created" may
          // simply mean "previously invisible" - deleting here could destroy
          // a pre-existing user file. Report, never delete.
          lines.push(
            `Sensitive file ${shownPath} appeared under a path the pre-run snapshot could not inspect; left in place unreviewed - ask the user to check it.`,
          );
          continue;
        }
        if (hit.change === "created") {
          await unlink(hit.absolutePath);
        } else if (hit.beforeContent !== null) {
          // Bytes, not text: a utf8 round-trip would corrupt binary
          // lockfiles (bun.lockb) on restore.
          await writeFile(hit.absolutePath, hit.beforeContent);
        } else {
          lines.push(
            `Unreviewed change to sensitive file ${shownPath} could not be reverted (pre-run content was not retainable); ask the user to inspect it.`,
          );
          continue;
        }
        if (hit.afterContent === null) {
          lines.push(
            `Reverted unreviewed sensitive file ${hit.change === "created" ? "creation" : "change"}: ${shownPath} (not stageable for review: binary, oversize, unreadable, or not a regular file).`,
          );
          continue;
        }
        // Count actual cards, not loop positions: earlier report-only hits
        // must not consume approval slots.
        if (stagedCount >= MAX_POSTEXEC_STAGED) {
          lines.push(
            `Reverted unreviewed sensitive file change: ${shownPath} (approval cap reached; re-run for this file alone).`,
          );
          continue;
        }
        const approval = await this.workspaceChangeReviews.stageSensitiveFileChange({
          absolutePath: hit.absolutePath,
          afterContent: hit.afterContent,
          // Attribution-neutral on purpose: a concurrent legitimate writer
          // (the user's editor, an approval applying mid-run) can also land
          // in this window; the staged card restores either way.
          reason:
            "Changed during a sandboxed shell command without review; reverted and staged by the post-execution scan.",
          sessionId: this.runSessionId(),
        });
        stagedCount += 1;
        lines.push(`${STAGED_SENSITIVE_CHANGE_PREFIX} ${engineLineText(approval.path)}`);
      } catch (err) {
        logger.error(err, "[mari] Could not revert/stage a sensitive file the sandbox run changed");
        lines.push(
          `Unreviewed change to sensitive file ${shownPath} could not be fully processed; ask the user to inspect it.`,
        );
      }
    }
    if (lines.length > 0) {
      logger.warn("[mari] Post-execution scan intercepted %d unreviewed sensitive file change(s)", scan.hits.length);
    }
    return lines;
  }

  private async commandDependency(args: Record<string, unknown>): Promise<string> {
    const approval = await this.workspaceChangeReviews.requestDependencyInstall({
      packageName: stringArg(args, "packageName"),
      version: stringArg(args, "version") || "latest",
      target: stringArg(args, "target") as MariDependencyTarget,
      dev: booleanArg(args, "dev"),
      reason: stringArg(args, "reason") || null,
      sessionId: this.runSessionId(),
    });
    return [
      `Dependency request staged for user approval: ${approval.packageName}@${approval.version}`,
      `Target: ${approval.target} (${approval.dependencyType})`,
      `Integrity: ${approval.integrity}`,
      `Approval: ${approval.id}`,
      "Nothing has been installed. Do not import the package or claim it is available until the user approves it.",
    ].join("\n");
  }

  private async commandMariDirect(command: string, argv: string[]): Promise<string> {
    const result = await getMariDbService(this.app.db).executeCli({
      argv,
      command,
      cwd: this.workspaceRoot,
      sessionId: this.runSessionId(),
    });
    const printable =
      isRecord(result) && "output" in result && !("summary" in result) ? result.output : compactMutationResult(result);
    const output = compactOutput(
      [
        // A sentinel MUST be the output's first line: everything after it can
        // contain model-authored text (the command string, echoed rows), so
        // the verification guard only trusts position zero. The read-back and
        // dry-run (#5776) sentinels are mutually exclusive - a read-back only
        // rides applied mutations, and a dry-run never applies - so position
        // zero stays deterministic.
        ...(isRecord(result.readBack) && result.readBack.status === "verified"
          ? [READ_BACK_VERIFIED_SENTINEL]
          : isRecord(result.readBack) && result.readBack.status === "mismatch"
            ? [READ_BACK_MISMATCH_SENTINEL]
            : []),
        ...(isRecord(result) && result.mode === "dry-run" ? [MARI_DRY_RUN_SENTINEL] : []),
        `Command: ${engineLineText(command)}`,
        `Exit code: ${result.ok === false ? 1 : 0} (direct mari runtime)`,
        "",
        "stdout:",
        stringifyOutput(printable),
      ].join("\n"),
    );
    if (result.ok === false) throw new Error(output);
    return output;
  }

  private async commandPackageService(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const packageId = stringArg(args, "package").trim();
    const action = stringArg(args, "action").trim();
    if (!action) {
      const offered = (await listCapabilityMariActions(signal)).filter(
        (entry) => !packageId || entry.package === packageId,
      );
      if (offered.length === 0) {
        return packageId
          ? `Package "${packageId}" offers no Mari actions, or it is not installed and enabled.`
          : "No installed package offers Mari actions.";
      }
      return stringifyOutput(offered);
    }
    const value = await runCapabilityMariAction(packageId, action, packageServiceInput(args), signal);
    return `${packageId} ${action} succeeded.\n${elideDataUrls(stringifyOutput(value ?? null))}`;
  }

  private async commandAppData(args: Record<string, unknown>): Promise<WorkspaceCommandExecution> {
    const action = typeof args.action === "string" ? args.action : "unknown";
    if (action === "decision.get" || action === "decision.record") {
      return { output: stringifyOutput(await executeMariDecisionAction(action, args.data)) };
    }
    // Slice 87: every applied change keeps a restore copy in every permissions mode; the mode only
    // decides whether she asks first.
    const result = await getMariDbService(this.app.db).executeAction({
      ...args,
      cwd: this.workspaceRoot,
      sessionId: this.runSessionId(),
    });
    if (result.ok !== false && (action === "personal_extension.create" || action === "personal_extension.update")) {
      await personalServerExtensionRuntime.reloadAll();
    }
    const printable =
      isRecord(result) && "output" in result && !("summary" in result) ? result.output : compactMutationResult(result);
    const truncationNote = formatMariReadTruncation(result.truncation);
    const output = compactOutput(
      [
        // The sentinel MUST be the output's first line: everything after it
        // can contain model-authored text (the action string, echoed rows),
        // so the verification guard only trusts position zero.
        ...(isRecord(result.readBack) && result.readBack.status === "verified"
          ? [READ_BACK_VERIFIED_SENTINEL]
          : isRecord(result.readBack) && result.readBack.status === "mismatch"
            ? [READ_BACK_MISMATCH_SENTINEL]
            : []),
        `Command: app_data ${action}`,
        `Exit code: ${result.ok === false ? 1 : 0} (structured app-data runtime)`,
        "",
        "stdout:",
        stringifyOutput(printable),
        ...(truncationNote ? ["", truncationNote] : []),
      ].join("\n"),
    );
    if (result.ok === false) {
      const failure = new Error(output) as Error & { actionResult?: MariWorkspaceActionResult };
      const reason =
        typeof (result as { error?: unknown }).error === "string" ? (result as { error: string }).error : output;
      failure.actionResult = buildMariFailedActionResult(action, args, reason) ?? undefined;
      throw failure;
    }
    return { output, actionResult: buildMariWorkspaceActionResult(action, result, args.reason) ?? undefined };
  }

  /**
   * The session id this run's database commands carry, naming its Mari chat, so the
   * change cards they create belong to that chat (#6842).
   */
  private runSessionId(): string {
    return mariWorkspaceSessionId(this.getRun().decisionContext?.chatId);
  }

  private withMariRuntimeEnv(env: NodeJS.ProcessEnv, mariCliBinDir: string) {
    env.MARI_WORKSPACE_SESSION_ID = this.runSessionId();
    env.MARI_SERVER_URL = `${getServerProtocol()}://127.0.0.1:${getPort()}`;
    env.MARINARA_PI_API_KEY = RUNTIME_API_KEY;
    env.DATA_DIR = DATA_DIR;
    return prependPathEntry(env, mariCliBinDir);
  }

  async ensureMariCliShim() {
    const binDir = join(DATA_DIR, ".mari-workspace", "bin");
    await mkdir(binDir, { recursive: true });
    const posixCliPath = join(binDir, "mari");
    const cmdCliPath = join(binDir, "mari.cmd");
    const powershellCliPath = join(binDir, "mari.ps1");
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const distCli = join(packageRoot, "dist", "bin", "mari.js");
    const sourceCli = join(packageRoot, "src", "bin", "mari.ts");
    const posixShell = process.platform === "android" ? "/data/data/com.termux/files/usr/bin/sh" : "/bin/sh";
    const posixScript = `#!${posixShell}
DIST_CLI=${shellQuote(distCli)}
SOURCE_CLI=${shellQuote(sourceCli)}
if [ -f "$DIST_CLI" ]; then
  exec node "$DIST_CLI" "$@"
fi
exec pnpm exec tsx "$SOURCE_CLI" "$@"
`;
    const cmdScript = `@echo off\r
setlocal\r
set "DIST_CLI=${distCli}"\r
set "SOURCE_CLI=${sourceCli}"\r
if exist "%DIST_CLI%" (\r
  node "%DIST_CLI%" %*\r
  exit /b %ERRORLEVEL%\r
)\r
pnpm exec tsx "%SOURCE_CLI%" %*\r
exit /b %ERRORLEVEL%\r
`;
    const powershellScript = `$DistCli = ${powershellQuote(distCli)}
$SourceCli = ${powershellQuote(sourceCli)}
if (Test-Path -LiteralPath $DistCli) {
  & node $DistCli @args
  exit $LASTEXITCODE
}
& pnpm exec tsx $SourceCli @args
exit $LASTEXITCODE
`;
    await Promise.all([
      writeFile(posixCliPath, posixScript, { mode: 0o755 }),
      writeFile(cmdCliPath, cmdScript),
      writeFile(powershellCliPath, powershellScript),
    ]);
    this.withMariRuntimeEnv(process.env, binDir);
    if (!existsSync(posixCliPath) || !existsSync(cmdCliPath) || !existsSync(powershellCliPath)) {
      logger.warn("[Professor Mari] failed to create one or more mari CLI shims at %s", binDir);
    }
    return binDir;
  }
}
