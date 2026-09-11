/**
 * Resume / recovery of an orphaned IN_PROGRESS cycle — RAIL-D-00006
 * acceptance tests.
 *
 * Fully offline: an in-memory Rail fake, an injected read-only worktree
 * inspector, an injected execution factory, injected timers/clock. No real
 * Rail, no real adapter, no real `claude`, no network, no git.
 *
 * Coverage (ticket AC + prompt §22):
 *   T6-AC-01  stale-lease takeover uses /recover and only executes after new
 *             valid ownership.
 *   T6-AC-02  ownerless orphan resumes on the EXACT last Run; the previous
 *             terminal outcome stays intact.
 *   T6-AC-03  concurrency / fencing / invalid runtime / shutdown fail safe: no
 *             duplicated ownership, no false success, no fallback `claim`.
 *   T6-AC-04  a recovered E2E that reaches a humanOnly frontier stops with
 *             evidence, no fabricated approval.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRecoveryRunner,
  createResumeRunner,
  RECOVERY_RESULT_CODES,
  worktreeProblem
} from "../src/worker/recovery.js";
import {
  resolveRecoveryTarget,
  resolveResumeTarget,
  isActiveRunLeaseLive,
  pickLastRun,
  buildRecoverRequest,
  RECOVERY_CODES,
  RECOVERY_TARGETS,
  RESUME_CODES,
  RESUME_TARGETS
} from "../src/worker/recovery-preflight.js";
import { normalizeRunHandoff } from "../src/rail/rail-api-client.js";
import {
  createOrchestrationExecution,
  mapOrchestrationOutcome
} from "../src/orchestration/orchestrator.js";
import { interpretExecutionResult } from "../src/orchestration/roles.js";

const PID = "proj-recovery";
const REF = "RAIL-D-00006";
const CODE = "RAIL-D-00006";
const BRANCH = "rail/rail-d-00006";
const REPO = "Pachimanok/railHarness";
const NEW_CT = "CT-recovery-new-secret-xyz789";
const OLD_RUN = "run-previous-abandoned";
const STALE_RUN = "run-stale-active";
const NEW_RUN = "run-recovered-1";

const isoIn = ms => new Date(Date.now() + ms).toISOString();
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, { timeout = 1000, label = "condición" } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (pred()) return;
    await delay(5);
  }
  throw new Error(`timeout esperando ${label}`);
}

// ── fixtures ────────────────────────────────────────────────────────────

/** A) classic orphan: activeRun == null, last Run ABANDONED/FAILED. */
function orphanTicket(over = {}) {
  return {
    projectId: PID,
    state: "IN_PROGRESS",
    blocked: false,
    activeRun: null,
    item: { code: CODE, id: "tkt_6", title: "resume/recovery" },
    targetRepository: { repoFullName: REPO },
    runs: [
      { id: "run-way-old", state: "FAILED", startedAt: isoIn(-3 * 3600_000) },
      { id: OLD_RUN, state: "ABANDONED", startedAt: isoIn(-3600_000) }
    ],
    planning: {
      acceptance_criteria: [
        { id: "T6-AC-01", given: "run stale", when: "otro worker continúa", then: "usa recover" }
      ]
    },
    ...over
  };
}

/** B) stale-lease takeover: activeRun present but not lease-live. */
function staleTicket(over = {}) {
  return {
    projectId: PID,
    state: "IN_PROGRESS",
    blocked: false,
    activeRun: {
      id: STALE_RUN,
      state: "ACTIVE",
      branch: BRANCH,
      leaseExpiresAt: isoIn(-5 * 60_000) // expired
    },
    item: { code: CODE, id: "tkt_6", title: "resume/recovery" },
    targetRepository: { repoFullName: REPO },
    runs: [{ id: STALE_RUN, state: "ACTIVE", branch: BRANCH, startedAt: isoIn(-1800_000) }],
    ...over
  };
}

function goodWs(over = {}) {
  return {
    path: "/ws/rail-d-00006",
    exists: true,
    isWorktree: true,
    isRoot: true,
    registered: true,
    branch: BRANCH,
    dirty: true, // recovery: uncommitted work is EXPECTED
    originSlug: "pachimanok/railharness",
    toplevel: "/ws/rail-d-00006",
    ...over
  };
}

/**
 * In-memory Rail fake covering BOTH the recovery methods and the orchestration
 * methods. Records every call; `claim` throws — it must NEVER be reached.
 */
function fakeRail({ ticket = orphanTicket(), recoverImpl, resumeImpl, heartbeatImpl } = {}) {
  const calls = {
    getTicket: [],
    recover: [],
    resume: [],
    heartbeat: [],
    finishRun: [],
    claim: [],
    transition: [],
    createCheck: [],
    createQuery: [],
    addComment: [],
    listQueries: 0
  };
  const state = { ticket };
  const queries = [];
  const grantHandoff = (body, cycleState) =>
    normalizeRunHandoff({
      activeRun: { id: NEW_RUN, state: "ACTIVE", claimToken: NEW_CT, leaseExpiresAt: isoIn(30 * 60_000) },
      recoveryOfRunId: body.lastRunId,
      cycle: { state: cycleState }
    });
  return {
    calls,
    state,
    queries,
    async getTicket(ref) {
      calls.getTicket.push(ref);
      return state.ticket;
    },
    async recover(ref, body) {
      calls.recover.push({ ref, body });
      if (recoverImpl) return recoverImpl({ ref, body, calls, state });
      return grantHandoff(body, "IN_PROGRESS");
    },
    async resume(ref, body) {
      calls.resume.push({ ref, body });
      if (resumeImpl) return resumeImpl({ ref, body, calls, state });
      // /resume PRESERVES the cycle state exactly.
      const cs = state.ticket?.state ?? "IN_PROGRESS";
      return grantHandoff(body, cs);
    },
    async heartbeat(runId, claimToken) {
      calls.heartbeat.push({ runId, claimToken });
      if (heartbeatImpl) return heartbeatImpl({ runId, claimToken, calls });
      return { leaseExpiresAt: isoIn(45 * 60_000) };
    },
    async finishRun(runId, payload) {
      calls.finishRun.push({ runId, payload });
      return { ok: true };
    },
    async claim(ref, branch) {
      calls.claim.push({ ref, branch });
      throw new Error("claim NUNCA debe llamarse durante un recovery");
    },
    async transition(ref, body) {
      calls.transition.push({ ref, body });
      return { toState: body.to, gateResults: { passed: true, humanOnly: false } };
    },
    async createCheck(ref, body) {
      calls.createCheck.push({ ref, body });
      return { id: `chk-${calls.createCheck.length}` };
    },
    async createQuery(ref, body) {
      calls.createQuery.push({ ref, body });
      const q = { id: `q-${calls.createQuery.length}`, blocking: true, status: "PENDING", ...body };
      queries.push(q);
      return { id: q.id, blocking: true };
    },
    async listQueries() {
      calls.listQueries += 1;
      return { queries: queries.map(q => ({ ...q })) };
    },
    async addComment(ref, content) {
      calls.addComment.push({ ref, content });
      return { ok: true };
    }
  };
}

/** Execution whose `done` only settles on `cancel()`. */
function heldExecution() {
  const cancels = [];
  let resolveDone;
  const done = new Promise(r => {
    resolveDone = r;
  });
  const h = {
    cancels,
    ctx: null,
    factory(ctx) {
      h.ctx = ctx;
      return {
        done,
        cancel(reason) {
          cancels.push(reason);
          resolveDone({ outcome: "RELEASED", note: `cancelada: ${reason}` });
        }
      };
    }
  };
  return h;
}

/** Execution that resolves immediately with a fixed result. */
function resolvedExecution(result) {
  const h = { ctx: null, cancels: [] };
  h.factory = ctx => {
    h.ctx = ctx;
    return {
      done: Promise.resolve(result),
      cancel(r) {
        h.cancels.push(r);
      }
    };
  };
  return h;
}

/** Capturing interval double. */
function fakeTimers() {
  const box = { fn: null, ms: null, cleared: false };
  return {
    box,
    setIntervalFn(fn, ms) {
      box.fn = fn;
      box.ms = ms;
      return { unref() {} };
    },
    clearIntervalFn() {
      box.cleared = true;
    },
    async fire() {
      if (box.fn) box.fn();
      await delay(20);
    }
  };
}

