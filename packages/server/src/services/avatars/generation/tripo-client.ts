// ──────────────────────────────────────────────
// Avatar generation: Tripo's API, with the user's own key (lane: 3D generation)
// ──────────────────────────────────────────────
// Tripo v3 (https://openapi.tripo3d.ai/v3): `Authorization: Bearer <key>`, answers `{ code: 0, data }`, and
// work runs as tasks that are polled at GET /tasks/{id}. The key goes to that one address only: never to the
// signed download links, never into a log line or an error message (each is passed through redact()). In
// debug mode (debugMode / DEBUG_AGENTS) every request's parameters and every task id are logged with
// logDebugOverride. Tripo has no way to stop a task: Cancel stops waiting, and a task already started may
// still finish and use its credits on Tripo's side.
import { TRIPO_API_BASE_URL } from "@marinara-engine/shared";
import { logDebugOverride } from "../../../lib/logger.js";
import { safeFetch } from "../../../utils/security.js";

/** What went wrong, for the plain message and the HTTP status the route answers with. */
export type TripoErrorKind =
  "bad-key" | "no-credits" | "content-policy" | "rate-limited" | "task-failed" | "timeout" | "unavailable" | "refused";

export class TripoError extends Error {
  readonly kind: TripoErrorKind;
  constructor(kind: TripoErrorKind, message: string) {
    super(message);
    this.name = "TripoError";
    this.kind = kind;
  }
}

export const TRIPO_ERROR_MESSAGES: Readonly<Record<Exclude<TripoErrorKind, "task-failed" | "refused">, string>> = {
  "bad-key": "Tripo didn't accept the API key. Check your Tripo API key on the 3D Avatars page.",
  "no-credits": "Your Tripo account doesn't have enough credits. Top up at Tripo, then try again.",
  "content-policy": "Tripo refused this picture under its content policy. Try another sprite.",
  "rate-limited": "Tripo is busy or limiting requests right now. Try again in a minute.",
  timeout: "Tripo is taking too long. Try again later.",
  unavailable: "Couldn't reach Tripo. Check your internet connection and try again.",
};

/** A finished or running task, as GET /tasks/{id} describes it. */
export interface TripoTask {
  task_id: string;
  type?: string;
  status: "queued" | "running" | "success" | "failed" | "banned" | "expired" | "cancelled" | string;
  progress?: number;
  output?: Record<string, unknown>;
  credits_consumed?: number;
  error_code?: number | string;
  error_message?: string;
}

/** fetch as safeFetch does it (public HTTPS addresses only, a capped body); replaced in tests. */
export type TripoFetch = (url: string, init: RequestInit & { maxResponseBytes: number }) => Promise<Response>;

const API_ORIGIN = new URL(TRIPO_API_BASE_URL).origin;
const API_RESPONSE_MAX_BYTES = 1024 * 1024;
/** Tripo's limit for an uploaded picture. */
export const TRIPO_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const POLL_INTERVAL_MS = 3000;
/** A request Tripo accepted but never answers fails after this long; uploads and downloads get longer. */
const REQUEST_TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 120_000;
/** One task never takes this long; a model takes about two minutes. */
const TASK_TIMEOUT_MS = 15 * 60 * 1000;
/** A busy answer (429) is tried again this many times, waiting as Tripo asks or longer each time. */
const BUSY_RETRIES = 4;
const MAX_BUSY_WAIT_MS = 30_000;
const TASK_ENDED = new Set(["failed", "banned", "expired", "cancelled"]);

const defaultFetch: TripoFetch = (url, { maxResponseBytes, ...init }) =>
  safeFetch(url, {
    ...init,
    maxResponseBytes,
    // API calls stay on Tripo's API; downloads may be on its storage hosts, still public HTTPS only.
    policy: url.startsWith(`${API_ORIGIN}/`) ? { allowedOrigins: [API_ORIGIN] } : {},
  });

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("The request was cancelled.", "AbortError");
}

/** Waits `ms`, or rejects at once when the signal aborts. */
export function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** A signed download link without its query (the signature), for logs. */
function linkShape(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(not a link)";
  }
}

export interface TripoClientOptions {
  apiKey: string;
  signal?: AbortSignal;
  debug?: boolean;
  fetch?: TripoFetch;
  /** Waits between polls and before retrying a busy answer; replaced in tests. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  taskTimeoutMs?: number;
  /** Per request: API calls, then uploads and downloads. */
  requestTimeoutMs?: number;
  transferTimeoutMs?: number;
  now?: () => number;
}

