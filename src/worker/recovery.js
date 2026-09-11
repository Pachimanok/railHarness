/**
 * Governed resume / recovery of an orphaned `IN_PROGRESS` WorkCycle —
 * RAIL-D-00006.
 *
 *   getTicket (read-only)
 *     -> resolveRecoveryTarget  (pure; fail-closed on any precondition)
 *     -> inspectWorktree        (read-only git; dirty is EXPECTED, not an error)
 *     -> api.recover(...)        (THE ONE mutation)
 *     -> heartbeat (NEW token) + one governed execution from IN_PROGRESS
 *     -> finishRun (the RECOVERED Run, exactly once)
 *
 * HARD RULES (ticket AC + docs/STATE_MACHINE.md + docs/RECOVERY.md):
 *   - `claim` and `recover` are DISTINCT. A refused recover is NEVER retried as
 *     a `claim`, and a refused `claim` is never retried as a `recover`.
 *   - Rail is the authority: the Harness never reconstructs ownership by
 *     inference and never executes code without a fresh, valid `claimToken`
 *     from the recover handoff.
 *   - Exactly ONE new Run per recovery. The previous Run is never finished,
 *     never revived, and its terminal outcome is never rewritten.
 *   - The NEW `claimToken` lives ONLY in this module's closure (heartbeat /
 *     finish). It never enters the execution context, the ExecutionEnvelope,
 *     prompts, the adapter, logs or the child env.
 *   - A missing recover endpoint (404 / 405 / 501) is fail-closed with NO
 *     alternative mutation.
 *   - Recovery never runs `git reset` / `clean` / destructive `checkout`, never
 *     recreates the worktree, and never rewinds the cycle to `READY`.
 *
 * All I/O is injected so the whole flow is testable offline (no real Rail, no
 * real adapter, no real `claude`, no network). Human-facing text is Spanish;
 * every `code` / RailSoft state is a machine-readable identifier, never
 * translated.
 */

import { stripSecretKeys, SECRET_KEY_RE } from "../security/sanitize.js";
import { inspectWorktree as defaultInspectWorktree } from "../workspace/workspace-manager.js";
import { defaultBranchFor } from "./worker-core.js";
import {
  resolveRecoveryTarget as defaultResolveRecoveryTarget,
  resolveResumeTarget as defaultResolveResumeTarget,
  buildRecoverRequest,
  recoveryTargetSummary,
  RECOVERY_TARGETS,
  RESUME_TARGETS
} from "./recovery-preflight.js";

/** Which governed continuation endpoint this runner drives. */
export const CONTINUATION_OPERATIONS = Object.freeze({
  RESUME: "resume", // POST /tickets/:ref/resume — GENERAL, preserves cycle state
  RECOVER: "recover" // POST /tickets/:ref/recover — IN_PROGRESS ownerless FAILED/ABANDONED compat
});

/** Recovery lifecycle phases (identifiers — never translated). */
export const RECOVERY_PHASES = Object.freeze({
  INIT: "INIT",
  READING: "READING",
  PREFLIGHT: "PREFLIGHT",
  RECOVERING: "RECOVERING",
  EXECUTING: "EXECUTING",
  FENCING: "FENCING",
  STOPPING: "STOPPING",
  DONE: "DONE"
});

/** Result `code`s the caller (CLI) can branch on. Identifiers — never translated. */
export const RECOVERY_RESULT_CODES = Object.freeze({
  RECOVERED: "RECOVERED", // recover granted; the recovered Run ran and was finished
  FENCED: "RECOVERY_OWNERSHIP_LOST", // heartbeat rejected mid-execution; no finishRun
  STOPPED: "RECOVERY_STOPPED", // SIGINT/SIGTERM during the recovered execution
  NOT_RECOVERABLE: "RECOVERY_NOT_RECOVERABLE", // preflight fail-closed
  WORKSPACE_MISMATCH: "RECOVERY_WORKSPACE_MISMATCH",
  ENDPOINT_UNAVAILABLE: "RECOVERY_ENDPOINT_UNAVAILABLE",
  REJECTED_ACTIVE_RUN: "RECOVERY_REJECTED_ACTIVE_RUN",
  REJECTED: "RECOVERY_REJECTED",
  RESPONSE_CONTRACT_ERROR: "RECOVERY_RESPONSE_CONTRACT_ERROR",
  TICKET_READ_FAILED: "RECOVERY_TICKET_READ_FAILED"
});

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Recover-endpoint-absent signals (docs/PROTOCOL.md). */
const ENDPOINT_ABSENT_STATUSES = new Set([404, 405, 501]);
const ENDPOINT_ABSENT_CODE_RE =
  /(NOT[_-]?FOUND|NOT[_-]?IMPLEMENTED|UNKNOWN[_-]?ROUTE|METHOD[_-]?NOT[_-]?ALLOWED|UNSUPPORTED)/i;

