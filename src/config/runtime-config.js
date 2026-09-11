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
  "RAIL_RESUME_REF",
  "RAIL_BASE_BRANCH",
  "RAIL_RECOVER_NOTES",
  "RAIL_RESUME_NOTES",
  // Worker Core (src/worker/cli.js) — polling / heartbeat cadence.
  "RAIL_HEARTBEAT_INTERVAL_MS",
  "RAIL_DISCOVERY_POLL_MS",
  // Workspace Manager (src/workspace/) — root under which every ticket gets
  // its own isolated git worktree. Absolute path; no machine-specific default.
  "RAIL_WORKSPACE_ROOT",
  // Orchestration (src/orchestration/) — explicit adapter provider driven
  // through the AdapterRouter. Default: claude-code.
  "RAIL_ADAPTER_PROVIDER"
]);

export const HARNESS_MODES = Object.freeze({
  DISCOVERY: "discovery",
  EXPLICIT: "explicit",
  RECOVER: "recover", // POST /recover — IN_PROGRESS ownerless FAILED/ABANDONED compat
  RESUME: "resume" // POST /resume  — GENERAL continuation of a non-terminal cycle
});

const DEFAULT_AGENT = "rail-harness";

function clean(value) {
  const v = (value ?? "").toString().trim();
  return v.length ? v : null;
}

/**
 * `RAIL_TICKET_REF` (explicit claim), `RAIL_RESUME_REF` (governed GENERAL
 * `/resume` continuation of a non-terminal cycle) and `RAIL_RECOVER_REF`
 * (compat `/recover` of an orphaned IN_PROGRESS cycle) are MUTUALLY EXCLUSIVE —
 * each mode uses a distinct endpoint and there is no fallback between them.
 * Mirror of the reference's `assertModeSelection`. Pure.
 */
export function resolveMode({ ticketRef, recoverRef, resumeRef }) {
  const set = [
    ["RAIL_TICKET_REF", ticketRef],
    ["RAIL_RECOVER_REF", recoverRef],
    ["RAIL_RESUME_REF", resumeRef]
  ].filter(([, v]) => v);
  if (set.length > 1) {
    throw new Error(
      `${set.map(([n]) => n).join(", ")} are mutually exclusive. Use RAIL_RESUME_REF to continue a ` +
        "non-terminal cycle (/resume), RAIL_RECOVER_REF for the classic /recover of an orphaned " +
        "IN_PROGRESS cycle, or RAIL_TICKET_REF for a normal claim."
    );
  }
  if (resumeRef) return HARNESS_MODES.RESUME;
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
  const resumeRef = clean(env.RAIL_RESUME_REF);
  const mode = resolveMode({ ticketRef, recoverRef, resumeRef });

  const config = {
    rail: {
      apiUrl: apiUrl.replace(/\/$/, ""),
      token: clean(env.RAIL_TOKEN),
      projectId: clean(env.RAIL_PROJECT_ID)
    },
    repoPath: clean(env.RAIL_REPO_PATH),
    workspaceRoot: clean(env.RAIL_WORKSPACE_ROOT),
    adapterProvider: clean(env.RAIL_ADAPTER_PROVIDER) || "claude-code",
    machine: clean(env.RAIL_MACHINE) || machineFallback || "unknown-machine",
    agent: clean(env.RAIL_AGENT) || DEFAULT_AGENT,
    actor: "agent",
    mode,
    ticketRef,
    recoverRef,
    resumeRef,
    baseBranch: clean(env.RAIL_BASE_BRANCH),
    recoverNotes: clean(env.RAIL_RECOVER_NOTES),
    resumeNotes: clean(env.RAIL_RESUME_NOTES)
  };

  config.rail = Object.freeze(config.rail);
  return Object.freeze(config);
}

/**
 * Vista human-facing de la config, sin secretos, para logs / preflight. En
 * español (política de idioma — docs/HARNESS.md). El token sólo se reporta
 * como presente/ausente y nunca se imprime; además todo el texto pasa por
 * `redactSecrets` como defensa en profundidad.
 *
 * Las etiquetas (`apiUrl`, `mode`, …) son identificadores de configuración y
 * el valor de `mode` es un enum: no se traducen.
 */
export function describeConfig(config) {
  const lines = [
    `apiUrl:     ${config.rail.apiUrl}`,
    `projectId:  ${config.rail.projectId}`,
    `token:      ${config.rail.token ? "presente (<redacted>)" : "FALTANTE"}`,
    `repoPath:   ${config.repoPath}`,
    `workspaceRoot: ${config.workspaceRoot ?? "(sin configurar)"}`,
    `machine:    ${config.machine}`,
    `agent:      ${config.agent}`,
    `mode:       ${config.mode}`,
    `ticketRef:  ${config.ticketRef ?? "(ninguno)"}`,
    `recoverRef: ${config.recoverRef ?? "(ninguno)"}`,
    `resumeRef:  ${config.resumeRef ?? "(ninguno)"}`,
    `baseBranch: ${config.baseBranch ?? "(autodetección)"}`
  ];

  return redactSecrets(lines.join("\n"), [config.rail.token]);
}
