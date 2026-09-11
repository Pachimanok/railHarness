/**
 * Recovery preflight — RAIL-D-00006.
 *
 * Pure, read-only resolution of whether an orphaned `IN_PROGRESS` WorkCycle is
 * safely RECOVERABLE, and — if so — which exact `lastRunId` the governed
 * `POST /tickets/:ref/recover` must carry. No I/O, no logging: the caller
 * (`src/worker/recovery.js`) decides what to print and is the only place that
 * ever mutates Rail.
 *
 * Derived from the approved reference (`~/rail-runner/harness/RECOVERY.md`,
 * `scripts/harness.mjs`: `assertRecoverable` / `isActiveRunLeaseLive` /
 * `pickLastRun` / `buildRecoverRequest` / `recoveryTargetSummary`). RailSoft is
 * authoritative above this mirror.
 *
 * HARD RULES enforced here (see the ticket AC + docs/STATE_MACHINE.md):
 *   - `claim` and `recover` are DISTINCT operations. This module never resolves
 *     a claim and the caller must never fall back to `claim` when recovery is
 *     refused.
 *   - Ownership is NEVER reconstructed by inference: an `IN_PROGRESS` cycle
 *     whose `activeRun` lease is still LIVE is NOT recoverable — abort BEFORE
 *     any POST (`RECOVERY_LEASE_STILL_ACTIVE`).
 *   - A clean terminal last Run (`COMPLETED` / `RELEASED`) is NOT an orphan:
 *     recovery is refused so a finished cycle is never resurrected and no clean
 *     outcome is rewritten (`must_not_regress`).
 *   - `lastRunId` must be a concrete id that belongs to THIS cycle. If it
 *     cannot be determined unambiguously the result is fail-closed
 *     (`recoverable: false`), never a guess.
 *
 * Human-facing `reason` text is Spanish (docs/HARNESS.md); every `code` and
 * every RailSoft state name is a machine-readable identifier and is never
 * translated.
 */

/** Recovery-preflight failure / target codes. Identifiers — never translated. */
export const RECOVERY_CODES = Object.freeze({
  RECOVERABLE: "RECOVERABLE",
  NO_TICKET: "RECOVERY_NO_TICKET",
  PROJECT_MISMATCH: "RECOVERY_PROJECT_MISMATCH",
  NOT_IN_PROGRESS: "RECOVERY_NOT_IN_PROGRESS",
  CYCLE_BLOCKED: "RECOVERY_CYCLE_BLOCKED",
  LEASE_STILL_ACTIVE: "RECOVERY_LEASE_STILL_ACTIVE",
  LAST_RUN_TERMINAL_CLEAN: "RECOVERY_LAST_RUN_TERMINAL_CLEAN",
  LAST_RUN_NOT_TERMINAL: "RECOVERY_LAST_RUN_NOT_TERMINAL",
  LAST_RUN_INDETERMINATE: "RECOVERY_LAST_RUN_INDETERMINATE",
  BRANCH_MISMATCH: "RECOVERY_BRANCH_MISMATCH"
});

/** Which recovery target the caller is about to act on. */
export const RECOVERY_TARGETS = Object.freeze({
  CLASSIC_ORPHAN: "CLASSIC_ORPHAN", // A) activeRun == null, last Run FAILED/ABANDONED
  STALE_LEASE_TAKEOVER: "STALE_LEASE_TAKEOVER" // B) activeRun != null but not lease-live
});

/**
 * Run states that mean "this Run is finished and its outcome is CLEAN" — the
 * cycle is not an orphan and must NOT be recovered.
 */
const CLEAN_TERMINAL_RUN_STATES = new Set(["COMPLETED", "RELEASED", "SUCCESS"]);

/**
 * Run states that make a `activeRun == null` cycle a genuine CLASSIC ORPHAN:
 * a Run died (lease expired → sweeper → `ABANDONED`, or an explicit `FAILED`).
 */
const ORPHAN_TERMINAL_RUN_STATES = new Set(["FAILED", "ABANDONED"]);

