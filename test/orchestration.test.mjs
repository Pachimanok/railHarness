/**
 * Orchestration — RAIL-D-00005 acceptance tests.
 *
 * Fully offline: an in-memory Rail fake, a scripted role runner, an injected
 * workspace preparer. No real Rail, no real adapter, no real `claude`.
 *
 * Coverage (ticket §13 + the three Acceptance Criteria):
 *   - T5-AC-01: CODE_REVIEW / AUTOMATED_TESTS / ACCEPTANCE_CRITERIA recorded
 *               WITH EVIDENCE and BEFORE the gated transition.
 *   - T5-AC-02: a subagent BLOCKED becomes a blocking Agent Query
 *               (question/context/impact) and the advance stops — no invented
 *               answer; governed resume preserves the session.
 *   - T5-AC-03: a humanOnly frontier is a safe hand-off — no fabricated approval.
 *   - RELEASE / FAILED handling, reviewer rework, tester fail, evidence guards,
 *     Rail-rejection fail-safe, cancellation / fencing / idempotent cancel,
 *     secrets & claimToken never crossing to the role runner, Reviewer != Tester,
 *     provider goes through the AdapterRouter, single Rail Run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createOrchestrator,
  createOrchestrationExecution,
  mapOrchestrationOutcome
} from "../src/orchestration/orchestrator.js";
import {
  interpretExecutionResult,
  decisionFor,
  defaultRunRole,
  ROLES
} from "../src/orchestration/roles.js";
import {
  assertCheckEvidence,
  classifyTransition,
  isHumanOnlyRejection,
  createResolvedQueryWaiter,
  RAIL_QUERY_STATUSES,
  isKnownQueryStatus,
  readQueryStatus
} from "../src/orchestration/rail-effects.js";
import { assertNoSecrets } from "../src/contracts/execution-envelope.js";
import { createAdapterRouter } from "../src/adapters/adapter-router.js";
import { createWorkerCore, WORKER_PHASES } from "../src/worker/worker-core.js";

// ── fixtures ────────────────────────────────────────────────────────────

const delay = ms => new Promise(r => setTimeout(r, ms));

const REF = "RAIL-D-00005";
const RUN_ID = "run-1";
const BRANCH = "rail/rail-d-00005";
const WS = "/ws/rail-d-00005";

const TICKET = Object.freeze({
  state: "IN_PROGRESS",
  projectId: "proj-1",
  item: { code: REF, title: "Orquestación de roles" },
  planning: {
    acceptance_criteria: [
      { id: "T5-AC-01", given: "implementación exitosa", when: "review y test", then: "checks antes de transiciones" },
      { id: "T5-AC-02", given: "subagente BLOCKED", when: "devuelve BLOCKED", then: "Agent Query sin inventar respuesta" },
      { id: "T5-AC-03", given: "frontier humanOnly", when: "se alcanza", then: "handoff sin aprobación" }
    ]
  }
});

/** Build an ExecutionResult (the approved adapter contract). */
function er(outcome, extra = {}) {
  return {
    outcome,
    summary: extra.summary ?? `resultado ${outcome} (en español)`,
    question:
      extra.question ?? (outcome === "BLOCKED" ? "¿Qué motor de base de datos uso?" : null),
    context: extra.context ?? (outcome === "BLOCKED" ? "La SPEC no lo fija." : null),
    impact: extra.impact ?? (outcome === "BLOCKED" ? "Cambia el esquema." : null),
    tests: extra.tests ?? (outcome === "IMPLEMENTED" ? ["npm test : PASS"] : []),
    filesChanged: extra.filesChanged ?? ["src/x.js"]
  };
}

/** Deterministic session ids so we can assert independence. */
function seqIds(prefix = "sess") {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/**
 * In-memory Rail fake. Records every governed call in a single ordered log so
 * "check BEFORE transition" is directly assertable.
 */
function fakeRail(impl = {}) {
  const order = [];
  const calls = {
    createCheck: [],
    transition: [],
    createQuery: [],
    addComment: [],
    listQueries: 0
  };
  // Mutable Agent Query store the default query waiter polls via listQueries.
  const queries = [];
  return {
    order,
    calls,
    queries,
    async createCheck(ref, body) {
      calls.createCheck.push({ ref, body });
      order.push(`check:${body.type}`);
      if (impl.createCheck) return impl.createCheck({ ref, body, calls });
      return { id: `chk-${calls.createCheck.length}` };
    },
    async transition(ref, body) {
      calls.transition.push({ ref, body });
      order.push(`transition:${body.to}`);
      if (impl.transition) return impl.transition({ ref, body, calls });
      return { toState: body.to, gateResults: { passed: true, humanOnly: false } };
    },
    async createQuery(ref, body) {
      calls.createQuery.push({ ref, body });
      order.push("query");
      if (impl.createQuery) return impl.createQuery({ ref, body, calls });
      // RailSoft's RailQueryStatus: a fresh blocking query is PENDING (not "OPEN").
      const q = { id: `q-${calls.createQuery.length}`, blocking: true, status: "PENDING", ...body };
      queries.push(q);
      return { id: q.id, blocking: true };
    },
    async listQueries() {
      calls.listQueries += 1;
      if (impl.listQueries) return impl.listQueries({ calls, queries });
      return { queries: queries.map(q => ({ ...q })) };
    },
    async addComment(ref, content) {
      calls.addComment.push({ ref, content });
      order.push("comment");
      return { ok: true };
    }
  };
}

/**
 * Scripted role runner. `steps` is consumed in order; each is
 * `{ role?, result?: ExecutionResult, throw?: Error }`. Records every call's
 * args so we can assert on the envelope / that no secret crossed.
 */
function scriptedRunRole(steps) {
  const seen = [];
  let i = 0;
  const fn = async args => {
    seen.push({ ...args, argKeys: Object.keys(args) });
    const step = steps[i++];
    if (!step) throw new Error(`role runner: sin paso programado para la llamada #${i} (${args.role})`);
    if (step.role && step.role !== args.role) {
      throw new Error(`role runner: esperaba ${step.role}, recibí ${args.role}`);
    }
    if (step.throw) throw step.throw;
    return interpretExecutionResult(args.role, step.result, args.envelope.session.id);
  };
  fn.seen = seen;
  return fn;
}

function makeOrch(runRole, { api = fakeRail(), orchOpts = {}, execOpts = {} } = {}) {
  const orch = createOrchestrator({
    api,
    runRole,
    newSessionId: seqIds(),
    now: () => 0,
    logger: () => {},
    ...orchOpts
  });
  const run = () =>
    orch.execute({
      ref: REF,
      runId: RUN_ID,
      ticket: TICKET,
      branch: BRANCH,
      workspacePath: WS,
      startState: "IN_PROGRESS",
      ...execOpts
    });
  return { api, orch, run };
}

const HAPPY = [
  { role: "IMPLEMENTER", result: er("IMPLEMENTED", { filesChanged: ["src/a.js", "src/b.js"] }) },
  { role: "REVIEWER", result: er("IMPLEMENTED") },
  { role: "TESTER", result: er("IMPLEMENTED", { tests: ["npm test : PASS", "npm run lint : PASS"] }) }
];

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────

test("decisionFor: RELEASE is REWORK for reviewer/tester, RELEASE for implementer", () => {
  assert.equal(decisionFor(ROLES.IMPLEMENTER, "RELEASE"), "RELEASE");
  assert.equal(decisionFor(ROLES.REVIEWER, "RELEASE"), "REWORK");
  assert.equal(decisionFor(ROLES.TESTER, "RELEASE"), "REWORK");
  assert.equal(decisionFor(ROLES.IMPLEMENTER, "IMPLEMENTED"), "PASS");
  assert.equal(decisionFor(ROLES.REVIEWER, "BLOCKED"), "BLOCKED");
  assert.equal(decisionFor(ROLES.TESTER, "FAILED"), "FAILED");
});

test("interpretExecutionResult rejects a non-ExecutionResult (never guesses)", () => {
  assert.throws(
    () => interpretExecutionResult(ROLES.REVIEWER, { outcome: "NOPE" }),
    /ExecutionResult inválido/
  );
});

test("assertCheckEvidence: refuses a PASS without real evidence", () => {
  assert.throws(() => assertCheckEvidence("AUTOMATED_TESTS", { tests: [] }), /ORCH_INSUFFICIENT_EVIDENCE|evidencia válida/);
  assert.throws(() => assertCheckEvidence("CODE_REVIEW", { summary: "x", reviewerDecision: "REWORK" }), /Reviewer no es PASS/);
  assert.throws(
    () => assertCheckEvidence("ACCEPTANCE_CRITERIA", { acceptanceCriteria: [{ id: "A", status: "FAIL" }] }),
    /no está en PASS/
  );
  assert.doesNotThrow(() =>
    assertCheckEvidence("ACCEPTANCE_CRITERIA", { acceptanceCriteria: [{ id: "A", status: "PASS" }] })
  );
});

test("classifyTransition / isHumanOnlyRejection", () => {
  assert.equal(classifyTransition({ toState: "REVIEWING" }, "REVIEWING").applied, true);
  assert.equal(classifyTransition({ gateResults: { passed: false } }, "REVIEWING").applied, false);
  const ho = classifyTransition({ gateResults: { passed: false, humanOnly: true } }, "SANDBOX_READY");
  assert.equal(ho.applied, false);
  assert.equal(ho.humanOnly, true);
  assert.equal(isHumanOnlyRejection({ code: "HUMAN_APPROVAL_REQUIRED" }), true);
  assert.equal(isHumanOnlyRejection({ status: 409, code: "CONFLICT" }), false);
});

// ─────────────────────────────────────────────────────────────────────────
// T5-AC-01 — checks WITH EVIDENCE, BEFORE the gated transitions
// ─────────────────────────────────────────────────────────────────────────

test("T5-AC-01: happy path records checks before each gated transition, in order", async () => {
  const runRole = scriptedRunRole(HAPPY);
  const { api, run } = makeOrch(runRole);
  const result = await run();

  assert.equal(result.outcome, "COMPLETED");
  assert.deepEqual(api.order, [
    "check:IMPLEMENTATION",
    "transition:REVIEWING",
    "check:CODE_REVIEW",
    "transition:TESTING",
    "check:AUTOMATED_TESTS",
    "check:ACCEPTANCE_CRITERIA",
    "transition:SANDBOX_READY"
  ]);
  assert.deepEqual(result.checks, [
    "IMPLEMENTATION",
    "CODE_REVIEW",
    "AUTOMATED_TESTS",
    "ACCEPTANCE_CRITERIA"
  ]);
  assert.deepEqual(
    result.transitions.map(t => `${t.from}->${t.to}`),
    ["IN_PROGRESS->REVIEWING", "REVIEWING->TESTING", "TESTING->SANDBOX_READY"]
  );
});

test("T5-AC-01: every check carries PASS + runId + real evidence in the note, never a claimToken", async () => {
  const runRole = scriptedRunRole(HAPPY);
  const { api, run } = makeOrch(runRole);
  await run();

  for (const { body } of api.calls.createCheck) {
    assert.equal(body.status, "PASS");
    assert.equal(body.runId, RUN_ID);
    assert.ok(!("claimToken" in body), "el check no lleva claimToken");
    assert.ok(typeof body.note === "string" && /evidencia:/.test(body.note), `note con evidencia: ${body.note}`);
  }
  const byType = Object.fromEntries(api.calls.createCheck.map(c => [c.body.type, c.body.note]));
  assert.match(byType.AUTOMATED_TESTS, /npm test : PASS/);
  assert.match(byType.ACCEPTANCE_CRITERIA, /T5-AC-01=PASS/);
  assert.match(byType.ACCEPTANCE_CRITERIA, /T5-AC-03=PASS/);
});

test("T5-AC-01: from CLAIMED the orchestrator itself runs the governed CLAIMED -> IN_PROGRESS", async () => {
  const runRole = scriptedRunRole(HAPPY);
  const { api, run } = makeOrch(runRole, { execOpts: { startState: "CLAIMED" } });
  const result = await run();
  assert.equal(result.outcome, "COMPLETED");
  assert.equal(api.calls.transition[0].body.to, "IN_PROGRESS");
  assert.equal(api.order[0], "transition:IN_PROGRESS");
});

// ─────────────────────────────────────────────────────────────────────────
// T5-AC-02 — BLOCKED -> Agent Query, advance stops, no invented answer
// ─────────────────────────────────────────────────────────────────────────

test("T5-AC-02: a subagent BLOCKED raises a blocking Agent Query and the execution stays PENDING (no invented answer, no finishRun)", async () => {
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("BLOCKED", { question: "¿Postgres o MySQL?", context: "SPEC muda", impact: "esquema" }) }
  ]);
  // Default waiter: polls listQueries; the query stays PENDING => never resolves.
  const { api, orch, run } = makeOrch(runRole, {
    orchOpts: { sleep: ms => new Promise(r => setTimeout(r, ms)), queryPollMs: 1 }
  });
  const p = run();

  // The blocking Agent Query is created with the role's own question/context/impact.
  await delay(20);
  assert.equal(api.calls.createQuery.length, 1);
  const q = api.calls.createQuery[0].body;
  assert.equal(q.question, "¿Postgres o MySQL?");
  assert.equal(q.context, "SPEC muda");
  assert.equal(q.impact, "esquema");
  assert.equal(q.blocking, true);
  assert.equal(q.runId, RUN_ID);
  assert.ok(!("claimToken" in q));

  // Nothing fabricated; the advance stopped.
  assert.equal(api.calls.createCheck.length, 0, "no se creó ningún check");
  assert.equal(api.calls.transition.length, 0, "no se pidió ninguna transición");
  assert.ok(api.calls.listQueries > 0, "poll gobernado de la Agent Query");

  // The execution Promise MUST stay pending while the query is open — that is
  // exactly what lets the Worker Core keep heartbeating and not finishRun.
  const settled = await Promise.race([
    p.then(() => "settled"),
    delay(30).then(() => "pending")
  ]);
  assert.equal(settled, "pending", "execute() sigue pending mientras la query está abierta");

  // Only a cancel (fencing / shutdown) settles it.
  orch.cancel("fin de test");
  const result = await p;
  assert.equal(result.outcome, "CANCELLED");
});

