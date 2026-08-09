// ──────────────────────────────────────────────
// Shared classification for getUserMedia() failures
// ──────────────────────────────────────────────

export type MicAccessErrorKind = "insecure-context" | "permission-denied" | "not-found" | "unknown";

/**
 * `navigator.mediaDevices` is only defined in secure contexts (HTTPS, or localhost/127.0.0.1).
 * On plain HTTP over a LAN IP, calling `getUserMedia` throws a TypeError before any permission
 * prompt appears — that failure mode looks identical to a denied prompt unless we check for it
 * explicitly, so classify it first.
 */
export function classifyMicAccessError(error: unknown): MicAccessErrorKind {
  if (typeof navigator !== "undefined" && !navigator.mediaDevices) return "insecure-context";
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "permission-denied";
    if (error.name === "NotFoundError") return "not-found";
  }
  return "unknown";
}