function makeRunner(api, exec, over = {}) {
  return createRecoveryRunner({
    api,
    projectId: PID,
    createExecution: ctx => exec.factory(ctx),
    workspaceRoot: "/ws",
    repoPath: "/repo",
    inspectWorktree: () => goodWs(),
    heartbeatIntervalMs: 1000,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: () => {},
    ...over
  });
}

// ═══════════════════════════════════════════════════════════════════════
// PURE preflight — resolveRecoveryTarget / lease-live / pickLastRun
// ═══════════════════════════════════════════════════════════════════════

test("isActiveRunLeaseLive: exact mirror (ACTIVE && lease!=null && lease>now)", () => {
  const now = 1_000_000;
  assert.equal(isActiveRunLeaseLive({ state: "ACTIVE", leaseExpiresAt: new Date(now + 1).toISOString() }, now), true);
  assert.equal(isActiveRunLeaseLive({ state: "ACTIVE", leaseExpiresAt: new Date(now).toISOString() }, now), false, "== now no es live");
  assert.equal(isActiveRunLeaseLive({ state: "ACTIVE", leaseExpiresAt: new Date(now - 1).toISOString() }, now), false);
  assert.equal(isActiveRunLeaseLive({ state: "ACTIVE", leaseExpiresAt: null }, now), false);
  assert.equal(isActiveRunLeaseLive({ state: "ABANDONED", leaseExpiresAt: new Date(now + 9e9).toISOString() }, now), false);
});

test("pickLastRun: most recent by startedAt, only from THIS cycle's runs", () => {
  const last = pickLastRun(orphanTicket());
  assert.equal(last.id, OLD_RUN);
  assert.equal(pickLastRun({ runs: [] }), null);
});

test("T6-AC-02: classic orphan (activeRun==null, last ABANDONED) => recoverable on the exact last Run", () => {
  const res = resolveRecoveryTarget(orphanTicket(), { projectId: PID, ref: REF, expectedBranch: BRANCH });
  assert.equal(res.recoverable, true);
  assert.equal(res.target, RECOVERY_TARGETS.CLASSIC_ORPHAN);
  assert.equal(res.lastRunId, OLD_RUN);
  assert.equal(res.branch, BRANCH);
});

test("T6-AC-01: stale-lease takeover uses activeRun.id as lastRunId", () => {
  const res = resolveRecoveryTarget(staleTicket(), { projectId: PID, ref: REF, expectedBranch: BRANCH });
  assert.equal(res.recoverable, true);
  assert.equal(res.target, RECOVERY_TARGETS.STALE_LEASE_TAKEOVER);
  assert.equal(res.lastRunId, STALE_RUN);
});

test("lease STILL live => NOT recoverable, fail-closed before any POST (no ownership by inference)", () => {
  const t = staleTicket({ activeRun: { id: STALE_RUN, state: "ACTIVE", branch: BRANCH, leaseExpiresAt: isoIn(10 * 60_000) } });
  const res = resolveRecoveryTarget(t, { projectId: PID, ref: REF, expectedBranch: BRANCH, now: () => Date.now() });
  assert.equal(res.recoverable, false);
  assert.equal(res.code, RECOVERY_CODES.LEASE_STILL_ACTIVE);
  assert.equal(res.activeRunId, STALE_RUN);
});

test("CLASSIC /recover only: a CLEAN terminal last Run (RELEASED/COMPLETED) is NOT a classic-recover target — use /resume instead", () => {
  // This is a /recover COMPAT rule (IN_PROGRESS + activeRun null + FAILED/ABANDONED).
  // The general /resume path (below) DOES accept COMPLETED/RELEASED.
  for (const st of ["RELEASED", "COMPLETED"]) {
    const res = resolveRecoveryTarget(
      orphanTicket({ runs: [{ id: OLD_RUN, state: st, startedAt: isoIn(-1000) }] }),
      { projectId: PID, ref: REF, expectedBranch: BRANCH }
    );
    assert.equal(res.recoverable, false, st);
    assert.equal(res.code, RECOVERY_CODES.LAST_RUN_TERMINAL_CLEAN, st);
    assert.match(res.reason, /\/resume/, "el mensaje redirige a /resume");
  }
});

test("not IN_PROGRESS => not a classic /recover target", () => {
  const res = resolveRecoveryTarget(orphanTicket({ state: "READY" }), { projectId: PID, ref: REF, expectedBranch: BRANCH });
  assert.equal(res.code, RECOVERY_CODES.NOT_IN_PROGRESS);
});

test("BLOCKED cycle => not recoverable (human resolution first)", () => {
  const res = resolveRecoveryTarget(orphanTicket({ blocked: true }), { projectId: PID, ref: REF, expectedBranch: BRANCH });
  assert.equal(res.code, RECOVERY_CODES.CYCLE_BLOCKED);
});

test("project mismatch => not recoverable", () => {
  const res = resolveRecoveryTarget(orphanTicket({ projectId: "otro" }), { projectId: PID, ref: REF, expectedBranch: BRANCH });
  assert.equal(res.code, RECOVERY_CODES.PROJECT_MISMATCH);
});

test("indeterminate lastRunId (no runs, activeRun null) => fail-closed, no invented id", () => {
  const res = resolveRecoveryTarget(orphanTicket({ runs: [] }), { projectId: PID, ref: REF, expectedBranch: BRANCH });
  assert.equal(res.code, RECOVERY_CODES.LAST_RUN_INDETERMINATE);
});

test("stale takeover with activeRun.branch != expected branch => BRANCH_MISMATCH", () => {
  const t = staleTicket({ activeRun: { id: STALE_RUN, state: "ABANDONED", branch: "rail/other", leaseExpiresAt: null } });
  const res = resolveRecoveryTarget(t, { projectId: PID, ref: REF, expectedBranch: BRANCH });
  assert.equal(res.code, RECOVERY_CODES.BRANCH_MISMATCH);
});

test("buildRecoverRequest carries branch + exact lastRunId + worktreePath", () => {
  const res = resolveRecoveryTarget(orphanTicket(), { projectId: PID, ref: REF, expectedBranch: BRANCH });
  const body = buildRecoverRequest(res, { worktreePath: "/ws/x", reason: "porque sí" });
  assert.deepEqual({ branch: body.branch, lastRunId: body.lastRunId, worktreePath: body.worktreePath }, {
    branch: BRANCH,
    lastRunId: OLD_RUN,
    worktreePath: "/ws/x"
  });
  assert.equal(body.reason, "porque sí");
});

test("worktreeProblem: dirty is NOT a problem; wrong branch / missing / foreign IS", () => {
  assert.equal(worktreeProblem(goodWs(), { expectedBranch: BRANCH, expectedRepo: "pachimanok/railharness" }), null);
  assert.equal(worktreeProblem(goodWs({ dirty: true }), { expectedBranch: BRANCH }), null);
  assert.match(worktreeProblem(goodWs({ exists: false }), { expectedBranch: BRANCH }), /no existe/);
  assert.match(worktreeProblem(goodWs({ branch: "main" }), { expectedBranch: BRANCH }), /branch/);
  assert.match(
    worktreeProblem(goodWs({ originSlug: "otro/repo" }), { expectedBranch: BRANCH, expectedRepo: "pachimanok/railharness" }),
    /apunta a/
  );
  assert.match(worktreeProblem(goodWs({ registered: false }), { expectedBranch: BRANCH }), /registrado/);
});

// ═══════════════════════════════════════════════════════════════════════
// RUNNER — the governed recover flow
// ═══════════════════════════════════════════════════════════════════════

test("§22.1 happy path: exactly one recover, zero claim, execution runs, one finishRun(COMPLETED) on the NEW Run", async () => {
  const api = fakeRail();
  const exec = resolvedExecution({ outcome: "COMPLETED", note: "listo" });
  const runner = makeRunner(api, exec);

  const result = await runner.recover(REF, { reason: "recuperar" });

  assert.equal(api.calls.recover.length, 1, "una sola llamada a recover");
  assert.equal(api.calls.claim.length, 0, "NUNCA se hace claim");
  assert.equal(result.outcome, "COMPLETED");
  assert.equal(result.code, RECOVERY_RESULT_CODES.RECOVERED);
  assert.equal(result.recoveredRunId, NEW_RUN);
  assert.equal(api.calls.finishRun.length, 1, "un único finishRun");
  assert.equal(api.calls.finishRun[0].runId, NEW_RUN, "finishRun sobre el Run recuperado");
  assert.equal(api.calls.finishRun[0].payload.outcome, "COMPLETED");
});

