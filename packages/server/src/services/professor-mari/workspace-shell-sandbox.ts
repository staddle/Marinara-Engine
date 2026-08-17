import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { workspacePathAccessPolicy } from "./workspace-change-review.service.js";
import { getBubblewrapRuntimeStatus } from "../sandbox/bubblewrap-runtime.js";

export type WorkspaceShellSandboxBackend = "macos-seatbelt" | "linux-bubblewrap";
export type WorkspaceProcessIsolationBackend = WorkspaceShellSandboxBackend | "node-permission-opt-in";

export type WorkspaceShellSandboxStatus =
  | { available: true; backend: WorkspaceShellSandboxBackend }
  | { available: false; backend: null; reason: string };

export type WorkspaceSandboxedShell = {
  backend: WorkspaceProcessIsolationBackend;
  child: ChildProcess;
  cleanup: () => Promise<void>;
};

type SpawnWorkspaceShellInput = {
  command: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
};

export type SpawnWorkspaceProcessInput = {
  executable: string;
  args: string[];
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  writableWorkspace?: boolean;
  allowChildProcesses?: boolean;
};

const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SAFE_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
]);
const POLICY_SCAN_SKIPPED_DIRS = new Set([
  "node_modules",
  ".pnpm",
  ".pnpm-store",
  ".cache",
  "dist",
  "build",
  "coverage",
]);

export function sanitizeWorkspaceShellEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (SAFE_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_"))) env[key] = value;
  }
  return env;
}

function findBubblewrap() {
  const status = getBubblewrapRuntimeStatus();
  return status.available ? status.executable : undefined;
}

export function getWorkspaceShellSandboxStatus(): WorkspaceShellSandboxStatus {
  if (process.platform === "darwin" && existsSync(MACOS_SANDBOX_EXEC)) {
    return { available: true, backend: "macos-seatbelt" };
  }
  if (process.platform === "linux") {
    const status = getBubblewrapRuntimeStatus();
    if (status.available) return { available: true, backend: "linux-bubblewrap" };
    return { available: false, backend: null, reason: `Professor Mari shell commands are disabled. ${status.reason}` };
  }
  return {
    available: false,
    backend: null,
    reason: `Professor Mari shell commands are disabled because no supported OS sandbox is available on ${process.platform}.`,
  };
}

function sandboxLiteral(path: string) {
  const resolved = resolve(path);
  return JSON.stringify(existsSync(resolved) ? realpathSync(resolved) : resolved);
}

function uniqueExistingPaths(paths: Array<string | undefined>) {
  return [
    ...new Set(
      paths
        .filter((path): path is string => Boolean(path))
        .map((path) => resolve(path))
        .filter((path) => existsSync(path))
        .map((path) => realpathSync(path)),
    ),
  ];
}

function uniqueExistingMountPaths(paths: Array<string | undefined>) {
  return [
    ...new Set(
      paths
        .filter((path): path is string => Boolean(path))
        .map((path) => resolve(path))
        .filter((path) => existsSync(path)),
    ),
  ];
}

// The walk runs fresh on every spawn on purpose: caching would let a newly
// created secret file slip past the deny list. It is async so a large
// workspace scan yields to the event loop instead of blocking other requests.
async function workspacePolicyPaths(workspaceRoot: string) {
  const forbidden: string[] = [];
  const sensitive: string[] = [];
  const visit = async (path: string) => {
    const policy = workspacePathAccessPolicy(workspaceRoot, path);
    if (policy === "forbidden") {
      forbidden.push(path);
      return;
    }
    const stats = await lstat(path);
    if (policy === "sensitive") {
      sensitive.push(path);
      if (stats.isDirectory()) return;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() && POLICY_SCAN_SKIPPED_DIRS.has(entry.name)) continue;
      await visit(join(path, entry.name));
    }
  };
  await visit(workspaceRoot);
  return {
    forbidden: uniqueExistingPaths(forbidden),
    sensitive: uniqueExistingPaths(sensitive),
  };
}

function macosReadRoots(workspaceRoot: string, env: NodeJS.ProcessEnv, sandboxTemp: string) {
  const pathRoots = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return uniqueExistingPaths([
    workspaceRoot,
    sandboxTemp,
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/private/etc",
    "/private/var/db",
    "/private/var/select",
    "/private/var/run",
    "/dev",
    "/opt/homebrew",
    "/usr/local",
    dirname(process.execPath),
    ...pathRoots,
  ]);
}

