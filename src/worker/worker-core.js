/**
 * Worker Core — the persistent process that consumes Rail's READY queue.
 *
 * Owns exactly ONE Run at a time:
 *
 *   connect + validate Rail  ->  discovery (poll READY)  ->  preflight  ->
 *   atomic claim  ->  heartbeat supervisor + one active execution  ->
 *   finish / fence / shutdown  ->  back to discovery
 *
 * Rail is the authority (docs/HARNESS.md). This Core never decides scope,
 * never mutates work state on its own judgement, and — while idle — creates
 * NO Run and NO workspace.
 *
 * The work between `claim` and `finish` is supplied by an injected
 * `createExecution` collaborator. As of RAIL-D-00005 the CLI wires
 * `createOrchestrationExecution` (isolated workspace → Implementer → Reviewer →
 * Tester, governed checks / transitions). `createPlaceholderExecution` (touches
 * nothing) stays for tests / dry-runs. This module still never calls
 * `POST /transitions` / `/checks` / `/queries` itself — those belong to the
 * collaborator, on the Run the Core already owns. The Core owns `finishRun` and
 * passes the collaborator's mapped Run outcome through unchanged.
 *
 * What this module deliberately does NOT do (see docs/WORKER_CORE.md):
 *   - full resume / recovery of an orphaned IN_PROGRESS cycle (later ticket)
 *
 * SECURITY INVARIANT: the per-Run `claimToken` lives ONLY inside this module,
 * captured in the closure of the active-run record's `heartbeat()` / `finish()`
 * methods. It is never stored as an enumerable property, never logged, and
 * never passed to an execution.
 */

import { stripSecretKeys, SECRET_KEY_RE } from "../security/sanitize.js";
import { pickDiscoveryRef, isTicketClaimable } from "./ticket-preflight.js";

/**
 * Internal lifecycle phases, for observability and tests. These are Worker
 * Core identifiers, NOT Rail protocol values — but they are machine-readable,
 * so like every enum in this Harness they are left untranslated.
 */
export const WORKER_PHASES = Object.freeze({
  INIT: "INIT",
  CONNECTING: "CONNECTING",
  IDLE: "IDLE",
  CLAIMING: "CLAIMING",
  EXECUTING: "EXECUTING",
  FENCING: "FENCING",
  STOPPING: "STOPPING",
  STOPPED: "STOPPED"
});

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_DISCOVERY_POLL_MS = 30 * 1000;
export const DEFAULT_DISCOVERY_LIMIT = 10;

/**
 * HTTP statuses / error codes from Rail that mean "you are not (or no longer)
 * the owner of this Run" — a definitive ownership rejection that triggers
 * fencing. A network/5xx failure is NOT in here: it is transient, logged, and
 * retried on the next interval (if the lease truly lapsed, the following
 * heartbeat gets a definitive rejection and fencing happens then).
 */
/**
 * Run outcomes RailSoft's contract supports on `finishRun`
 * (`COMPLETED` / `FAILED` / `ABANDONED` / `RELEASED`). The orchestration
 * collaborator returns one of these (via `mapOrchestrationOutcome`); the Worker
 * Core passes it through UNCHANGED — the happy path finishes `COMPLETED`, not
 * `RELEASED`. Anything UNRECOGNIZED is closed as `FAILED` — aligned with
 * `mapOrchestrationOutcome` (`<unknown> → FAILED`). `RELEASED` is NOT the
 * catch-all: it is reserved for a genuine release / controlled shutdown
 * (`teardownActive`). RailSoft is authoritative above the local docs/mirror.
 */
const RUN_FINISH_OUTCOMES = new Set(["COMPLETED", "FAILED", "ABANDONED", "RELEASED"]);

const OWNERSHIP_REJECTION_STATUSES = new Set([401, 403, 404, 409, 410]);
const OWNERSHIP_REJECTION_CODE_RE =
  /(OWNERSHIP|NOT[_-]?OWNER|LEASE|ABANDONED|FENCED|FORBIDDEN|NOT[_-]?FOUND|CONFLICT|EXPIRED)/i;

