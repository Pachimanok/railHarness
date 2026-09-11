/**
 * Rail Harness Developer Console — READ-ONLY Rail facade (HC-02, Paso 2).
 *
 * This is the ONLY file under `src/console/` allowed to import
 * `../rail/rail-api-client.js`. Every other console module receives a
 * `rail` object (this facade, or a test fake) by dependency injection and
 * never touches `RailApiClient` directly.
 *
 * `createReadonlyRail()` exposes EXACTLY three read-only methods —
 * `listProjects`, `listReady`, `getTicket` — and nothing else. The
 * underlying `RailApiClient` also has mutating methods (`claim`, `resume`,
 * `recover`, `transition`, `addComment`, `createQuery`, `createCheck`,
 * `createDeployment`, `updateDeployment`, `heartbeat`, `finishRun`); none of
 * them are reachable from the object this module returns. The Worker Core
 * still uses the full client elsewhere — this facade does not change
 * `RailApiClient` in any way, it only restricts what the Developer Console
 * can reach.
 *
 * Never logs, never prints `RAIL_TOKEN`. `RAIL_API_URL` (optionally
 * `RAIL_AGENT`, `RAIL_MACHINE`) always comes from the environment. The token
 * itself comes from the environment too via `buildReadonlyRailFromEnv`
 * (HC-02, unchanged), or — via `buildReadonlyRailFromCredentials` (HC-03) —
 * from `env.RAIL_TOKEN` falling back to the developer's locally stored
 * personal credential (`credential-store.js`).
 *
 * `RAIL_API_URL` must satisfy the same secure-transport policy as the Worker
 * Core (`assertSecureRailUrl` from `src/config/runtime-config.js`: HTTPS, or
 * HTTP only for `localhost`). That check runs BEFORE `RailApiClient` is ever
 * constructed, so an invalid/insecure URL can never reach `fetch` and
 * `RAIL_TOKEN` is never sent anywhere.
 */

import { RailApiClient } from "../rail/rail-api-client.js";
import { assertSecureRailUrl } from "../config/runtime-config.js";
import { resolveCredentials } from "./credential-resolve.js";

function clean(value) {
  const v = (value ?? "").toString().trim();
  return v.length ? v : null;
}

/**
 * Read Rail credentials from `env`. Returns `null` when `RAIL_API_URL` or
 * `RAIL_TOKEN` is missing — callers must treat that as "RailSoft not
 * configured for this user" and never fall back to inventing a value.
 */
export function railCredentialsFromEnv(env = process.env) {
  const apiUrl = clean(env.RAIL_API_URL);
  const token = clean(env.RAIL_TOKEN);
  if (!apiUrl || !token) return null;

  return {
    apiUrl,
    token,
    agent: clean(env.RAIL_AGENT) || undefined,
    machine: clean(env.RAIL_MACHINE) || undefined
  };
}

/**
 * Build the read-only Rail capability handed to the Developer Console.
 * `creds` is the object returned by `railCredentialsFromEnv` (or an
 * equivalent test fixture). Throws if `apiUrl`/`token` are missing, or if
 * `apiUrl` fails `assertSecureRailUrl` (not HTTPS, and not `localhost`) —
 * in every throwing case `RailApiClient` is never constructed, so no `fetch`
 * can happen and `RAIL_TOKEN` is never sent. Callers that read `env`
 * directly should prefer `buildReadonlyRailFromEnv`, which turns this throw
 * into a Spanish, secret-free message instead of propagating an exception.
 */
export function createReadonlyRail(creds) {
  assertSecureRailUrl(creds?.apiUrl);

  const client = new RailApiClient({
    baseUrl: creds?.apiUrl,
    token: creds?.token,
    agent: creds?.agent,
    machine: creds?.machine,
    actor: "agent"
  });

  return Object.freeze({
    listProjects: () => client.listProjects(),
    listReady: (projectId, limit) => client.listReady(projectId, limit),
    getTicket: ref => client.getTicket(ref)
  });
}

/** Human, Spanish, secret-free message for an invalid/insecure `RAIL_API_URL`. */
export const RAIL_INSECURE_URL_MESSAGE =
  "RAIL_API_URL no es válida o no es segura (debe ser HTTPS; HTTP sólo se " +
  "permite para localhost, en desarrollo). Contactá al administrador del Harness.";

/**
 * Resolve the read-only Rail facade from `env` in one call, never throwing:
 *   - `{ rail: null, error: null }`      — no credentials configured at all
 *     (`RAIL_API_URL`/`RAIL_TOKEN` missing) — "RailSoft not configured".
 *   - `{ rail: null, error: <string> }`  — credentials present but
 *     `RAIL_API_URL` is invalid or insecure. `createReadonlyRail` is never
 *     even called with it, so no `RailApiClient` is built and no `fetch`
 *     can happen. `error` never contains `RAIL_TOKEN` or its value.
 *   - `{ rail: <facade>, error: null }`  — ready to use.
 * The validation this performs runs strictly before any request is
 * possible — callers should check `error` BEFORE falling back to treating
 * `rail === null` as "not configured".
 */
export function buildReadonlyRailFromEnv(env = process.env) {
  const creds = railCredentialsFromEnv(env);
  if (!creds) return { rail: null, error: null };

  try {
    assertSecureRailUrl(creds.apiUrl);
  } catch {
    return { rail: null, error: RAIL_INSECURE_URL_MESSAGE };
  }

  return { rail: createReadonlyRail(creds), error: null };
}

/**
 * Resolve the read-only Rail facade using the HC-03 credential precedence:
 * `RAIL_TOKEN` from `env` wins (unchanged HC-02 behaviour), otherwise the
 * token saved locally by `rail-harness login` (`credential-store.js`, via
 * `credential-resolve.js`). `RAIL_API_URL` itself is still read from `env`
 * only — it is not a secret and is shared by every developer on the
 * machine; only the token is personal. Same never-throws contract as
 * `buildReadonlyRailFromEnv`:
 *   - `{ rail: null, error: null, source: null }` — no token at all
 *     (NOT_AUTHENTICATED) or no `RAIL_API_URL` configured.
 *   - `{ rail: null, error: <string>, source: null }` — a token is present
 *     but `RAIL_API_URL` is invalid/insecure; no request is possible.
 *   - `{ rail: <facade>, error: null, source }` — ready to use; `source` is
 *     `"environment"` or `"credencial local"`.
 */
export function buildReadonlyRailFromCredentials({ env = process.env, homeDir } = {}) {
  const apiUrl = clean(env.RAIL_API_URL);
  const { token, source } = resolveCredentials({ env, homeDir });

  if (!apiUrl || !token) return { rail: null, error: null, source: null };

  try {
    assertSecureRailUrl(apiUrl);
  } catch {
    return { rail: null, error: RAIL_INSECURE_URL_MESSAGE, source: null };
  }

  const creds = {
    apiUrl,
    token,
    agent: clean(env.RAIL_AGENT) || undefined,
    machine: clean(env.RAIL_MACHINE) || undefined
  };
  return { rail: createReadonlyRail(creds), error: null, source };
}
