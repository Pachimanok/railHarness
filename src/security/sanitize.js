/**
 * Secret sanitization for the Rail Harness.
 *
 * Single home for every "do not leak a secret" helper. The Harness handles a
 * Rail agent bearer token, per-Run `claimToken`s and (potentially) human
 * tokens. NONE of them may end up in logs, in a prompt handed to an adapter,
 * or in an environment inherited by a child process.
 *
 * Ported/consolidated from the approved reference (`~/rail-runner/harness`):
 *   - `sanitizeTicket`      (scripts/harness.mjs)
 *   - `safeTopLevelKeys`    (scripts/harness.mjs)
 *   - `safeEnvironment`     (adapters/claude-code.mjs)
 *
 * Nothing here performs I/O or logging; callers decide what to print.
 */

/** Keys whose *value* is always a secret and must never be shown. */
export const SECRET_KEY_RE =
  /(token|secret|authorization|password|passwd|apikey|api[-_]?key|bearer|credential|claim[-_]?token)/i;

/** Env var names the Harness control plane owns and must not pass to adapters. */
export const CONTROL_PLANE_ENV_RE = /^RAIL_/;

/** Extra single env vars stripped from any adapter/child environment. */
export const EXTRA_STRIPPED_ENV = Object.freeze([
  "CLAIM_TOKEN",
  "RAIL_HUMAN_TOKEN"
]);

export const REDACTION = "<redacted>";

/**
 * Deep-clone `value` with every property whose key matches `SECRET_KEY_RE`
 * removed. Works on nested objects and arrays. Non-plain values (Date, etc.)
 * are returned via structured JSON round-trip semantics, matching the
 * reference's `JSON.parse(JSON.stringify(...))` approach.
 *
 * Use this on a Rail ticket detail before it is embedded in an adapter
 * prompt or written to disk.
 */
export function stripSecretKeys(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) => {
      if (key && SECRET_KEY_RE.test(key)) return undefined;
      return val;
    })
  );
}

/** Back-compat alias matching the reference name. */
export const sanitizeTicket = stripSecretKeys;

/**
 * Human-readable list of an object's top-level keys for diagnostics, with any
 * secret-looking key rendered as `key=<redacted>`. NEVER prints a value.
 */
export function safeTopLevelKeys(obj) {
  if (obj === null || obj === undefined) return "(no payload)";
  if (typeof obj !== "object") return `(payload ${typeof obj})`;

  const keys = Object.keys(obj);
  if (keys.length === 0) return "(empty payload)";

  return keys
    .map(k => (SECRET_KEY_RE.test(k) ? `${k}=${REDACTION}` : k))
    .join(", ");
}

/**
 * Redact secret-looking substrings from a free-form string before logging:
 *   - `Authorization: Bearer <x>` / `Bearer <x>`
 *   - Rail agent tokens (`rag_...`) and generic long opaque tokens
 *   - any exact value listed in `extraValues` (e.g. the loaded token)
 *
 * Pure. Returns a new string.
 */
export function redactSecrets(input, extraValues = []) {
  let text = String(input ?? "");

  for (const raw of extraValues) {
    const v = String(raw ?? "").trim();
    if (v.length >= 6) {
      text = text.split(v).join(REDACTION);
    }
  }

  text = text.replace(/\b(bearer\s+)[A-Za-z0-9._\-+/=]{6,}/gi, `$1${REDACTION}`);
  text = text.replace(
    /\b(authorization\s*[:=]\s*)[^\s,;]+/gi,
    `$1${REDACTION}`
  );
  text = text.replace(/\brag_[A-Za-z0-9._\-]{6,}/g, REDACTION);
  text = text.replace(
    /\b(claim[-_]?token"?\s*[:=]\s*"?)[A-Za-z0-9._\-]{6,}/gi,
    `$1${REDACTION}`
  );

  return text;
}

/**
 * A copy of `sourceEnv` safe to hand to an adapter / child process: every
 * `RAIL_*` var and every name in `EXTRA_STRIPPED_ENV` removed. The Harness
 * control plane credentials never cross into adapter execution.
 */
export function safeEnvironment(sourceEnv = process.env) {
  const env = { ...sourceEnv };

  for (const key of Object.keys(env)) {
    if (CONTROL_PLANE_ENV_RE.test(key)) delete env[key];
  }
  for (const key of EXTRA_STRIPPED_ENV) {
    delete env[key];
  }

  return env;
}