function isOwnershipRejection(err) {
  if (!err) return false;
  if (typeof err.status === "number" && OWNERSHIP_REJECTION_STATUSES.has(err.status)) {
    return true;
  }
  if (err.code && OWNERSHIP_REJECTION_CODE_RE.test(String(err.code))) return true;
  return false;
}

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
function assertNoSecretKeys(node, path = "executionContext") {
  if (node == null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (SECRET_KEY_RE.test(key)) {
      throw new Error(
        `El contexto de ejecución no puede contener secretos: ${path}.${key}`
      );
    }
    assertNoSecretKeys(value, `${path}.${key}`);
  }
}

/**
 * Build a Worker Core.
 *
 * @param {object}   p
 * @param {object}   p.api                 RailApiClient (or a compatible fake). Needs
 *                                          `listProjects`, `listReady`, `getTicket`,
 *                                          `claim`, `heartbeat`, `finishRun`.
 * @param {string}   p.projectId           Rail project the worker is bound to.
 * @param {(ctx:object) => {done:Promise, cancel:Function}} p.createExecution
 *                                          Factory for the one active execution. Receives
 *                                          `{ ref, ticket, branch, run:{id} }` — NEVER a
 *                                          claimToken. `done` resolves with an optional
 *                                          `{ outcome, note }` or rejects on failure;
 *                                          `cancel(reason)` must make `done` settle promptly.
 * @param {(codeOrRef:string)=>string} [p.branchFor]   ticket ref -> `rail/<code>` branch.
 * @param {number}   [p.heartbeatIntervalMs]
 * @param {number}   [p.discoveryPollMs]
 * @param {number}   [p.discoveryLimit]
 * @param {(msg:string)=>void} [p.logger]  human-facing sink (Spanish). Default: console.log.
 * @param {() => number}       [p.now]     clock (ms). Default: Date.now.
 * @param {(ms:number)=>Promise} [p.sleep] Default: setTimeout-based, unref'd.
 * @param {Function} [p.setIntervalFn]     Default: global setInterval.
 * @param {Function} [p.clearIntervalFn]   Default: global clearInterval.
 */