/** "There is another live Run / you cannot take ownership" rejection of recover. */
const ACTIVE_RUN_CONFLICT_STATUSES = new Set([409, 423]);
const ACTIVE_RUN_CONFLICT_CODE_RE =
  /(ACTIVE[_-]?RUN|LEASE[_-]?LIVE|LEASE[_-]?STILL|ALREADY[_-]?CLAIMED|CONFLICT|OWNERSHIP)/i;

/** Ownership-rejection signals for the recovered Run's heartbeat (mirror of Worker Core). */
const OWNERSHIP_REJECTION_STATUSES = new Set([401, 403, 404, 409, 410]);
const OWNERSHIP_REJECTION_CODE_RE =
  /(OWNERSHIP|NOT[_-]?OWNER|LEASE|ABANDONED|FENCED|FORBIDDEN|NOT[_-]?FOUND|CONFLICT|EXPIRED)/i;

/** Run outcomes RailSoft's `finishRun` accepts; unknown ⇒ FAILED (never RELEASED). */
const RUN_FINISH_OUTCOMES = new Set(["COMPLETED", "FAILED", "ABANDONED", "RELEASED"]);

function matches(err, statuses, codeRe) {
  if (!err) return false;
  if (typeof err.status === "number" && statuses.has(err.status)) return true;
  if (err.code && codeRe.test(String(err.code))) return true;
  return false;
}
const isEndpointAbsent = err => matches(err, ENDPOINT_ABSENT_STATUSES, ENDPOINT_ABSENT_CODE_RE);
const isActiveRunConflict = err =>
  matches(err, ACTIVE_RUN_CONFLICT_STATUSES, ACTIVE_RUN_CONFLICT_CODE_RE);
const isOwnershipRejection = err =>
  matches(err, OWNERSHIP_REJECTION_STATUSES, OWNERSHIP_REJECTION_CODE_RE);

function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve, settled: false };
}

function clip(value, max = 1500) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Throw if `node` carries a secret-looking KEY anywhere (defense in depth). */
function assertNoSecretKeys(node, path = "recoveryExecutionContext") {
  if (node == null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (SECRET_KEY_RE.test(key)) {
      throw new Error(`El contexto de recovery no puede contener secretos: ${path}.${key}`);
    }
    assertNoSecretKeys(value, `${path}.${key}`);
  }
}

function frozenResult(fields) {
  return Object.freeze({ ...fields });
}

/**
 * Build a governed recovery runner.
 *
 * @param {object}   p
 * @param {object}   p.api                RailApiClient (or fake). Needs
 *                                          `getTicket`, `recover`, `heartbeat`,
 *                                          `finishRun`.
 * @param {string}   p.projectId          Rail project the worker is bound to.
 * @param {(ctx:object)=>{done:Promise,cancel:Function}} p.createExecution
 *                                          Factory for the one recovered execution.
 *                                          Receives `{ ref, ticket, branch,
 *                                          run:{id}, recovery:{fromRunId,target} }`
 *                                          — NEVER a claimToken.
 * @param {string}   p.workspaceRoot
 * @param {string}   p.repoPath
 * @param {(codeOrRef:string)=>string} [p.branchFor]
 * @param {Function} [p.runGit]
 * @param {Function} [p.inspectWorktree]   read-only worktree inspector (tests inject a fake).
 * @param {Function} [p.resolveRecoveryTarget]
 * @param {number}   [p.heartbeatIntervalMs]
 * @param {(msg:string)=>void} [p.logger]
 * @param {() => number} [p.now]
 * @param {Function} [p.setIntervalFn]
 * @param {Function} [p.clearIntervalFn]
 */