test("T5-AC-02: a governed answer resumes the SAME adapter session (continuation, no new task)", async () => {
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("BLOCKED") },
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);
  const { api, run } = makeOrch(runRole, {
    orchOpts: { resolveQuery: async () => "usá PostgreSQL" }
  });
  const result = await run();

  assert.equal(result.outcome, "COMPLETED");
  assert.equal(api.calls.createQuery.length, 1);

  const call1 = runRole.seen[0];
  const call2 = runRole.seen[1];
  assert.equal(call1.role, "IMPLEMENTER");
  assert.equal(call1.envelope.resumeAnswer, null);
  assert.equal(call2.role, "IMPLEMENTER");
  assert.equal(call2.envelope.resumeAnswer, "usá PostgreSQL", "la respuesta humana viaja al adapter");
  assert.equal(
    call2.envelope.session.id,
    call1.envelope.session.id,
    "misma sesión: es una continuación, no una tarea nueva"
  );
  assert.ok(result.timeline.some(e => e.kind === "resume"));
});

test("T5-AC-02: a repeated governed answer that never unblocks stops (does not loop forever)", async () => {
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("BLOCKED") },
    { role: "IMPLEMENTER", result: er("BLOCKED") }
  ]);
  const { run } = makeOrch(runRole, {
    orchOpts: { resolveQuery: async () => "respuesta que no ayuda", maxQueryResumes: 1 }
  });
  const result = await run();
  assert.equal(result.outcome, "BLOCKED");
});

test("Rail rejecting the Agent Query is respected: advance stops, no invented answer", async () => {
  const api = fakeRail({
    createQuery: () => {
      const e = new Error("queries deshabilitadas");
      e.status = 403;
      throw e;
    }
  });
  const runRole = scriptedRunRole([{ role: "IMPLEMENTER", result: er("BLOCKED") }]);
  const { run } = makeOrch(runRole, { api });
  const result = await run();
  assert.equal(result.outcome, "FAILED");
  assert.equal(api.calls.transition.length, 0);
  assert.equal(api.calls.createCheck.length, 0);
  assert.match(result.note, /Rail rechazó/i);
});

// ─────────────────────────────────────────────────────────────────────────
// T5-AC-03 — humanOnly frontier: safe hand-off, no fabricated approval
// ─────────────────────────────────────────────────────────────────────────

test("T5-AC-03: Rail marking a transition humanOnly => HANDOFF, evidence kept, no approval fabricated", async () => {
  const api = fakeRail({
    transition: ({ body }) =>
      body.to === "SANDBOX_READY"
        ? { gateResults: { passed: false, humanOnly: true } }
        : { toState: body.to, gateResults: { passed: true } }
  });
  const runRole = scriptedRunRole(HAPPY);
  const { run } = makeOrch(runRole, { api });
  const result = await run();

  assert.equal(result.outcome, "HANDOFF");
  // Evidence for the tester gate was still recorded (it is legitimate).
  const types = api.calls.createCheck.map(c => c.body.type);
  assert.ok(types.includes("AUTOMATED_TESTS") && types.includes("ACCEPTANCE_CRITERIA"));
  // No approval-shaped check was ever created.
  assert.ok(!types.some(t => /APPROV/i.test(t)), "no se fabricó un check de aprobación");
  // The transition was requested exactly once — not forced / retried.
  assert.equal(api.calls.transition.filter(t => t.body.to === "SANDBOX_READY").length, 1);
  // A governed, factual note was left for the human.
  assert.ok(api.calls.addComment.length >= 1);
  assert.match(result.note, /no se fabricó ninguna aprobación/i);
});

test("T5-AC-03: a configured humanOnly state => HANDOFF without even requesting the transition", async () => {
  const runRole = scriptedRunRole(HAPPY);
  const { api, run } = makeOrch(runRole, {
    orchOpts: { humanOnlyStates: ["SANDBOX_READY"] }
  });
  const result = await run();

  assert.equal(result.outcome, "HANDOFF");
  assert.equal(
    api.calls.transition.filter(t => t.body.to === "SANDBOX_READY").length,
    0,
    "no se pide una transición hacia un estado humanOnly"
  );
  const types = api.calls.createCheck.map(c => c.body.type);
  assert.ok(types.includes("AUTOMATED_TESTS") && types.includes("ACCEPTANCE_CRITERIA"));
  assert.ok(api.calls.addComment.length >= 1);
});

// ─────────────────────────────────────────────────────────────────────────
// RELEASE / FAILED
// ─────────────────────────────────────────────────────────────────────────

test("IMPLEMENTER RELEASE => RELEASED, no checks, no transitions, no query", async () => {
  const runRole = scriptedRunRole([{ role: "IMPLEMENTER", result: er("RELEASE") }]);
  const { api, run } = makeOrch(runRole);
  const result = await run();
  assert.equal(result.outcome, "RELEASED");
  assert.equal(api.calls.createCheck.length, 0);
  assert.equal(api.calls.transition.length, 0);
  assert.equal(api.calls.createQuery.length, 0);
});