/**
 * EXACT mirror of RailSoft's lease-live rule (docs/STATE_MACHINE.md):
 *
 *   leaseLive =
 *     run.state === "ACTIVE"
 *     && run.leaseExpiresAt != null
 *     && Date.parse(run.leaseExpiresAt) > now   // strictly greater; == now is NOT live
 *
 * Any other case is STALE and enables the takeover: `ACTIVE` + expired lease,
 * `ACTIVE` + null/absent lease, or `state != ACTIVE`.
 */
export function isActiveRunLeaseLive(run, now = Date.now()) {
  if (!run || typeof run !== "object") return false;
  if (run.state !== "ACTIVE") return false;
  if (run.leaseExpiresAt == null) return false;
  const ms = Date.parse(run.leaseExpiresAt);
  if (Number.isNaN(ms)) return false;
  return ms > now;
}

/** Read the WorkCycle state off a Rail ticket detail, tolerating a couple of shapes. */
function cycleStateOf(detail) {
  return detail?.state ?? detail?.cycle?.state ?? detail?.workCycle?.state ?? null;
}

/** Read the project id off a Rail ticket detail. */
function projectIdOf(detail) {
  return detail?.projectId ?? detail?.project?.id ?? detail?.item?.project?.id ?? null;
}

/** Normalized array of this cycle's Runs (newest-first is NOT assumed). */
function runsOf(detail) {
  const runs = Array.isArray(detail?.runs) ? detail.runs : [];
  return runs.filter(r => r && typeof r === "object" && typeof r.id === "string" && r.id);
}