test("§22.2 recover uses the EXACT lastRunId — classic orphan -> last Run id; stale -> activeRun.id", async () => {
  {
    const api = fakeRail({ ticket: orphanTicket() });
    await makeRunner(api, resolvedExecution({ outcome: "COMPLETED" })).recover(REF);
    assert.equal(api.calls.recover[0].body.lastRunId, OLD_RUN);
  }
  {
    const api = fakeRail({ ticket: staleTicket() });
    await makeRunner(api, resolvedExecution({ outcome: "COMPLETED" })).recover(REF);
    assert.equal(api.calls.recover[0].body.lastRunId, STALE_RUN);
  }
});

test("§22.3 recover preserves the ticket branch on the request, the execution ctx and finishRun", async () => {
  const api = fakeRail();
  const exec = resolvedExecution({ outcome: "COMPLETED" });
  await makeRunner(api, exec).recover(REF);
  assert.equal(api.calls.recover[0].body.branch, BRANCH);
  assert.equal(exec.ctx.branch, BRANCH);
  assert.equal(api.calls.finishRun[0].payload.branch, BRANCH);
});

test("§22.4 recover reuses the valid worktree and PRESERVES uncommitted work (no reset/clean/checkout)", async () => {
  const api = fakeRail();
  const exec = resolvedExecution({ outcome: "COMPLETED" });
  const logs = [];
  const runner = makeRunner(api, exec, {
    inspectWorktree: () => goodWs({ dirty: true, path: "/ws/rail-d-00006" }),
    logger: l => logs.push(l)
  });
  const res = await runner.recover(REF);
  assert.equal(res.outcome, "COMPLETED");
  assert.equal(api.calls.recover[0].body.worktreePath, "/ws/rail-d-00006");
  assert.ok(logs.some(l => /sin commitear/.test(l) && /PRESERVA/.test(l)), "loguea que el trabajo sucio se preserva");
});

test("§22.5 recover NEVER falls back to claim — on every refusal path claim stays untouched", async () => {
  // preflight refusal
  {
    const api = fakeRail({ ticket: orphanTicket({ state: "READY" }) });
    const r = await makeRunner(api, heldExecution()).recover(REF);
    assert.equal(r.code, RECOVERY_RESULT_CODES.NOT_RECOVERABLE);
    assert.equal(api.calls.claim.length, 0);
    assert.equal(api.calls.recover.length, 0);
  }
  // recover endpoint error
  {
    const api = fakeRail({ recoverImpl: () => { throw Object.assign(new Error("boom"), { status: 500 }); } });
    const r = await makeRunner(api, heldExecution()).recover(REF);
    assert.equal(r.code, RECOVERY_RESULT_CODES.REJECTED);
    assert.equal(api.calls.claim.length, 0);
  }
});

test("§22.6 recover rejected (generic) => FAILED, no fallback claim, no compensating transition, no finishRun", async () => {
  const api = fakeRail({ recoverImpl: () => { throw Object.assign(new Error("rechazado"), { status: 500 }); } });
  const r = await makeRunner(api, heldExecution()).recover(REF);
  assert.equal(r.outcome, "FAILED");
  assert.equal(r.code, RECOVERY_RESULT_CODES.REJECTED);
  assert.equal(api.calls.claim.length, 0);
  assert.equal(api.calls.transition.length, 0);
  assert.equal(api.calls.finishRun.length, 0);
});

test("§22.7 recover 404/405/501 => fail-closed ENDPOINT_UNAVAILABLE, no claim, no other mutation", async () => {
  for (const status of [404, 405, 501]) {
    const api = fakeRail({ recoverImpl: () => { throw Object.assign(new Error("no route"), { status }); } });
    const logs = [];
    const r = await makeRunner(api, heldExecution(), { logger: l => logs.push(l) }).recover(REF);
    assert.equal(r.code, RECOVERY_RESULT_CODES.ENDPOINT_UNAVAILABLE, `status ${status}`);
    assert.equal(r.outcome, "BLOCKED");
    assert.equal(api.calls.claim.length, 0);
    assert.equal(api.calls.finishRun.length, 0);
    assert.equal(api.calls.transition.length, 0);
    assert.ok(logs.some(l => /no está desplegado/.test(l) && /NO se hace un claim/.test(l)));
  }
});

test("§22.8 a lease-live activeRun blocks recover: no POST, no claim", async () => {
  const t = staleTicket({ activeRun: { id: STALE_RUN, state: "ACTIVE", branch: BRANCH, leaseExpiresAt: isoIn(10 * 60_000) } });
  const api = fakeRail({ ticket: t });
  const r = await makeRunner(api, heldExecution()).recover(REF);
  assert.equal(r.code, RECOVERY_RESULT_CODES.NOT_RECOVERABLE);
  assert.equal(r.preflightCode, RECOVERY_CODES.LEASE_STILL_ACTIVE);
  assert.equal(api.calls.recover.length, 0);
  assert.equal(api.calls.claim.length, 0);
});

test("§22.9 recover response whose recoveryOfRunId != requested lastRunId => contract error, no execution", async () => {
  const api = fakeRail({
    recoverImpl: ({ body }) =>
      normalizeRunHandoff({
        activeRun: { id: NEW_RUN, state: "ACTIVE", claimToken: NEW_CT, leaseExpiresAt: isoIn(1e6) },
        recoveryOfRunId: "un-run-de-otro-ticket",
        cycle: { state: "IN_PROGRESS" }
      })
  });
  const exec = heldExecution();
  const r = await makeRunner(api, exec).recover(REF);
  assert.equal(r.code, RECOVERY_RESULT_CODES.RESPONSE_CONTRACT_ERROR);
  assert.equal(exec.ctx, null, "no se inicia ninguna ejecución");
  assert.equal(api.calls.finishRun.length, 0);
});

test("§22.9b recover response whose new runId === lastRunId => contract error (a recover must create a NEW Run)", async () => {
  const api = fakeRail({
    recoverImpl: ({ body }) =>
      normalizeRunHandoff({
        activeRun: { id: body.lastRunId, state: "ACTIVE", claimToken: NEW_CT, leaseExpiresAt: isoIn(1e6) },
        recoveryOfRunId: body.lastRunId
      })
  });
  const r = await makeRunner(api, heldExecution()).recover(REF);
  assert.equal(r.code, RECOVERY_RESULT_CODES.RESPONSE_CONTRACT_ERROR);
});

test("§22.10 worktree mismatch => fail-closed, recover endpoint NEVER called", async () => {
  const api = fakeRail();
  const r = await makeRunner(api, heldExecution(), { inspectWorktree: () => goodWs({ branch: "main" }) }).recover(REF);
  assert.equal(r.code, RECOVERY_RESULT_CODES.WORKSPACE_MISMATCH);
  assert.equal(api.calls.recover.length, 0);
  assert.equal(api.calls.claim.length, 0);
});

test("§22.10b worktree does not exist => fail-closed (recovery never recreates the worktree)", async () => {
  const api = fakeRail();
  const r = await makeRunner(api, heldExecution(), { inspectWorktree: () => goodWs({ exists: false }) }).recover(REF);
  assert.equal(r.code, RECOVERY_RESULT_CODES.WORKSPACE_MISMATCH);
  assert.equal(api.calls.recover.length, 0);
});

test("§22.11 recovered handoff without run.id => fail-closed; a read-only GET reports whether Rail made ownership", async () => {
  const api = fakeRail({ recoverImpl: () => normalizeRunHandoff({ ok: true }) });
  // after the failed recover, getTicket now shows an activeRun (Rail DID create one)
  const orig = api.getTicket.bind(api);
  let getN = 0;
  api.getTicket = async ref => {
    getN += 1;
    api.calls.getTicket.push(ref);
    return getN === 1 ? orphanTicket() : { ...orphanTicket(), activeRun: { id: NEW_RUN, state: "ACTIVE" } };
  };
  const exec = heldExecution();
  const r = await makeRunner(api, exec).recover(REF);
  assert.equal(r.code, RECOVERY_RESULT_CODES.RESPONSE_CONTRACT_ERROR);
  assert.equal(r.railCreatedOwnership, true);
  assert.equal(exec.ctx, null);
  assert.equal(api.calls.finishRun.length, 0);
});

