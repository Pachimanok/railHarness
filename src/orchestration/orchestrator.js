/**
 * Orchestration — RAIL-D-00005.
 *
 *   RailSoft  (authority)
 *      -> Worker Core        (owns the Run + lease + fencing + shutdown)
 *      -> Orchestration      (THIS module: coordinates roles, turns their
 *                             results into GOVERNED requests to Rail)
 *      -> Workspace Manager  (isolated git worktree)
 *      -> AdapterRouter      (provider-independent role execution)
 *      -> Implementer / Reviewer / Tester
 *
 * The orchestrator works on the Run the Worker Core ALREADY owns. It never
 * claims, never recovers, never heartbeats, never finishes the Run. It only:
 *
 *   1. runs IMPLEMENTER -> (IMPLEMENTATION check) -> transition IN_PROGRESS→REVIEWING
 *   2. runs REVIEWER    -> (CODE_REVIEW check)    -> transition REVIEWING→TESTING
 *   3. runs TESTER      -> (AUTOMATED_TESTS + ACCEPTANCE_CRITERIA checks)
 *                        -> transition TESTING→SANDBOX_READY
 *
 * Every check is created WITH EVIDENCE and BEFORE the transition it gates
 * (T5-AC-01). A role that returns BLOCKED becomes a blocking Agent Query; the
 * orchestrator then WAITS for a governed human resolution — `execute()` stays
 * PENDING while the query is open, so the Worker Core keeps heartbeating and
 * never finishes the Run (no invented answer — T5-AC-02). A REVIEWER / TESTER
 * REWORK goes through a GOVERNED backward transition (REVIEWING / TESTING →
 * IN_PROGRESS) before the IMPLEMENTER re-runs; a TESTER rework always forces a
 * fresh independent REVIEWER before the TESTER retries. A `humanOnly` frontier
 * is a safe hand-off — no fabricated approval (T5-AC-03).
 *
 * Rail is authoritative: a rejected check / transition / query / rewind is
 * respected, never forced, never simulated.
 */

import { randomUUID } from "node:crypto";

import { stripSecretKeys } from "../security/sanitize.js";
import { prepareWorkspace } from "../workspace/workspace-manager.js";
import {
  ROLES,
  assertRoleResult,
  buildRoleEnvelope,
  defaultRunRole
} from "./roles.js";
import {
  createRailEffects,
  createResolvedQueryWaiter,
  TRANSITION_PLAN
} from "./rail-effects.js";

/** Terminal outcomes of an orchestration run. Identifiers — never translated. */
export const ORCHESTRATION_OUTCOMES = Object.freeze([
  "COMPLETED", // full flow through `targetState`, all checks + transitions done
  "BLOCKED", // governed answers exhausted without unblocking (a still-open query
  //            keeps `execute()` PENDING instead — the Core keeps heartbeating)
  "HANDOFF", // reached a humanOnly frontier; handed off, no approval fabricated
  "RELEASED", // a role returned RELEASE (ticket / SPEC / repo do not correspond)
  "FAILED", // technical failure, or Rail rejected a required mutation
  "CANCELLED" // Worker Core cancelled (fencing / shutdown) mid-flow
]);

/** Default Agent Query poll interval (ms) while a blocking query is open. */
export const DEFAULT_QUERY_POLL_MS = 15000;

const DEFAULT_MAX_REWORKS = 1;
const DEFAULT_MAX_QUERY_RESUMES = 1;

/** Internal control-flow signal — caught once at the top of `execute`. */
class OrchestrationStop {
  constructor(outcome, note) {
    this.outcome = outcome;
    this.note = note;
  }
}

/**
 * Build an orchestrator bound to a set of collaborators/policy. All I/O is
 * injected so the whole flow is testable without Rail or a real adapter.
 *
 * @param {object} p
 * @param {object} p.api                RailApiClient (or fake). Checks /
 *                                       transitions / queries / comments.
 * @param {(a:{role,envelope,signal}) => Promise<object>} p.runRole
 *                                       Role runner (RoleResult). Default:
 *                                       `defaultRunRole({ adapterRouter, provider })`.
 * @param {(q:object) => Promise<string|null|{kind:string,answer?:string}>} [p.resolveQuery]
 *                                       Governed human-answer resolver for a
 *                                       blocking Agent Query. A non-empty string
 *                                       is the human answer (RESOLVED); null / ""
 *                                       means "no governed answer available".
 *                                       When omitted, a CANCELABLE poller over
 *                                       `api.listQueries` is used: it resolves
 *                                       ONLY on the RailSoft status of THAT exact
 *                                       `queryId` — `RESOLVED` (with non-empty
 *                                       answer text) or `DISMISSED` — and
 *                                       otherwise leaves `execute()` PENDING
 *                                       (never an invented answer, never
 *                                       `finishRun`). `RESOLVED` without answer
 *                                       text, or an unknown status, is a
 *                                       fail-closed contract violation.
 * @param {number}  [p.queryPollMs]      poll interval for that waiter (default 15000).
 * @param {(ms:number)=>Promise} [p.sleep]  injectable timer for the waiter (tests).
 * @param {number}  [p.maxReworks]       Reviewer/Tester REWORK budget (default 1).
 * @param {number}  [p.maxQueryResumes]  governed BLOCKED->resume budget (default 1).
 *                                       MUST be an integer >= 0. Explicit
 *                                       semantics for `0`: Agent-Query-driven
 *                                       resume is DISABLED — a role that returns
 *                                       BLOCKED is fail-closed (outcome `BLOCKED`
 *                                       → Run `FAILED`) and **no Agent Query is
 *                                       created** (an unwaitable query would be
 *                                       an orphan). `1` (default) allows exactly
 *                                       one governed human resume.
 * @param {string}  [p.targetState]      final WorkCycle state (default SANDBOX_READY).
 * @param {string[]}[p.humanOnlyStates]  states the Harness must hand off, not enter.
 * @param {() => string} [p.newSessionId]
 * @param {(msg:string)=>void} [p.logger]
 * @param {() => number} [p.now]
 */
