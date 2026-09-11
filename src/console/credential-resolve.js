/**
 * Rail Harness Developer Console — credential resolution (HC-03).
 *
 * Single place that decides which Rail token a command should use:
 * `RAIL_TOKEN` from the environment always wins — backward compatible with
 * HC-02, and NEVER persisted automatically just because it was read — and
 * otherwise the token saved locally by `rail-harness login`
 * (`credential-store.js`). Neither value is ever logged here; callers must
 * treat the resolved token exactly like any other secret.
 */

import os from "node:os";

import { readCredentials } from "./credential-store.js";

export const CREDENTIAL_SOURCE = Object.freeze({
  ENVIRONMENT: "environment",
  STORE: "credencial local"
});

function clean(value) {
  const v = (value ?? "").toString().trim();
  return v.length ? v : null;
}

/**
 * Resolve `{ token, source }`. `source` is `CREDENTIAL_SOURCE.ENVIRONMENT`,
 * `CREDENTIAL_SOURCE.STORE`, or `null` when neither is present — the
 * caller's NOT_AUTHENTICATED state (`token` is `null` too, in that case).
 */
export function resolveCredentials({ env = process.env, homeDir = os.homedir() } = {}) {
  const envToken = clean(env.RAIL_TOKEN);
  if (envToken) {
    return { token: envToken, source: CREDENTIAL_SOURCE.ENVIRONMENT };
  }

  const stored = readCredentials(homeDir);
  if (stored.ok) {
    return { token: stored.token, source: CREDENTIAL_SOURCE.STORE };
  }

  return { token: null, source: null };
}