export type TripoClient = ReturnType<typeof createTripoClient>;

export function createTripoClient(options: TripoClientOptions) {
  const key = options.apiKey.trim();
  if (!key) throw new TripoError("bad-key", TRIPO_ERROR_MESSAGES["bad-key"]);
  const send = options.fetch ?? defaultFetch;
  const wait = options.wait ?? waitFor;
  const now = options.now ?? Date.now;
  const { signal } = options;
  const debug = options.debug === true;
  /** The caller's signal (Cancel) with a time limit, so a request that never answers can't hold the run. */
  const limited = (ms: number) =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

  /** The key never leaves this module in text: not in a log line, not in an error. */
  const redact = (text: string) => text.split(key).join("[redacted]");
  /** Log lines also leave out the signature of any download link (its query). */
  const log = (message: string, ...args: unknown[]) =>
    logDebugOverride(
      debug,
      message,
      ...args.map((arg) =>
        typeof arg === "string" ? redact(arg).replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gu, "$1") : arg,
      ),
    );

  function errorFor(status: number, code: number | undefined, message: string | undefined): TripoError {
    if (status === 401 || code === 1000 || code === 1001)
      return new TripoError("bad-key", TRIPO_ERROR_MESSAGES["bad-key"]);
    if (code === 2010) return new TripoError("no-credits", TRIPO_ERROR_MESSAGES["no-credits"]);
    if (code === 2008) return new TripoError("content-policy", TRIPO_ERROR_MESSAGES["content-policy"]);
    if (status === 429) return new TripoError("rate-limited", TRIPO_ERROR_MESSAGES["rate-limited"]);
    if (status >= 500)
      return new TripoError("unavailable", `Tripo had a problem on its side (error ${status}). Try again later.`);
    const detail = redact(String(message ?? ""))
      .replace(/[<>]/gu, "")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 200);
    return new TripoError("refused", `Tripo refused the request (${code ?? status})${detail ? `: ${detail}` : "."}`);
  }

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown, form?: FormData): Promise<T> {
    // Polls are left out: waitForTask logs each task's start and end.
    if (form) log("[debug/avatar-generation] Tripo %s %s (a picture)", method, path);
    else if (!path.startsWith("/tasks/")) {
      log("[debug/avatar-generation] Tripo %s %s %s", method, path, body === undefined ? "" : JSON.stringify(body));
    }
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw abortError(signal);
      let response: Response;
      try {
        response = await send(`${TRIPO_API_BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            ...(body !== undefined && !form ? { "Content-Type": "application/json" } : {}),
          },
          body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
          signal: limited(
            form
              ? (options.transferTimeoutMs ?? TRANSFER_TIMEOUT_MS)
              : (options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
          ),
          maxResponseBytes: API_RESPONSE_MAX_BYTES,
        });
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        log(
          "[debug/avatar-generation] Tripo %s %s failed: %s",
          method,
          path,
          String((error as Error)?.message ?? error),
        );
        throw new TripoError("unavailable", TRIPO_ERROR_MESSAGES.unavailable);
      }
      let parsed: { code?: unknown; data?: unknown; message?: unknown } = {};
      try {
        parsed = (await response.json()) as typeof parsed;
      } catch {
        // An empty or HTML answer is judged by its status alone.
      }
      const code = typeof parsed.code === "number" ? parsed.code : undefined;
      const message = typeof parsed.message === "string" ? parsed.message : undefined;
      if (response.status === 429 && attempt < BUSY_RETRIES) {
        const asked = Number(response.headers.get("retry-after")) * 1000;
        const delay = Math.min(MAX_BUSY_WAIT_MS, Math.max(Number.isFinite(asked) ? asked : 0, 2000 * 2 ** attempt));
        log("[debug/avatar-generation] Tripo busy on %s (code %s); trying again in %d s", path, code, delay / 1000);
        await wait(delay, signal);
        continue;
      }
      if (!response.ok || code !== 0) {
        log(
          "[debug/avatar-generation] Tripo %s %s answered %d (code %s): %s",
          method,
          path,
          response.status,
          code,
          message ?? "",
        );
        throw errorFor(response.status, code, message);
      }
      return parsed.data as T;
    }
  }

  return {
    /** Credits left (`balance`) and held by running tasks (`frozen`). */
    async balance(): Promise<{ balance: number; frozen: number }> {
      const data = await request<{ balance?: unknown; frozen?: unknown }>("GET", "/account/balance");
      const balance = Number(data?.balance);
      if (!Number.isFinite(balance)) throw new TripoError("refused", "Tripo didn't say how many credits are left.");
      return { balance, frozen: Number(data?.frozen) || 0 };
    },

    /** Uploads a PNG or JPEG and returns the token tasks take as their input. */
    async upload(bytes: Buffer, mimeType: "image/png" | "image/jpeg"): Promise<string> {
      if (bytes.length > TRIPO_UPLOAD_MAX_BYTES) {
        throw new TripoError("refused", "The sprite is larger than the 20 MB Tripo accepts.");
      }
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(bytes)], { type: mimeType }),
        mimeType === "image/png" ? "sprite.png" : "sprite.jpg",
      );
      const data = await request<{ file_token?: unknown }>("POST", "/files", undefined, form);
      if (typeof data?.file_token !== "string" || !data.file_token) {
        throw new TripoError("refused", "Tripo didn't accept the picture.");
      }
      return data.file_token;
    },

    /** Starts a task and returns its id. */
    async start(path: string, body: Record<string, unknown>): Promise<string> {
      const data = await request<{ task_id?: unknown }>("POST", path, body);
      if (typeof data?.task_id !== "string" || !data.task_id) {
        throw new TripoError("refused", "Tripo didn't start the task.");
      }
      log("[debug/avatar-generation] Tripo started %s: task %s", path, data.task_id);
      return data.task_id;
    },

    /** Polls a task until it succeeds; `onProgress` hears Tripo's 0 to 100 progress as it changes. */
    async waitForTask(
      taskId: string,
      what: string,
      onProgress?: (progress: number | null) => void,
    ): Promise<TripoTask> {
      const started = now();
      // The run already said the step started, so only real progress is passed on.
      let last: number | null = null;
      const timeout = options.taskTimeoutMs ?? TASK_TIMEOUT_MS;
      while (now() - started < timeout) {
        const task = await request<TripoTask>("GET", `/tasks/${encodeURIComponent(taskId)}`);
        const progress = typeof task?.progress === "number" ? task.progress : null;
        if (progress !== last) {
          last = progress;
          onProgress?.(progress);
        }
        if (task?.status === "success") {
          log("[debug/avatar-generation] Tripo task %s finished: %d credits", taskId, task.credits_consumed ?? 0);
          return task;
        }
        if (TASK_ENDED.has(String(task?.status))) {
          log(
            "[debug/avatar-generation] Tripo task %s ended %s (%s): %s",
            taskId,
            task.status,
            task.error_code,
            task.error_message ?? "",
          );
          if (task.status === "banned" || task.error_code === 2008 || task.error_code === "2008") {
            throw new TripoError("content-policy", TRIPO_ERROR_MESSAGES["content-policy"]);
          }
          throw new TripoError(
            "task-failed",
            `Tripo couldn't make ${what} (${task.status}). Credits for a failed step are given back. Try again, or use another sprite.`,
          );
        }
        await wait(options.pollIntervalMs ?? POLL_INTERVAL_MS, signal);
      }
      throw new TripoError("timeout", TRIPO_ERROR_MESSAGES.timeout);
    },

    /** Downloads a result from its signed link, without the key: links are signed, and the key goes only to
     *  the API. Download right away; links don't last. */
    async download(url: unknown, maxBytes: number): Promise<Buffer> {
      if (typeof url !== "string" || !/^https:\/\//iu.test(url)) {
        throw new TripoError("refused", "Tripo sent back a result without a secure download link.");
      }
      log("[debug/avatar-generation] Tripo download %s", linkShape(url));
      let response: Response;
      try {
        response = await send(url, {
          method: "GET",
          signal: limited(options.transferTimeoutMs ?? TRANSFER_TIMEOUT_MS),
          maxResponseBytes: maxBytes,
        });
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        log("[debug/avatar-generation] Tripo download failed: %s", String((error as Error)?.message ?? error));
        throw new TripoError("unavailable", "Couldn't download the result from Tripo. Try again.");
      }
      if (!response.ok) {
        throw new TripoError(
          "unavailable",
          `Couldn't download the result from Tripo (error ${response.status}). Try again.`,
        );
      }
      return Buffer.from(await response.arrayBuffer());
    },
  };
}