export function createOrchestrator({
  api,
  runRole,
  resolveQuery = null,
  queryPollMs = DEFAULT_QUERY_POLL_MS,
  sleep,
  maxReworks = DEFAULT_MAX_REWORKS,
  maxQueryResumes = DEFAULT_MAX_QUERY_RESUMES,
  targetState = "SANDBOX_READY",
  humanOnlyStates = [],
  newSessionId = () => randomUUID(),
  logger = () => {},
  now = () => Date.now()
} = {}) {
  if (!api) throw new Error("createOrchestrator requiere un cliente Rail (api)");
  if (typeof runRole !== "function") {
    throw new Error("createOrchestrator requiere runRole({ role, envelope, signal })");
  }
  if (!Number.isInteger(maxQueryResumes) || maxQueryResumes < 0) {
    throw new Error(
      "maxQueryResumes debe ser un entero >= 0 (0 = Agent Queries deshabilitadas, " +
        "BLOCKED falla cerrado sin crear query)"
    );
  }
  if (!Number.isInteger(maxReworks) || maxReworks < 0) {
    throw new Error("maxReworks debe ser un entero >= 0");
  }

  const log = msg => {
    try {
      logger(String(msg));
    } catch {
      /* ignore */
    }
  };

  const abort = new AbortController();
  let cancelled = false;
  let cancelReason = null;

  function cancel(reason = "cancelación solicitada") {
    if (cancelled) return; // idempotent
    cancelled = true;
    cancelReason = reason;
    log(
      `Orquestación: cancelación solicitada (${reason}). No se ejecutarán más roles ` +
        "ni se harán más efectos en Rail."
    );
    try {
      abort.abort();
    } catch {
      /* ignore */
    }
  }

  async function execute({ ref, runId, ticket, branch, workspacePath, startState, recovery = null }) {
    if (!ref || !runId || !branch || !workspacePath) {
      throw new Error(
        "execute requiere { ref, runId, branch, workspacePath } (el Run ya lo posee el Worker Core)"
      );
    }

    const fx = createRailEffects({ api, ref, runId, logger: log });

    // How a still-open blocking Agent Query is waited on. An injected
    // `resolveQuery` wins (tests / a custom governed channel); otherwise a
    // cancelable poller over `api.listQueries` that NEVER fabricates an answer
    // and leaves `execute()` pending while the query stays open. Built LAZILY —
    // only when a role actually returns BLOCKED.
    //
    // Normalized result shape (RailSoft semantics). `HUMAN_ANSWER` is an
    // internal Harness `kind`, deliberately NOT `"ANSWERED"` — `ANSWERED` is an
    // *invalid* RailSoft query status and the two must never be confused
    // (RailSoft statuses stay PENDING / RESOLVED / DISMISSED, untouched).
    //   { kind: "HUMAN_ANSWER", answer } — a real, non-empty human answer (RESOLVED)
    //   { kind: "DISMISSED" }            — discarded WITHOUT an answer (DISMISSED)
    //   { kind: "NO_ANSWER" }            — no governed answer available (injected
    //                                      resolver said so / gave up)
    // A contract violation (RESOLVED w/o text, unknown status, missing queryId)
    // is thrown as `ORCH_QUERY_CONTRACT_VIOLATION` — never a synthetic answer.
    let queryWaiter = null;
    const waitForGovernedAnswer = async payload => {
      if (typeof resolveQuery === "function") {
        const raw = await resolveQuery(payload);
        if (typeof raw === "string" && raw.trim() !== "") {
          return { kind: "HUMAN_ANSWER", answer: raw.trim() };
        }
        if (raw && typeof raw === "object" && typeof raw.kind === "string") {
          // Back-compat: an injected resolver may still say "ANSWERED".
          if (raw.kind === "ANSWERED") return { kind: "HUMAN_ANSWER", answer: raw.answer };
          return raw;
        }
        return { kind: "NO_ANSWER" };
      }
      if (!queryWaiter) {
        queryWaiter = createResolvedQueryWaiter({
          api,
          ref,
          pollMs: queryPollMs,
          signal: abort.signal,
          sleep,
          logger: log
        });
      }
      return queryWaiter(payload);
    };

    /** WorkCycle state as the orchestrator understands it (Rail re-validates). */
    let cycle;

    const timeline = [];
    const record = entry => {
      timeline.push(Object.freeze({ at: now(), ...entry }));
    };
    const stop = (outcome, note) => {
      throw new OrchestrationStop(outcome, note);
    };
    const guardCancelled = () => {
      if (cancelled) {
        stop(
          "CANCELLED",
          `Orquestación cancelada (${cancelReason}). No se ejecutaron más roles ni ` +
            "efectos en Rail; Rail es autoritativo sobre el estado del ciclo."
        );
      }
    };

    // ── one role execution, with the BLOCKED -> Agent Query -> governed resume loop
    async function runRoleGoverned({
      role,
      kind = "IMPLEMENT",
      sessionId,
      continuation = null,
      roleBrief = null,
      audienceRole
    }) {
      guardCancelled();
      let resumeAnswer = null;

      for (let attempt = 0; attempt <= maxQueryResumes; attempt += 1) {
        guardCancelled();
        const envelope = buildRoleEnvelope({
          role,
          kind,
          runId,
          branch,
          ticket,
          workspacePath,
          sessionId,
          continuation,
          resumeAnswer,
          roleBrief
        });
        record({
          kind: "role",
          role,
          session: sessionId,
          envelopeKind: envelope.kind,
          resumed: resumeAnswer != null
        });

        let roleResult;
        try {
          roleResult = await runRole({ role, envelope, signal: abort.signal });
        } catch (err) {
          // Adapter / role technical failure — not a business decision.
          return Object.freeze({
            role,
            decision: "FAILED",
            summary: `Fallo técnico ejecutando el rol ${role}: ${err.message}`,
            question: null,
            context: null,
            impact: null,
            evidence: Object.freeze({ tests: [], filesChanged: [], findings: [] }),
            sessionId
          });
        }
        roleResult = assertRoleResult(role, roleResult);

        if (roleResult.decision !== "BLOCKED") return roleResult;

        // MAX QUERY RESUMES — check the budget BEFORE creating another Agent
        // Query. If there is no resume budget left, a new query could never be
        // waited on / acted upon, so it is NOT created (it would be left
        // pending and orphaned). Fail-closed instead.
        guardCancelled();
        if (attempt >= maxQueryResumes) {
          stop(
            "BLOCKED",
            (maxQueryResumes === 0
              ? `El rol ${role} devolvió BLOCKED y las Agent Queries están deshabilitadas ` +
                `(maxQueryResumes=0). `
              : `El rol ${role} sigue BLOCKED y no queda presupuesto de resume ` +
                `(maxQueryResumes=${maxQueryResumes}). `) +
              "NO se crea otra Agent Query — dejarla pendiente sin poder esperarla sería una " +
              "query huérfana. Se detiene el avance sin inventar una resolución."
          );
        }

        // BLOCKED -> blocking Agent Query. Preserve question/context/impact.
        guardCancelled();
        const q = await fx.raiseBlockingQuery({
          question: roleResult.question,
          context: roleResult.context,
          impact: roleResult.impact,
          audienceRole
        });
        record({ kind: "query", role, created: q.created, id: q.id ?? null });
        if (!q.created) {
          stop(
            "FAILED",
            "Rail rechazó la Agent Query bloqueante. Se respeta el rechazo y se detiene " +
              "el avance; no se inventa una respuesta."
          );
        }
        // B4 — RailSoft's `createQuery` ALWAYS returns a `queryId`. Its absence
        // is a contract violation: fail-closed. NEVER fall back to matching
        // "some blocking query" — an old / other-Run / other-block query must
        // not unblock this wait.
        if (!q.id) {
          stop(
            "FAILED",
            "Rail creó la Agent Query bloqueante pero no devolvió un queryId — viola el " +
              "contrato de RailSoft (createQuery devuelve siempre { queryId, blocking, " +
              "cycleState }). Fail-closed: no se espera una query ambigua ni se reanuda el rol."
          );
        }

        // Governed resolution ONLY. With the default waiter this call stays
        // PENDING while the query is open — `execute()` never settles, so the
        // Worker Core keeps heartbeating and the Run stays ACTIVE. It settles
        // only on a real Rail resolution, or rejects when cancel/fencing fires.
        guardCancelled();
        let waited;
        try {
          waited = await waitForGovernedAnswer({
            question: roleResult.question,
            context: roleResult.context,
            impact: roleResult.impact,
            role,
            queryId: q.id,
            ref,
            signal: abort.signal
          });
        } catch (err) {
          // A cancel during the wait must surface as CANCELLED, not BLOCKED.
          guardCancelled();
          // A RailSoft Agent Query contract violation (RESOLVED without answer
          // text, an unknown status like ANSWERED/CLOSED, a missing queryId) is
          // fail-closed as FAILED — never an eternal wait, never a resume.
          if (err && err.code === "ORCH_QUERY_CONTRACT_VIOLATION") {
            stop("FAILED", err.message);
          }
          log(
            `La espera de la Agent Query terminó sin respuesta gobernada (${err.message}); ` +
              "se detiene el avance."
          );
          waited = { kind: "NO_ANSWER" };
        }
        guardCancelled();

        // DISMISSED — RailSoft semantics: "descartar sin responder". The agent
        // CANNOT continue from the question. No adapter resume, no resumeAnswer,
        // no new query, no invented human instruction. RailSoft already
        // recomputed BLOCKED and restored `stateBeforeBlock`; the Harness only
        // records a factual governed note and ends FAILED (the Worker Core then
        // finishRun(FAILED)).
        if (waited && waited.kind === "DISMISSED") {
          record({ kind: "query-dismissed", role, id: q.id });
          await fx.governedNote(
            `La Agent Query bloqueante ${q.id} (rol ${role}) fue descartada (DISMISSED) sin ` +
              "respuesta humana. El Harness NO continúa a partir de la pregunta, NO reanuda el " +
              "adapter y NO fabrica una instrucción; el Run se cierra como FAILED. RailSoft ya " +
              "recalculó BLOCKED y restauró el estado previo del WorkCycle."
          );
          stop(
            "FAILED",
            `Agent Query ${q.id} descartada sin respuesta (DISMISSED). No se reanuda el rol ` +
              `${role}, no se usa resumeAnswer y no se crea otra query; el Run termina FAILED.`
          );
        }

        if (
          !waited ||
          waited.kind !== "HUMAN_ANSWER" ||
          typeof waited.answer !== "string" ||
          waited.answer.trim() === ""
        ) {
          stop(
            "BLOCKED",
            `Avance detenido: Agent Query bloqueante ${q.id} abierta para el rol ${role}. Se ` +
              "espera una respuesta humana gobernada; no se inventó ninguna respuesta."
          );
        }

        resumeAnswer = waited.answer.trim();
        record({ kind: "resume", role, session: sessionId });
        // loop: same sessionId + resumeAnswer -> the adapter resumes the SAME
        // session with the SAME role framing (buildResumePrompt is role-aware).
      }

      stop(
        "BLOCKED",
        `El rol ${role} siguió BLOCKED tras ${maxQueryResumes} respuesta(s) gobernada(s). ` +
          "Se detiene el avance sin inventar una resolución."
      );
    }

    // ── publish gating checks (with evidence) THEN request the transition ────
    async function publishThenTransition({ checks, from, to, role }) {
      guardCancelled();

      // Evidence is always legitimate to record; publish it first (T5-AC-01).
      for (const c of checks) {
        guardCancelled();
        try {
          await fx.publishCheck({ type: c.type, evidence: c.evidence, note: c.note });
        } catch (err) {
          if (err.code === "ORCH_INSUFFICIENT_EVIDENCE") {
            stop("FAILED", err.message);
          }
          if (err.code === "ORCH_CHECK_REJECTED") {
            stop("FAILED", err.message);
          }
          throw err;
        }
        record({ kind: "check", type: c.type });
      }

      // Re-check cancel after the check writes, before the next Rail effect.
      guardCancelled();

      // Proactive humanOnly frontier: do NOT even request the transition.
      if (humanOnlyStates.includes(to)) {
        await fx.governedNote(
          `Frontera humanOnly: la transición ${from} → ${to} requiere una acción humana. ` +
            "El Harness hace hand-off y NO publica ninguna aprobación humana. La evidencia " +
            "(checks) quedó registrada para la persona que decida."
        );
        record({ kind: "handoff", from, to, humanOnly: true, proactive: true });
        stop(
          "HANDOFF",
          `Hand-off seguro en ${from} → ${to}: requiere acción humanOnly. Checks de evidencia ` +
            "registrados; no se fabricó ninguna aprobación humana."
        );
      }

      guardCancelled();
      const tr = await fx.requestTransition({
        from,
        to,
        reason: `Rol ${role} PASS con evidencia registrada (${checks
          .map(c => c.type)
          .join(", ")}).`
      });
      // A request already left the process; Rail may still decide it. But after
      // a cancel the orchestrator starts no further effect and records no later
      // step as done.
      guardCancelled();

      if (tr.applied) {
        record({ kind: "transition", from, to });
        cycle = to;
        return;
      }
      if (tr.humanOnly) {
        await fx.governedNote(
          `Rail marcó la transición ${from} → ${to} como humanOnly. El Harness hace hand-off ` +
            "y NO publica ninguna aprobación humana."
        );
        record({ kind: "handoff", from, to, humanOnly: true });
        stop(
          "HANDOFF",
          `Rail requiere una acción humanOnly para ${from} → ${to}. Hand-off seguro; ` +
            "no se fabricó ninguna aprobación."
        );
      }
      record({ kind: "transition-rejected", from, to, missing: tr.missing ?? [] });
      stop(
        "FAILED",
        `Rail rechazó la transición ${from} → ${to} (${tr.reason ?? "gate no aprobado"})` +
          (tr.missing && tr.missing.length ? `; falta: ${tr.missing.join(", ")}` : "") +
          ". Se respeta el rechazo; no se fuerza ni se simula éxito."
      );
    }

    /**
     * GOVERNED REWIND for a Reviewer / Tester REWORK. Before the IMPLEMENTER is
     * re-run, Rail must move the cycle back to IN_PROGRESS — the Harness never
     * re-runs the IMPLEMENTER while Rail still sits in REVIEWING / TESTING, and
     * never fabricates a backward transition.
     *
     * If Rail REJECTS the rewind: the rejection is respected — the IMPLEMENTER
     * is NOT run, no IMPLEMENTATION PASS is published, no state is invented.
     * A `humanOnly` rewind frontier is a safe hand-off.
     *
     * @returns {void} on success (`cycle` is now "IN_PROGRESS"); otherwise
     *          throws an OrchestrationStop (FAILED / HANDOFF).
     */
    async function governedRewind({ from, source }) {
      guardCancelled();
      const tr = await fx.requestTransition({
        from,
        to: "IN_PROGRESS",
        reason:
          `REWORK pedido por el ${source}: se solicita a Rail el rewind gobernado ` +
          `${from} → IN_PROGRESS antes de reanudar al IMPLEMENTER.`
      });
      guardCancelled();
      if (tr.applied) {
        record({ kind: "transition", from, to: "IN_PROGRESS", rewind: true, source });
        cycle = "IN_PROGRESS";
        return;
      }
      if (tr.humanOnly) {
        await fx.governedNote(
          `El rewind ${from} → IN_PROGRESS (REWORK del ${source}) es humanOnly en Rail. ` +
            "Hand-off seguro; no se ejecuta el IMPLEMENTER ni se fabrica una aprobación."
        );
        record({ kind: "handoff", from, to: "IN_PROGRESS", humanOnly: true, rewind: true });
        stop(
          "HANDOFF",
          `Rail requiere una acción humanOnly para el rewind ${from} → IN_PROGRESS. ` +
            "No se ejecuta el IMPLEMENTER; no se fabrica ninguna aprobación."
        );
      }
      record({
        kind: "transition-rejected",
        from,
        to: "IN_PROGRESS",
        rewind: true,
        missing: tr.missing ?? []
      });
      stop(
        "FAILED",
        `Rail rechazó el rewind ${from} → IN_PROGRESS (${tr.reason ?? "gate no aprobado"})` +
          (tr.missing && tr.missing.length ? `; falta: ${tr.missing.join(", ")}` : "") +
          ". Se respeta el rechazo: NO se ejecuta el IMPLEMENTER, NO se publica IMPLEMENTATION " +
          "PASS y NO se inventa estado."
      );
    }

    /**
     * Re-run the IMPLEMENTER as a governed RECOVERY continuation (same impl
     * session) after a rewind, publish the fresh IMPLEMENTATION evidence and
     * transition IN_PROGRESS → REVIEWING. `cycle` ends at "REVIEWING".
     * @returns {object} the new `lastImpl` RoleResult.
     */
    async function reworkImplementerThenBackToReview({
      implSessionId,
      feedbackResult,
      changedFiles,
      reworkN
    }) {
      guardCancelled();
      const back = await runRoleGoverned({
        role: ROLES.IMPLEMENTER,
        kind: "RECOVERY",
        sessionId: implSessionId,
        continuation: {
          failedReviewNote: feedbackResult.summary,
          pendingFeedback: [...feedbackResult.evidence.findings],
          changedFiles: [...changedFiles]
        }
      });
      if (back.decision === "RELEASE") {
        stop("RELEASED", `RELEASE del IMPLEMENTER durante el rework: ${back.summary}`);
      }
      if (back.decision === "FAILED") {
        stop("FAILED", `El IMPLEMENTER falló durante el rework: ${back.summary}`);
      }
      guardCancelled();
      await publishThenTransition({
        checks: [
          {
            type: "IMPLEMENTATION",
            evidence: {
              summary: back.summary,
              filesChanged: [...back.evidence.filesChanged]
            },
            note: `Rework ${reworkN}: implementación corregida; nueva evidencia IMPLEMENTATION.`
          }
        ],
        from: "IN_PROGRESS",
        to: "REVIEWING",
        role: ROLES.IMPLEMENTER
      });
      return back;
    }

    function acListFromTicket() {
      const acs = ticket?.planning?.acceptance_criteria;
      if (!Array.isArray(acs)) return [];
      return acs
        .filter(ac => ac && typeof ac.id === "string" && ac.id.trim() !== "")
        .map(ac => ({
          id: ac.id,
          text: [ac.given, ac.when, ac.then].filter(Boolean).join(" / ")
        }));
    }

    function finish(outcome, note) {
      const checks = timeline.filter(t => t.kind === "check").map(t => t.type);
      const transitions = timeline
        .filter(t => t.kind === "transition")
        .map(t => ({ from: t.from, to: t.to }));
      const queries = timeline
        .filter(t => t.kind === "query")
        .map(t => ({ role: t.role, id: t.id, created: t.created }));
      const handoffs = timeline
        .filter(t => t.kind === "handoff")
        .map(t => ({ from: t.from, to: t.to }));
      log(`Orquestación finalizada: ${outcome}. ${note}`);
      return Object.freeze({
        outcome,
        note,
        checks: Object.freeze(checks),
        transitions: Object.freeze(transitions.map(Object.freeze)),
        queries: Object.freeze(queries.map(Object.freeze)),
        handoffs: Object.freeze(handoffs.map(Object.freeze)),
        timeline: Object.freeze(timeline)
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    try {
      cycle = String(startState || ticket?.state || "CLAIMED");

      // Step 0 — CLAIMED -> IN_PROGRESS (governed). The Worker Core just
      // claimed; the orchestrator, not the Core, owns this transition.
      if (cycle === "CLAIMED") {
        guardCancelled();
        const tr = await fx.requestTransition({
          from: "CLAIMED",
          to: "IN_PROGRESS",
          reason: "Claim válido; inicio de la orquestación gobernada de roles."
        });
        if (tr.humanOnly) {
          record({ kind: "handoff", from: "CLAIMED", to: "IN_PROGRESS", humanOnly: true });
          return finish(
            "HANDOFF",
            "Rail marcó CLAIMED → IN_PROGRESS como humanOnly. Hand-off; no se fabrica aprobación."
          );
        }
        if (!tr.applied) {
          return finish(
            "FAILED",
            `No se pudo pasar el ciclo CLAIMED → IN_PROGRESS (${tr.reason ?? "rechazo de Rail"}). ` +
              "No se ejecuta ningún rol."
          );
        }
        record({ kind: "transition", from: "CLAIMED", to: "IN_PROGRESS" });
        cycle = "IN_PROGRESS";
      }

      // STATE-AWARE ENTRY (RAIL-D-00006 `/resume`). A resumed cycle continues
      // from the EXACT state Rail preserved — the orchestrator never rewinds it
      // and never re-runs (or re-publishes) a stage Rail already accepted:
      //   IN_PROGRESS → run IMPLEMENTER, then REVIEWER, then TESTER
      //   REVIEWING   → run REVIEWER, then TESTER  (NO IMPLEMENTER, NO IMPLEMENTATION check)
      //   TESTING     → run TESTER only            (NO IMPLEMENTER/REVIEWER, NO IMPLEMENTATION/CODE_REVIEW check)
      //   <targetState> → nothing to execute (already at the frontier)
      const cycleEntry = cycle;
      const ENTRY_STATES = new Set(["IN_PROGRESS", "REVIEWING", "TESTING", targetState]);
      if (!ENTRY_STATES.has(cycle)) {
        return finish(
          "RELEASED",
          `Estado de ciclo inesperado para orquestar (${cycle}). No se ejecuta ningún rol; ` +
            "Rail es autoritativo sobre el estado."
        );
      }
      if (cycle === targetState) {
        if (humanOnlyStates.includes(cycle)) {
          await fx.governedNote(
            `Ejecución reanudada con el ciclo ya en ${cycle} (frontera humanOnly). El Harness hace ` +
              "hand-off y NO fabrica ninguna aprobación; la evidencia previa del ciclo queda para la persona."
          );
          record({ kind: "handoff", from: cycle, to: cycle, humanOnly: true, resumed: true });
          return finish(
            "HANDOFF",
            `Reanudado en ${cycle}: es una frontera humanOnly. Hand-off seguro; ninguna aprobación fabricada.`
          );
        }
        return finish(
          "COMPLETED",
          `Ejecución reanudada con el ciclo ya en ${targetState}: no hay pasos automáticos pendientes. ` +
            "No se re-ejecuta ni se re-publica nada; Rail es autoritativo."
        );
      }

      // `lastImpl` is only populated when THIS execution ran the IMPLEMENTER.
      // On a pure `/resume` into REVIEWING / TESTING it stays null and the
      // REVIEWER / TESTER get a factual "resumed, do not re-implement" brief.
      let lastImpl = null;
      let implSessionId = null;

      const resumeBrief = () => ({
        implementationSummary:
          `Ejecución reanudada (RESUME) en ${cycleEntry}: los pasos previos ya aceptados por Rail ` +
          `para este HEAD (IMPLEMENTATION${cycleEntry === "TESTING" ? " + CODE_REVIEW" : ""}) NO se ` +
          "re-ejecutan ni se re-publican. Revisá el estado real del worktree y los checks del ciclo y " +
          "continuá desde acá; no re-implementes ni inventes aprobaciones.",
        changedFiles: []
      });
      const reviewerBrief = () =>
        lastImpl
          ? {
              implementationSummary: lastImpl.summary,
              changedFiles: [...lastImpl.evidence.filesChanged]
            }
          : resumeBrief();
      const testerBrief = () => ({ ...reviewerBrief(), acceptanceCriteria: acListFromTicket() });
      const changedFilesForRework = () => (lastImpl ? [...lastImpl.evidence.filesChanged] : []);

      // Phase 1 — IMPLEMENTER — ONLY when entering at IN_PROGRESS ────────────
      // In a `/resume` or `/recover` continuation the worktree already holds
      // prior work: the first IMPLEMENTER runs as a `RECOVERY` continuation (do
      // NOT start from scratch), NOT a cold `IMPLEMENT`. This is a RUN
      // recovery — NOT an adapter-session resume — and never fabricates a human
      // answer or a prior approval.
      if (cycle === "IN_PROGRESS") {
        implSessionId = newSessionId();
        const implKind = recovery ? "RECOVERY" : "IMPLEMENT";
        const implContinuation = recovery
          ? {
              priorImplementationNote:
                `Continuación de un ciclo IN_PROGRESS reanudado ` +
                `(recoveryOfRunId=${recovery.fromRunId ?? "?"}, target=${recovery.target ?? "?"}). ` +
                "Ya existe trabajo previo sin commitear en el worktree: revisá git status / git diff " +
                "primero y continuá; NO empieces de cero y NO descartes el trabajo existente.",
              changedFiles: []
            }
          : null;
        lastImpl = await runRoleGoverned({
          role: ROLES.IMPLEMENTER,
          kind: implKind,
          sessionId: implSessionId,
          continuation: implContinuation
        });
        if (lastImpl.decision === "RELEASE") {
          return finish("RELEASED", `El IMPLEMENTER devolvió RELEASE: ${lastImpl.summary}`);
        }
        if (lastImpl.decision === "FAILED") {
          return finish("FAILED", `El IMPLEMENTER falló: ${lastImpl.summary}`);
        }
        // decision === PASS
        await publishThenTransition({
          checks: [
            {
              type: "IMPLEMENTATION",
              evidence: {
                summary: lastImpl.summary,
                filesChanged: [...lastImpl.evidence.filesChanged]
              },
              note: "Implementación producida por el IMPLEMENTER."
            }
          ],
          from: "IN_PROGRESS",
          to: "REVIEWING",
          role: ROLES.IMPLEMENTER
        });
        // `publishThenTransition` set `cycle = "REVIEWING"`.
      }

      let reworks = 0;
      // Enter the REVIEWER/TESTER loop at the TESTER when the cycle was resumed
      // straight into TESTING (Rail already accepted CODE_REVIEW for this HEAD).
      // Every LATER iteration (after a rework) always runs the REVIEWER first —
      // a code change can never skip a fresh independent review.
      let enterAtTester = cycle === "TESTING";

      // Phases 2 + 3 — one governed loop: REVIEWER (REVIEWING) then TESTER
      // (TESTING). A REWORK from either role goes through a GOVERNED REWIND to
      // IN_PROGRESS (Defect 1) before the IMPLEMENTER runs again, publishes new
      // IMPLEMENTATION evidence, transitions back IN_PROGRESS → REVIEWING, and
      // re-enters the loop at the REVIEWER — a TESTER rework can NEVER go
      // straight back to the TESTER without a fresh independent review.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        guardCancelled();

        // ── REVIEWER (independent, fresh session). cycle === "REVIEWING". ──
        // Skipped on the FIRST iteration only when the cycle was resumed
        // straight into TESTING (Rail already accepted CODE_REVIEW).
        if (!enterAtTester) {
          const reviewSessionId = newSessionId();
          const review = await runRoleGoverned({
            role: ROLES.REVIEWER,
            kind: "IMPLEMENT",
            sessionId: reviewSessionId,
            audienceRole: "REVIEWER",
            roleBrief: reviewerBrief()
          });

          if (review.decision === "FAILED") {
            return finish("FAILED", `El REVIEWER falló técnicamente: ${review.summary}`);
          }
          if (review.decision === "RELEASE") {
            return finish("RELEASED", `El REVIEWER indicó RELEASE: ${review.summary}`);
          }
          if (review.decision === "REWORK") {
            reworks += 1;
            record({ kind: "rework", source: "REVIEWER", n: reworks });
            if (reworks > maxReworks) {
              return finish(
                "FAILED",
                `Code Review no aprobado tras ${maxReworks} rework(s). NO se crea CODE_REVIEW PASS ` +
                  "y NO se avanza a TESTING."
              );
            }
            // Governed rewind REVIEWING → IN_PROGRESS BEFORE re-running the
            // IMPLEMENTER. A Rail rejection stops here (FAILED / HANDOFF): no
            // IMPLEMENTER, no IMPLEMENTATION PASS, no invented state.
            await governedRewind({ from: "REVIEWING", source: "REVIEWER" });
            implSessionId = implSessionId || newSessionId();
            lastImpl = await reworkImplementerThenBackToReview({
              implSessionId,
              feedbackResult: review,
              changedFiles: changedFilesForRework(),
              reworkN: reworks
            });
            continue; // fresh independent REVIEWER
          }

          // REVIEWER PASS — CODE_REVIEW (evidence) then REVIEWING → TESTING.
          await publishThenTransition({
            checks: [
              {
                type: "CODE_REVIEW",
                evidence: {
                  summary: review.summary,
                  reviewerDecision: "PASS",
                  tests: [...review.evidence.tests]
                },
                note: "Revisión independiente aprobada por el REVIEWER."
              }
            ],
            from: "REVIEWING",
            to: "TESTING",
            role: ROLES.REVIEWER
          });
        }
        enterAtTester = false; // every later iteration runs the REVIEWER first

        // ── TESTER (independent, fresh session; != REVIEWER). cycle === "TESTING". ──
        guardCancelled();
        const testSessionId = newSessionId();
        const test = await runRoleGoverned({
          role: ROLES.TESTER,
          kind: "IMPLEMENT",
          sessionId: testSessionId,
          audienceRole: "TESTER",
          roleBrief: testerBrief()
        });

        if (test.decision === "FAILED") {
          return finish("FAILED", `El TESTER falló técnicamente: ${test.summary}`);
        }
        if (test.decision === "RELEASE") {
          return finish("RELEASED", `El TESTER indicó RELEASE: ${test.summary}`);
        }
        if (test.decision === "REWORK") {
          reworks += 1;
          record({ kind: "rework", source: "TESTER", n: reworks });
          if (reworks > maxReworks) {
            return finish(
              "FAILED",
              `El TESTER no aprobó tras ${maxReworks} rework(s). NO se crean AUTOMATED_TESTS / ` +
                "ACCEPTANCE_CRITERIA PASS y NO se avanza a SANDBOX_READY."
            );
          }
          // Governed rewind TESTING → IN_PROGRESS, fix with the IMPLEMENTER,
          // new IMPLEMENTATION PASS, IN_PROGRESS → REVIEWING, then re-enter the
          // loop: a fresh REVIEWER runs before the TESTER is retried.
          await governedRewind({ from: "TESTING", source: "TESTER" });
          implSessionId = implSessionId || newSessionId();
          lastImpl = await reworkImplementerThenBackToReview({
            implSessionId,
            feedbackResult: test,
            changedFiles: changedFilesForRework(),
            reworkN: reworks
          });
          continue; // mandatory re-review before the TESTER
        }

        // TESTER PASS — evidence must be REAL (tests actually run).
        const acEvidence = acListFromTicket().map(ac => ({
          id: ac.id,
          status: "PASS",
          note: `Validado por el TESTER (sesión ${testSessionId.slice(0, 8)}).`
        }));
        await publishThenTransition({
          checks: [
            {
              type: "AUTOMATED_TESTS",
              evidence: { tests: [...test.evidence.tests], summary: test.summary },
              note: "Suite ejecutada por el TESTER."
            },
            {
              type: "ACCEPTANCE_CRITERIA",
              evidence: { acceptanceCriteria: acEvidence, summary: test.summary },
              note: "Acceptance Criteria verificados por el TESTER."
            }
          ],
          from: "TESTING",
          to: targetState,
          role: ROLES.TESTER
        });
        break;
      }

      return finish(
        "COMPLETED",
        cycleEntry === "IN_PROGRESS"
          ? `Orquestación completa. IMPLEMENTATION / CODE_REVIEW / AUTOMATED_TESTS / ` +
              `ACCEPTANCE_CRITERIA registrados con evidencia; ciclo llevado a ${targetState} ` +
              "mediante transiciones gobernadas de Rail."
          : `Orquestación reanudada desde ${cycleEntry} y completada hasta ${targetState}. Sólo se ` +
              "ejecutaron y publicaron los pasos aún NO aceptados por Rail para este HEAD; los previos " +
              "no se re-ejecutaron ni se re-publicaron."
      );
    } catch (err) {
      if (err instanceof OrchestrationStop) return finish(err.outcome, err.note);
      throw err;
    }
  }

  return { execute, cancel };
}

/**
 * Map an orchestration outcome onto the Run outcome the Worker Core hands to
 * `finishRun`. RailSoft's contract supports COMPLETED / FAILED / ABANDONED /
 * RELEASED (RailSoft is authoritative above the local mirror). RELEASED is NOT
 * a catch-all: an unknown internal outcome and a HANDOFF are never silently
 * mapped to it.
 *
 *   COMPLETED  → COMPLETED   the automated flow reached `targetState`.
 *   HANDOFF    → COMPLETED   the automated work finished at a valid humanOnly
 *                            frontier; evidence recorded, a human takes over.
 *                            Semantically distinct from RELEASED — the ticket
 *                            still corresponds — and from FAILED — nothing failed.
 *   RELEASED   → RELEASED    a role determined the ticket / SPEC / repo does not
 *                            correspond (a genuine release).
 *   CANCELLED  → RELEASED    fencing / controlled shutdown; Rail is authoritative.
 *   BLOCKED    → FAILED      governed answers were exhausted without unblocking.
 *                            (A still-open query keeps `execute()` PENDING and
 *                            never reaches here — the Run stays ACTIVE.)
 *   FAILED     → FAILED
 *   <unknown>  → FAILED      explicitly NOT RELEASED.
 */
export function mapOrchestrationOutcome(result) {
  const note = result?.note ?? "";
  switch (result?.outcome) {
    case "COMPLETED":
    case "HANDOFF":
      return { outcome: "COMPLETED", note };
    case "RELEASED":
    case "CANCELLED":
      return { outcome: "RELEASED", note };
    case "BLOCKED":
    case "FAILED":
      return { outcome: "FAILED", note };
    default:
      return {
        outcome: "FAILED",
        note:
          `Outcome de orquestación desconocido: ${JSON.stringify(result?.outcome)} — ` +
          "no se mapea a RELEASED; el Worker Core cierra el Run como FAILED."
      };
  }
}

/**
 * The Worker Core `createExecution` collaborator, backed by the orchestrator.
 * Replaces `createPlaceholderExecution` for productive runs:
 *
 *   prepare isolated workspace  ->  createOrchestrator().execute()  ->  { outcome, note }
 *
 * `ctx` is the Worker Core execution context `{ ref, ticket, branch, run:{id} }`
 * — it carries NO `claimToken` (`assertNoSecretKeys` in the Core proves it).
 * The `api` / `adapterRouter` / workspace config are injected HERE, never
 * through `ctx`.
 *
 * @param {object} ctx
 * @param {object} deps
 * @param {object}   deps.api             RailApiClient
 * @param {object}   [deps.adapterRouter] AdapterRouter (required unless `runRole` given)
 * @param {string}   [deps.provider]      explicit adapter provider
 * @param {Function} [deps.runRole]       role runner override (tests)
 * @param {string}   deps.workspaceRoot
 * @param {string}   deps.repoPath
 * @param {string}   [deps.baseBranch]
 * @param {Function} [deps.prepareWorkspace]
 * @param {Function} [deps.runGit]
 * @param {Function} [deps.resolveQuery]  governed Agent Query resolver override
 * @param {number}   [deps.queryPollMs]   Agent Query poll interval (default 15000)
 * @param {Function} [deps.sleep]         injectable timer for the query waiter
 * @param {number}   [deps.maxReworks]
 * @param {string}   [deps.targetState]
 * @param {string[]} [deps.humanOnlyStates]
 * @param {Function} [deps.newSessionId]
 * @param {string}   [deps.startState]    WorkCycle state at hand-off (default CLAIMED)
 * @param {(msg:string)=>void} [deps.logger]
 * @returns {{ done: Promise<{outcome:string,note:string}>, cancel: Function }}
 */
export function createOrchestrationExecution(ctx, deps = {}) {
  const {
    api,
    adapterRouter,
    provider,
    runRole,
    workspaceRoot,
    repoPath,
    baseBranch,
    prepareWorkspace: prepareWs = prepareWorkspace,
    runGit,
    resolveQuery,
    queryPollMs,
    sleep,
    maxReworks,
    maxQueryResumes,
    targetState,
    humanOnlyStates,
    newSessionId,
    startState = "CLAIMED",
    logger = line => console.log(line)
  } = deps;

  const log = m => {
    try {
      logger(String(m));
    } catch {
      /* ignore */
    }
  };

  if (!api) throw new Error("createOrchestrationExecution requiere api (RailApiClient)");
  const roleRunner = runRole || defaultRunRole({ adapterRouter, provider });

  let orchestrator = null;
  let cancelledEarly = false;
  let cancelReason = null;

  const done = (async () => {
    if (!workspaceRoot) {
      return {
        outcome: "FAILED",
        note:
          "RAIL_WORKSPACE_ROOT no está configurado; la orquestación necesita un workspace " +
          "git aislado y no puede continuar."
      };
    }

    let workspace;
    try {
      workspace = await prepareWs({
        ticket: stripSecretKeys(ctx.ticket ?? {}),
        branch: ctx.branch,
        workspaceRoot,
        repoPath,
        baseBranch,
        runGit,
        logger
      });
      log(`Workspace aislado listo para ${ctx.ref} en ${workspace.path} (branch ${workspace.branch}).`);
    } catch (err) {
      return {
        outcome: "FAILED",
        note: `No se pudo preparar el workspace aislado para ${ctx.ref}: ${err.message}`
      };
    }

    if (cancelledEarly) {
      return {
        outcome: "RELEASED",
        note: `Orquestación cancelada antes de ejecutar roles: ${cancelReason}.`
      };
    }

    orchestrator = createOrchestrator({
      api,
      runRole: roleRunner,
      resolveQuery,
      queryPollMs,
      sleep,
      maxReworks,
      maxQueryResumes,
      targetState,
      humanOnlyStates,
      newSessionId,
      logger
    });
    if (cancelledEarly) orchestrator.cancel(cancelReason);

    const result = await orchestrator.execute({
      ref: ctx.ref,
      runId: ctx.run?.id,
      ticket: ctx.ticket ?? {},
      branch: ctx.branch,
      workspacePath: workspace.path,
      startState,
      // A recovered execution carries `ctx.recovery` (RAIL-D-00006): the first
      // IMPLEMENTER continues the cycle instead of starting cold.
      recovery: ctx.recovery ?? null
    });

    log(
      `Orquestación de ${ctx.ref}: outcome=${result.outcome}. ` +
        `checks=[${result.checks.join(", ") || "-"}] ` +
        `transiciones=[${result.transitions.map(t => `${t.from}->${t.to}`).join(", ") || "-"}] ` +
        `queries=${result.queries.length} handoffs=${result.handoffs.length}.`
    );
    return mapOrchestrationOutcome(result);
  })();

  return {
    done,
    cancel(reason = "cancelación solicitada") {
      cancelReason = reason;
      cancelledEarly = true;
      if (orchestrator) orchestrator.cancel(reason);
    }
  };
}

export { TRANSITION_PLAN };