test("IMPLEMENTER FAILED (technical) => FAILED, nothing mutated", async () => {
  const runRole = scriptedRunRole([{ role: "IMPLEMENTER", result: er("FAILED") }]);
  const { api, run } = makeOrch(runRole);
  const result = await run();
  assert.equal(result.outcome, "FAILED");
  assert.equal(api.calls.createCheck.length, 0);
  assert.equal(api.calls.transition.length, 0);
});

test("a role runner that throws => FAILED (technical), not a fake IMPLEMENTED", async () => {
  const runRole = scriptedRunRole([{ role: "IMPLEMENTER", throw: new Error("spawn ENOENT") }]);
  const { api, run } = makeOrch(runRole);
  const result = await run();
  assert.equal(result.outcome, "FAILED");
  assert.equal(api.calls.createCheck.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// Reviewer rework
// ─────────────────────────────────────────────────────────────────────────

test("Reviewer FAIL => rework to the IMPLEMENTER (RECOVERY, same session); no CODE_REVIEW PASS until it passes", async () => {
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
    { role: "REVIEWER", result: er("RELEASE", { summary: "falta manejar el caso vacío" }) },
    { role: "IMPLEMENTER", result: er("IMPLEMENTED", { summary: "corregido el caso vacío" }) },
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);
  const { api, run } = makeOrch(runRole);
  const result = await run();

  assert.equal(result.outcome, "COMPLETED");
  assert.equal(
    api.calls.createCheck.filter(c => c.body.type === "CODE_REVIEW").length,
    1,
    "CODE_REVIEW PASS sólo tras la revisión aprobada"
  );
  assert.equal(
    api.calls.createCheck.filter(c => c.body.type === "IMPLEMENTATION").length,
    2,
    "IMPLEMENTATION registrado en el intento inicial y en el rework"
  );
  // The 3rd role call is the rework: RECOVERY, continuation, same impl session.
  const rework = runRole.seen[2];
  assert.equal(rework.role, "IMPLEMENTER");
  assert.equal(rework.envelope.kind, "RECOVERY");
  assert.equal(rework.envelope.continuation.failedReviewNote, "falta manejar el caso vacío");
  assert.equal(rework.envelope.session.id, runRole.seen[0].envelope.session.id);
  // Defect 1: a GOVERNED rewind REVIEWING -> IN_PROGRESS happened BEFORE the
  // IMPLEMENTER re-ran, and it was requested exactly once.
  const rewind = api.calls.transition.filter(t => t.body.to === "IN_PROGRESS");
  assert.equal(rewind.length, 1, "un único rewind gobernado REVIEWING -> IN_PROGRESS");
  const rewindIdx = api.order.indexOf("transition:IN_PROGRESS");
  const reworkImplIdx = api.order.lastIndexOf("check:IMPLEMENTATION");
  assert.ok(rewindIdx !== -1 && rewindIdx < reworkImplIdx, "el rewind precede a la nueva evidencia");
  // Full governed order: initial REVIEWING, rewind, re-REVIEWING, TESTING, SANDBOX_READY.
  assert.deepEqual(
    api.calls.transition.map(t => t.body.to),
    ["REVIEWING", "IN_PROGRESS", "REVIEWING", "TESTING", "SANDBOX_READY"]
  );
});

test("Reviewer FAIL beyond the rework budget => FAILED, no CODE_REVIEW PASS, no advance to TESTING", async () => {
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
    { role: "REVIEWER", result: er("RELEASE") },
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
    { role: "REVIEWER", result: er("RELEASE") }
  ]);
  const { api, run } = makeOrch(runRole, { orchOpts: { maxReworks: 1 } });
  const result = await run();

  assert.equal(result.outcome, "FAILED");
  assert.equal(api.calls.createCheck.filter(c => c.body.type === "CODE_REVIEW").length, 0);
  assert.equal(api.calls.transition.filter(t => t.body.to === "TESTING").length, 0);
  assert.match(result.note, /NO se crea CODE_REVIEW PASS/);
});

// ─────────────────────────────────────────────────────────────────────────
// Tester fail / evidence guards
// ─────────────────────────────────────────────────────────────────────────

test("Tester FAIL beyond budget => FAILED; no AUTOMATED_TESTS/ACCEPTANCE_CRITERIA PASS, no SANDBOX_READY", async () => {
  // A TESTER rework goes through a governed rewind + a fresh REVIEWER before the
  // TESTER is retried (Defect 1); the 2nd TESTER FAIL is over the budget.
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("RELEASE", { summary: "3 tests en rojo" }) },
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("RELEASE", { summary: "sigue 1 test en rojo" }) }
  ]);
  const { api, run } = makeOrch(runRole, { orchOpts: { maxReworks: 1 } });
  const result = await run();

  assert.equal(result.outcome, "FAILED");
  const types = api.calls.createCheck.map(c => c.body.type);
  assert.ok(!types.includes("AUTOMATED_TESTS"));
  assert.ok(!types.includes("ACCEPTANCE_CRITERIA"));
  assert.equal(api.calls.transition.filter(t => t.body.to === "SANDBOX_READY").length, 0);
  // The governed rewind TESTING -> IN_PROGRESS did happen (once).
  assert.equal(api.calls.transition.filter(t => t.body.to === "IN_PROGRESS").length, 1);
});

test("Tester PASS but NO tests actually run => checks NOT created, no advance (evidence guard)", async () => {
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("IMPLEMENTED", { tests: [] }) }
  ]);
  const { api, run } = makeOrch(runRole);
  const result = await run();

  assert.equal(result.outcome, "FAILED");
  const types = api.calls.createCheck.map(c => c.body.type);
  assert.ok(!types.includes("AUTOMATED_TESTS"), "sin comandos de test no se crea AUTOMATED_TESTS");
  assert.ok(!types.includes("ACCEPTANCE_CRITERIA"));
  assert.equal(api.calls.transition.filter(t => t.body.to === "SANDBOX_READY").length, 0);
  assert.match(result.note, /evidencia válida/i);
});

// ─────────────────────────────────────────────────────────────────────────
// DEFECT 1 — REWORK con rewind gobernado (REVIEWING/TESTING -> IN_PROGRESS)
// ─────────────────────────────────────────────────────────────────────────

test("DEFECT 1 — REVIEWER REWORK: governed REVIEWING -> IN_PROGRESS BEFORE the IMPLEMENTER re-runs", async () => {
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
    { role: "REVIEWER", result: er("RELEASE", { summary: "hallazgo a corregir" }) },
    { role: "IMPLEMENTER", result: er("IMPLEMENTED", { summary: "corregido" }) },
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);
  const { api, run } = makeOrch(runRole);
  const result = await run();

  assert.equal(result.outcome, "COMPLETED");
  // The rework IMPLEMENTER call only happens AFTER Rail accepted the rewind.
  const rewindOrder = api.order.indexOf("transition:IN_PROGRESS");
  const reworkImpl = api.order.indexOf("check:IMPLEMENTATION", api.order.indexOf("transition:REVIEWING") + 1);
  assert.ok(rewindOrder !== -1, "hubo un rewind gobernado REVIEWING -> IN_PROGRESS");
  assert.ok(rewindOrder < reworkImpl, "el rewind precede a la nueva evidencia IMPLEMENTATION");
  assert.deepEqual(
    api.calls.transition.map(t => t.body.to),
    ["REVIEWING", "IN_PROGRESS", "REVIEWING", "TESTING", "SANDBOX_READY"]
  );
  // The rewind carries runId and never a claimToken.
  const rewind = api.calls.transition.find(t => t.body.to === "IN_PROGRESS");
  assert.equal(rewind.body.runId, RUN_ID);
  assert.ok(!/claimToken/i.test(JSON.stringify(rewind.body)));
});

test("DEFECT 1 — TESTER REWORK: governed TESTING -> IN_PROGRESS, then IMPLEMENTER, then a FRESH REVIEWER before the TESTER retries", async () => {
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("RELEASE", { summary: "1 test en rojo" }) },
    { role: "IMPLEMENTER", result: er("IMPLEMENTED", { summary: "test arreglado" }) },
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);
  const { api, run } = makeOrch(runRole);
  const result = await run();

  assert.equal(result.outcome, "COMPLETED");
  // Two independent REVIEWER passes and two TESTER passes — re-review is mandatory.
  assert.equal(runRole.seen.filter(s => s.role === "REVIEWER").length, 2);
  assert.equal(runRole.seen.filter(s => s.role === "TESTER").length, 2);
  const reviewerSessions = new Set(
    runRole.seen.filter(s => s.role === "REVIEWER").map(s => s.envelope.session.id)
  );
  assert.equal(reviewerSessions.size, 2, "cada REVIEWER es una sesión fresca e independiente");
  // Governed transition order: forward, rewind from TESTING, forward again.
  assert.deepEqual(
    api.calls.transition.map(t => t.body.to),
    ["REVIEWING", "TESTING", "IN_PROGRESS", "REVIEWING", "TESTING", "SANDBOX_READY"]
  );
  // The rework IMPLEMENTER used the SAME implementer session (continuation).
  const implSessions = new Set(
    runRole.seen.filter(s => s.role === "IMPLEMENTER").map(s => s.envelope.session.id)
  );
  assert.equal(implSessions.size, 1, "el IMPLEMENTER del rework es una continuación (misma sesión)");
  const reworkImpl = runRole.seen.filter(s => s.role === "IMPLEMENTER")[1];
  assert.equal(reworkImpl.envelope.kind, "RECOVERY");
});

