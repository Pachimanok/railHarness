/**
 * Rail Harness runtime configuration.
 *
 * Reads the environment once, validates it, and produces a frozen config
 * object. No I/O beyond reading `env`. No secret is ever logged: use
 * `describeConfig()` for anything human-facing.
 *
 * Derived from the approved reference (`~/rail-runner/harness/scripts/harness.mjs`
 * `main()` + `assertModeSelection`). The autonomous loop that *consumes* this
 * config (Worker Core / Orchestration) is a later ticket.
 */

import { redactSecrets } from "../security/sanitize.js";

/** Env vars required in every mode. */
export const REQUIRED_ENV = Object.freeze([
  "RAIL_API_URL",
  "RAIL_TOKEN",
  "RAIL_PROJECT_ID",
  "RAIL_REPO_PATH"
]);

/** Optional env vars the Harness understands (documented in `.env.example`). */
export const OPTIONAL_ENV = Object.freeze([
  "RAIL_MACHINE",
  "RAIL_AGENT",
  "RAIL_TICKET_REF",
  "RAIL_RECOVER_REF",
  "RAIL_BASE_BRANCH",
  "RAIL_RECOVER_NOTES"
]);

export const HARNESS_MODES = Object.freeze({
  DISCOVERY: "discovery",
  EXPLICIT: "explicit",
  RECOVER: "recover"
});

const DEFAULT_AGENT = "rail-harness";

function clean(value) {
  const v = (value ?? "").toString().trim();
  return v.length ? v : null;
}

/**
 * `RAIL_TICKET_REF` (explicit claim) and `RAIL_RECOVER_REF` (governed
 * recovery of an orphaned IN_PROGRESS cycle) are mutually exclusive. Mirror
 * of the reference's `assertModeSelection`. Pure.
 */
export function resolveMode({ ticketRef, recoverRef }) {
  if (ticketRef && recoverRef) {
    throw new Error(
      "RAIL_RECOVER_REF and RAIL_TICKET_REF are mutually exclusive. " +
        "Use RAIL_RECOVER_REF to recover an orphaned cycle, or RAIL_TICKET_REF for a normal claim."
    );
  }
  if (recoverRef) return HARNESS_MODES.RECOVER;
  if (ticketRef) return HARNESS_MODES.EXPLICIT;
  return HARNESS_MODES.DISCOVERY;
}

/**
 * Build the runtime config from `env` (defaults to `process.env`).
 *
 * `machineFallback` is injectable for tests (production passes
 * `os.hostname()`); it is only used when `RAIL_MACHINE` is unset.
 *
 * Throws an explicit Error listing every missing required var. The message is
 * safe to print — it never contains a value.
 */
export function loadRuntimeConfig(env = process.env, { machineFallback = null } = {}) {
  const missing = REQUIRED_ENV.filter(name => !clean(env[name]));
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "See .env.example. No secret values are read from anywhere else."
    );
  }

  const apiUrl = clean(env.RAIL_API_URL);
  let parsedUrl;
  try {
    parsedUrl = new URL(apiUrl);
  } catch {
    throw new Error(`RAIL_API_URL is not a valid URL: ${apiUrl}`);
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost") {
    throw new Error(
      `RAIL_API_URL must be https (got ${parsedUrl.protocol}//). ` +
        "Only localhost may use http, for local development."
    );
  }

  const ticketRef = clean(env.RAIL_TICKET_REF);
  const recoverRef = clean(env.RAIL_RECOVER_REF);
  const mode = resolveMode({ ticketRef, recoverRef });

  const config = {
    rail: {
      apiUrl: apiUrl.replace(/\/$/, ""),
      token: clean(env.RAIL_TOKEN),
      projectId: clean(env.RAIL_PROJECT_ID)
    },
    repoPath: clean(env.RAIL_REPO_PATH),
    machine: clean(env.RAIL_MACHINE) || machineFallback || "unknown-machine",
    agent: clean(env.RAIL_AGENT) || DEFAULT_AGENT,
    actor: "agent",
    mode,
    ticketRef,
    recoverRef,
    baseBranch: clean(env.RAIL_BASE_BRANCH),
    recoverNotes: clean(env.RAIL_RECOVER_NOTES)
  };

  config.rail = Object.freeze(config.rail);
  return Object.freeze(config);
}

/**
 * Human-readable, secret-free view of a config for logging / preflight
 * output. The token is reported only as present/absent and never printed;
 * every field is additionally run through `redactSecrets` as defense in
 * depth.
 */
export function describeConfig(config) {
  const lines = [
    `apiUrl:     ${config.rail.apiUrl}`,
    `projectId:  ${config.rail.projectId}`,
    `token:      ${config.rail.token ? "present (<redacted>)" : "MISSING"}`,
    `repoPath:   ${config.repoPath}`,
    `machine:    ${config.machine}`,
    `agent:      ${config.agent}`,
    `mode:       ${config.mode}`,
    `ticketRef:  ${config.ticketRef ?? "(none)"}`,
    `recoverRef: ${config.recoverRef ?? "(none)"}`,
    `baseBranch: ${config.baseBranch ?? "(auto-detect)"}`
  ];

  return redactSecrets(lines.join("\n"), [config.rail.token]);
}