export async function buildMacosWorkspaceShellProfile(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  sandboxTemp: string,
  writableWorkspace = true,
  executable = "/bin/bash",
  allowChildProcesses = true,
) {
  const policyPaths = await workspacePolicyPaths(workspaceRoot);
  const readable = macosReadRoots(workspaceRoot, env, sandboxTemp)
    .map((path) => `    (subpath ${sandboxLiteral(path)})`)
    .join("\n");
  const forbiddenReads = policyPaths.forbidden.map((path) => `    (subpath ${sandboxLiteral(path)})`).join("\n");
  const sensitiveWrites = policyPaths.sensitive.map((path) => `    (subpath ${sandboxLiteral(path)})`).join("\n");
  const forbiddenReadRule = forbiddenReads ? `(deny file-read*\n${forbiddenReads})` : "";
  const sensitiveWriteRule = writableWorkspace && sensitiveWrites ? `(deny file-write*\n${sensitiveWrites})` : "";
  const workspaceWriteRule = writableWorkspace ? `    (subpath ${sandboxLiteral(workspaceRoot)})\n` : "";
  const processRules = allowChildProcesses
    ? `(allow process*)\n(allow signal)`
    : `(allow process-exec (literal ${sandboxLiteral(executable)}))\n(allow process-info* (target self))\n(allow signal (target self))`;
  return `(version 1)
(deny default)
${processRules}
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix*)
(allow file-read-metadata)
(allow file-read*
    (literal "/")
${readable})
(allow file-write*
${workspaceWriteRule}
    (subpath ${sandboxLiteral(sandboxTemp)})
    (literal "/dev/null")
    (literal "/dev/tty"))
${forbiddenReadRule}
${sensitiveWriteRule}
(deny network*)
`;
}

function linuxReadRoots(workspaceRoot: string, env: NodeJS.ProcessEnv) {
  const pathRoots = (env.PATH ?? "").split(delimiter).filter(Boolean);
  // Preserve paths such as /bin and /lib even when the host exposes them as
  // symlinks into /usr. Bubblewrap starts with an empty root, so canonicalizing
  // those mount destinations would remove the aliases expected by shells and
  // ELF interpreters inside the sandbox.
  return uniqueExistingMountPaths([
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc",
    "/nix/store",
    dirname(process.execPath),
    workspaceRoot,
    ...pathRoots,
  ]);
}

async function linuxBubblewrapArgs(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  sandboxTemp: string,
  executable: string,
  commandArgs: string[],
  writableWorkspace: boolean,
) {
  const policyPaths = await workspacePolicyPaths(workspaceRoot);
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  for (const root of linuxReadRoots(workspaceRoot, env)) {
    if (root === workspaceRoot) continue;
    args.push("--ro-bind", root, root);
  }
  args.push(writableWorkspace ? "--bind" : "--ro-bind", workspaceRoot, workspaceRoot);
  args.push("--bind", sandboxTemp, sandboxTemp);
  for (const path of policyPaths.sensitive) {
    args.push("--ro-bind", path, path);
  }
  for (const path of policyPaths.forbidden) {
    if ((await lstat(path)).isDirectory()) args.push("--tmpfs", path);
    else args.push("--ro-bind", "/dev/null", path);
  }
  args.push("--chdir", workspaceRoot);
  args.push(executable, ...commandArgs);
  return args;
}

export async function spawnWorkspaceSandboxedProcess(
  input: SpawnWorkspaceProcessInput,
): Promise<WorkspaceSandboxedShell> {
  const status = getWorkspaceShellSandboxStatus();
  if (!status.available) {
    throw new Error(`${status.reason}`);
  }

  const workspaceRoot = resolve(input.workspaceRoot);
  const writableWorkspace = input.writableWorkspace !== false;
  const allowChildProcesses = input.allowChildProcesses !== false;
  const sandboxTemp = await mkdtemp(join(tmpdir(), "marinara-mari-shell-"));
  const safeEnv = sanitizeWorkspaceShellEnv(input.env);
  const env: NodeJS.ProcessEnv = {
    ...safeEnv,
    HOME: workspaceRoot,
    TMPDIR: sandboxTemp,
    TMP: sandboxTemp,
    TEMP: sandboxTemp,
    XDG_CACHE_HOME: sandboxTemp,
    XDG_CONFIG_HOME: sandboxTemp,
    XDG_DATA_HOME: sandboxTemp,
  };
  let child: ChildProcess;
  try {
    if (status.backend === "macos-seatbelt") {
      child = spawn(
        MACOS_SANDBOX_EXEC,
        [
          "-p",
          await buildMacosWorkspaceShellProfile(
            workspaceRoot,
            env,
            sandboxTemp,
            writableWorkspace,
            input.executable,
            allowChildProcesses,
          ),
          input.executable,
          ...input.args,
        ],
        { cwd: workspaceRoot, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    } else {
      child = spawn(
        findBubblewrap()!,
        await linuxBubblewrapArgs(workspaceRoot, env, sandboxTemp, input.executable, input.args, writableWorkspace),
        { cwd: workspaceRoot, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    }
  } catch (error) {
    await rm(sandboxTemp, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  return {
    backend: status.backend,
    child,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(sandboxTemp, { recursive: true, force: true });
    },
  };
}

export async function spawnWorkspaceSandboxedShell(input: SpawnWorkspaceShellInput): Promise<WorkspaceSandboxedShell> {
  try {
    const sandboxed = await spawnWorkspaceSandboxedProcess({
      executable: "/bin/bash",
      args: ["--noprofile", "--norc", "-c", input.command],
      workspaceRoot: input.workspaceRoot,
      env: input.env,
    });
    sandboxed.child.stdin?.end();
    return sandboxed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} Use Professor Mari's structured read, grep, find, ls, edit, write, copy, move, remove, and app_data tools instead.`,
    );
  }
}