test("DEFECT 1 — Rail REJECTS the rewind: no IMPLEMENTER re-run, no IMPLEMENTATION PASS after, FAILED (nothing invented)", async () => {
  const api = fakeRail({
    transition: ({ body }) => {
      if (body.to === "IN_PROGRESS") {
        const e = new Error("rewind no permitido por el gate");
        e.status = 409;
        e.code = "GATE_NOT_MET";
        throw e;
      }
      return { toState: body.to };
    }
  });
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
    { role: "REVIEWER", result: er("RELEASE", { summary: "hay que corregir" }) },
    // A 3rd step exists but must NEVER be consumed.
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") }
  ]);
  const { run } = makeOrch(runRole, { api });
  const result = await run();

  assert.equal(result.outcome, "FAILED");
  assert.equal(runRole.seen.length, 2, "el IMPLEMENTER NO se volvió a ejecutar");
  assert.equal(
    api.calls.createCheck.filter(c => c.body.type === "IMPLEMENTATION").length,
    1,
    "no se publicó una segunda IMPLEMENTATION PASS"
  );
  assert.equal(api.calls.createCheck.filter(c => c.body.type === "CODE_REVIEW").length, 0);
  assert.equal(api.calls.transition.filter(t => t.body.to === "TESTING").length, 0);
  assert.match(result.note, /rewind REVIEWING → IN_PROGRESS/);
  assert.match(result.note, /NO se ejecuta el IMPLEMENTER/);
});

// ─────────────────────────────────────────────────────────────────────────
// DEFECT 2 — happy path finishes the Run COMPLETED; real RELEASE stays RELEASED
// ─────────────────────────────────────────────────────────────────────────

test("DEFECT 2 — happy path: orchestration COMPLETED maps to a COMPLETED Run", async () => {
  const runRole = scriptedRunRole(HAPPY);
  const { run } = makeOrch(runRole);
  const result = await run();
  assert.equal(result.outcome, "COMPLETED");
  assert.equal(mapOrchestrationOutcome(result).outcome, "COMPLETED");
});

test("DEFECT 2 — a genuine RELEASE still finishes the Run RELEASED (only where it corresponds)", async () => {
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("RELEASE", { summary: "el ticket/repo no corresponde" }) }
  ]);
  const { run } = makeOrch(runRole);
  const result = await run();
  assert.equal(result.outcome, "RELEASED");
  assert.equal(mapOrchestrationOutcome(result).outcome, "RELEASED");
});

test("DEFECT 2 — a HANDOFF does NOT map to RELEASED (it is a COMPLETED automated Run at a valid frontier)", async () => {
  const runRole = scriptedRunRole(HAPPY);
  const { run } = makeOrch(runRole, { orchOpts: { humanOnlyStates: ["SANDBOX_READY"] } });
  const result = await run();
  assert.equal(result.outcome, "HANDOFF");
  assert.equal(mapOrchestrationOutcome(result).outcome, "COMPLETED");
});

// ─────────────────────────────────────────────────────────────────────────
// DEFECT 3 — BLOCKED does not finish the Run; a resolved query resumes it
// ─────────────────────────────────────────────────────────────────────────

test("DEFECT 3 — the default query waiter polls listQueries and resolves ONLY on a real RESOLVED status", async () => {
  const api = fakeRail();
  // The role blocks once, then (after the query resolves) passes the whole flow.
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("BLOCKED", { question: "¿qué motor?" }) },
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);
  const { orch, run } = makeOrch(runRole, {
    api,
    orchOpts: { sleep: ms => new Promise(r => setTimeout(r, ms)), queryPollMs: 1 }
  });
  const p = run();

  // Poll a few times while the query is PENDING — nothing resumes.
  await delay(20);
  assert.equal(api.calls.createQuery.length, 1);
  assert.ok(api.calls.listQueries >= 1);
  assert.equal(runRole.seen.length, 1, "sigue bloqueado: no se reanudó el rol");

  // A human resolves it with an answer -> the SAME role resumes.
  api.queries[0].status = "RESOLVED";
  api.queries[0].answer = "usá PostgreSQL";
  const result = await p;

  assert.equal(result.outcome, "COMPLETED");
  const resumed = runRole.seen[1];
  assert.equal(resumed.role, "IMPLEMENTER");
  assert.equal(resumed.envelope.resumeAnswer, "usá PostgreSQL");
  assert.equal(
    resumed.envelope.session.id,
    runRole.seen[0].envelope.session.id,
    "misma session.id: es una continuación, no una tarea nueva"
  );
  void orch;
});

test("DEFECT 3 — cancel while waiting for the Agent Query => CANCELLED, no further Rail effects", async () => {
  const api = fakeRail();
  const runRole = scriptedRunRole([{ role: "IMPLEMENTER", result: er("BLOCKED") }]);
  const { orch, run } = makeOrch(runRole, {
    api,
    orchOpts: { sleep: ms => new Promise(r => setTimeout(r, ms)), queryPollMs: 1 }
  });
  const p = run();
  await delay(20);
  assert.equal(api.calls.createQuery.length, 1);

  orch.cancel("ownership perdido (fencing)");
  const result = await p;

  assert.equal(result.outcome, "CANCELLED");
  assert.equal(api.calls.createCheck.length, 0);
  assert.equal(api.calls.transition.length, 0);
});

test("DEFECT 3 (E2E) — while the blocking query is open the Worker Core keeps the Run: finishRun NOT called, heartbeat still Core-owned; resolution finishes COMPLETED", async () => {
  const isoIn = ms => new Date(Date.now() + ms).toISOString();
  const rail = fakeRail();
  const wcCalls = { heartbeat: 0, finishRun: [], claim: 0 };
  const ticketDetail = { ...TICKET, state: "READY", activeRun: null };

  let gateResolve;
  const gate = new Promise(r => {
    gateResolve = r;
  });

  const api = {
    ...rail,
    async listProjects() {
      return { items: [{ id: "proj-1" }] };
    },
    async listReady() {
      return wcCalls.claim === 0 ? { items: [{ item: ticketDetail.item }] } : { items: [] };
    },
    async getTicket() {
      return ticketDetail;
    },
    async claim() {
      wcCalls.claim += 1;
      return { run: { id: RUN_ID, claimToken: "CT-secret", leaseExpiresAt: isoIn(30 * 60_000) } };
    },
    async heartbeat() {
      wcCalls.heartbeat += 1;
      return { leaseExpiresAt: isoIn(30 * 60_000) };
    },
    async finishRun(runId, payload) {
      wcCalls.finishRun.push({ runId, payload });
      return { ok: true };
    }
  };

  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("BLOCKED", { question: "¿motor?" }) },
    { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);

  let hbCallback = null;
  let worker;
  worker = createWorkerCore({
    api,
    projectId: "proj-1",
    createExecution: ctx =>
      createOrchestrationExecution(ctx, {
        api,
        runRole,
        // A governed resolver the test controls: stays pending until `gate`.
        resolveQuery: async () => gate,
        prepareWorkspace: fakePrepareWorkspace(),
        workspaceRoot: "/root",
        repoPath: "/repo",
        logger: () => {}
      }),
    sleep: async () => worker.requestStop("fin de test"),
    setIntervalFn: cb => {
      hbCallback = cb;
      return { unref() {} };
    },
    clearIntervalFn: () => {},
    logger: () => {}
  });

  const startP = worker.start();

  // Wait until the orchestration is blocked on the Agent Query.
  for (let i = 0; i < 100 && rail.calls.createQuery.length === 0; i += 1) await delay(5);
  assert.equal(rail.calls.createQuery.length, 1, "se creó exactamente una Agent Query bloqueante");

  // The Run is NOT finished while the query is open, and ownership is Core-owned.
  assert.equal(wcCalls.finishRun.length, 0, "finishRun NO se llamó mientras la query está abierta");
  assert.equal(worker.getState().phase, WORKER_PHASES.EXECUTING);
  assert.equal(worker.getState().activeRunId, RUN_ID);
  assert.ok(typeof hbCallback === "function", "el supervisor de heartbeat quedó armado");
  hbCallback();
  await delay(5);
  assert.ok(wcCalls.heartbeat >= 1, "el Worker Core sigue haciendo heartbeat");

  // A governed answer arrives -> resume same session, flow completes.
  gateResolve("usá PostgreSQL");
  await startP;

  assert.equal(wcCalls.claim, 1, "un único claim / un único Run");
  assert.equal(wcCalls.finishRun.length, 1);
  assert.equal(wcCalls.finishRun[0].payload.outcome, "COMPLETED");
  const resumed = runRole.seen[1];
  assert.equal(resumed.envelope.resumeAnswer, "usá PostgreSQL");
  assert.equal(resumed.envelope.session.id, runRole.seen[0].envelope.session.id);
  assert.equal(resumed.role, "IMPLEMENTER");
});

// ─────────────────────────────────────────────────────────────────────────
// Rail rejection fail-safe
// ─────────────────────────────────────────────────────────────────────────

test("Rail rejecting a (non-human) transition is respected: FAILED, not forced, not retried", async () => {
  const api = fakeRail({
    transition: ({ body }) => {
      if (body.to === "REVIEWING") {
        const e = new Error("gate no cumplido");
        e.status = 409;
        e.code = "GATE_NOT_MET";
        e.missing = ["SMOKE_TEST"];
        throw e;
      }
      return { toState: body.to };
    }
  });
  const runRole = scriptedRunRole(HAPPY);
  const { run } = makeOrch(runRole, { api });
  const result = await run();

  assert.equal(result.outcome, "FAILED");
  assert.equal(api.calls.createCheck.filter(c => c.body.type === "IMPLEMENTATION").length, 1);
  assert.equal(api.calls.transition.filter(t => t.body.to === "REVIEWING").length, 1, "no se reintenta");
  assert.match(result.note, /Se respeta el rechazo/i);
});