export function createWorkerCore({
  api,
  projectId,
  createExecution,
  branchFor = defaultBranchFor,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  discoveryPollMs = DEFAULT_DISCOVERY_POLL_MS,
  discoveryLimit = DEFAULT_DISCOVERY_LIMIT,
  logger = line => console.log(line),
  now = () => Date.now(),
  sleep = ms => new Promise(r => {
    const t = setTimeout(r, ms);
    if (t && typeof t.unref === "function") t.unref();
  }),
  setIntervalFn = (...args) => setInterval(...args),
  clearIntervalFn = (...args) => clearInterval(...args)
} = {}) {
  if (!api || typeof api.claim !== "function" || typeof api.heartbeat !== "function") {
    throw new Error("createWorkerCore requiere un cliente Rail con claim() y heartbeat()");
  }
  if (!projectId) throw new Error("createWorkerCore requiere projectId");
  if (typeof createExecution !== "function") {
    throw new Error("createWorkerCore requiere createExecution(ctx)");
  }
  if (!(heartbeatIntervalMs > 0)) {
    throw new Error("heartbeatIntervalMs debe ser > 0");
  }
  if (!(discoveryPollMs > 0)) {
    throw new Error("discoveryPollMs debe ser > 0");
  }

  const log = msg => {
    try {
      logger(String(msg));
    } catch {
      /* a broken logger must never crash the worker */
    }
  };

  const state = {
    phase: WORKER_PHASES.INIT,
    stopRequested: false,
    stopReason: null,
    fenced: false,
    pollCount: 0,
    claimsWon: 0,
    lastError: null
  };

  const stopSignal = deferred();
  /** The one active run, or null. Holds NO claimToken as a property. */
  let active = null;

  function setPhase(next) {
    state.phase = next;
  }

  // ── Active-run record: claimToken captured in closure only ───────────────

  function makeActiveRun({ ref, detail, branch, runId, claimToken, leaseExpiresAt }) {
    let lease = leaseExpiresAt ?? null;
    const rec = {
      ref,
      detail,
      branch,
      runId,
      get leaseExpiresAt() {
        return lease;
      },
      ownershipLost: false,
      runFinished: false,
      cancelled: false,
      execution: null,
      ownershipLostSignal: deferred(),
      async heartbeatOnce() {
        const r = await api.heartbeat(runId, claimToken);
        if (r && r.leaseExpiresAt) lease = r.leaseExpiresAt;
        return r;
      },
      async finish(outcome, note) {
        return api.finishRun(runId, { claimToken, outcome, note: clip(note), branch });
      }
    };
    return rec;
  }

  // ── Heartbeat supervisor ───────────────────────────────────────────────

  function startHeartbeat(run) {
    let stopped = false;
    let timer = null;

    const beat = async () => {
      if (stopped || run.ownershipLost || run.runFinished || state.fenced) return;
      const leaseMs = run.leaseExpiresAt ? Date.parse(run.leaseExpiresAt) : NaN;
      if (!Number.isNaN(leaseMs) && leaseMs <= now()) {
        log(
          "Aviso: el lease del Run venció localmente antes de este heartbeat; " +
            "si Rail ya lo marcó ABANDONED el heartbeat será rechazado y se hará fencing."
        );
      }
      try {
        await run.heartbeatOnce();
        log(`heartbeat OK — lease renovado hasta ${run.leaseExpiresAt}`);
      } catch (err) {
        if (isOwnershipRejection(err)) {
          stopped = true;
          if (timer) clearIntervalFn(timer);
          log(
            `heartbeat RECHAZADO por Rail (status=${err.status ?? "-"} code=${err.code ?? "-"}): ` +
              "se perdió el ownership del Run. Fencing en curso."
          );
          onOwnershipLost("heartbeat rechazado por Rail");
        } else {
          log(
            `heartbeat con error transitorio (${err.message}); no es un rechazo de ownership, ` +
              "se reintenta en el próximo intervalo."
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

  function onOwnershipLost(reason) {
    if (!active || active.ownershipLost) return;
    active.ownershipLost = true;
    state.fenced = true;
    setPhase(WORKER_PHASES.FENCING);
    log(
      `FENCING: ${reason}. Se cancela la ejecución activa y se bloquea toda mutación ` +
        `sobre el Run ${active.runId}. No se hará heartbeat ni finishRun sobre este Run.`
    );
    const exec = active.execution;
    if (exec && !active.cancelled) {
      active.cancelled = true;
      try {
        Promise.resolve(exec.cancel("ownership perdido (fencing)")).catch(cancelErr =>
          log(`La cancelación de la ejecución falló: ${cancelErr.message}`)
        );
      } catch (cancelErr) {
        log(`La cancelación de la ejecución falló: ${cancelErr.message}`);
      }
    }
    if (!active.ownershipLostSignal.settled) {
      active.ownershipLostSignal.settled = true;
      active.ownershipLostSignal.resolve();
    }
  }

  // ── Connectivity + project validation ──────────────────────────────────

  async function connectAndValidate() {
    setPhase(WORKER_PHASES.CONNECTING);
    log("Validando conectividad con Rail…");
    let projects;
    try {
      projects = await api.listProjects();
    } catch (err) {
      throw new Error(
        `No se pudo contactar a Rail (${err.message}). ` +
          "El Worker Core no arranca sin conectividad verificada."
      );
    }
    const list = Array.isArray(projects)
      ? projects
      : projects?.items || projects?.projects || [];
    const visible = list.some(p => (p?.id || p?.projectId || p) === projectId);
    if (list.length && !visible) {
      throw new Error(
        `El projectId configurado (${projectId}) no es visible para este agente en Rail. ` +
          "Revisá RAIL_PROJECT_ID y el token."
      );
    }
    log(
      visible
        ? `Conectividad con Rail verificada. Project ${projectId} visible.`
        : "Conectividad con Rail verificada (Rail no enumeró proyectos; se confía en el projectId configurado)."
    );
  }

  // ── Discovery + preflight + atomic claim ───────────────────────────────

  /**
   * One discovery pass. Returns an active-run record on a won claim, or `null`
   * when there is nothing to claim right now (empty queue, candidate not
   * claimable, or claim lost to another worker). Throws only on a fatal
   * contract error (claim answered 2xx without a usable runId/claimToken).
   */
  async function discoverAndClaimOne() {
    setPhase(WORKER_PHASES.IDLE);
    state.pollCount += 1;

    let ready;
    try {
      ready = await api.listReady(projectId, discoveryLimit);
    } catch (err) {
      state.lastError = err.message;
      log(`No pude consultar la cola READY (${err.message}). Reintento tras el polling.`);
      return null;
    }

    const ref = pickDiscoveryRef(ready);
    if (!ref) {
      log("No hay tickets READY. Idle: no se crea Run ni workspace, se vuelve a consultar.");
      return null;
    }

    log(`Candidato READY: ${ref}. Ejecutando preflight (read-only) antes del claim…`);

    let detail;
    try {
      detail = await api.getTicket(ref);
    } catch (err) {
      log(`No pude leer el detalle de ${ref} (${err.message}). Se descarta y se vuelve a discovery.`);
      return null;
    }

    const check = isTicketClaimable(detail, projectId, ref);
    if (!check.claimable) {
      log(`Preflight rechazó ${ref}: ${check.reason} Se vuelve a discovery.`);
      return null;
    }

    const ticketCode = detail.item?.code || ref;
    const branch = branchFor(ticketCode);

    setPhase(WORKER_PHASES.CLAIMING);
    log(`Preflight OK para ${ref}. Claim atómico (branch ${branch})…`);

    let handoff;
    try {
      handoff = await api.claim(ref, branch);
    } catch (err) {
      // Lost the race, or Rail refused the claim. Not fatal for a persistent
      // worker: log and go back to discovery.
      log(
        `El claim de ${ref} no prosperó (status=${err.status ?? "-"} code=${err.code ?? "-"}: ${err.message}). ` +
          "Probablemente otro worker lo reclamó primero. Se vuelve a discovery."
      );
      return null;
    }

    const runId = handoff?.run?.id ?? null;
    const claimToken = handoff?.run?.claimToken ?? null;
    const leaseExpiresAt = handoff?.run?.leaseExpiresAt ?? null;

    if (!runId || !claimToken) {
      // PROTOCOL.md: a 2xx whose normalized run.id/claimToken is missing is a
      // contract error — do NOT retry the mutation, do NOT continue without a
      // claimToken.
      const err = new Error(
        `CLAIM_CONTRACT_ERROR: el claim de ${ref} respondió 2xx pero sin run.id/claimToken usables ` +
          `(run.id ${runId ? "presente" : "AUSENTE"}, claimToken ${claimToken ? "presente" : "AUSENTE"}). ` +
          "No se reintenta el claim y no se continúa sin claimToken."
      );
      err.code = "CLAIM_CONTRACT_ERROR";
      err.ref = ref;
      throw err;
    }

    state.claimsWon += 1;
    log(`Claim exitoso: ${ref} -> Run ${runId}. El claimToken queda sólo dentro del Worker Core.`);
    return makeActiveRun({ ref, detail, branch, runId, claimToken, leaseExpiresAt });
  }

  // ── Drive the one active run ───────────────────────────────────────────

  async function runClaimed(run) {
    active = run;
    setPhase(WORKER_PHASES.EXECUTING);

    const hb = startHeartbeat(run);

    try {
      // Build the execution context. NO claimToken, ticket secret-stripped.
      const executionContext = {
        ref: run.ref,
        ticket: stripSecretKeys(run.detail ?? {}),
        branch: run.branch,
        run: { id: run.runId }
      };
      assertNoSecretKeys(executionContext);

      if (run.ownershipLost || state.stopRequested) {
        // Ownership already gone, or a stop landed between claim and here.
        await teardownActive(
          run,
          hb,
          run.ownershipLost ? "ownership perdido antes de iniciar la ejecución" : state.stopReason
        );
        return;
      }

      let execution;
      try {
        execution = createExecution(executionContext);
      } catch (err) {
        log(`No pude iniciar la ejecución para ${run.ref}: ${err.message}`);
        hb.stop();
        await safeFinish(run, "FAILED", `No se pudo iniciar la ejecución: ${err.message}`);
        active = null;
        return;
      }
      run.execution = execution;
      log(`Ejecución activa iniciada para ${run.ref} (Run ${run.runId}). Una sola por proceso.`);

      const outcome = await Promise.race([
        Promise.resolve(execution.done).then(
          value => ({ kind: "done", value }),
          error => ({ kind: "error", error })
        ),
        run.ownershipLostSignal.promise.then(() => ({ kind: "fenced" })),
        stopSignal.promise.then(() => ({ kind: "stop" }))
      ]);

      if (run.ownershipLost || outcome.kind === "fenced") {
        // Ownership is gone. heartbeat is already stopped and
        // `execution.cancel` was already invoked by `onOwnershipLost`. Drain
        // the execution and DO NOT touch Rail for this Run — no heartbeat, no
        // finishRun. Rail is authoritative for its state. This branch wins
        // even if `execution.done` settled first (a cancel that resolves it).
        await drainCancelled(execution);
        hb.stop();
        log(
          `Fencing completado para ${run.ref}. El Run ${run.runId} queda sin owner del lado del Worker; ` +
            "Rail es autoritativo sobre su estado."
        );
        active = null;
        return;
      }

      if (outcome.kind === "stop") {
        await teardownActive(run, hb, state.stopReason || "parada solicitada");
        return;
      }

      hb.stop();

      if (outcome.kind === "error") {
        log(`La ejecución de ${run.ref} falló: ${outcome.error?.message ?? outcome.error}`);
        await safeFinish(run, "FAILED", outcome.error?.message ?? "Fallo técnico de la ejecución");
        active = null;
        return;
      }

      // Normal completion. The orchestration collaborator already mapped its
      // internal outcome onto a RailSoft Run outcome (`mapOrchestrationOutcome`)
      // — the Worker Core owns `finishRun` and passes that outcome through
      // unchanged. A COMPLETED orchestration finishes the Run COMPLETED. An
      // unrecognized / missing outcome is closed as FAILED (never RELEASED as a
      // catch-all) — aligned with `mapOrchestrationOutcome`'s `<unknown> → FAILED`.
      const value = outcome.value && typeof outcome.value === "object" ? outcome.value : {};
      const runOutcome = RUN_FINISH_OUTCOMES.has(value.outcome) ? value.outcome : "FAILED";
      const note =
        value.note ||
        "La ejecución terminó sin un outcome explícito; el Worker Core cierra el Run como FAILED.";
      await safeFinish(run, runOutcome, note);
      active = null;
    } finally {
      hb.stop();
      if (active === run) active = null;
    }
  }

  async function teardownActive(run, hb, reason) {
    setPhase(WORKER_PHASES.STOPPING);
    log(`Shutdown controlado del Run ${run.runId}: ${reason}`);
    if (run.execution && !run.cancelled) {
      run.cancelled = true;
      try {
        await Promise.resolve(run.execution.cancel(reason));
        log("Ejecución activa cancelada de forma controlada.");
      } catch (err) {
        log(`La cancelación de la ejecución falló: ${err.message}`);
      }
    }
    hb.stop();
    await safeFinish(run, "RELEASED", `Shutdown controlado: ${reason}`);
    active = null;
  }

  async function safeFinish(run, outcome, note) {
    if (run.ownershipLost || state.fenced) {
      log(
        `No se finaliza el Run ${run.runId}: el Worker perdió el ownership (fencing). ` +
          "Rail es autoritativo."
      );
      return;
    }
    if (run.runFinished) return;
    run.runFinished = true;
    try {
      await run.finish(outcome, note);
      log(`Run ${run.runId} finalizado con outcome=${outcome}.`);
    } catch (err) {
      log(
        `No pude finalizar el Run ${run.runId} (${err.message}). ` +
          "El lease expirará solo; Rail lo marcará ABANDONED."
      );
    }
  }

  async function drainCancelled(execution) {
    // Give a cancelled execution a brief, bounded window to settle its `done`
    // promise. Deliberately does NOT use the injected `sleep` (that one paces
    // discovery polling): a real, unref'd timer caps the wait.
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

  // ── Public API ─────────────────────────────────────────────────────────

  async function start() {
    if (state.phase !== WORKER_PHASES.INIT) {
      throw new Error("El Worker Core ya fue iniciado");
    }
    await connectAndValidate();

    while (!state.stopRequested) {
      let claimed = null;
      try {
        claimed = await discoverAndClaimOne();
      } catch (err) {
        if (err.code === "CLAIM_CONTRACT_ERROR") {
          setPhase(WORKER_PHASES.STOPPED);
          log(`FATAL: ${err.message}`);
          throw err;
        }
        state.lastError = err.message;
        log(`Error inesperado en discovery/claim: ${err.message}. Se reintenta tras el polling.`);
      }

      if (state.stopRequested) {
        if (claimed) await teardownDetached(claimed);
        break;
      }

      if (!claimed) {
        await interruptibleSleep(discoveryPollMs);
        continue;
      }

      await runClaimed(claimed);
      // fenced runs continue the loop and look for new work
      state.fenced = false;
    }

    setPhase(WORKER_PHASES.STOPPED);
    log(`Worker Core detenido. ${state.stopReason ? `Motivo: ${state.stopReason}.` : ""}`.trim());
  }

  /** Claim landed in the same tick a stop was requested: release it now. */
  async function teardownDetached(run) {
    active = run;
    const hb = { stop() {} };
    await teardownActive(run, hb, state.stopReason || "parada solicitada tras el claim");
  }

  function requestStop(reason = "parada solicitada") {
    if (state.stopRequested) return;
    state.stopRequested = true;
    state.stopReason = reason;
    log(`Parada solicitada: ${reason}. No se reclama trabajo nuevo.`);
    if (!stopSignal.settled) {
      stopSignal.settled = true;
      stopSignal.resolve();
    }
  }

  async function interruptibleSleep(ms) {
    await Promise.race([sleep(ms), stopSignal.promise]);
  }

  function getState() {
    return {
      phase: state.phase,
      stopRequested: state.stopRequested,
      stopReason: state.stopReason,
      fenced: state.fenced,
      pollCount: state.pollCount,
      claimsWon: state.claimsWon,
      hasActiveExecution: Boolean(active && active.execution),
      activeRef: active?.ref ?? null,
      activeRunId: active?.runId ?? null,
      activeLeaseExpiresAt: active?.leaseExpiresAt ?? null,
      lastError: state.lastError
    };
  }

  return { start, requestStop, getState, WORKER_PHASES };
}

/** ticket ref / code -> canonical `rail/<code>` branch. Pure. */
export function defaultBranchFor(codeOrRef) {
  return `rail/${String(codeOrRef)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")}`;
}
