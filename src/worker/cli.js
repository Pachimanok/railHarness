/**
 * `npm run worker` — the persistent Worker Core process, plus the one-shot
 * governed RECOVERY path.
 *
 * Default (`RAIL_RECOVER_REF` unset): read the runtime config, build a
 * RailApiClient, and drive `createWorkerCore`. Between `claim` and `finish` it
 * wires the ORCHESTRATION execution (RAIL-D-00005): isolated workspace ->
 * IMPLEMENTER -> REVIEWER -> TESTER, publishing governed checks and requesting
 * governed transitions (docs/ORCHESTRATION.md).
 *
 * Recovery (`RAIL_RECOVER_REF=<ref>`, mutually exclusive with
 * `RAIL_TICKET_REF`): a SINGLE governed `recover` of an orphaned `IN_PROGRESS`
 * cycle (docs/RECOVERY.md) — `getTicket` (read-only) -> fail-closed preflight ->
 * read-only worktree check -> `POST /recover` (the one mutation) -> heartbeat
 * with the NEW claimToken + one governed execution from `IN_PROGRESS` ->
 * `finishRun` for the recovered Run exactly once. `claim` is NEVER a fallback.
 *
 * Human-facing output is Spanish; the Rail token and any per-Run claimToken are
 * never printed. SIGINT / SIGTERM request a controlled stop; a second signal
 * forces an immediate exit.
 */

import os from "node:os";

import { loadRuntimeConfig, describeConfig, HARNESS_MODES } from "../config/runtime-config.js";
import { RailApiClient } from "../rail/rail-api-client.js";
import { createWorkerCore } from "./worker-core.js";
import {
  createRecoveryRunner,
  createResumeRunner,
  RECOVERY_RESULT_CODES
} from "./recovery.js";
import { createAdapterRouter } from "../adapters/adapter-router.js";
import { createOrchestrationExecution } from "../orchestration/orchestrator.js";

/** Parse an optional positive-integer ms env var, falling back to `fallback`. */
export function readIntervalEnv(env, name, fallback) {
  const raw = (env[name] ?? "").toString().trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} debe ser un entero de milisegundos > 0 (recibí "${raw}").`);
  }
  return Math.floor(n);
}

/** Wire SIGINT / SIGTERM to a controlled stop; a second signal exits now. */
function installSignalHandlers(stop, logger) {
  let seen = 0;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      seen += 1;
      if (seen === 1) {
        stop(`Señal ${signal} recibida`);
      } else {
        logger("Segunda señal recibida: salida inmediata.");
        process.exit(130);
      }
    });
  }
}

/** Result codes that mean "recovery did not run any execution and Rail was not mutated". */
const RECOVERY_NO_OP_CODES = new Set([
  RECOVERY_RESULT_CODES.NOT_RECOVERABLE,
  RECOVERY_RESULT_CODES.WORKSPACE_MISMATCH,
  RECOVERY_RESULT_CODES.ENDPOINT_UNAVAILABLE,
  RECOVERY_RESULT_CODES.REJECTED_ACTIVE_RUN,
  RECOVERY_RESULT_CODES.TICKET_READ_FAILED
]);

const CLI_BANNERS = {
  [HARNESS_MODES.RESUME]: "Rail Harness — Resume (/resume)",
  [HARNESS_MODES.RECOVER]: "Rail Harness — Recover (/recover, compat)"
};

export async function runWorkerCli({ env = process.env, logger = line => console.log(line) } = {}) {
  const config = loadRuntimeConfig(env, { machineFallback: os.hostname() });

  logger(CLI_BANNERS[config.mode] || "Rail Harness — Worker Core");
  logger(describeConfig(config));
  logger("");

  const heartbeatIntervalMs = readIntervalEnv(env, "RAIL_HEARTBEAT_INTERVAL_MS", 5 * 60 * 1000);
  const discoveryPollMs = readIntervalEnv(env, "RAIL_DISCOVERY_POLL_MS", 30 * 1000);

  if (heartbeatIntervalMs >= 15 * 60 * 1000) {
    logger(
      "Aviso: el intervalo de heartbeat es alto; asegurate de que sea menor que la " +
        "duración del lease que otorga Rail."
    );
  }

  const api = RailApiClient.fromRuntimeConfig(config);
  const adapterRouter = createAdapterRouter({ provider: config.adapterProvider });

  if (!config.workspaceRoot) {
    logger(
      "Aviso: RAIL_WORKSPACE_ROOT no está configurado; la orquestación no podrá preparar " +
        "un workspace aislado y cada ejecución terminará en FAILED. Configuralo en .env."
    );
  }

  // The one collaborator that turns a claimed / resumed / recovered Run into
  // governed IMPLEMENTER -> REVIEWER -> TESTER work. The start state is taken
  // from `ctx.recovery.cycleState` when the runner set it (a fresh claim has no
  // `ctx.recovery`, so it starts at CLAIMED; a `/resume` preserves the EXACT
  // Rail state; a classic `/recover` starts at IN_PROGRESS).
  const makeExecution = ctx =>
    createOrchestrationExecution(ctx, {
      api,
      adapterRouter,
      provider: config.adapterProvider,
      workspaceRoot: config.workspaceRoot,
      repoPath: config.repoPath,
      baseBranch: config.baseBranch,
      startState: ctx.recovery?.cycleState ?? "CLAIMED",
      logger
    });

  // ── One governed /resume or /recover, then exit ──────────────────────────
  if (config.mode === HARNESS_MODES.RESUME || config.mode === HARNESS_MODES.RECOVER) {
    const isResume = config.mode === HARNESS_MODES.RESUME;
    const ref = isResume ? config.resumeRef : config.recoverRef;
    const notes = isResume ? config.resumeNotes : config.recoverNotes;
    const make = isResume ? createResumeRunner : createRecoveryRunner;

    const runner = make({
      api,
      projectId: config.rail.projectId,
      createExecution: makeExecution,
      workspaceRoot: config.workspaceRoot,
      repoPath: config.repoPath,
      baseBranch: config.baseBranch,
      heartbeatIntervalMs,
      logger
    });
    installSignalHandlers(reason => runner.requestStop(reason), logger);

    const result = await (isResume ? runner.resume : runner.recover)(ref, { reason: notes });
    logger(
      `${isResume ? "resume" : "recover"} de ${ref}: outcome=${result.outcome} code=${result.code}` +
        (result.recoveredRunId ? ` newRunId=${result.recoveredRunId}` : "") +
        (result.fromRunId ? ` recoveryOfRunId=${result.fromRunId}` : "") +
        (result.finishOutcome ? ` finishRun=${result.finishOutcome}` : "") +
        "."
    );
    return {
      mode: config.mode,
      result,
      // exit 0 only when the new Run finished COMPLETED; a fail-closed no-op
      // exits 2 (nothing mutated); anything else exits 1.
      exitCode:
        result.outcome === "COMPLETED"
          ? 0
          : RECOVERY_NO_OP_CODES.has(result.code)
            ? 2
            : 1
    };
  }

  // ── Default: the persistent discovery / claim loop ────────────────────────
  const worker = createWorkerCore({
    api,
    projectId: config.rail.projectId,
    createExecution: makeExecution,
    heartbeatIntervalMs,
    discoveryPollMs,
    logger
  });

  installSignalHandlers(reason => worker.requestStop(reason), logger);

  await worker.start();
  return { mode: config.mode, state: worker.getState(), exitCode: 0 };
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  runWorkerCli()
    .then(res => process.exit(res?.exitCode ?? 0))
    .catch(err => {
      console.error("WORKER CORE FATAL:");
      console.error(err);
      process.exit(1);
    });
}