/** Milliseconds for ordering a Run; `-Infinity` when it has no usable timestamp. */
function runStartMs(run) {
  for (const key of ["startedAt", "createdAt", "endedAt"]) {
    const ms = Date.parse(run?.[key] ?? "");
    if (!Number.isNaN(ms)) return ms;
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * The single most-recent Run of THIS cycle, chosen deterministically by
 * `startedAt` (then `id` as a stable tie-break). Returns `null` when the cycle
 * has no Run at all. NEVER looks outside `detail.runs` — a Run id from another
 * cycle can never be picked (`must_not_regress`: "no revivir Runs viejos de
 * otro ciclo").
 */
export function pickLastRun(detail) {
  const runs = runsOf(detail);
  if (!runs.length) return null;
  let best = runs[0];
  for (const r of runs.slice(1)) {
    const rMs = runStartMs(r);
    const bMs = runStartMs(best);
    if (rMs > bMs || (rMs === bMs && String(r.id) > String(best.id))) best = r;
  }
  return best;
}

/** Every Run id that belongs to this cycle (`activeRun` included). */
export function cycleRunIds(detail) {
  const ids = new Set(runsOf(detail).map(r => r.id));
  if (detail?.activeRun?.id) ids.add(detail.activeRun.id);
  return ids;
}

function outcome(code, reason, extra = {}) {
  return Object.freeze({ recoverable: false, code, reason, ...extra });
}

/**
 * Decide whether `detail` (a `GET /tickets/:ref` response) is a safely
 * recoverable orphan for `projectId`, and resolve the exact `lastRunId`.
 *
 * @param {object} detail                 Rail ticket detail (read-only).
 * @param {object} p
 * @param {string} p.projectId            the project the worker is bound to.
 * @param {string} p.ref                  the ticket ref (for messages).
 * @param {string} p.expectedBranch       `rail/<ticket-code>` the recovery must run on.
 * @param {() => number} [p.now]          clock (ms). Default: `Date.now`.
 * @returns {Readonly<
 *   | { recoverable: true, code: "RECOVERABLE", target: string, lastRunId: string,
 *       branch: string, activeRunId: string|null, cycleState: "IN_PROGRESS",
 *       leaseExpiresAt: string|null }
 *   | { recoverable: false, code: string, reason: string,
 *       activeRunId?: string|null, leaseExpiresAt?: string|null }
 * >}
 */
export function resolveRecoveryTarget(
  detail,
  { projectId, ref, expectedBranch, now = () => Date.now() } = {}
) {
  const nowMs = now();

  // 1. Ticket exists.
  if (!detail || typeof detail !== "object") {
    return outcome(
      RECOVERY_CODES.NO_TICKET,
      `El ticket "${ref}" no existe o Rail no devolvió detalle. No se hace recover.`
    );
  }

  // 2. Belongs to the configured project.
  const pid = projectIdOf(detail);
  if (projectId && pid && pid !== projectId) {
    return outcome(
      RECOVERY_CODES.PROJECT_MISMATCH,
      `Project mismatch: "${ref}" pertenece a projectId=${pid}, configurado=${projectId}. ` +
        "No se hace recover."
    );
  }

  // 3. Recovery only ever applies to an IN_PROGRESS cycle.
  const state = cycleStateOf(detail);
  if (state !== "IN_PROGRESS") {
    return outcome(
      RECOVERY_CODES.NOT_IN_PROGRESS,
      `El ciclo de "${ref}" no está IN_PROGRESS (state=${state}). ` +
        "recover sólo continúa un ciclo IN_PROGRESS huérfano; no se hace recover."
    );
  }

  // 4. A BLOCKED cycle (open blocking Agent Query) is never recovered — the
  //    human resolution comes first.
  if (detail.blocked) {
    return outcome(
      RECOVERY_CODES.CYCLE_BLOCKED,
      `El ciclo de "${ref}" está BLOCKED (stateBeforeBlock=${detail.stateBeforeBlock ?? "?"}). ` +
        "Hay una Agent Query bloqueante abierta; se resuelve primero, no se hace recover."
    );
  }

  const activeRun = detail.activeRun && typeof detail.activeRun === "object" ? detail.activeRun : null;
  const knownIds = cycleRunIds(detail);

  let target;
  let lastRunId;
  let branchToMatch = expectedBranch ?? null;

  if (activeRun) {
    // ── B) STALE LEASE TAKEOVER ────────────────────────────────────────────
    if (isActiveRunLeaseLive(activeRun, nowMs)) {
      return outcome(
        RECOVERY_CODES.LEASE_STILL_ACTIVE,
        `El activeRun de "${ref}" (${activeRun.id}) tiene el lease VIGENTE ` +
          `(leaseExpiresAt=${activeRun.leaseExpiresAt}). El Harness NO reconstruye ownership por ` +
          "inferencia ni le roba el Run a otro worker: se aborta antes de cualquier POST.",
        { activeRunId: activeRun.id, leaseExpiresAt: activeRun.leaseExpiresAt ?? null }
      );
    }
    target = RECOVERY_TARGETS.STALE_LEASE_TAKEOVER;
    lastRunId = activeRun.id;
    // In B the recovered work must also match the abandoned Run's own branch.
    if (typeof activeRun.branch === "string" && activeRun.branch) {
      if (expectedBranch && activeRun.branch !== expectedBranch) {
        return outcome(
          RECOVERY_CODES.BRANCH_MISMATCH,
          `La branch del activeRun de "${ref}" (${activeRun.branch}) no coincide con la branch ` +
            `esperada del ticket (${expectedBranch}). No se hace recover.`,
          { activeRunId: activeRun.id }
        );
      }
      branchToMatch = activeRun.branch;
    }
  } else {
    // ── A) CLASSIC ORPHAN ─────────────────────────────────────────────────
    const last = pickLastRun(detail);
    if (!last) {
      return outcome(
        RECOVERY_CODES.LAST_RUN_INDETERMINATE,
        `El ciclo de "${ref}" está IN_PROGRESS con activeRun=null pero no expone ningún Run ` +
          "previo concreto. No se puede determinar lastRunId sin ambigüedad; fail-closed."
      );
    }
    if (CLEAN_TERMINAL_RUN_STATES.has(String(last.state))) {
      return outcome(
        RECOVERY_CODES.LAST_RUN_TERMINAL_CLEAN,
        `El último Run de "${ref}" (${last.id}) terminó LIMPIO (state=${last.state}). No es un ` +
          "recover CLÁSICO (que exige FAILED/ABANDONED). Para continuar un ciclo NO terminal cuyo " +
          "último Run no está ACTIVE — incluido COMPLETED/RELEASED — usá /resume (resolveResumeTarget), " +
          "que preserva el estado y NO reescribe el outcome viejo."
      );
    }
    if (!ORPHAN_TERMINAL_RUN_STATES.has(String(last.state))) {
      return outcome(
        RECOVERY_CODES.LAST_RUN_NOT_TERMINAL,
        `El último Run de "${ref}" (${last.id}) está en state=${last.state}; el recover CLÁSICO exige ` +
          "que el Run previo sea FAILED o ABANDONED. Para el caso general usá /resume. Fail-closed."
      );
    }
    target = RECOVERY_TARGETS.CLASSIC_ORPHAN;
    lastRunId = last.id;
  }

  // `lastRunId` must be a concrete id of THIS cycle — never invented, never
  // borrowed from another ticket.
  if (typeof lastRunId !== "string" || !lastRunId || !knownIds.has(lastRunId)) {
    return outcome(
      RECOVERY_CODES.LAST_RUN_INDETERMINATE,
      `No se pudo resolver un lastRunId inequívoco de este ciclo para "${ref}" ` +
        `(candidato=${JSON.stringify(lastRunId ?? null)}). Fail-closed: no se inventa un runId.`
    );
  }

  return Object.freeze({
    recoverable: true,
    code: RECOVERY_CODES.RECOVERABLE,
    target,
    lastRunId,
    branch: branchToMatch ?? expectedBranch ?? null,
    activeRunId: activeRun?.id ?? null,
    cycleState: "IN_PROGRESS",
    leaseExpiresAt: activeRun?.leaseExpiresAt ?? null
  });
}

/**
 * Throwing form of {@link resolveRecoveryTarget}. Returns the recoverable
 * descriptor or throws an `Error` carrying `.code` (one of `RECOVERY_CODES`).
 * The caller must NOT fall back to `claim` on this throw.
 */
export function assertRecoverable(detail, opts) {
  const res = resolveRecoveryTarget(detail, opts);
  if (res.recoverable) return res;
  const err = new Error(res.reason);
  err.code = res.code;
  if (res.activeRunId != null) err.activeRunId = res.activeRunId;
  if (res.leaseExpiresAt != null) err.leaseExpiresAt = res.leaseExpiresAt;
  throw err;
}

/**
 * Build the exact `api.recover(ref, body)` request body from a recoverable
 * descriptor. Pure. `worktreePath` is the on-disk isolated worktree the
 * recovery reuses; `reason` is an operator-facing Spanish sentence.
 */
export function buildRecoverRequest(recoverable, { worktreePath, reason } = {}) {
  if (!recoverable || recoverable.recoverable !== true) {
    throw new Error("buildRecoverRequest requiere un descriptor recoverable:true");
  }
  return {
    branch: recoverable.branch,
    worktreePath: worktreePath ?? null,
    lastRunId: recoverable.lastRunId,
    reason:
      reason ||
      `Continuación gobernada (${recoverable.target}) de un ciclo NO terminal; ` +
        `lastRunId=${recoverable.lastRunId}. claim, recover y resume son operaciones distintas.`
  };
}

/** Alias — a `/resume` request body has the same shape as a `/recover` one. */
export const buildResumeRequest = buildRecoverRequest;

/**
 * A one-line, secret-free digest of a continuation target (resume OR recover)
 * for a human log. Never contains a `claimToken` (the descriptor has none).
 */
export function recoveryTargetSummary(recoverable) {
  if (!recoverable || recoverable.recoverable !== true) {
    return "Continuation target: (no recuperable)";
  }
  const KINDS = {
    [RECOVERY_TARGETS.STALE_LEASE_TAKEOVER]: "recover clásico: stale activeRun / lease vencido (IN_PROGRESS)",
    [RECOVERY_TARGETS.CLASSIC_ORPHAN]: "recover clásico: activeRun nulo / último Run FAILED|ABANDONED (IN_PROGRESS)",
    [RESUME_TARGETS.STALE_TAKEOVER]: "resume: stale activeRun / lease vencido",
    [RESUME_TARGETS.OWNERLESS]: "resume: activeRun nulo / último Run NO ACTIVE"
  };
  const kind = KINDS[recoverable.target] || recoverable.target;
  return (
    `Continuation target: ${kind}. cycleState=${recoverable.cycleState} ` +
    `branch=${recoverable.branch} lastRunId=${recoverable.lastRunId}` +
    (recoverable.activeRunId ? ` activeRunId=${recoverable.activeRunId}` : "")
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// /resume — the GENERAL continuation of ownership on a NON-terminal cycle.
// ═══════════════════════════════════════════════════════════════════════════

/** `/resume` preflight failure / target codes. Identifiers — never translated. */
export const RESUME_CODES = Object.freeze({
  RECOVERABLE: "RECOVERABLE",
  NO_TICKET: "RESUME_NO_TICKET",
  PROJECT_MISMATCH: "RESUME_PROJECT_MISMATCH",
  CYCLE_TERMINAL: "RESUME_CYCLE_TERMINAL",
  CYCLE_BLOCKED: "RESUME_CYCLE_BLOCKED",
  CYCLE_PRE_OWNERSHIP: "RESUME_CYCLE_PRE_OWNERSHIP",
  LEASE_STILL_ACTIVE: "RESUME_LEASE_STILL_ACTIVE",
  CANDIDATE_ACTIVE_INCONSISTENT: "RESUME_CANDIDATE_ACTIVE_INCONSISTENT",
  LAST_RUN_INDETERMINATE: "RESUME_LAST_RUN_INDETERMINATE",
  LAST_RUN_NOT_LATEST: "RESUME_LAST_RUN_NOT_LATEST",
  LAST_RUN_FOREIGN: "RESUME_LAST_RUN_FOREIGN",
  BRANCH_MISMATCH: "RESUME_BRANCH_MISMATCH"
});

/** Which `/resume` target the caller is about to act on. */
export const RESUME_TARGETS = Object.freeze({
  STALE_TAKEOVER: "RESUME_STALE_TAKEOVER", // A) activeRun ACTIVE, lease <= now
  OWNERLESS: "RESUME_OWNERLESS" // B) activeRun == null, last Run state != ACTIVE
});

/**
 * Cycle states that are TERMINAL — `/resume` never applies (the cycle is done).
 * Conservative allow-through: anything NOT in here and not BLOCKED / pre-ownership
 * is treated as a non-terminal, resumable state (RailSoft re-validates).
 */
const TERMINAL_CYCLE_STATES = new Set([
  "DONE",
  "MERGED",
  "CLOSED",
  "CANCELLED",
  "CANCELED",
  "ARCHIVED",
  "REJECTED",
  "COMPLETED",
  "RELEASED",
  "ABANDONED"
]);

/** Cycle states that exist BEFORE any ownership — use `claim`, not `/resume`. */
const PRE_OWNERSHIP_CYCLE_STATES = new Set(["BACKLOG", "READY"]);

/**
 * Decide whether `detail` (a `GET /tickets/:ref` response) is a safely
 * `/resume`-able cycle for `projectId`, resolving the exact `lastRunId` and
 * PRESERVING the cycle state exactly as Rail reports it.
 *
 * Accepts (RailSoft `/resume` contract):
 *  - **A) `RESUME_STALE_TAKEOVER`** — `activeRun` `ACTIVE` with an expired lease
 *    (`leaseExpiresAt <= now`), on any non-terminal, non-`BLOCKED` cycle state
 *    (`IN_PROGRESS` / `REVIEWING` / `TESTING` / `SANDBOX_READY` / …).
 *    `lastRunId = activeRun.id`.
 *  - **B) `RESUME_OWNERLESS`** — `activeRun == null` and the SAME cycle's most
 *    recent Run has `state != ACTIVE` — `COMPLETED` / `RELEASED` / `FAILED` /
 *    `ABANDONED` are ALL valid. The old Run stays terminal and untouched;
 *    `lastRunId =` its id.
 *
 * Fail-closed on: terminal cycle state, `BLOCKED`, pre-ownership cycle state,
 * a lease-live `activeRun`, `activeRun == null` with an `ACTIVE` candidate
 * (inconsistency), an indeterminate / foreign / non-latest `lastRunId`, or a
 * branch mismatch.
 *
 * @returns {Readonly<
 *   | { recoverable:true, code:"RECOVERABLE", target:string, lastRunId:string,
 *       branch:string|null, activeRunId:string|null, cycleState:string,
 *       leaseExpiresAt:string|null }
 *   | { recoverable:false, code:string, reason:string, activeRunId?:string|null,
 *       leaseExpiresAt?:string|null }
 * >}
 */
export function resolveResumeTarget(
  detail,
  { projectId, ref, expectedBranch, expectedLastRunId = null, now = () => Date.now() } = {}
) {
  const nowMs = now();
  const rOut = (code, reason, extra = {}) => Object.freeze({ recoverable: false, code, reason, ...extra });

  if (!detail || typeof detail !== "object") {
    return rOut(RESUME_CODES.NO_TICKET, `El ticket "${ref}" no existe o Rail no devolvió detalle. No se hace resume.`);
  }
  const pid = projectIdOf(detail);
  if (projectId && pid && pid !== projectId) {
    return rOut(
      RESUME_CODES.PROJECT_MISMATCH,
      `Project mismatch: "${ref}" pertenece a projectId=${pid}, configurado=${projectId}. No se hace resume.`
    );
  }

  const state = cycleStateOf(detail);
  const stateU = String(state ?? "").toUpperCase();

  if (detail.blocked || stateU === "BLOCKED") {
    return rOut(
      RESUME_CODES.CYCLE_BLOCKED,
      `El ciclo de "${ref}" está BLOCKED (stateBeforeBlock=${detail.stateBeforeBlock ?? "?"}). ` +
        "RailSoft /resume rechaza BLOCKED: se resuelve la Agent Query primero; no se crea ownership " +
        "de ejecución ni se intenta sortearlo con recover/claim/transition."
    );
  }
  if (TERMINAL_CYCLE_STATES.has(stateU)) {
    return rOut(
      RESUME_CODES.CYCLE_TERMINAL,
      `El ciclo de "${ref}" está en un estado TERMINAL (state=${state}). /resume sólo continúa un ` +
        "ciclo NO terminal; fail-closed."
    );
  }
  if (PRE_OWNERSHIP_CYCLE_STATES.has(stateU)) {
    return rOut(
      RESUME_CODES.CYCLE_PRE_OWNERSHIP,
      `El ciclo de "${ref}" está en ${state} (previo a cualquier ownership). Para tomar ownership ` +
        "inicial se usa claim, no /resume; fail-closed."
    );
  }

  const activeRun = detail.activeRun && typeof detail.activeRun === "object" ? detail.activeRun : null;
  const knownIds = cycleRunIds(detail);

  let target;
  let lastRunId;
  let branchToMatch = expectedBranch ?? null;

  if (activeRun) {
    if (isActiveRunLeaseLive(activeRun, nowMs)) {
      return rOut(
        RESUME_CODES.LEASE_STILL_ACTIVE,
        `El activeRun de "${ref}" (${activeRun.id}) tiene el lease VIGENTE ` +
          `(leaseExpiresAt=${activeRun.leaseExpiresAt}). El Harness NO reconstruye ownership por ` +
          "inferencia ni le roba el Run a otro worker: se aborta antes de cualquier POST.",
        { activeRunId: activeRun.id, leaseExpiresAt: activeRun.leaseExpiresAt ?? null }
      );
    }
    target = RESUME_TARGETS.STALE_TAKEOVER;
    lastRunId = activeRun.id;
    if (typeof activeRun.branch === "string" && activeRun.branch) {
      if (expectedBranch && activeRun.branch !== expectedBranch) {
        return rOut(
          RESUME_CODES.BRANCH_MISMATCH,
          `La branch del activeRun de "${ref}" (${activeRun.branch}) no coincide con la esperada ` +
            `(${expectedBranch}). No se hace resume.`,
          { activeRunId: activeRun.id }
        );
      }
      branchToMatch = activeRun.branch;
    }
  } else {
    const last = pickLastRun(detail);
    if (!last) {
      return rOut(
        RESUME_CODES.LAST_RUN_INDETERMINATE,
        `El ciclo de "${ref}" (state=${state}) tiene activeRun=null y no expone ningún Run previo ` +
          "concreto. No se puede determinar lastRunId sin ambigüedad; fail-closed."
      );
    }
    if (String(last.state).toUpperCase() === "ACTIVE") {
      return rOut(
        RESUME_CODES.CANDIDATE_ACTIVE_INCONSISTENT,
        `Inconsistencia en "${ref}": activeRun=null pero el último Run (${last.id}) está ACTIVE. ` +
          "Fail-closed: el Harness no resuelve una inconsistencia de Rail por inferencia."
      );
    }
    // Any non-ACTIVE state is valid — COMPLETED / RELEASED / FAILED / ABANDONED.
    target = RESUME_TARGETS.OWNERLESS;
    lastRunId = last.id;
  }

  if (typeof lastRunId !== "string" || !lastRunId || !knownIds.has(lastRunId)) {
    return rOut(
      RESUME_CODES.LAST_RUN_INDETERMINATE,
      `No se pudo resolver un lastRunId inequívoco de este ciclo para "${ref}" ` +
        `(candidato=${JSON.stringify(lastRunId ?? null)}). Fail-closed: no se inventa un runId.`
    );
  }

  // Optional guard: an explicitly-provided lastRunId MUST be this cycle's and
  // MUST be the one we resolved (the latest / the stale activeRun).
  if (expectedLastRunId != null) {
    if (!knownIds.has(expectedLastRunId)) {
      return rOut(
        RESUME_CODES.LAST_RUN_FOREIGN,
        `El lastRunId indicado (${expectedLastRunId}) no pertenece al ciclo de "${ref}". ` +
          "Fail-closed: nunca se reutiliza un runId de otro ciclo."
      );
    }
    if (expectedLastRunId !== lastRunId) {
      return rOut(
        RESUME_CODES.LAST_RUN_NOT_LATEST,
        `El lastRunId indicado (${expectedLastRunId}) no es el Run vigente para continuar "${ref}" ` +
          `(corresponde ${lastRunId}). Fail-closed: no se reanuda desde un Run viejo.`
      );
    }
  }

  return Object.freeze({
    recoverable: true,
    code: RESUME_CODES.RECOVERABLE,
    target,
    lastRunId,
    // The cycle state is PRESERVED EXACTLY as Rail reported it — never rewound.
    cycleState: state,
    branch: branchToMatch ?? expectedBranch ?? null,
    activeRunId: activeRun?.id ?? null,
    leaseExpiresAt: activeRun?.leaseExpiresAt ?? null
  });
}

/**
 * Throwing form of {@link resolveResumeTarget}. Returns the descriptor or
 * throws an `Error` carrying `.code` (one of `RESUME_CODES`). The caller must
 * NOT fall back to `recover` or `claim` on this throw.
 */
export function assertResumable(detail, opts) {
  const res = resolveResumeTarget(detail, opts);
  if (res.recoverable) return res;
  const err = new Error(res.reason);
  err.code = res.code;
  if (res.activeRunId != null) err.activeRunId = res.activeRunId;
  if (res.leaseExpiresAt != null) err.leaseExpiresAt = res.leaseExpiresAt;
  throw err;
}