test("Rail rejecting a check is respected: FAILED, no forced success, no onward transition", async () => {
  const api = fakeRail({
    createCheck: ({ body }) => {
      if (body.type === "CODE_REVIEW") {
        const e = new Error("check rechazado");
        e.status = 422;
        throw e;
      }
      return { id: "chk" };
    }
  });
  const runRole = scriptedRunRole(HAPPY);
  const { run } = makeOrch(runRole, { api });
  const result = await run();

  assert.equal(result.outcome, "FAILED");
  assert.equal(api.calls.transition.filter(t => t.body.to === "TESTING").length, 0);
  assert.match(result.note, /Rail rechazó el check CODE_REVIEW/);
});

// ─────────────────────────────────────────────────────────────────────────
// Security: no secret / claimToken ever crosses to the role runner
// ─────────────────────────────────────────────────────────────────────────

test("no claimToken / secret reaches the role runner; the seam only gets { role, envelope, signal }", async () => {
  const taintedTicket = {
    ...TICKET,
    claimToken: "CT-super-secret",
    authorization: "Bearer rag_secret",
    detail: { token: "rag_nested_secret" }
  };
  const runRole = scriptedRunRole(HAPPY);
  const orch = createOrchestrator({ api: fakeRail(), runRole, newSessionId: seqIds(), logger: () => {} });
  await orch.execute({
    ref: REF,
    runId: RUN_ID,
    ticket: taintedTicket,
    branch: BRANCH,
    workspacePath: WS,
    startState: "IN_PROGRESS"
  });

  for (const call of runRole.seen) {
    assert.deepEqual(call.argKeys.sort(), ["envelope", "role", "signal"]);
    assert.doesNotThrow(() => assertNoSecrets(call.envelope), "el envelope no contiene claves secretas");
    const wire = JSON.stringify(call.envelope);
    assert.ok(!wire.includes("CT-super-secret"));
    assert.ok(!wire.includes("rag_secret"));
    assert.ok(!wire.includes("rag_nested_secret"));
    assert.ok(!("claimToken" in call), "el runner no recibe un claimToken");
    assert.ok(!("api" in call), "el runner no recibe el cliente Rail");
  }
});

