/**
 * Rail Harness Developer Console — HarnessEvent (HC-04).
 *
 * A `HarnessEvent` is a single structured fact about console usage:
 *
 *   { id, sessionId, type, timestamp, projectId, ticketRef, metadata }
 *
 * `type` MUST be one of `HARNESS_EVENT_TYPES` — an explicit, closed set.
 * `metadata` is restricted to `SAFE_METADATA_KEYS` and is recursively
 * stripped of anything that looks like a secret (`SECRET_KEY_RE` from
 * `src/security/sanitize.js`), with every string value additionally passed
 * through `redactSecrets` as defense in depth. This module measures FLOW,
 * never CONTENT: no shell commands, no keystrokes, no stdin, no source code,
 * no tokens.
 */

import crypto from "node:crypto";

import { SECRET_KEY_RE, redactSecrets } from "../../security/sanitize.js";

/** Explicit, closed set of event types — HC-04 scope only. */
export const HARNESS_EVENT_TYPES = Object.freeze([
  "SESSION_STARTED",
  "AUTH_STATUS_CHECKED",
  "LOGIN_SUCCEEDED",
  "LOGIN_FAILED",
  "LOGOUT",
  "PROJECT_LIST_VIEWED",
  "PROJECT_SELECTED",
  "READY_LIST_VIEWED",
  "TICKET_SELECTED",
  "TICKET_DETAIL_VIEWED",
  "DOCTOR_RUN",
  "SETUP_RUN",
  "COMMAND_FAILED",
  "SESSION_COMPLETED",
  "SESSION_FAILED",
  "SESSION_ABORTED"
]);

const EVENT_TYPE_SET = new Set(HARNESS_EVENT_TYPES);

export function isValidEventType(type) {
  return EVENT_TYPE_SET.has(type);
}

/** Explicit allowlist of metadata keys. Anything else is dropped, not just secret-looking keys. */
export const SAFE_METADATA_KEYS = Object.freeze([
  "projectName",
  "projectId",
  "ticketRef",
  "ticketTitle",
  "command",
  "result",
  "count",
  "reasonCode"
]);

function sanitizeValue(value) {
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue).filter(v => v !== undefined);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) continue;
      const sanitized = sanitizeValue(val);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }
  // functions, undefined, symbols: never stored.
  return undefined;
}

/**
 * Reduce arbitrary `metadata` to only the allowed keys, then recursively
 * strip any secret-looking key and redact any secret-shaped string value —
 * even inside an allowed key's own value, in case it happens to be an
 * object. Never throws; unknown/disallowed keys are silently dropped.
 */
export function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  const out = {};
  for (const key of SAFE_METADATA_KEYS) {
    if (!(key in metadata)) continue;
    if (SECRET_KEY_RE.test(key)) continue; // defensive; none of SAFE_METADATA_KEYS match today
    const sanitized = sanitizeValue(metadata[key]);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

function cleanRef(value) {
  const v = (value ?? "").toString().trim();
  return v.length ? v : null;
}

/**
 * Build one HarnessEvent. Throws only on a programmer error (invalid
 * `type` / missing `sessionId`) — both are internal-code invariants, never
 * user input, so this is safe to call without a try/catch at the call site;
 * `context.js`'s facade wraps it anyway for the fail-safe guarantee.
 */
export function createEvent({ sessionId, type, projectId = null, ticketRef = null, metadata = {} } = {}) {
  if (!sessionId) throw new Error("createEvent: sessionId requerido.");
  if (!isValidEventType(type)) throw new Error(`createEvent: tipo de evento inválido "${type}".`);

  return {
    id: `rhe_${crypto.randomUUID()}`,
    sessionId,
    type,
    timestamp: new Date().toISOString(),
    projectId: cleanRef(projectId),
    ticketRef: cleanRef(ticketRef),
    metadata: sanitizeMetadata(metadata)
  };
}