export function createRecoveryRunner({
  api,
  projectId,
  createExecution,
  workspaceRoot,
  repoPath,
  operation = CONTINUATION_OPERATIONS.RECOVER,
  branchFor = defaultBranchFor,
  runGit,
  inspectWorktree = defaultInspectWorktree,
  resolveRecoveryTarget = defaultResolveRecoveryTarget,
  resolveResumeTarget = defaultResolveResumeTarget,
  expectedLastRunId = null,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  logger = line => console.log(line),
  now = () => Date.now(),
  setIntervalFn = (...args) => setInterval(...args),
  clearIntervalFn = (...args) => clearInterval(...args)
} = {}) {
  const isResume = operation === CONTINUATION_OPERATIONS.RESUME;
  const opLabel = isResume ? "resume" : "recover";
  const apiMethod = isResume ? "resume" : "recover";

  if (!api || typeof api.getTicket !== "function" || typeof api[apiMethod] !== "function") {
    throw new Error(`createRecoveryRunner requiere un cliente Rail con getTicket() y ${apiMethod}()`);
  }
  if (!projectId) throw new Error("createRecoveryRunner requiere projectId");
  if (typeof createExecution !== "function") {
    throw new Error("createRecoveryRunner requiere createExecution(ctx)");
  }
  if (!(heartbeatIntervalMs > 0)) throw new Error("heartbeatIntervalMs debe ser > 0");

  const resolveTargetFn = isResume ? resolveResumeTarget : resolveRecoveryTarget;

  const log = msg => {
    try {
      logger(String(msg));
    } catch {
      /* a broken logger must never crash recovery */
    }
  };

  const state = {
    phase: RECOVERY_PHASES.INIT,
    stopRequested: false,
    stopReason: null,
    fenced: false,
    recoveredRunId: null,
    fromRunId: null,
    lastError: null
  };
  const stopSignal = deferred();
  let activeExecution = null;
  let ownershipLostSignal = null;

  const setPhase = next => {
    state.phase = next;
  };

  function requestStop(reason = "parada solicitada") {
    if (state.stopRequested) return;
    state.stopRequested = true;
    state.stopReason = reason;
    log(`Parada solicitada durante el recovery: ${reason}.`);
    if (!stopSignal.settled) {
      stopSignal.settled = true;
      stopSignal.resolve();
    }
  }

  function getState() {
    return {
      phase: state.phase,
      stopRequested: state.stopRequested,
      stopReason: state.stopReason,
      fenced: state.fenced,
      recoveredRunId: state.recoveredRunId,
      fromRunId: state.fromRunId,
      hasActiveExecution: Boolean(activeExecution),
      lastError: state.lastError
    };
  }

  // ── The recovered Run: claimToken captured in closure ONLY ──────────────

  function makeRecoveredRun({ ref, branch, runId, claimToken, leaseExpiresAt }) {
    let lease = leaseExpiresAt ?? null;
    return {
      ref,
      branch,
      runId,
      get leaseExpiresAt() {
        return lease;
      },
      ownershipLost: false,
      runFinished: false,
      cancelled: false,
      async heartbeatOnce() {
        const r = await api.heartbeat(runId, claimToken);
        if (r && r.leaseExpiresAt) lease = r.leaseExpiresAt;
        return r;
      },
      async finish(outcome, note) {
        return api.finishRun(runId, { claimToken, outcome, note: clip(note), branch });
      }
    };
  }

  function startHeartbeat(run) {
    let stopped = false;
    let timer = null;
    const beat = async () => {
      if (stopped || run.ownershipLost || run.runFinished || state.fenced) return;
      try {
        await run.heartbeatOnce();
        log(`heartbeat OK (Run recuperado ${run.runId}) — lease renovado hasta ${run.leaseExpiresAt}`);
      } catch (err) {
        if (isOwnershipRejection(err)) {
          stopped = true;
          if (timer) clearIntervalFn(timer);
          log(
            `heartbeat RECHAZADO por Rail para el Run recuperado ${run.runId} ` +
              `(status=${err.status ?? "-"} code=${err.code ?? "-"}): se perdió el ownership. Fencing.`
          );
          onOwnershipLost("heartbeat del Run recuperado rechazado por Rail");
        } else {
          log(
            `heartbeat del Run recuperado con error transitorio (${err.message}); no es un rechazo ` +
              "de ownership, se reintenta en el próximo intervalo."
          );
        }
      }
    };
    timer = setIntervalFn(() => {
      void beat();
    }, heartbeatIntervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    return {
      stop() {
        stopped = true;
        if (timer) clearIntervalFn(timer);
        timer = null;
      }
    };
  }

  let recoveredRunRef = null;
  function onOwnershipLost(reason) {
    if (!recoveredRunRef || recoveredRunRef.ownershipLost) return;
    recoveredRunRef.ownershipLost = true;
    state.fenced = true;
    setPhase(RECOVERY_PHASES.FENCING);
    log(
      `FENCING: ${reason}. Se cancela la ejecución recuperada y se bloquea toda mutación sobre el ` +
        `Run ${recoveredRunRef.runId}. No se hará heartbeat ni finishRun sobre este Run; ` +
        "Rail es autoritativo."
    );
    const exec = activeExecution;
    if (exec && !recoveredRunRef.cancelled) {
      recoveredRunRef.cancelled = true;
      try {
        Promise.resolve(exec.cancel("ownership perdido (fencing)")).catch(e =>
          log(`La cancelación de la ejecución recuperada falló: ${e.message}`)
        );
      } catch (e) {
        log(`La cancelación de la ejecución recuperada falló: ${e.message}`);
      }
    }
    if (ownershipLostSignal && !ownershipLostSignal.settled) {
      ownershipLostSignal.settled = true;
      ownershipLostSignal.resolve();
    }
  }

  // ── Public: run ONE governed continuation of `ref` ────────────────────

  async function runContinuation(ref, { reason } = {}) {
    if (state.phase !== RECOVERY_PHASES.INIT) {
      throw new Error(`El ${opLabel} runner ya fue usado (una sola recuperación por instancia)`);
    }
    if (!ref) throw new Error(`${opLabel}(ref) requiere un ref de ticket`);

    // 1. READ-ONLY ticket detail.
    setPhase(RECOVERY_PHASES.READING);
    log(
      `${opLabel} de ${ref}: leyendo el detalle del ticket (read-only). ` +
        "claim, recover y resume son operaciones distintas."
    );
    let detail;
    try {
      detail = await api.getTicket(ref);
    } catch (err) {
      state.lastError = err.message;
      setPhase(RECOVERY_PHASES.DONE);
      log(`No pude leer el detalle de ${ref} (${err.message}). No se hace ninguna mutación.`);
      return frozenResult({
        outcome: "FAILED",
        code: RECOVERY_RESULT_CODES.TICKET_READ_FAILED,
        reason: err.message
      });
    }

    const ticketCode = detail?.item?.code || ref;
    const expectedBranch = branchFor(ticketCode);

    // 2. PURE preflight — fail-closed on any precondition. NO mutation, NO claim,
    //    NO fallback to the other continuation endpoint.
    setPhase(RECOVERY_PHASES.PREFLIGHT);
    const target = resolveTargetFn(detail, {
      projectId,
      ref,
      expectedBranch,
      expectedLastRunId,
      now
    });
    if (!target.recoverable) {
      setPhase(RECOVERY_PHASES.DONE);
      log(
        `${opLabel} de ${ref} NO autorizado (${target.code}): ${target.reason} ` +
          "No se hace resume/recover/claim; Rail queda sin mutar."
      );
      return frozenResult({
        outcome: "BLOCKED",
        code: RECOVERY_RESULT_CODES.NOT_RECOVERABLE,
        preflightCode: target.code,
        reason: target.reason
      });
    }
    log(recoveryTargetSummary(target));

    // 3. READ-ONLY worktree inspection. A dirty worktree is EXPECTED in
    //    recovery and preserved; a mismatch is fail-closed.
    let expectedRepo = null;
    try {
      expectedRepo = detail?.targetRepository?.repoFullName
        ? String(detail.targetRepository.repoFullName).toLowerCase()
        : null;
    } catch {
      expectedRepo = null;
    }

    let ws;
    try {
      ws = inspectWorktree({ workspaceRoot, repoPath, dirKey: ticketCode, runGit });
    } catch (err) {
      setPhase(RECOVERY_PHASES.DONE);
      log(`No pude inspeccionar el worktree de recovery para ${ref} (${err.message}). Fail-closed.`);
      return frozenResult({
        outcome: "BLOCKED",
        code: RECOVERY_RESULT_CODES.WORKSPACE_MISMATCH,
        reason: err.message
      });
    }

    const wsProblem = worktreeProblem(ws, {
      expectedBranch: target.branch,
      expectedRepo
    });
    if (wsProblem) {
      setPhase(RECOVERY_PHASES.DONE);
      log(
        `El worktree de ${opLabel} de ${ref} no es consistente: ${wsProblem} No se hace ${opLabel} ` +
          "(no se recrea el worktree, no se resetea, no se pierde trabajo)."
      );
      return frozenResult({
        outcome: "BLOCKED",
        code: RECOVERY_RESULT_CODES.WORKSPACE_MISMATCH,
        reason: wsProblem
      });
    }
    if (ws.dirty) {
      log(
        `El worktree ${ws.path} tiene trabajo sin commitear: es lo esperado en un ${opLabel} y se ` +
          "PRESERVA (no se hace reset/clean/checkout)."
      );
    }

    // 4. THE ONE MUTATION — governed resume / recover.
    setPhase(RECOVERY_PHASES.RECOVERING);
    const body = buildRecoverRequest(target, { worktreePath: ws.path, reason });
    log(
      `POST ${opLabel} de ${ref} (target=${target.target}, cycleState=${target.cycleState}, ` +
        `branch=${body.branch}, lastRunId=${body.lastRunId}). Es la única mutación.`
    );

    let handoff;
    try {
      handoff = await api[apiMethod](ref, body);
    } catch (err) {
      state.lastError = err.message;
      setPhase(RECOVERY_PHASES.DONE);
      if (isEndpointAbsent(err)) {
        log(
          `El endpoint de ${opLabel} no está desplegado en Rail (status=${err.status ?? "-"} ` +
            `code=${err.code ?? "-"}). Fail-closed: NO se hace un claim, NO se hace ` +
            `${isResume ? "recover" : "resume"} de fallback, NO hay ninguna otra mutación ` +
            `alternativa. Se requiere desplegar POST /tickets/:ref/${apiMethod}.`
        );
        return frozenResult({
          outcome: "BLOCKED",
          code: RECOVERY_RESULT_CODES.ENDPOINT_UNAVAILABLE,
          reason: err.message
        });
      }
      if (isActiveRunConflict(err)) {
        log(
          `Rail rechazó el ${opLabel} de ${ref} porque hay otro activeRun / el lease sigue vivo ` +
            `(status=${err.status ?? "-"} code=${err.code ?? "-"}). Se respeta el rechazo: NO se ` +
            "roba ownership, NO se hace claim, NO se ejecuta el adapter."
        );
        return frozenResult({
          outcome: "ABORTED",
          code: RECOVERY_RESULT_CODES.REJECTED_ACTIVE_RUN,
          reason: err.message
        });
      }
      log(
        `Rail rechazó el ${opLabel} de ${ref} (status=${err.status ?? "-"} code=${err.code ?? "-"}: ` +
          `${err.message}). Se respeta el rechazo: sin claim/recover/resume de fallback, sin ` +
          "transición compensatoria, sin borrar branch/workspace."
      );
      return frozenResult({
        outcome: "FAILED",
        code: RECOVERY_RESULT_CODES.REJECTED,
        reason: err.message
      });
    }

    // 5. Validate the normalized handoff. A 2xx without a usable run.id /
    //    claimToken is a CONTRACT error — do NOT retry recover, do NOT claim.
    const recoveredRunId = handoff?.run?.id ?? null;
    const newClaimToken = handoff?.run?.claimToken ?? null;
    const leaseExpiresAt = handoff?.run?.leaseExpiresAt ?? null;
    const fromRunId = handoff?.recovered?.fromRunId ?? null;
    const cycleState = handoff?.recovered?.cycleState ?? null;

    if (!recoveredRunId || !newClaimToken) {
      setPhase(RECOVERY_PHASES.DONE);
      let railCreatedOwnership = false;
      try {
        const recheck = await api.getTicket(ref);
        railCreatedOwnership = Boolean(recheck?.activeRun?.id);
      } catch {
        /* read-only recheck failed — report the contract error anyway */
      }
      log(
        `RECOVERY_RESPONSE_CONTRACT_ERROR: el ${opLabel} de ${ref} respondió 2xx pero sin ` +
          `run.id/claimToken normalizables (run.id ${recoveredRunId ? "presente" : "AUSENTE"}, ` +
          `claimToken ${newClaimToken ? "presente" : "AUSENTE"}). No se reintenta el ${opLabel} y no se ` +
          `continúa sin claimToken.` +
          (railCreatedOwnership
            ? " AVISO: un GET read-only muestra que Rail SÍ creó un activeRun — la continuación " +
              "queda del lado de Rail; revisar la timeline antes de reintentar."
            : "")
      );
      return frozenResult({
        outcome: "FAILED",
        code: RECOVERY_RESULT_CODES.RESPONSE_CONTRACT_ERROR,
        railCreatedOwnership
      });
    }

    // The recovered Run MUST be a NEW Run, associated with the EXACT prior Run
    // we asked to recover.
    if (recoveredRunId === body.lastRunId) {
      setPhase(RECOVERY_PHASES.DONE);
      log(
        `RECOVERY_RESPONSE_CONTRACT_ERROR: el ${opLabel} de ${ref} devolvió el MISMO runId que ` +
          `lastRunId (${recoveredRunId}). Un ${opLabel} debe crear un Run nuevo. Fail-closed.`
      );
      return frozenResult({
        outcome: "FAILED",
        code: RECOVERY_RESULT_CODES.RESPONSE_CONTRACT_ERROR
      });
    }
    if (fromRunId != null && fromRunId !== body.lastRunId) {
      setPhase(RECOVERY_PHASES.DONE);
      log(
        `RECOVERY_RESPONSE_CONTRACT_ERROR: el ${opLabel} de ${ref} informó recoveryOfRunId=${fromRunId}, ` +
          `distinto del lastRunId solicitado (${body.lastRunId}). Fail-closed: debe estar asociado al ` +
          "Run anterior EXACTO."
      );
      return frozenResult({
        outcome: "FAILED",
        code: RECOVERY_RESULT_CODES.RESPONSE_CONTRACT_ERROR
      });
    }

    // The cycle state is PRESERVED EXACTLY: for `/resume` it is whatever Rail
    // reported (REVIEWING → REVIEWING, …); for classic `/recover` it is
    // IN_PROGRESS. Rail's echoed `cycleState` wins when present, else the
    // preflight's.
    const preservedCycleState = cycleState ?? target.cycleState ?? "IN_PROGRESS";
    state.recoveredRunId = recoveredRunId;
    state.fromRunId = fromRunId ?? body.lastRunId;
    log(
      `${opLabel} exitoso: ${ref} -> Run nuevo ${recoveredRunId} ` +
        `(recoveryOfRunId=${state.fromRunId}, cycleState=${preservedCycleState} — PRESERVADO). ` +
        "El nuevo claimToken queda sólo dentro del runner; el Run anterior no se toca."
    );

    // 6. Drive the recovered execution from IN_PROGRESS. Heartbeat uses the NEW
    //    token only. The prior Run is never touched.
    const run = makeRecoveredRun({
      ref,
      branch: body.branch,
      runId: recoveredRunId,
      claimToken: newClaimToken,
      leaseExpiresAt
    });
    recoveredRunRef = run;
    ownershipLostSignal = deferred();

    setPhase(RECOVERY_PHASES.EXECUTING);
    const hb = startHeartbeat(run);

    try {
      const executionContext = {
        ref: run.ref,
        ticket: stripSecretKeys(detail ?? {}),
        branch: run.branch,
        run: { id: run.runId },
        recovery: Object.freeze({
          fromRunId: state.fromRunId,
          target: target.target,
          operation: opLabel,
          // The orchestrator continues from THIS state; it never rewinds it.
          cycleState: preservedCycleState
        })
      };
      assertNoSecretKeys(executionContext);

      if (state.stopRequested) {
        await teardown(run, hb, state.stopReason || "parada solicitada");
        return frozenResult({
          outcome: "RELEASED",
          code: RECOVERY_RESULT_CODES.STOPPED,
          recoveredRunId,
          fromRunId: state.fromRunId,
          target: target.target
        });
      }

      let execution;
      try {
        execution = createExecution(executionContext);
      } catch (err) {
        hb.stop();
        await safeFinish(run, "FAILED", `No se pudo iniciar la ejecución recuperada: ${err.message}`);
        setPhase(RECOVERY_PHASES.DONE);
        return frozenResult({
          outcome: "FAILED",
          code: RECOVERY_RESULT_CODES.RECOVERED,
          finishOutcome: "FAILED",
          recoveredRunId,
          fromRunId: state.fromRunId,
          target: target.target
        });
      }
      activeExecution = execution;
      log(
        `Ejecución recuperada iniciada para ${run.ref} (Run ${run.runId}) desde IN_PROGRESS. ` +
          "Continuación gobernada; el outcome del Run anterior permanece intacto."
      );

      const raced = await Promise.race([
        Promise.resolve(execution.done).then(
          value => ({ kind: "done", value }),
          error => ({ kind: "error", error })
        ),
        ownershipLostSignal.promise.then(() => ({ kind: "fenced" })),
        stopSignal.promise.then(() => ({ kind: "stop" }))
      ]);

      if (run.ownershipLost || raced.kind === "fenced") {
        await drainCancelled(execution);
        hb.stop();
        setPhase(RECOVERY_PHASES.DONE);
        log(
          `Fencing completado para ${run.ref}. El Run recuperado ${run.runId} queda sin owner del ` +
            "lado del Harness; NO se hace finishRun. Rail es autoritativo."
        );
        return frozenResult({
          outcome: "FENCED",
          code: RECOVERY_RESULT_CODES.FENCED,
          recoveredRunId,
          fromRunId: state.fromRunId,
          target: target.target
        });
      }

      if (raced.kind === "stop") {
        await teardown(run, hb, state.stopReason || "parada solicitada");
        return frozenResult({
          outcome: "RELEASED",
          code: RECOVERY_RESULT_CODES.STOPPED,
          finishOutcome: run.runFinished ? "RELEASED" : null,
          recoveredRunId,
          fromRunId: state.fromRunId,
          target: target.target
        });
      }

      hb.stop();

      if (raced.kind === "error") {
        await safeFinish(
          run,
          "FAILED",
          raced.error?.message ?? "Fallo técnico de la ejecución recuperada"
        );
        setPhase(RECOVERY_PHASES.DONE);
        return frozenResult({
          outcome: "FAILED",
          code: RECOVERY_RESULT_CODES.RECOVERED,
          finishOutcome: "FAILED",
          recoveredRunId,
          fromRunId: state.fromRunId,
          target: target.target
        });
      }

      // Normal completion. Defensive outcome mapping — unknown ⇒ FAILED, never
      // RELEASED as a catch-all. The recovered Run is finished EXACTLY ONCE.
      const value = raced.value && typeof raced.value === "object" ? raced.value : {};
      const finishOutcome = RUN_FINISH_OUTCOMES.has(value.outcome) ? value.outcome : "FAILED";
      const note =
        value.note ||
        "La ejecución recuperada terminó sin un outcome explícito; se cierra el Run como FAILED.";
      await safeFinish(run, finishOutcome, note);
      setPhase(RECOVERY_PHASES.DONE);
      return frozenResult({
        outcome: finishOutcome,
        code: RECOVERY_RESULT_CODES.RECOVERED,
        finishOutcome,
        recoveredRunId,
        fromRunId: state.fromRunId,
        target: target.target
      });
    } finally {
      hb.stop();
      activeExecution = null;
    }
  }

  async function teardown(run, hb, reason) {
    setPhase(RECOVERY_PHASES.STOPPING);
    log(`Shutdown controlado del Run recuperado ${run.runId}: ${reason}`);
    if (activeExecution && !run.cancelled) {
      run.cancelled = true;
      try {
        await Promise.resolve(activeExecution.cancel(reason));
      } catch (err) {
        log(`La cancelación de la ejecución recuperada falló: ${err.message}`);
      }
    }
    hb.stop();
    await safeFinish(run, "RELEASED", `Shutdown controlado del recovery: ${reason}`);
    setPhase(RECOVERY_PHASES.DONE);
  }

  async function safeFinish(run, outcome, note) {
    if (run.ownershipLost || state.fenced) {
      log(
        `No se finaliza el Run recuperado ${run.runId}: el Harness perdió el ownership (fencing). ` +
          "Rail es autoritativo."
      );
      return;
    }
    if (run.runFinished) return;
    run.runFinished = true;
    try {
      await run.finish(outcome, note);
      log(`Run recuperado ${run.runId} finalizado con outcome=${outcome} (una sola vez).`);
    } catch (err) {
      log(
        `No pude finalizar el Run recuperado ${run.runId} (${err.message}). ` +
          "El lease expirará solo; Rail lo marcará ABANDONED."
      );
    }
  }

  async function drainCancelled(execution) {
    try {
      await Promise.race([
        Promise.resolve(execution?.done).catch(() => {}),
        new Promise(r => {
          const t = setTimeout(r, 50);
          if (t && typeof t.unref === "function") t.unref();
        })
      ]);
    } catch {
      /* ignore */
    }
  }

  // `recover` and `resume` are the same one-shot continuation; the endpoint is
  // fixed by `operation` at construction. Both names are exposed so callers read
  // naturally (`createResumeRunner(...).resume(ref)`).
  return { recover: runContinuation, resume: runContinuation, requestStop, getState, RECOVERY_PHASES };
}

/**
 * A governed `/resume` runner — the GENERAL continuation of ownership on a
 * non-terminal cycle (RAIL-D-00006 AC-11 / AC-12). Same runner as
 * {@link createRecoveryRunner} with `operation: "resume"`: it uses
 * `api.resume`, `resolveResumeTarget` (preserves the cycle state EXACTLY, and
 * accepts an ownerless last Run in ANY non-`ACTIVE` state incl.
 * `COMPLETED` / `RELEASED`), and hands the orchestrator the preserved
 * `cycleState` so continuation starts from the real stage.
 */
export function createResumeRunner(opts = {}) {
  return createRecoveryRunner({ ...opts, operation: CONTINUATION_OPERATIONS.RESUME });
}

/**
 * READ-ONLY consistency check of the recovery worktree. Returns `null` when the
 * worktree is a safe target, or a Spanish sentence naming the FIRST problem
 * (fail-closed). A dirty worktree is NOT a problem — it is expected.
 */
export function worktreeProblem(ws, { expectedBranch, expectedRepo } = {}) {
  if (!ws || typeof ws !== "object") return "no se obtuvo información del worktree.";
  if (!ws.exists) {
    return `no existe el worktree esperado en ${ws.path}; recovery no recrea el worktree.`;
  }
  if (!ws.isWorktree) return `${ws.path} existe pero no es un worktree Git.`;
  if (!ws.isRoot) {
    return `${ws.path} no es la raíz de su propio worktree (toplevel=${ws.toplevel ?? "desconocido"}).`;
  }
  if (!ws.registered) {
    return `${ws.path} no está registrado como worktree del clon primario; es un checkout ajeno.`;
  }
  if (expectedBranch && ws.branch !== expectedBranch) {
    return `el worktree está en la branch ${ws.branch ?? "desconocida"}, no en ${expectedBranch}.`;
  }
  if (expectedRepo && ws.originSlug && ws.originSlug !== expectedRepo) {
    return `el worktree apunta a ${ws.originSlug}, no a ${expectedRepo}.`;
  }
  return null;
}

export { RECOVERY_TARGETS, RESUME_TARGETS };