test("§22.12 recovered handoff without claimToken => fail-closed, no execution, no finishRun", async () => {
  const api = fakeRail({
    recoverImpl: ({ body }) => normalizeRunHandoff({ activeRun: { id: NEW_RUN, state: "ACTIVE" }, recoveryOfRunId: body.lastRunId })
  });
  const exec = heldExecution();
  const r = await makeRunner(api, exec).recover(REF);
  assert.equal(r.code, RECOVERY_RESULT_CODES.RESPONSE_CONTRACT_ERROR);
  assert.equal(exec.ctx, null);
  assert.equal(api.calls.finishRun.length, 0);
});

test("§22.13 heartbeat during the recovered execution uses the NEW claimToken only", async () => {
  const api = fakeRail();
  const timers = fakeTimers();
  const exec = heldExecution();
  const runner = makeRunner(api, exec, {
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });
  const p = runner.recover(REF);
  await waitFor(() => Boolean(exec.ctx), { label: "ejecución recuperada iniciada" });
  await timers.fire();
  assert.equal(api.calls.heartbeat.length, 1);
  assert.equal(api.calls.heartbeat[0].runId, NEW_RUN);
  assert.equal(api.calls.heartbeat[0].claimToken, NEW_CT);
  runner.requestStop("fin de test");
  await p;
});

test("§22.14 heartbeat rejected => fencing: child cancelled, NO finishRun, no more heartbeats", async () => {
  const api = fakeRail({
    heartbeatImpl: () => { throw Object.assign(new Error("perdiste el Run"), { status: 409, code: "LEASE_LOST" }); }
  });
  const timers = fakeTimers();
  const exec = heldExecution();
  const logs = [];
  const runner = makeRunner(api, exec, {
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    logger: l => logs.push(l)
  });
  const p = runner.recover(REF);
  await waitFor(() => Boolean(exec.ctx), { label: "ejecución iniciada" });
  await timers.fire(); // heartbeat -> rejected -> fencing

  const result = await p;
  assert.equal(result.outcome, "FENCED");
  assert.equal(result.code, RECOVERY_RESULT_CODES.FENCED);
  assert.equal(exec.cancels.length, 1, "canceló el hijo");
  assert.equal(api.calls.finishRun.length, 0, "NO finishRun tras perder ownership");
  assert.ok(logs.some(l => /FENCING/.test(l)));

  await timers.fire(); // firing again must not heartbeat
  assert.equal(api.calls.heartbeat.length, 1);
});

test("§22.15 + §22.16 the PREVIOUS Run is never finished; the recovered Run is finished EXACTLY once", async () => {
  for (const [ticket, prevId] of [
    [orphanTicket(), OLD_RUN],
    [staleTicket(), STALE_RUN]
  ]) {
    const api = fakeRail({ ticket });
    await makeRunner(api, resolvedExecution({ outcome: "COMPLETED" })).recover(REF);
    assert.equal(api.calls.finishRun.length, 1);
    assert.equal(api.calls.finishRun[0].runId, NEW_RUN);
    assert.ok(api.calls.finishRun.every(f => f.runId !== prevId), "jamás se finaliza el Run anterior");
  }
});

test("§22.19 a PENDING Agent Query on the recovered run does not fabricate an answer: execute stays pending, no finishRun, heartbeat keeps going", async () => {
  const api = fakeRail();
  const timers = fakeTimers();
  const pendingExec = { ctx: null, cancels: [] };
  pendingExec.factory = ctx => {
    pendingExec.ctx = ctx;
    return { done: new Promise(() => {}), cancel(r) { pendingExec.cancels.push(r); } };
  };
  const runner = makeRunner(api, pendingExec, {
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });
  const p = runner.recover(REF);
  await waitFor(() => Boolean(pendingExec.ctx), { label: "ejecución iniciada" });
  await timers.fire();
  await timers.fire();
  assert.ok(api.calls.heartbeat.length >= 2, "sigue latiendo mientras la query está abierta");
  assert.equal(api.calls.finishRun.length, 0, "nunca finishRun con la query abierta");

  runner.requestStop("cierre de test");
  const r = await p;
  assert.equal(pendingExec.cancels.length, 1);
  assert.equal(r.code, RECOVERY_RESULT_CODES.STOPPED);
  assert.equal(api.calls.finishRun[0].payload.outcome, "RELEASED", "shutdown controlado -> RELEASED");
});

test("§22.29 an unknown execution outcome closes the recovered Run FAILED, never RELEASED", async () => {
  const api = fakeRail();
  const r = await makeRunner(api, resolvedExecution({ outcome: "WAT", note: "?" })).recover(REF);
  assert.equal(api.calls.finishRun[0].payload.outcome, "FAILED");
  assert.equal(r.outcome, "FAILED");
});

test("execution error (technical) closes the recovered Run FAILED", async () => {
  const api = fakeRail();
  const exec = { ctx: null, factory: null };
  exec.factory = ctx => {
    exec.ctx = ctx;
    return { done: Promise.reject(new Error("explotó")), cancel() {} };
  };
  const r = await makeRunner(api, exec).recover(REF);
  assert.equal(api.calls.finishRun[0].payload.outcome, "FAILED");
  assert.equal(r.outcome, "FAILED");
});

test("SIGINT during the recovered execution => controlled teardown, finishRun(RELEASED) once", async () => {
  const api = fakeRail();
  const exec = heldExecution();
  const runner = makeRunner(api, exec);
  const p = runner.recover(REF);
  await waitFor(() => Boolean(exec.ctx), { label: "ejecución iniciada" });
  runner.requestStop("Señal SIGTERM recibida");
  const r = await p;
  assert.equal(exec.cancels.length, 1);
  assert.equal(api.calls.finishRun.length, 1);
  assert.equal(api.calls.finishRun[0].runId, NEW_RUN);
  assert.equal(api.calls.finishRun[0].payload.outcome, "RELEASED");
  assert.equal(r.code, RECOVERY_RESULT_CODES.STOPPED);
});

test("a recovery runner instance recovers ONCE (a second recover() throws)", async () => {
  const api = fakeRail();
  const runner = makeRunner(api, resolvedExecution({ outcome: "COMPLETED" }));
  await runner.recover(REF);
  await assert.rejects(() => runner.recover(REF), /una sola recuperación/);
});

// ═══════════════════════════════════════════════════════════════════════
// SECURITY — the NEW claimToken is Core/runner-only; the child never sees RAIL_*
// ═══════════════════════════════════════════════════════════════════════

test("§22.21/22/23 the recovered execution context carries NO claimToken and NO RAIL_* / secret", async () => {
  const api = fakeRail();
  const exec = resolvedExecution({ outcome: "COMPLETED" });
  const logs = [];
  await makeRunner(api, exec, { logger: l => logs.push(l) }).recover(REF);

  const ctx = exec.ctx;
  assert.equal("claimToken" in ctx, false);
  assert.equal("claimToken" in ctx.run, false);
  const serialized = JSON.stringify(ctx);
  assert.ok(!serialized.includes(NEW_CT), "el claimToken nuevo no entra al contexto");
  assert.ok(!/RAIL_TOKEN|rag_/.test(serialized), "ningún secreto RAIL_* en el contexto");
  // and never in any human-facing log line
  for (const l of logs) assert.ok(!String(l).includes(NEW_CT), `log filtró el claimToken: ${l}`);
  // but the runner DID use it to talk to Rail
  assert.equal(api.calls.finishRun[0].payload.claimToken, NEW_CT);
});

// ═══════════════════════════════════════════════════════════════════════
// E2E — recovery -> Orchestration -> checks / transitions / finishRun
// ═══════════════════════════════════════════════════════════════════════

function scriptedRunRole(steps) {
  const seen = [];
  let i = 0;
  const fn = async args => {
    seen.push({ role: args.role, envelope: args.envelope });
    const step = steps[i++];
    if (!step) throw new Error(`sin paso para la llamada #${i} (${args.role})`);
    return interpretExecutionResult(args.role, step.result, args.envelope.session.id);
  };
  fn.seen = seen;
  return fn;
}
const okResult = (outcome = "IMPLEMENTED", extra = {}) => ({
  outcome,
  summary: `resultado ${outcome}`,
  question: null,
  context: null,
  impact: null,
  tests: extra.tests ?? (outcome === "IMPLEMENTED" ? ["npm test : PASS"] : []),
  filesChanged: extra.filesChanged ?? ["src/x.js"]
});