test("every governed Rail call carries runId and never a claimToken", async () => {
  const runRole = scriptedRunRole(HAPPY);
  const { api, run } = makeOrch(runRole);
  await run();
  for (const c of [...api.calls.createCheck, ...api.calls.transition, ...api.calls.createQuery]) {
    assert.equal(c.body.runId, RUN_ID);
    assert.ok(!("claimToken" in c.body));
    assert.ok(!/claimToken/i.test(JSON.stringify(c.body)));
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Reviewer != Tester ; provider via AdapterRouter
// ─────────────────────────────────────────────────────────────────────────

test("Reviewer and Tester are independent: distinct roles, distinct fresh sessions", async () => {
  const runRole = scriptedRunRole(HAPPY);
  const { run } = makeOrch(runRole);
  await run();

  const [impl, review, tester] = runRole.seen;
  assert.equal(impl.envelope.role, "IMPLEMENTER");
  assert.equal(review.envelope.role, "REVIEWER");
  assert.equal(tester.envelope.role, "TESTER");
  const ids = new Set([impl.envelope.session.id, review.envelope.session.id, tester.envelope.session.id]);
  assert.equal(ids.size, 3, "tres sesiones distintas");
  // The Reviewer never gets write tools; the envelope says so via role.
  assert.notEqual(review.envelope.role, tester.envelope.role);
});

test("every role runs through the AdapterRouter (provider-independent), no secret crosses it", async () => {
  const seen = [];
  const fakeAdapter = {
    provider: "fake",
    preflight() {},
    run(envelope) {
      seen.push(envelope.role);
      return Promise.resolve({
        sessionId: envelope.session.id,
        result: er("IMPLEMENTED", { tests: ["npm test : PASS"] })
      });
    }
  };
  const router = createAdapterRouter({ provider: "fake", adapters: { fake: fakeAdapter } });
  const runRole = defaultRunRole({ adapterRouter: router });
  const { run } = makeOrch(runRole);
  const result = await run();

  assert.equal(result.outcome, "COMPLETED");
  assert.deepEqual(seen, ["IMPLEMENTER", "REVIEWER", "TESTER"]);
});

// ─────────────────────────────────────────────────────────────────────────
// Cancellation / fencing / idempotent cancel
// ─────────────────────────────────────────────────────────────────────────

test("cancel mid-flow: no further checks / transitions / queries; outcome CANCELLED", async () => {
  const api = fakeRail();
  let orchRef;
  const runRole = async ({ role, envelope }) => {
    if (role === "IMPLEMENTER") orchRef.cancel("ownership perdido (fencing)");
    return interpretExecutionResult(role, er("IMPLEMENTED"), envelope.session.id);
  };
  orchRef = createOrchestrator({ api, runRole, newSessionId: seqIds(), logger: () => {} });
  const result = await orchRef.execute({
    ref: REF,
    runId: RUN_ID,
    ticket: TICKET,
    branch: BRANCH,
    workspacePath: WS,
    startState: "IN_PROGRESS"
  });

  assert.equal(result.outcome, "CANCELLED");
  assert.equal(api.calls.createCheck.length, 0);
  assert.equal(api.calls.transition.length, 0);
  assert.equal(api.calls.createQuery.length, 0);
});

test("cancel before execute: zero role runs, zero Rail effects", async () => {
  const api = fakeRail();
  let ran = 0;
  const runRole = async ({ role, envelope }) => {
    ran += 1;
    return interpretExecutionResult(role, er("IMPLEMENTED"), envelope.session.id);
  };
  const orch = createOrchestrator({ api, runRole, newSessionId: seqIds(), logger: () => {} });
  orch.cancel("fencing");
  orch.cancel("fencing"); // idempotent
  orch.cancel("fencing");
  const result = await orch.execute({
    ref: REF,
    runId: RUN_ID,
    ticket: TICKET,
    branch: BRANCH,
    workspacePath: WS,
    startState: "IN_PROGRESS"
  });

  assert.equal(result.outcome, "CANCELLED");
  assert.equal(ran, 0);
  assert.equal(api.calls.createCheck.length, 0);
  assert.equal(api.calls.transition.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// mapOrchestrationOutcome
// ─────────────────────────────────────────────────────────────────────────

test("mapOrchestrationOutcome: COMPLETED -> COMPLETED; HANDOFF -> COMPLETED; RELEASE stays RELEASED; nothing maps to RELEASED by accident", () => {
  // Defect 2: the happy path finishes the Run COMPLETED, not RELEASED.
  assert.equal(mapOrchestrationOutcome({ outcome: "COMPLETED", note: "x" }).outcome, "COMPLETED");
  // A humanOnly frontier reached after the automated work is COMPLETED, not a
  // catch-all RELEASED.
  assert.equal(mapOrchestrationOutcome({ outcome: "HANDOFF", note: "x" }).outcome, "COMPLETED");
  // A genuine RELEASE (ticket / SPEC / repo do not correspond) stays RELEASED.
  assert.equal(mapOrchestrationOutcome({ outcome: "RELEASED", note: "x" }).outcome, "RELEASED");
  // Fencing / shutdown.
  assert.equal(mapOrchestrationOutcome({ outcome: "CANCELLED", note: "x" }).outcome, "RELEASED");
  // Exhausted governed answers is a failure to converge, never RELEASED.
  assert.equal(mapOrchestrationOutcome({ outcome: "BLOCKED", note: "x" }).outcome, "FAILED");
  assert.equal(mapOrchestrationOutcome({ outcome: "FAILED", note: "x" }).outcome, "FAILED");
  // An unknown internal outcome is FAILED — explicitly NOT RELEASED.
  const unknown = mapOrchestrationOutcome({ outcome: "WAT", note: "x" });
  assert.equal(unknown.outcome, "FAILED");
  assert.match(unknown.note, /no se mapea a RELEASED/i);
});

// ─────────────────────────────────────────────────────────────────────────
// createOrchestrationExecution — the Worker Core seam
// ─────────────────────────────────────────────────────────────────────────

function fakePrepareWorkspace() {
  const calls = [];
  const fn = async args => {
    calls.push(args);
    return { path: WS, branch: args.branch, baseBranch: "main", created: true, reused: false };
  };
  fn.calls = calls;
  return fn;
}

test("createOrchestrationExecution: workspace -> orchestrator -> { outcome:COMPLETED } on the happy path", async () => {
  const api = fakeRail();
  const prepareWs = fakePrepareWorkspace();
  const runRole = scriptedRunRole(HAPPY);
  const exec = createOrchestrationExecution(
    { ref: REF, ticket: TICKET, branch: BRANCH, run: { id: RUN_ID } },
    {
      api,
      runRole,
      prepareWorkspace: prepareWs,
      workspaceRoot: "/root",
      repoPath: "/repo",
      logger: () => {}
    }
  );
  const out = await exec.done;

  assert.equal(out.outcome, "COMPLETED");
  assert.match(out.note, /Orquestación completa/);
  assert.equal(prepareWs.calls.length, 1);
  // CLAIMED -> IN_PROGRESS + 3 forward transitions, 4 checks.
  assert.equal(api.calls.transition.length, 4);
  assert.equal(api.calls.createCheck.length, 4);
  // The ticket handed to the workspace preparer is secret-stripped.
  assert.ok(!JSON.stringify(prepareWs.calls[0].ticket).toLowerCase().includes("token"));
});

test("createOrchestrationExecution: workspace prep failure => FAILED, orchestrator never runs", async () => {
  const api = fakeRail();
  const failingPrep = async () => {
    throw new Error("origin != targetRepository");
  };
  const runRole = scriptedRunRole([]);
  const exec = createOrchestrationExecution(
    { ref: REF, ticket: TICKET, branch: BRANCH, run: { id: RUN_ID } },
    { api, runRole, prepareWorkspace: failingPrep, workspaceRoot: "/root", repoPath: "/repo", logger: () => {} }
  );
  const out = await exec.done;
  assert.equal(out.outcome, "FAILED");
  assert.equal(api.calls.createCheck.length, 0);
});

test("createOrchestrationExecution: no RAIL_WORKSPACE_ROOT => FAILED with a clear reason", async () => {
  const api = fakeRail();
  const exec = createOrchestrationExecution(
    { ref: REF, ticket: TICKET, branch: BRANCH, run: { id: RUN_ID } },
    { api, runRole: scriptedRunRole([]), prepareWorkspace: fakePrepareWorkspace(), repoPath: "/repo", logger: () => {} }
  );
  const out = await exec.done;
  assert.equal(out.outcome, "FAILED");
  assert.match(out.note, /RAIL_WORKSPACE_ROOT/);
});

test("createOrchestrationExecution: cancel() is idempotent and stops Rail effects", async () => {
  const api = fakeRail();
  let orchStarted = false;
  const runRole = async ({ role, envelope }) => {
    orchStarted = true;
    return interpretExecutionResult(role, er("IMPLEMENTED"), envelope.session.id);
  };
  const exec = createOrchestrationExecution(
    { ref: REF, ticket: TICKET, branch: BRANCH, run: { id: RUN_ID } },
    {
      api,
      runRole,
      prepareWorkspace: fakePrepareWorkspace(),
      workspaceRoot: "/root",
      repoPath: "/repo",
      startState: "IN_PROGRESS",
      logger: () => {}
    }
  );
  exec.cancel("fencing");
  exec.cancel("fencing");
  const out = await exec.done;

  assert.equal(out.outcome, "RELEASED"); // CANCELLED -> RELEASED Run
  assert.equal(api.calls.createCheck.length, 0);
  assert.equal(api.calls.transition.length, 0);
  assert.equal(orchStarted, false);
});

// ─────────────────────────────────────────────────────────────────────────
// End-to-end: Worker Core + Orchestration on a fake Rail — a SINGLE Run
// ─────────────────────────────────────────────────────────────────────────

test("E2E: Worker Core claims ONCE, orchestration drives roles+checks+transitions, Run finished COMPLETED", async () => {
  const isoIn = ms => new Date(Date.now() + ms).toISOString();
  const rail = fakeRail();
  const wcCalls = { listProjects: 0, listReady: 0, getTicket: 0, claim: 0, heartbeat: 0, finishRun: [] };
  const ticketDetail = { ...TICKET, state: "READY", activeRun: null };

  const api = {
    ...rail,
    async listProjects() {
      wcCalls.listProjects += 1;
      return { items: [{ id: "proj-1" }] };
    },
    async listReady() {
      wcCalls.listReady += 1;
      return wcCalls.claim === 0 ? { items: [{ item: ticketDetail.item }] } : { items: [] };
    },
    async getTicket() {
      wcCalls.getTicket += 1;
      return ticketDetail;
    },
    async claim() {
      wcCalls.claim += 1;
      return { run: { id: RUN_ID, claimToken: "CT-secret", leaseExpiresAt: isoIn(30 * 60_000) } };
    },
    async heartbeat() {
      wcCalls.heartbeat += 1;
      return { leaseExpiresAt: isoIn(30 * 60_000) };
    },
    async finishRun(runId, payload) {
      wcCalls.finishRun.push({ runId, payload });
      return { ok: true };
    }
  };

  const runRole = scriptedRunRole(HAPPY);
  let worker;
  worker = createWorkerCore({
    api,
    projectId: "proj-1",
    createExecution: ctx =>
      createOrchestrationExecution(ctx, {
        api,
        runRole,
        prepareWorkspace: fakePrepareWorkspace(),
        workspaceRoot: "/root",
        repoPath: "/repo",
        logger: () => {}
      }),
    sleep: async () => worker.requestStop("fin de test"),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: () => {}
  });

  await worker.start();

  assert.equal(wcCalls.claim, 1, "un único claim: sin claims secundarios");
  assert.equal(worker.getState().claimsWon, 1);
  assert.deepEqual(rail.calls.createCheck.map(c => c.body.type), [
    "IMPLEMENTATION",
    "CODE_REVIEW",
    "AUTOMATED_TESTS",
    "ACCEPTANCE_CRITERIA"
  ]);
  assert.deepEqual(rail.calls.transition.map(t => t.body.to), [
    "IN_PROGRESS",
    "REVIEWING",
    "TESTING",
    "SANDBOX_READY"
  ]);
  assert.equal(wcCalls.finishRun.length, 1, "el Worker Core cierra el único Run");
  assert.equal(
    wcCalls.finishRun[0].payload.outcome,
    "COMPLETED",
    "happy path: finishRun outcome === COMPLETED (no RELEASED)"
  );
  assert.equal(worker.getState().phase, WORKER_PHASES.STOPPED);
});

// ─────────────────────────────────────────────────────────────────────────
// E2E timeline evidence (verification: "Timeline E2E fake")
// ─────────────────────────────────────────────────────────────────────────

test("E2E timeline: the happy-path timeline is a legible, ordered record", async () => {
  const runRole = scriptedRunRole(HAPPY);
  const { run } = makeOrch(runRole, { execOpts: { startState: "CLAIMED" } });
  const result = await run();

  const kinds = result.timeline.map(e => e.kind);
  assert.deepEqual(kinds, [
    "transition", // CLAIMED -> IN_PROGRESS
    "role", // IMPLEMENTER
    "check", // IMPLEMENTATION
    "transition", // IN_PROGRESS -> REVIEWING
    "role", // REVIEWER
    "check", // CODE_REVIEW
    "transition", // REVIEWING -> TESTING
    "role", // TESTER
    "check", // AUTOMATED_TESTS
    "check", // ACCEPTANCE_CRITERIA
    "transition" // TESTING -> SANDBOX_READY
  ]);
  assert.equal(result.queries.length, 0);
  assert.equal(result.handoffs.length, 0);
});

test("E2E timeline (blocked): role -> query -> stop, nothing fabricated", async () => {
  const runRole = scriptedRunRole([{ role: "IMPLEMENTER", result: er("BLOCKED") }]);
  // Explicit governed resolver that reports "no answer available" => terminal
  // BLOCKED at the orchestration level (a still-open query would keep pending).
  const { run } = makeOrch(runRole, { orchOpts: { resolveQuery: async () => null } });
  const result = await run();
  assert.equal(result.outcome, "BLOCKED");
  assert.deepEqual(
    result.timeline.map(e => e.kind),
    ["role", "query"]
  );
  // And a terminal BLOCKED never becomes a silent RELEASED Run.
  assert.equal(mapOrchestrationOutcome(result).outcome, "FAILED");
});

// ─────────────────────────────────────────────────────────────────────────
// FINAL FIX — RailSoft Agent Query resolution semantics
// (RailQueryStatus = PENDING | RESOLVED | DISMISSED — no ANSWERED, no CLOSED)
// ─────────────────────────────────────────────────────────────────────────

const SENTINEL_RE = /Continuá según la SPEC|resuelta por un humano sin respuesta textual/;

/** Drive the default waiter to a blocked orchestration, run `mutate`, await. */
async function blockedThen(mutate, { steps, orchOpts = {} } = {}) {
  const api = fakeRail();
  const runRole = scriptedRunRole(
    steps ?? [
      { role: "IMPLEMENTER", result: er("BLOCKED", { question: "¿motor?" }) },
      { role: "IMPLEMENTER", result: er("IMPLEMENTED") },
      { role: "REVIEWER", result: er("IMPLEMENTED") },
      { role: "TESTER", result: er("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
    ]
  );
  const { orch, run } = makeOrch(runRole, {
    api,
    orchOpts: { sleep: ms => new Promise(r => setTimeout(r, ms)), queryPollMs: 1, ...orchOpts }
  });
  const p = run();
  for (let i = 0; i < 200 && api.calls.createQuery.length === 0; i += 1) await delay(2);
  assert.equal(api.calls.createQuery.length, 1, "se creó exactamente una Agent Query");
  await delay(10); // a few polls while PENDING
  await mutate({ api, runRole, orch });
  return { api, runRole, orch, result: await p };
}

test("FINAL 1 — PENDING: execution stays pending, zero resume, zero finishRun", async () => {
  const api = fakeRail();
  const wcFinish = [];
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("BLOCKED", { question: "¿motor?" }) }
  ]);
  const { orch, run } = makeOrch(runRole, {
    api,
    orchOpts: { sleep: ms => new Promise(r => setTimeout(r, ms)), queryPollMs: 1 }
  });
  const p = run();
  p.then(() => wcFinish.push("settled"));

  await delay(30);
  assert.equal(api.calls.createQuery.length, 1);
  assert.equal(runRole.seen.length, 1, "el rol NO se reanudó mientras la query está PENDING");
  assert.equal(api.calls.transition.length, 0);
  assert.ok(api.calls.listQueries > 1, "el poll gobernado sigue corriendo");
  assert.equal(wcFinish.length, 0, "execute() sigue pending: el Worker Core no hace finishRun");

  orch.cancel("fin de test");
  const result = await p;
  assert.equal(result.outcome, "CANCELLED");
});

test("FINAL 2 — RESOLVED + answer: resume same Run / role / session.id, answer EXACTLY the human text", async () => {
  const HUMAN = "usá PostgreSQL 16 con esquema `núcleo`";
  const { api, runRole, result } = await blockedThen(({ api }) => {
    api.queries[0].status = "RESOLVED";
    api.queries[0].answer = HUMAN;
  });

  assert.equal(result.outcome, "COMPLETED");
  assert.equal(api.calls.createQuery.length, 1);
  const first = runRole.seen[0];
  const resumed = runRole.seen[1];
  assert.equal(resumed.role, "IMPLEMENTER", "mismo rol");
  assert.equal(resumed.envelope.run.id, RUN_ID, "mismo Run");
  assert.equal(resumed.envelope.session.id, first.envelope.session.id, "misma session.id");
  assert.equal(resumed.envelope.resumeAnswer, HUMAN, "answer EXACTAMENTE el texto humano");
  assert.ok(result.timeline.some(e => e.kind === "resume"));
});

test("FINAL 3 — RESOLVED without answer: FAILED, zero resume, zero sentinel", async () => {
  const { api, runRole, result } = await blockedThen(({ api }) => {
    api.queries[0].status = "RESOLVED";
    // no answer / response / resolution set
  });

  assert.equal(result.outcome, "FAILED");
  assert.equal(runRole.seen.length, 1, "no se reanudó el rol");
  assert.equal(api.calls.transition.length, 0);
  assert.doesNotMatch(result.note, SENTINEL_RE, "no hay respuesta sintética");
  assert.match(result.note, /contrato de RailSoft|RESOLVED sin 'answer'/i);
});

test("FINAL 4 — DISMISSED: FAILED, zero resume, zero resumeAnswer, zero new query, zero invented text", async () => {
  const { api, runRole, result } = await blockedThen(({ api }) => {
    api.queries[0].status = "DISMISSED";
  });

  assert.equal(result.outcome, "FAILED");
  assert.equal(runRole.seen.length, 1, "NO se reanuda el adapter");
  assert.equal(api.calls.createQuery.length, 1, "NO se crea otra query");
  assert.equal(api.calls.transition.length, 0);
  assert.ok(runRole.seen.every(s => s.envelope.resumeAnswer == null), "nunca hay resumeAnswer");
  assert.doesNotMatch(result.note, SENTINEL_RE, "no se inventa instrucción humana");
  assert.match(result.note, /DISMISSED/);
  // A factual governed note is left (best-effort).
  assert.ok(api.calls.addComment.some(c => /DISMISSED/.test(c.content)));
  // DISMISSED maps to a FAILED Run (never HANDOFF / COMPLETED / RELEASED).
  assert.equal(mapOrchestrationOutcome(result).outcome, "FAILED");
});

test("FINAL 5 — ANSWERED status is unknown to RailSoft: contract violation => FAILED, zero resume", async () => {
  const { runRole, result } = await blockedThen(({ api }) => {
    api.queries[0].status = "ANSWERED";
    api.queries[0].answer = "texto que NO debe usarse";
  });
  assert.equal(result.outcome, "FAILED");
  assert.equal(runRole.seen.length, 1);
  assert.ok(runRole.seen.every(s => s.envelope.resumeAnswer == null));
  assert.match(result.note, /desconocido|contrato de RailSoft/i);
});

test("FINAL 6 — CLOSED status is unknown to RailSoft: contract violation => FAILED, zero resume", async () => {
  const { runRole, result } = await blockedThen(({ api }) => {
    api.queries[0].status = "CLOSED";
  });
  assert.equal(result.outcome, "FAILED");
  assert.equal(runRole.seen.length, 1);
  assert.match(result.note, /desconocido|contrato de RailSoft/i);
  assert.ok(!RAIL_QUERY_STATUSES.includes("CLOSED") && !RAIL_QUERY_STATUSES.includes("ANSWERED"));
});

test("FINAL 7 — an OLD RESOLVED query does NOT unblock the wait for the current queryId", async () => {
  const list = [
    { id: "q-OLD", blocking: true, status: "RESOLVED", answer: "respuesta vieja de otro bloqueo" },
    { id: "q-NEW", blocking: true, status: "PENDING" }
  ];
  const api = { async listQueries() { return { queries: list.map(q => ({ ...q })) }; } };
  let polls = 0;
  const waiter = createResolvedQueryWaiter({
    api,
    ref: REF,
    pollMs: 1,
    sleep: () => { polls += 1; return new Promise(r => setTimeout(r, 1)); }
  });
  const p = waiter({ queryId: "q-NEW" });
  // Let it poll several times: it must NOT resolve off the old query.
  await delay(20);
  const raced = await Promise.race([p.then(v => v), delay(15).then(() => "pending")]);
  assert.equal(raced, "pending", "sigue esperando: la query vieja no desbloquea");
  assert.ok(polls > 1);
  // Now the REAL query resolves -> the waiter returns ITS answer, not the old one.
  list[1].status = "RESOLVED";
  list[1].answer = "respuesta correcta";
  assert.deepEqual(await p, { kind: "HUMAN_ANSWER", answer: "respuesta correcta" });
});

test("FINAL 8 — a query from another Run does NOT unblock; only query.id === queryId does", async () => {
  const list = [
    { id: "q-other-run", queryId: "q-other-run", blocking: true, status: "RESOLVED", answer: "de otro Run" }
  ];
  const api = { async listQueries() { return { queries: list.map(q => ({ ...q })) }; } };
  const ac = new AbortController();
  const waiter = createResolvedQueryWaiter({
    api,
    ref: REF,
    pollMs: 1,
    signal: ac.signal,
    sleep: () => new Promise(r => setTimeout(r, 1))
  });
  const p = waiter({ queryId: "q-mine" });
  await delay(15);
  const raced = await Promise.race([p.then(() => "settled").catch(() => "rejected"), delay(10).then(() => "pending")]);
  assert.equal(raced, "pending", "una query de otro Run no desbloquea la espera actual");
  ac.abort();
  await assert.rejects(p, /cancelada/);
});

test("FINAL 9 — createQuery without a queryId: FAILED fail-closed, no fallback to another blocking query", async () => {
  const api = fakeRail({
    // Rail answers 2xx but WITHOUT a queryId (contract violation).
    createQuery: () => ({ blocking: true })
  });
  // Seed an unrelated blocking query in the store: it must NEVER be used as a fallback.
  api.queries.push({ id: "q-unrelated", blocking: true, status: "RESOLVED", answer: "no usar" });
  const runRole = scriptedRunRole([{ role: "IMPLEMENTER", result: er("BLOCKED") }]);
  const { run } = makeOrch(runRole, {
    api,
    orchOpts: { sleep: ms => new Promise(r => setTimeout(r, ms)), queryPollMs: 1 }
  });
  const result = await run();

  assert.equal(result.outcome, "FAILED");
  assert.equal(runRole.seen.length, 1, "no se reanuda el rol");
  assert.equal(api.calls.transition.length, 0);
  assert.match(result.note, /queryId/);
  assert.doesNotMatch(result.note, /no usar/);
});

test("FINAL 10 — transient listQueries error: retried, no invented answer", async () => {
  let call = 0;
  const api = {
    async listQueries() {
      call += 1;
      if (call === 1) throw Object.assign(new Error("503 temporal"), { status: 503 });
      if (call === 2) return { queries: [{ id: "q1", status: "PENDING" }] };
      return { queries: [{ id: "q1", status: "RESOLVED", answer: "respuesta real" }] };
    }
  };
  const waiter = createResolvedQueryWaiter({ api, ref: REF, pollMs: 1, sleep: () => new Promise(r => setTimeout(r, 1)) });
  const out = await waiter({ queryId: "q1" });
  assert.deepEqual(out, { kind: "HUMAN_ANSWER", answer: "respuesta real" });
  assert.ok(call >= 3, "reintentó tras el error transitorio en vez de inventar una respuesta");
});

test("FINAL 11 — cancel during polling: CANCELLED, no later Rail effects", async () => {
  const api = fakeRail();
  const runRole = scriptedRunRole([{ role: "IMPLEMENTER", result: er("BLOCKED") }]);
  const { orch, run } = makeOrch(runRole, {
    api,
    orchOpts: { sleep: ms => new Promise(r => setTimeout(r, ms)), queryPollMs: 1 }
  });
  const p = run();
  for (let i = 0; i < 200 && api.calls.createQuery.length === 0; i += 1) await delay(2);
  const checksBefore = api.calls.createCheck.length;
  orch.cancel("ownership perdido (fencing)");
  const result = await p;

  assert.equal(result.outcome, "CANCELLED");
  assert.equal(api.calls.createCheck.length, checksBefore);
  assert.equal(api.calls.transition.length, 0);
  assert.equal(runRole.seen.length, 1);
});

test("FINAL 12 — maxQueryResumes: budget checked BEFORE creating an extra query (no orphan query)", async () => {
  const api = fakeRail();
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("BLOCKED") },
    { role: "IMPLEMENTER", result: er("BLOCKED") } // still blocked after the one allowed resume
  ]);
  const { run } = makeOrch(runRole, {
    api,
    orchOpts: { resolveQuery: async () => "una respuesta que no ayuda", maxQueryResumes: 1 }
  });
  const result = await run();

  assert.equal(result.outcome, "BLOCKED");
  assert.equal(mapOrchestrationOutcome(result).outcome, "FAILED");
  assert.equal(
    api.calls.createQuery.length,
    1,
    "la query #2 NUNCA se crea: sin presupuesto de resume no se puede esperar => sería huérfana"
  );
  assert.equal(runRole.seen.length, 2, "un único resume gobernado, luego se detiene");
  assert.match(result.note, /presupuesto de resume|maxQueryResumes/);
});

// ═══════════════════════════════════════════════════════════════════════
// RAIL-D-00006 §16 — hardening follow-ups of RAIL-D-00005
// ═══════════════════════════════════════════════════════════════════════

test("§16A: the internal 'human answer' kind is HUMAN_ANSWER, never the invalid RailSoft status 'ANSWERED'", async () => {
  const api = { async listQueries() { return { queries: [{ id: "q1", status: "RESOLVED", answer: "usá PostgreSQL" }] }; } };
  const waiter = createResolvedQueryWaiter({ api, ref: REF, pollMs: 1, sleep: () => new Promise(r => setTimeout(r, 1)) });
  const out = await waiter({ queryId: "q1" });
  assert.equal(out.kind, "HUMAN_ANSWER");
  assert.notEqual(out.kind, "ANSWERED");
  assert.equal(out.answer, "usá PostgreSQL");

  // and a real 'ANSWERED' RailSoft status is still a contract violation (unchanged)
  const api2 = { async listQueries() { return { queries: [{ id: "q1", status: "ANSWERED", answer: "x" }] }; } };
  const w2 = createResolvedQueryWaiter({ api: api2, ref: REF, pollMs: 1, sleep: () => new Promise(r => setTimeout(r, 1)) });
  await assert.rejects(w2({ queryId: "q1" }), /desconocido|inválida/);
});

test("§16A: a governed resume still carries the human text verbatim into the SAME session (HUMAN_ANSWER path)", async () => {
  const api = fakeRail();
  const runRole = scriptedRunRole([
    { role: "IMPLEMENTER", result: er("BLOCKED") },
    { role: "IMPLEMENTER", result: er("IMPLEMENTED", { filesChanged: ["src/a.js"] }) },
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);
  const { run } = makeOrch(runRole, { api, orchOpts: { resolveQuery: async () => "usá PostgreSQL" } });
  const result = await run();
  assert.equal(result.outcome, "COMPLETED");
  const resumed = runRole.seen[1];
  assert.equal(resumed.envelope.resumeAnswer, "usá PostgreSQL");
  assert.equal(resumed.envelope.session.id, runRole.seen[0].envelope.session.id, "misma sesión");
});

test("§16B: query status validation has a single source of truth (RAIL_QUERY_STATUSES)", () => {
  assert.deepEqual([...RAIL_QUERY_STATUSES], ["PENDING", "RESOLVED", "DISMISSED"]);
  for (const s of RAIL_QUERY_STATUSES) assert.equal(isKnownQueryStatus(s), true);
  for (const s of ["ANSWERED", "CLOSED", "OPEN", "", null, undefined, "pending "]) {
    assert.equal(isKnownQueryStatus(s), false, JSON.stringify(s));
  }
  assert.equal(isKnownQueryStatus("pending"), true, "case-insensitive");
  assert.equal(readQueryStatus({ status: "resolved" }), "RESOLVED");
  assert.equal(readQueryStatus({ state: "dismissed" }), "DISMISSED");
});

test("§16D: maxQueryResumes=0 disables Agent Queries — a BLOCKED role fails closed and NO query is created", async () => {
  const api = fakeRail();
  const runRole = scriptedRunRole([{ role: "IMPLEMENTER", result: er("BLOCKED") }]);
  const { run } = makeOrch(runRole, { api, orchOpts: { maxQueryResumes: 0 } });
  const result = await run();

  assert.equal(result.outcome, "BLOCKED");
  assert.equal(mapOrchestrationOutcome(result).outcome, "FAILED");
  assert.equal(api.calls.createQuery.length, 0, "cero Agent Queries con maxQueryResumes=0");
  assert.equal(api.calls.transition.length, 0);
  assert.equal(runRole.seen.length, 1, "no hay resume");
  assert.match(result.note, /deshabilitadas|maxQueryResumes=0/);
});

test("§16D: maxQueryResumes / maxReworks must be integers >= 0", () => {
  const base = { api: fakeRail(), runRole: scriptedRunRole([]) };
  assert.throws(() => createOrchestrator({ ...base, maxQueryResumes: -1 }), /maxQueryResumes/);
  assert.throws(() => createOrchestrator({ ...base, maxQueryResumes: 1.5 }), /maxQueryResumes/);
  assert.throws(() => createOrchestrator({ ...base, maxReworks: -3 }), /maxReworks/);
  assert.doesNotThrow(() => createOrchestrator({ ...base, maxQueryResumes: 0 }));
});

// ═══════════════════════════════════════════════════════════════════════
// RAIL-D-00006 — state-aware /resume entry: the orchestrator continues from
// the EXACT state Rail preserved and never re-runs / re-publishes a stage
// Rail already accepted.
// ═══════════════════════════════════════════════════════════════════════

test("resume entry REVIEWING: runs REVIEWER then TESTER — NO IMPLEMENTER, NO IMPLEMENTATION check, NO rewind to IN_PROGRESS", async () => {
  const api = fakeRail();
  const runRole = scriptedRunRole([
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);
  const { run } = makeOrch(runRole, { api, execOpts: { startState: "REVIEWING" } });
  const result = await run();

  assert.equal(result.outcome, "COMPLETED");
  assert.deepEqual(runRole.seen.map(s => s.role), ["REVIEWER", "TESTER"]);
  assert.deepEqual(
    api.calls.createCheck.map(c => c.body.type),
    ["CODE_REVIEW", "AUTOMATED_TESTS", "ACCEPTANCE_CRITERIA"]
  );
  assert.deepEqual(api.calls.transition.map(t => t.body.to), ["TESTING", "SANDBOX_READY"]);
  assert.ok(!api.calls.transition.some(t => t.body.to === "IN_PROGRESS"), "no rebobina el estado");
});

test("resume entry TESTING: runs the TESTER only — NO IMPLEMENTER/REVIEWER, NO IMPLEMENTATION/CODE_REVIEW check", async () => {
  const api = fakeRail();
  const runRole = scriptedRunRole([
    { role: "TESTER", result: er("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);
  const { run } = makeOrch(runRole, { api, execOpts: { startState: "TESTING" } });
  const result = await run();

  assert.equal(result.outcome, "COMPLETED");
  assert.deepEqual(runRole.seen.map(s => s.role), ["TESTER"]);
  assert.deepEqual(api.calls.createCheck.map(c => c.body.type), ["AUTOMATED_TESTS", "ACCEPTANCE_CRITERIA"]);
  assert.ok(!api.calls.createCheck.some(c => c.body.type === "IMPLEMENTATION"));
  assert.ok(!api.calls.createCheck.some(c => c.body.type === "CODE_REVIEW"));
  assert.deepEqual(api.calls.transition.map(t => t.body.to), ["SANDBOX_READY"]);
});

test("resume entry SANDBOX_READY (== targetState): nothing executed, nothing published, outcome COMPLETED", async () => {
  const api = fakeRail();
  const runRole = scriptedRunRole([]);
  const { run } = makeOrch(runRole, { api, execOpts: { startState: "SANDBOX_READY" } });
  const result = await run();

  assert.equal(result.outcome, "COMPLETED");
  assert.equal(runRole.seen.length, 0);
  assert.equal(api.calls.createCheck.length, 0);
  assert.equal(api.calls.transition.length, 0);
});

test("resume entry SANDBOX_READY + humanOnly on that state => HANDOFF with a governed note, no fabricated approval", async () => {
  const api = fakeRail();
  const runRole = scriptedRunRole([]);
  const { run } = makeOrch(runRole, {
    api,
    orchOpts: { humanOnlyStates: ["SANDBOX_READY"] },
    execOpts: { startState: "SANDBOX_READY" }
  });
  const result = await run();

  assert.equal(result.outcome, "HANDOFF");
  assert.equal(mapOrchestrationOutcome(result).outcome, "COMPLETED");
  assert.equal(api.calls.transition.length, 0);
  assert.ok(api.calls.addComment.length >= 1, "deja una nota gobernada");
});

test("resume entry REVIEWING with a REVIEWER REWORK: governed rewind + IMPLEMENTER RECOVERY + fresh IMPLEMENTATION check, then re-review", async () => {
  const api = fakeRail();
  const runRole = scriptedRunRole([
    { role: "REVIEWER", result: er("RELEASE") }, // reviewer RELEASE => REWORK
    { role: "IMPLEMENTER", result: er("IMPLEMENTED", { filesChanged: ["src/fix.js"] }) },
    { role: "REVIEWER", result: er("IMPLEMENTED") },
    { role: "TESTER", result: er("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);
  const { run } = makeOrch(runRole, { api, execOpts: { startState: "REVIEWING" }, orchOpts: { maxReworks: 1 } });
  const result = await run();

  assert.equal(result.outcome, "COMPLETED");
  // rewind REVIEWING -> IN_PROGRESS happened, then IMPLEMENTATION was published during the rework
  assert.ok(api.calls.transition.some(t => t.body.to === "IN_PROGRESS"), "rewind gobernado");
  assert.ok(api.calls.createCheck.some(c => c.body.type === "IMPLEMENTATION"), "IMPLEMENTATION durante el rework");
  assert.deepEqual(runRole.seen.map(s => s.role), ["REVIEWER", "IMPLEMENTER", "REVIEWER", "TESTER"]);
});