function e2eRunner(api, runRole, { humanOnlyStates = [], logger = () => {} } = {}) {
  return createRecoveryRunner({
    api,
    projectId: PID,
    workspaceRoot: "/ws",
    repoPath: "/repo",
    inspectWorktree: () => goodWs(),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger,
    createExecution: ctx =>
      createOrchestrationExecution(ctx, {
        api,
        runRole,
        workspaceRoot: "/ws",
        repoPath: "/repo",
        prepareWorkspace: async () => ({
          path: "/ws/rail-d-00006",
          branch: BRANCH,
          baseBranch: "main",
          repoFullName: REPO,
          created: false,
          reused: true
        }),
        startState: "IN_PROGRESS",
        humanOnlyStates,
        newSessionId: (() => { let n = 0; return () => `sess-${++n}`; })(),
        logger
      })
  });
}

test("E2E RECOVERY PATH: zero claim, exactly one recover, governed IMPLEMENTER->REVIEWER->TESTER, one finishRun(COMPLETED) on the recovered Run", async () => {
  const api = fakeRail();
  const runRole = scriptedRunRole([
    { result: okResult("IMPLEMENTED", { filesChanged: ["src/a.js"] }) },
    { result: okResult("IMPLEMENTED") },
    { result: okResult("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);
  const result = await e2eRunner(api, runRole).recover(REF);

  assert.equal(api.calls.claim.length, 0);
  assert.equal(api.calls.recover.length, 1);
  assert.equal(result.outcome, "COMPLETED");

  // first IMPLEMENTER runs as a RECOVERY continuation, not a cold IMPLEMENT
  assert.equal(runRole.seen[0].role, "IMPLEMENTER");
  assert.equal(runRole.seen[0].envelope.kind, "RECOVERY");
  assert.ok(runRole.seen[0].envelope.continuation, "lleva contexto de continuación");

  // §22.17/18 — no duplicated checks / transitions; NO CLAIMED->IN_PROGRESS
  const transitions = api.calls.transition.map(t => t.body.to);
  assert.deepEqual(transitions, ["REVIEWING", "TESTING", "SANDBOX_READY"]);
  assert.ok(!api.calls.transition.some(t => t.body.to === "IN_PROGRESS"), "no re-hace CLAIMED->IN_PROGRESS");
  const checkTypes = api.calls.createCheck.map(c => c.body.type);
  assert.deepEqual(checkTypes, ["IMPLEMENTATION", "CODE_REVIEW", "AUTOMATED_TESTS", "ACCEPTANCE_CRITERIA"]);

  // §22.20 — Reviewer != Tester (distinct fresh sessions)
  const bySession = {};
  for (const s of runRole.seen) bySession[s.role] = s.envelope.session.id;
  assert.notEqual(bySession.REVIEWER, bySession.TESTER);

  // §22.21 — the recovered run finished once, on the recovered Run id
  assert.equal(api.calls.finishRun.length, 1);
  assert.equal(api.calls.finishRun[0].runId, NEW_RUN);
  assert.equal(api.calls.finishRun[0].payload.outcome, "COMPLETED");

  // every governed call carries runId, never a claimToken
  for (const c of [...api.calls.createCheck, ...api.calls.transition]) {
    assert.equal(c.body.runId, NEW_RUN);
    assert.ok(!JSON.stringify(c.body).includes(NEW_CT));
  }
});

test("E2E REJECTION PATH: recover refused (endpoint absent) => zero execution, zero role runs, zero fallback claim", async () => {
  const api = fakeRail({ recoverImpl: () => { throw Object.assign(new Error("501"), { status: 501 }); } });
  const runRole = scriptedRunRole([]);
  const r = await e2eRunner(api, runRole).recover(REF);
  assert.equal(r.code, RECOVERY_RESULT_CODES.ENDPOINT_UNAVAILABLE);
  assert.equal(runRole.seen.length, 0, "no corre ningún rol");
  assert.equal(api.calls.claim.length, 0);
  assert.equal(api.calls.createCheck.length, 0);
  assert.equal(api.calls.transition.length, 0);
  assert.equal(api.calls.finishRun.length, 0);
});

test("E2E FENCING PATH: heartbeat rejected mid-orchestration => child aborted, zero later mutations, no finishRun", async () => {
  let beats = 0;
  const api = fakeRail({
    heartbeatImpl: () => { beats += 1; throw Object.assign(new Error("fenced"), { status: 410, code: "ABANDONED" }); }
  });
  const timers = fakeTimers();
  // a role runner that blocks forever on the first IMPLEMENTER so fencing can hit mid-flight
  const runRole = async () => new Promise(() => {});
  const runner = createRecoveryRunner({
    api,
    projectId: PID,
    workspaceRoot: "/ws",
    repoPath: "/repo",
    inspectWorktree: () => goodWs(),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    logger: () => {},
    createExecution: ctx =>
      createOrchestrationExecution(ctx, {
        api,
        runRole,
        workspaceRoot: "/ws",
        repoPath: "/repo",
        prepareWorkspace: async () => ({ path: "/ws/x", branch: BRANCH, baseBranch: "main", repoFullName: REPO, created: false, reused: true }),
        startState: "IN_PROGRESS",
        newSessionId: () => "s1",
        logger: () => {}
      })
  });
  const p = runner.recover(REF);
  await waitFor(() => api.calls.createCheck.length >= 0 && timers.box.fn != null, { label: "heartbeat armado" });
  await timers.fire(); // heartbeat -> fenced

  const r = await p;
  assert.equal(r.outcome, "FENCED");
  assert.equal(api.calls.finishRun.length, 0, "no finishRun tras fencing");
  const mutationsAfter = api.calls.transition.length + api.calls.createCheck.length;
  assert.equal(mutationsAfter, 0, "cero mutaciones posteriores");
});

test("E2E HUMAN-GATE PATH (T6-AC-04): a recovered run reaching a humanOnly frontier hands off with evidence, no fabricated approval", async () => {
  const api = fakeRail();
  const runRole = scriptedRunRole([
    { result: okResult("IMPLEMENTED") },
    { result: okResult("IMPLEMENTED") },
    { result: okResult("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);
  // make the FINAL frontier (SANDBOX_READY) humanOnly
  const r = await e2eRunner(api, runRole, { humanOnlyStates: ["SANDBOX_READY"] }).recover(REF);

  // HANDOFF maps to a COMPLETED Run (valid frontier, not RELEASED/FAILED)
  assert.equal(r.outcome, "COMPLETED");
  assert.equal(api.calls.finishRun[0].payload.outcome, "COMPLETED");
  // evidence checks were recorded, a governed note left, and NO transition into SANDBOX_READY
  assert.ok(api.calls.createCheck.some(c => c.body.type === "AUTOMATED_TESTS"));
  assert.ok(api.calls.addComment.length >= 1, "deja una nota gobernada para el humano");
  assert.ok(!api.calls.transition.some(t => t.body.to === "SANDBOX_READY"), "no fuerza la frontera humanOnly");
});

test("mapOrchestrationOutcome still: HANDOFF -> COMPLETED, CANCELLED -> RELEASED (unchanged by recovery)", () => {
  assert.equal(mapOrchestrationOutcome({ outcome: "HANDOFF" }).outcome, "COMPLETED");
  assert.equal(mapOrchestrationOutcome({ outcome: "CANCELLED" }).outcome, "RELEASED");
  assert.equal(mapOrchestrationOutcome({ outcome: "ZZZ" }).outcome, "FAILED");
});

// ═══════════════════════════════════════════════════════════════════════
// RAIL-D-00006 CORRECCIÓN CONTRACTUAL — /resume (semántica GENERAL)
// ═══════════════════════════════════════════════════════════════════════

function resumeStaleTicket(cycleState, over = {}) {
  return {
    projectId: PID,
    state: cycleState,
    blocked: false,
    activeRun: { id: STALE_RUN, state: "ACTIVE", branch: BRANCH, leaseExpiresAt: isoIn(-5 * 60_000) },
    item: { code: CODE, id: "tkt_6" },
    targetRepository: { repoFullName: REPO },
    runs: [{ id: STALE_RUN, state: "ACTIVE", branch: BRANCH, startedAt: isoIn(-1800_000) }],
    planning: { acceptance_criteria: [{ id: "T6-AC-01", given: "x", when: "y", then: "z" }] },
    ...over
  };
}
function resumeOwnerlessTicket(cycleState, lastRunState, over = {}) {
  return {
    projectId: PID,
    state: cycleState,
    blocked: false,
    activeRun: null,
    item: { code: CODE, id: "tkt_6" },
    targetRepository: { repoFullName: REPO },
    runs: [
      { id: "run-older", state: "FAILED", startedAt: isoIn(-3 * 3600_000) },
      { id: OLD_RUN, state: lastRunState, startedAt: isoIn(-3600_000) }
    ],
    planning: { acceptance_criteria: [{ id: "T6-AC-02", given: "x", when: "y", then: "z" }] },
    ...over
  };
}
function makeResumeRunner(api, exec, over = {}) {
  return createResumeRunner({
    api,
    projectId: PID,
    createExecution: ctx => exec.factory(ctx),
    workspaceRoot: "/ws",
    repoPath: "/repo",
    inspectWorktree: () => goodWs(),
    heartbeatIntervalMs: 1000,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: () => {},
    ...over
  });
}

// ── PURE resolveResumeTarget ──────────────────────────────────────────

test("resume PURE: stale takeover accepted from REVIEWING / TESTING / IN_PROGRESS / SANDBOX_READY (state PRESERVED)", () => {
  for (const st of ["IN_PROGRESS", "REVIEWING", "TESTING", "SANDBOX_READY"]) {
    const res = resolveResumeTarget(resumeStaleTicket(st), { projectId: PID, ref: REF, expectedBranch: BRANCH });
    assert.equal(res.recoverable, true, st);
    assert.equal(res.target, RESUME_TARGETS.STALE_TAKEOVER, st);
    assert.equal(res.lastRunId, STALE_RUN, st);
    assert.equal(res.cycleState, st, `${st} se preserva EXACTAMENTE`);
  }
});

test("resume PURE: ownerless accepted for a last Run in ANY non-ACTIVE state (COMPLETED/RELEASED/FAILED/ABANDONED)", () => {
  for (const lastState of ["COMPLETED", "RELEASED", "FAILED", "ABANDONED"]) {
    const res = resolveResumeTarget(resumeOwnerlessTicket("TESTING", lastState), {
      projectId: PID,
      ref: REF,
      expectedBranch: BRANCH
    });
    assert.equal(res.recoverable, true, lastState);
    assert.equal(res.target, RESUME_TARGETS.OWNERLESS, lastState);
    assert.equal(res.lastRunId, OLD_RUN, lastState);
    assert.equal(res.cycleState, "TESTING", lastState);
  }
});

test("resume PURE: ownerless with the last Run ACTIVE (activeRun==null) => inconsistency, fail-closed", () => {
  const res = resolveResumeTarget(resumeOwnerlessTicket("REVIEWING", "ACTIVE"), {
    projectId: PID,
    ref: REF,
    expectedBranch: BRANCH
  });
  assert.equal(res.recoverable, false);
  assert.equal(res.code, RESUME_CODES.CANDIDATE_ACTIVE_INCONSISTENT);
});

test("resume PURE: BLOCKED cycle => fail-closed (RailSoft /resume rechaza BLOCKED)", () => {
  const res = resolveResumeTarget(resumeStaleTicket("REVIEWING", { blocked: true }), {
    projectId: PID,
    ref: REF,
    expectedBranch: BRANCH
  });
  assert.equal(res.code, RESUME_CODES.CYCLE_BLOCKED);
});

test("resume PURE: terminal cycle state => fail-closed", () => {
  for (const st of ["DONE", "MERGED", "CLOSED", "CANCELLED", "COMPLETED", "RELEASED"]) {
    const res = resolveResumeTarget(resumeOwnerlessTicket(st, "COMPLETED"), {
      projectId: PID,
      ref: REF,
      expectedBranch: BRANCH
    });
    assert.equal(res.code, RESUME_CODES.CYCLE_TERMINAL, st);
  }
});

test("resume PURE: pre-ownership cycle state (READY/BACKLOG) => fail-closed (usar claim)", () => {
  for (const st of ["READY", "BACKLOG"]) {
    const res = resolveResumeTarget(resumeOwnerlessTicket(st, "FAILED"), {
      projectId: PID,
      ref: REF,
      expectedBranch: BRANCH
    });
    assert.equal(res.code, RESUME_CODES.CYCLE_PRE_OWNERSHIP, st);
  }
});

test("resume PURE: activeRun lease STILL live => fail-closed BEFORE any POST", () => {
  const t = resumeStaleTicket("REVIEWING", {
    activeRun: { id: STALE_RUN, state: "ACTIVE", branch: BRANCH, leaseExpiresAt: isoIn(10 * 60_000) }
  });
  const res = resolveResumeTarget(t, { projectId: PID, ref: REF, expectedBranch: BRANCH, now: () => Date.now() });
  assert.equal(res.code, RESUME_CODES.LEASE_STILL_ACTIVE);
  assert.equal(res.activeRunId, STALE_RUN);
});

test("resume PURE: an explicit lastRunId that is not the latest => LAST_RUN_NOT_LATEST", () => {
  const res = resolveResumeTarget(resumeOwnerlessTicket("REVIEWING", "COMPLETED"), {
    projectId: PID,
    ref: REF,
    expectedBranch: BRANCH,
    expectedLastRunId: "run-older" // a real but OLDER run of this cycle
  });
  assert.equal(res.code, RESUME_CODES.LAST_RUN_NOT_LATEST);
});

test("resume PURE: an explicit lastRunId from another cycle => LAST_RUN_FOREIGN", () => {
  const res = resolveResumeTarget(resumeOwnerlessTicket("REVIEWING", "COMPLETED"), {
    projectId: PID,
    ref: REF,
    expectedBranch: BRANCH,
    expectedLastRunId: "run-de-otro-ciclo"
  });
  assert.equal(res.code, RESUME_CODES.LAST_RUN_FOREIGN);
});

test("resume PURE: stale activeRun.branch != expected => BRANCH_MISMATCH", () => {
  const t = resumeStaleTicket("REVIEWING", {
    activeRun: { id: STALE_RUN, state: "ACTIVE", branch: "rail/other", leaseExpiresAt: isoIn(-1000) }
  });
  const res = resolveResumeTarget(t, { projectId: PID, ref: REF, expectedBranch: BRANCH });
  assert.equal(res.code, RESUME_CODES.BRANCH_MISMATCH);
});

// ── RUNNER — /resume drives api.resume, never api.recover/claim ────────

test("§14.3 stale ACTIVE lease uses api.resume (NOT api.recover, NOT claim)", async () => {
  const api = fakeRail({ ticket: resumeStaleTicket("REVIEWING") });
  const exec = resolvedExecution({ outcome: "COMPLETED" });
  const r = await makeResumeRunner(api, exec).resume(REF);
  assert.equal(api.calls.resume.length, 1, "una llamada a /resume");
  assert.equal(api.calls.recover.length, 0, "NUNCA /recover");
  assert.equal(api.calls.claim.length, 0, "NUNCA claim");
  assert.equal(r.outcome, "COMPLETED");
});

test("§14.4/5/6 stale takeover from REVIEWING / TESTING / IN_PROGRESS; ctx.recovery.cycleState PRESERVES the state", async () => {
  for (const st of ["REVIEWING", "TESTING", "IN_PROGRESS"]) {
    const api = fakeRail({ ticket: resumeStaleTicket(st) });
    const exec = resolvedExecution({ outcome: "COMPLETED" });
    await makeResumeRunner(api, exec).resume(REF);
    assert.equal(api.calls.resume[0].body.lastRunId, STALE_RUN, st);
    assert.equal(exec.ctx.recovery.cycleState, st, `${st} llega intacto al orquestador`);
    assert.equal(exec.ctx.recovery.operation, "resume", st);
  }
});

test("§14.8-11 ownerless + last Run COMPLETED/RELEASED/FAILED/ABANDONED => /resume permitido y ejecuta", async () => {
  for (const lastState of ["COMPLETED", "RELEASED", "FAILED", "ABANDONED"]) {
    const api = fakeRail({ ticket: resumeOwnerlessTicket("TESTING", lastState) });
    const exec = resolvedExecution({ outcome: "COMPLETED" });
    const r = await makeResumeRunner(api, exec).resume(REF);
    assert.equal(api.calls.resume.length, 1, lastState);
    assert.equal(api.calls.resume[0].body.lastRunId, OLD_RUN, lastState);
    assert.equal(r.outcome, "COMPLETED", lastState);
  }
});

test("§14.12/13 the OLD Run is never mutated and never finishRun'd (ownerless COMPLETED)", async () => {
  const ticket = resumeOwnerlessTicket("REVIEWING", "COMPLETED");
  const runsSnapshot = JSON.stringify(ticket.runs);
  const api = fakeRail({ ticket });
  await makeResumeRunner(api, resolvedExecution({ outcome: "COMPLETED" })).resume(REF);
  assert.equal(JSON.stringify(api.state.ticket.runs), runsSnapshot, "los Runs previos no se tocan");
  assert.ok(api.calls.finishRun.every(f => f.runId !== OLD_RUN && f.runId !== "run-older"));
  assert.equal(api.calls.finishRun.length, 1);
  assert.equal(api.calls.finishRun[0].runId, NEW_RUN);
});

test("§14.14 the new Run's recoveryOfRunId is the EXACT resolved lastRunId", async () => {
  const api = fakeRail({ ticket: resumeStaleTicket("REVIEWING") });
  const r = await makeResumeRunner(api, resolvedExecution({ outcome: "COMPLETED" })).resume(REF);
  assert.equal(r.fromRunId, STALE_RUN);
  assert.equal(api.calls.resume[0].body.lastRunId, STALE_RUN);
});

test("§14.15 ownerless + last Run ACTIVE => runner fails closed, NO POST", async () => {
  const api = fakeRail({ ticket: resumeOwnerlessTicket("REVIEWING", "ACTIVE") });
  const r = await makeResumeRunner(api, heldExecution()).resume(REF);
  assert.equal(r.code, RECOVERY_RESULT_CODES.NOT_RECOVERABLE);
  assert.equal(r.preflightCode, RESUME_CODES.CANDIDATE_ACTIVE_INCONSISTENT);
  assert.equal(api.calls.resume.length, 0);
  assert.equal(api.calls.recover.length, 0);
  assert.equal(api.calls.claim.length, 0);
});

test("§14.18 activeRun lease live => runner does NOT POST /resume", async () => {
  const t = resumeStaleTicket("REVIEWING", {
    activeRun: { id: STALE_RUN, state: "ACTIVE", branch: BRANCH, leaseExpiresAt: isoIn(10 * 60_000) }
  });
  const api = fakeRail({ ticket: t });
  const r = await makeResumeRunner(api, heldExecution()).resume(REF);
  assert.equal(r.preflightCode, RESUME_CODES.LEASE_STILL_ACTIVE);
  assert.equal(api.calls.resume.length, 0);
});

test("§14.19 BLOCKED cycle => runner does NOT POST anything (no recover/claim/transition either)", async () => {
  const api = fakeRail({ ticket: resumeStaleTicket("REVIEWING", { blocked: true }) });
  const r = await makeResumeRunner(api, heldExecution()).resume(REF);
  assert.equal(r.preflightCode, RESUME_CODES.CYCLE_BLOCKED);
  assert.equal(api.calls.resume.length, 0);
  assert.equal(api.calls.recover.length, 0);
  assert.equal(api.calls.claim.length, 0);
  assert.equal(api.calls.transition.length, 0);
});

test("§14.20 terminal cycle => runner does NOT POST /resume", async () => {
  const api = fakeRail({ ticket: resumeOwnerlessTicket("DONE", "COMPLETED") });
  const r = await makeResumeRunner(api, heldExecution()).resume(REF);
  assert.equal(r.preflightCode, RESUME_CODES.CYCLE_TERMINAL);
  assert.equal(api.calls.resume.length, 0);
});

test("§14.21/22 /resume rejected => NO fallback recover, NO fallback claim", async () => {
  const api = fakeRail({
    ticket: resumeStaleTicket("REVIEWING"),
    resumeImpl: () => { throw Object.assign(new Error("boom"), { status: 500 }); }
  });
  const r = await makeResumeRunner(api, heldExecution()).resume(REF);
  assert.equal(r.outcome, "FAILED");
  assert.equal(r.code, RECOVERY_RESULT_CODES.REJECTED);
  assert.equal(api.calls.recover.length, 0);
  assert.equal(api.calls.claim.length, 0);
  assert.equal(api.calls.finishRun.length, 0);
});

test("§14.23 /resume 404/405/501 => fail-closed ENDPOINT_UNAVAILABLE, no recover, no claim", async () => {
  for (const status of [404, 405, 501]) {
    const api = fakeRail({
      ticket: resumeStaleTicket("TESTING"),
      resumeImpl: () => { throw Object.assign(new Error("no route"), { status }); }
    });
    const logs = [];
    const r = await makeResumeRunner(api, heldExecution(), { logger: l => logs.push(l) }).resume(REF);
    assert.equal(r.code, RECOVERY_RESULT_CODES.ENDPOINT_UNAVAILABLE, `${status}`);
    assert.equal(api.calls.recover.length, 0);
    assert.equal(api.calls.claim.length, 0);
    assert.ok(logs.some(l => /no está desplegado/.test(l) && /recover de fallback/.test(l)));
  }
});

test("§14.24 workspace mismatch => NO /resume", async () => {
  const api = fakeRail({ ticket: resumeStaleTicket("REVIEWING") });
  const r = await makeResumeRunner(api, heldExecution(), {
    inspectWorktree: () => goodWs({ branch: "main" })
  }).resume(REF);
  assert.equal(r.code, RECOVERY_RESULT_CODES.WORKSPACE_MISMATCH);
  assert.equal(api.calls.resume.length, 0);
});

test("§14.25/26 /resume handoff without run.id / without claimToken => fail-closed, no execution", async () => {
  {
    const api = fakeRail({ ticket: resumeStaleTicket("REVIEWING"), resumeImpl: () => normalizeRunHandoff({ ok: true }) });
    const exec = heldExecution();
    const r = await makeResumeRunner(api, exec).resume(REF);
    assert.equal(r.code, RECOVERY_RESULT_CODES.RESPONSE_CONTRACT_ERROR);
    assert.equal(exec.ctx, null);
  }
  {
    const api = fakeRail({
      ticket: resumeStaleTicket("REVIEWING"),
      resumeImpl: ({ body }) => normalizeRunHandoff({ activeRun: { id: NEW_RUN, state: "ACTIVE" }, recoveryOfRunId: body.lastRunId })
    });
    const exec = heldExecution();
    const r = await makeResumeRunner(api, exec).resume(REF);
    assert.equal(r.code, RECOVERY_RESULT_CODES.RESPONSE_CONTRACT_ERROR);
    assert.equal(exec.ctx, null);
    assert.equal(api.calls.finishRun.length, 0);
  }
});

test("§14.27 heartbeat after /resume uses the NEW claimToken only", async () => {
  const api = fakeRail({ ticket: resumeStaleTicket("REVIEWING") });
  const timers = fakeTimers();
  const exec = heldExecution();
  const runner = makeResumeRunner(api, exec, {
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });
  const p = runner.resume(REF);
  await waitFor(() => Boolean(exec.ctx), { label: "ejecución reanudada" });
  await timers.fire();
  assert.equal(api.calls.heartbeat[0].runId, NEW_RUN);
  assert.equal(api.calls.heartbeat[0].claimToken, NEW_CT);
  runner.requestStop("fin");
  await p;
});

test("§14.28 fencing after /resume: child cancelled, NO finishRun, no more heartbeats", async () => {
  const api = fakeRail({
    ticket: resumeStaleTicket("TESTING"),
    heartbeatImpl: () => { throw Object.assign(new Error("lost"), { status: 410, code: "ABANDONED" }); }
  });
  const timers = fakeTimers();
  const exec = heldExecution();
  const runner = makeResumeRunner(api, exec, {
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn
  });
  const p = runner.resume(REF);
  await waitFor(() => Boolean(exec.ctx), { label: "ejecución reanudada" });
  await timers.fire();
  const r = await p;
  assert.equal(r.outcome, "FENCED");
  assert.equal(exec.cancels.length, 1);
  assert.equal(api.calls.finishRun.length, 0);
  await timers.fire();
  assert.equal(api.calls.heartbeat.length, 1);
});

test("a resume runner instance resumes ONCE (a second resume() throws)", async () => {
  const api = fakeRail({ ticket: resumeStaleTicket("REVIEWING") });
  const runner = makeResumeRunner(api, resolvedExecution({ outcome: "COMPLETED" }));
  await runner.resume(REF);
  await assert.rejects(() => runner.resume(REF), /una sola recuperación/);
});

test("SECURITY: the NEW claimToken never enters the resumed execution context / logs", async () => {
  const api = fakeRail({ ticket: resumeStaleTicket("REVIEWING") });
  const exec = resolvedExecution({ outcome: "COMPLETED" });
  const logs = [];
  await makeResumeRunner(api, exec, { logger: l => logs.push(l) }).resume(REF);
  const ctx = exec.ctx;
  assert.equal("claimToken" in ctx, false);
  assert.equal("claimToken" in ctx.run, false);
  assert.ok(!JSON.stringify(ctx).includes(NEW_CT));
  for (const l of logs) assert.ok(!String(l).includes(NEW_CT));
  assert.equal(api.calls.finishRun[0].payload.claimToken, NEW_CT);
});

// ── E2E /resume — state-aware continuation ────────────────────────────

function e2eResumeRunner(api, runRole, { humanOnlyStates = [], logger = () => {} } = {}) {
  return createResumeRunner({
    api,
    projectId: PID,
    workspaceRoot: "/ws",
    repoPath: "/repo",
    inspectWorktree: () => goodWs(),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger,
    createExecution: ctx =>
      createOrchestrationExecution(ctx, {
        api,
        runRole,
        workspaceRoot: "/ws",
        repoPath: "/repo",
        prepareWorkspace: async () => ({
          path: "/ws/rail-d-00006",
          branch: BRANCH,
          baseBranch: "main",
          repoFullName: REPO,
          created: false,
          reused: true
        }),
        // startState is DERIVED from the preserved cycle state — never forced.
        startState: ctx.recovery?.cycleState ?? "CLAIMED",
        humanOnlyStates,
        newSessionId: (() => { let n = 0; return () => `sess-${++n}`; })(),
        logger
      })
  });
}

test("E2E A — REVIEWING + stale activeRun => /resume, state PRESERVED, continue at REVIEWER (NO IMPLEMENTER, NO IMPLEMENTATION check)", async () => {
  const api = fakeRail({ ticket: resumeStaleTicket("REVIEWING") });
  const runRole = scriptedRunRole([
    { result: okResult("IMPLEMENTED") }, // REVIEWER PASS
    { result: okResult("IMPLEMENTED", { tests: ["npm test : PASS"] }) } // TESTER PASS
  ]);
  const r = await e2eResumeRunner(api, runRole).resume(REF);

  assert.equal(api.calls.claim.length, 0);
  assert.equal(api.calls.recover.length, 0);
  assert.equal(api.calls.resume.length, 1);
  assert.equal(r.outcome, "COMPLETED");

  // the roles that actually ran: REVIEWER then TESTER — NO IMPLEMENTER
  assert.deepEqual(runRole.seen.map(s => s.role), ["REVIEWER", "TESTER"]);
  // checks: NO IMPLEMENTATION (Rail already accepted it for this HEAD)
  assert.deepEqual(api.calls.createCheck.map(c => c.body.type), [
    "CODE_REVIEW",
    "AUTOMATED_TESTS",
    "ACCEPTANCE_CRITERIA"
  ]);
  // transitions: only the ones for stages NOT yet accepted; NO rewind to IN_PROGRESS
  assert.deepEqual(api.calls.transition.map(t => t.body.to), ["TESTING", "SANDBOX_READY"]);
  assert.ok(!api.calls.transition.some(t => t.body.to === "IN_PROGRESS"), "el estado no se rebobina");
  // one finish, on the new Run
  assert.equal(api.calls.finishRun.length, 1);
  assert.equal(api.calls.finishRun[0].runId, NEW_RUN);
  assert.equal(api.calls.finishRun[0].payload.outcome, "COMPLETED");
});

test("E2E B — TESTING + ownerless last Run COMPLETED => /resume, state PRESERVED, continue at TESTER only (NO CODE_REVIEW, NO IMPLEMENTATION duplication)", async () => {
  const ticket = resumeOwnerlessTicket("TESTING", "COMPLETED");
  const runsSnapshot = JSON.stringify(ticket.runs);
  const api = fakeRail({ ticket });
  const runRole = scriptedRunRole([
    { result: okResult("IMPLEMENTED", { tests: ["npm test : PASS"] }) } // TESTER PASS
  ]);
  const r = await e2eResumeRunner(api, runRole).resume(REF);

  assert.equal(r.outcome, "COMPLETED");
  assert.deepEqual(runRole.seen.map(s => s.role), ["TESTER"], "sólo corre el TESTER");
  assert.deepEqual(api.calls.createCheck.map(c => c.body.type), ["AUTOMATED_TESTS", "ACCEPTANCE_CRITERIA"]);
  assert.ok(!api.calls.createCheck.some(c => c.body.type === "CODE_REVIEW"), "no se duplica CODE_REVIEW");
  assert.ok(!api.calls.createCheck.some(c => c.body.type === "IMPLEMENTATION"), "no se duplica IMPLEMENTATION");
  assert.deepEqual(api.calls.transition.map(t => t.body.to), ["SANDBOX_READY"]);
  assert.equal(JSON.stringify(api.state.ticket.runs), runsSnapshot, "el Run viejo COMPLETED queda intacto");
  assert.equal(api.calls.finishRun.length, 1);
  assert.equal(api.calls.finishRun[0].runId, NEW_RUN);
});

test("E2E — resume into SANDBOX_READY (already at the frontier): nothing re-executed, Run finished COMPLETED", async () => {
  const api = fakeRail({ ticket: resumeStaleTicket("SANDBOX_READY") });
  const runRole = scriptedRunRole([]);
  const r = await e2eResumeRunner(api, runRole).resume(REF);
  assert.equal(r.outcome, "COMPLETED");
  assert.equal(runRole.seen.length, 0, "no corre ningún rol");
  assert.equal(api.calls.createCheck.length, 0);
  assert.equal(api.calls.transition.length, 0);
  assert.equal(api.calls.finishRun[0].runId, NEW_RUN);
  assert.equal(api.calls.finishRun[0].payload.outcome, "COMPLETED");
});

test("E2E — T6-AC-04: a RESUMED run reaching a humanOnly frontier hands off with evidence, no fabricated approval", async () => {
  const api = fakeRail({ ticket: resumeStaleTicket("REVIEWING") });
  const runRole = scriptedRunRole([
    { result: okResult("IMPLEMENTED") },
    { result: okResult("IMPLEMENTED", { tests: ["npm test : PASS"] }) }
  ]);
  const r = await e2eResumeRunner(api, runRole, { humanOnlyStates: ["SANDBOX_READY"] }).resume(REF);
  assert.equal(r.outcome, "COMPLETED"); // HANDOFF -> COMPLETED Run
  assert.ok(api.calls.createCheck.some(c => c.body.type === "AUTOMATED_TESTS"), "evidencia registrada");
  assert.ok(api.calls.addComment.length >= 1, "nota gobernada para el humano");
  assert.ok(!api.calls.transition.some(t => t.body.to === "SANDBOX_READY"), "no fuerza la frontera humanOnly");
});

test("E2E — /resume rejected mid-flight (endpoint absent): zero role runs, zero fallback recover/claim", async () => {
  const api = fakeRail({
    ticket: resumeStaleTicket("REVIEWING"),
    resumeImpl: () => { throw Object.assign(new Error("501"), { status: 501 }); }
  });
  const runRole = scriptedRunRole([]);
  const r = await e2eResumeRunner(api, runRole).resume(REF);
  assert.equal(r.code, RECOVERY_RESULT_CODES.ENDPOINT_UNAVAILABLE);
  assert.equal(runRole.seen.length, 0);
  assert.equal(api.calls.recover.length, 0);
  assert.equal(api.calls.claim.length, 0);
  assert.equal(api.calls.createCheck.length, 0);
  assert.equal(api.calls.transition.length, 0);
  assert.equal(api.calls.finishRun.length, 0);
});
