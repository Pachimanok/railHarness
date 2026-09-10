import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorkerCore, WORKER_PHASES } from "../src/worker/worker-core.js";
import { createPlaceholderExecution } from "../src/worker/placeholder-execution.js";

const PID = "proj_worker_core";
const CLAIM_TOKEN = "CT-super-secret-token-abc123";

const isoIn = ms => new Date(Date.now() + ms).toISOString();
const delay = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(predicate, { timeout = 1000, label = "condición" } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`timeout esperando ${label}`);
}

function readyTicketItem() {
  return { code: "RAIL-D-00002", id: "tkt_1", title: "Worker Core" };
}
function readyTicket(overrides = {}) {
  return {
    projectId: PID,
    state: "READY",
    blocked: false,
    activeRun: null,
    item: readyTicketItem(),
    ...overrides
  };
}

/**
 * Minimal in-memory Rail fake. One ticket. Records every call. Individual
 * behaviours are overridable per test.
 */
function fakeRail({
  projects = { items: [{ id: PID }] },
  ticket = readyTicket(),
  claimImpl,
  heartbeatImpl,
  listReadyAlwaysOffers = false
} = {}) {
  const calls = {
    listProjects: [],
    listReady: [],
    getTicket: [],
    claim: [],
    heartbeat: [],
    finishRun: []
  };
  const state = { ticket, claimed: false };

  const api = {
    calls,
    state,
    async listProjects() {
      calls.listProjects.push(1);
      if (projects instanceof Error) throw projects;
      return projects;
    },
    async listReady(projectId, limit) {
      calls.listReady.push({ projectId, limit });
      const offer =
        listReadyAlwaysOffers || (!state.claimed && state.ticket.state === "READY");
      return { items: offer ? [{ item: state.ticket.item }] : [] };
    },
    async getTicket(ref) {
      calls.getTicket.push(ref);
      return state.ticket;
    },
    async claim(ref, branch) {
      calls.claim.push({ ref, branch });
      if (claimImpl) return claimImpl({ ref, branch, state, calls });
      state.claimed = true;
      state.ticket = { ...state.ticket, state: "CLAIMED", activeRun: { id: "run-1" } };
      return {
        run: { id: "run-1", claimToken: CLAIM_TOKEN, leaseExpiresAt: isoIn(30 * 60_000) }
      };
    },
    async heartbeat(runId, claimToken) {
      calls.heartbeat.push({ runId, claimToken });
      if (heartbeatImpl) return heartbeatImpl({ runId, claimToken, calls });
      return { leaseExpiresAt: isoIn(45 * 60_000) };
    },
    async finishRun(runId, payload) {
      calls.finishRun.push({ runId, payload });
      return { ok: true };
    }
  };
  return api;
}

/** Execution whose `done` never settles on its own — only `cancel()` settles it. */
function heldExecution() {
  const cancels = [];
  let resolveDone;
  const done = new Promise(resolve => {
    resolveDone = resolve;
  });
  return {
    cancels,
    factory(ctx) {
      this.ctx = ctx;
      return {
        done,
        cancel(reason) {
          cancels.push(reason);
          resolveDone({ outcome: "RELEASED", note: `cancelada: ${reason}` });
        }
      };
    }
  };
}

/** Capturing timer double: exposes the scheduled callback for manual firing. */
function fakeTimers() {
  const box = { fn: null, ms: null, cleared: false, fires: 0 };
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
      box.fires += 1;
      box.fn();
      await delay(20);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────
// T2-AC-01 — cola vacía: valida conectividad, queda idle, re-consulta,
// no crea Run ni workspace.
// ─────────────────────────────────────────────────────────────────────────

test("T2-AC-01: cola vacía => valida conectividad, idle y re-poll sin crear Run", async () => {
  const api = fakeRail({ ticket: readyTicket({ state: "BACKLOG" }) });
  let polls = 0;
  let worker;
  const logs = [];
  worker = createWorkerCore({
    api,
    projectId: PID,
    createExecution: () => {
      throw new Error("no debe crear ejecución en idle");
    },
    sleep: async () => {
      polls += 1;
      if (polls >= 2) worker.requestStop("fin de test");
    },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: l => logs.push(l)
  });

  await worker.start();

  assert.equal(api.calls.listProjects.length, 1, "valida conectividad una vez");
  assert.ok(api.calls.listReady.length >= 2, "hace al menos dos ciclos de polling");
  assert.equal(api.calls.claim.length, 0, "no reclama nada: no crea Run");
  assert.equal(api.calls.finishRun.length, 0);
  assert.equal(worker.getState().phase, WORKER_PHASES.STOPPED);
  assert.ok(
    logs.some(l => /Conectividad con Rail verificada/.test(l)),
    "loguea la validación de conectividad en español"
  );
  assert.ok(logs.some(l => /Idle/.test(l) && /no se crea Run ni workspace/.test(l)));
});

// ─────────────────────────────────────────────────────────────────────────
// T2-AC-02 — ticket READY elegible: detalle + preflight + claim ANTES de
// habilitar la ejecución (mutación del repo).
// ─────────────────────────────────────────────────────────────────────────

test("T2-AC-02: preflight y claim ocurren antes de iniciar la ejecución", async () => {
  const order = [];
  const api = fakeRail();
  const origGetTicket = api.getTicket;
  const origClaim = api.claim;
  api.getTicket = async ref => {
    order.push("getTicket");
    return origGetTicket(ref);
  };
  api.claim = async (ref, branch) => {
    order.push("claim");
    return origClaim(ref, branch);
  };

  let execCtx = null;
  let worker;
  worker = createWorkerCore({
    api,
    projectId: PID,
    createExecution: ctx => {
      order.push("createExecution");
      execCtx = ctx;
      return { done: Promise.resolve({ outcome: "RELEASED" }), cancel() {} };
    },
    sleep: async () => worker.requestStop("fin de test"),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: () => {}
  });

  await worker.start();

  assert.deepEqual(order, ["getTicket", "claim", "createExecution"]);
  assert.equal(worker.getState().claimsWon, 1);
  assert.equal(execCtx.ref, "RAIL-D-00002");
  assert.equal(execCtx.run.id, "run-1");
  assert.equal(execCtx.branch, "rail/rail-d-00002");
  assert.ok(execCtx.ticket, "la ejecución recibe el ticket");
});

// ─────────────────────────────────────────────────────────────────────────
// T2-AC-03 — carrera: el perdedor del claim vuelve a discovery sin ejecutar.
// ─────────────────────────────────────────────────────────────────────────

test("T2-AC-03: si el claim lo gana otro worker, el perdedor vuelve a discovery", async () => {
  const api = fakeRail({
    claimImpl: () => {
      const err = new Error("otro worker ya reclamó este ticket");
      err.status = 409;
      err.code = "ALREADY_CLAIMED";
      throw err;
    }
  });
  let worker;
  const logs = [];
  worker = createWorkerCore({
    api,
    projectId: PID,
    createExecution: () => {
      throw new Error("el perdedor no debe ejecutar nada");
    },
    sleep: async () => worker.requestStop("fin de test"),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: l => logs.push(l)
  });

  await worker.start();

  assert.equal(api.calls.claim.length, 1, "intentó el claim una vez");
  assert.equal(worker.getState().claimsWon, 0);
  assert.equal(worker.getState().hasActiveExecution, false);
  assert.equal(api.calls.finishRun.length, 0);
  assert.ok(logs.some(l => /claim de RAIL-D-00002 no prosperó/.test(l)));
});

test("T2-AC-03: el ganador conserva ownership; un segundo worker que pierde no ejecuta", async () => {
  const shared = { taken: false };
  const winnerExec = heldExecution();

  const apiA = fakeRail({
    listReadyAlwaysOffers: true,
    claimImpl: () => {
      if (shared.taken) {
        const e = new Error("perdió la carrera");
        e.status = 409;
        throw e;
      }
      shared.taken = true;
      return {
        run: { id: "run-A", claimToken: "CT-A-secret-1", leaseExpiresAt: isoIn(30 * 60_000) }
      };
    }
  });
  let workerA;
  workerA = createWorkerCore({
    api: apiA,
    projectId: PID,
    createExecution: ctx => winnerExec.factory(ctx),
    sleep: async () => workerA.requestStop("fin A"),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: () => {}
  });
  const startA = workerA.start();
  await waitFor(() => workerA.getState().phase === WORKER_PHASES.EXECUTING, {
    label: "worker A EXECUTING"
  });
  assert.equal(workerA.getState().claimsWon, 1);

  // A second worker discovers the same ticket and loses the claim.
  const apiB = fakeRail({
    listReadyAlwaysOffers: true,
    claimImpl: () => {
      const e = new Error("perdió la carrera");
      e.status = 409;
      throw e;
    }
  });
  let workerB;
  let bExecStarted = false;
  workerB = createWorkerCore({
    api: apiB,
    projectId: PID,
    createExecution: () => {
      bExecStarted = true;
      return { done: new Promise(() => {}), cancel() {} };
    },
    sleep: async () => workerB.requestStop("fin B"),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: () => {}
  });
  await workerB.start();

  assert.equal(bExecStarted, false, "el perdedor no arranca ejecución");
  assert.equal(workerB.getState().claimsWon, 0);
  assert.equal(apiB.calls.finishRun.length, 0);

  // winner still owns its run
  assert.equal(workerA.getState().phase, WORKER_PHASES.EXECUTING);
  assert.equal(workerA.getState().hasActiveExecution, true);

  workerA.requestStop("cierre de test");
  await startA;
  assert.equal(workerA.getState().phase, WORKER_PHASES.STOPPED);
});

// ─────────────────────────────────────────────────────────────────────────
// T2-AC-04 — heartbeat periódico renueva la lease.
// ─────────────────────────────────────────────────────────────────────────

test("T2-AC-04: al vencer el intervalo, el Core renueva la lease vía heartbeat", async () => {
  const exec = heldExecution();
  const timers = fakeTimers();
  const newLease = isoIn(60 * 60_000);
  const api = fakeRail({ heartbeatImpl: () => ({ leaseExpiresAt: newLease }) });

  let worker;
  worker = createWorkerCore({
    api,
    projectId: PID,
    heartbeatIntervalMs: 5 * 60_000,
    createExecution: ctx => exec.factory(ctx),
    sleep: async () => worker.requestStop("fin de test"),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    logger: () => {}
  });
  const startP = worker.start();
  await waitFor(() => worker.getState().phase === WORKER_PHASES.EXECUTING, {
    label: "EXECUTING"
  });

  const leaseBefore = worker.getState().activeLeaseExpiresAt;
  assert.equal(timers.box.ms, 5 * 60_000, "el intervalo de heartbeat es el configurado");

  await timers.fire();

  assert.equal(api.calls.heartbeat.length, 1, "renovó la lease una vez");
  assert.equal(api.calls.heartbeat[0].runId, "run-1");
  assert.equal(api.calls.heartbeat[0].claimToken, CLAIM_TOKEN);
  assert.equal(worker.getState().activeLeaseExpiresAt, newLease);
  assert.notEqual(worker.getState().activeLeaseExpiresAt, leaseBefore);

  worker.requestStop("cierre de test");
  await startP;
});

// ─────────────────────────────────────────────────────────────────────────
// T2-AC-05 — fencing: heartbeat rechazado => cancela la ejecución y bloquea
// nuevas mutaciones sobre ese Run.
// ─────────────────────────────────────────────────────────────────────────

test("T2-AC-05: heartbeat rechazado por Rail => fencing (cancela ejecución, sin más mutaciones)", async () => {
  const exec = heldExecution();
  const timers = fakeTimers();
  const api = fakeRail({
    heartbeatImpl: () => {
      const err = new Error("el Run ya no te pertenece");
      err.status = 409;
      err.code = "LEASE_LOST";
      throw err;
    }
  });

  let worker;
  const logs = [];
  worker = createWorkerCore({
    api,
    projectId: PID,
    heartbeatIntervalMs: 1000,
    createExecution: ctx => exec.factory(ctx),
    sleep: async () => worker.requestStop("fin de test"),
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    logger: l => logs.push(l)
  });
  const startP = worker.start();
  await waitFor(() => worker.getState().phase === WORKER_PHASES.EXECUTING, {
    label: "EXECUTING"
  });

  await timers.fire(); // heartbeat -> rejected -> fencing

  assert.equal(exec.cancels.length, 1, "canceló el proceso hijo asociado");
  assert.equal(api.calls.finishRun.length, 0, "no hace finishRun tras perder ownership");
  assert.equal(api.calls.heartbeat.length, 1, "un solo intento de heartbeat");
  assert.ok(logs.some(l => /FENCING/.test(l)));

  // Firing the interval again must NOT produce another heartbeat.
  await timers.fire();
  assert.equal(api.calls.heartbeat.length, 1, "no hay heartbeat después del fencing");

  await startP; // loop drains: nothing READY -> sleep -> stop
  assert.equal(api.calls.finishRun.length, 0, "ninguna mutación sobre el Run tras el fencing");
  assert.ok(worker.getState().pollCount >= 2, "vuelve a discovery tras el fencing");
});

// ─────────────────────────────────────────────────────────────────────────
// T2-AC-06 — SIGINT/SIGTERM: deja de reclamar y finaliza/cancela controlado.
// ─────────────────────────────────────────────────────────────────────────

test("T2-AC-06: parada con ejecución activa => cancela el hijo y finaliza el Run (RELEASED)", async () => {
  const exec = heldExecution();
  const api = fakeRail();
  let worker;
  worker = createWorkerCore({
    api,
    projectId: PID,
    createExecution: ctx => exec.factory(ctx),
    sleep: async () => {},
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: () => {}
  });
  const startP = worker.start();
  await waitFor(() => worker.getState().phase === WORKER_PHASES.EXECUTING, {
    label: "EXECUTING"
  });

  worker.requestStop("Señal SIGTERM recibida");
  await startP;

  assert.equal(exec.cancels.length, 1, "canceló la ejecución activa");
  assert.equal(api.calls.finishRun.length, 1, "finalizó el Run que poseía");
  assert.equal(api.calls.finishRun[0].payload.outcome, "RELEASED");
  assert.equal(api.calls.finishRun[0].payload.claimToken, CLAIM_TOKEN);
  assert.equal(api.calls.finishRun[0].payload.branch, "rail/rail-d-00002");
  assert.equal(worker.getState().phase, WORKER_PHASES.STOPPED);
});

test("T2-AC-06: parada estando idle (sin hijo) => corta limpio sin reclamar ni finalizar Runs", async () => {
  const api = fakeRail({ ticket: readyTicket({ state: "BACKLOG" }) });
  let worker;
  worker = createWorkerCore({
    api,
    projectId: PID,
    createExecution: () => {
      throw new Error("no debe ejecutar");
    },
    sleep: async () => worker.requestStop("Señal SIGINT recibida"),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: () => {}
  });

  await worker.start();

  assert.equal(api.calls.claim.length, 0);
  assert.equal(api.calls.finishRun.length, 0);
  assert.equal(worker.getState().phase, WORKER_PHASES.STOPPED);
  assert.equal(worker.getState().stopReason, "Señal SIGINT recibida");
});

// ─────────────────────────────────────────────────────────────────────────
// Contrato de claim: 2xx sin runId/claimToken es fatal y no se reintenta.
// ─────────────────────────────────────────────────────────────────────────

test("claim 2xx sin runId/claimToken => error de contrato fatal, sin reintento ni ejecución", async () => {
  const api = fakeRail({ claimImpl: () => ({ run: { id: null, claimToken: null } }) });
  let execStarted = false;
  const worker = createWorkerCore({
    api,
    projectId: PID,
    createExecution: () => {
      execStarted = true;
      return { done: new Promise(() => {}), cancel() {} };
    },
    sleep: async () => {},
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: () => {}
  });

  await assert.rejects(() => worker.start(), /CLAIM_CONTRACT_ERROR/);
  assert.equal(api.calls.claim.length, 1, "no reintenta el claim");
  assert.equal(execStarted, false, "no continúa sin claimToken");
});

// ─────────────────────────────────────────────────────────────────────────
// Conectividad.
// ─────────────────────────────────────────────────────────────────────────

test("conectividad: si Rail no responde, el Worker Core no arranca y no reclama", async () => {
  const api = fakeRail({ projects: new Error("ECONNREFUSED") });
  const worker = createWorkerCore({
    api,
    projectId: PID,
    createExecution: () => ({ done: Promise.resolve(), cancel() {} }),
    sleep: async () => {},
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: () => {}
  });

  await assert.rejects(() => worker.start(), /No se pudo contactar a Rail/);
  assert.equal(api.calls.listReady.length, 0);
  assert.equal(api.calls.claim.length, 0);
});

test("conectividad: projectId no visible para el agente => aborta", async () => {
  const api = fakeRail({ projects: { items: [{ id: "otro_proyecto" }] } });
  const worker = createWorkerCore({
    api,
    projectId: PID,
    createExecution: () => ({ done: Promise.resolve(), cancel() {} }),
    sleep: async () => {},
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: () => {}
  });

  await assert.rejects(() => worker.start(), /no es visible para este agente/);
  assert.equal(api.calls.claim.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// claimToken confinado al Core: nunca en logs, nunca en la ejecución.
// ─────────────────────────────────────────────────────────────────────────

test("el claimToken vive sólo dentro del Core: no aparece en logs ni en el contexto de ejecución", async () => {
  const exec = heldExecution();
  const api = fakeRail();
  const logs = [];
  let worker;
  worker = createWorkerCore({
    api,
    projectId: PID,
    createExecution: ctx => exec.factory(ctx),
    sleep: async () => worker.requestStop("fin de test"),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: l => logs.push(l)
  });
  const startP = worker.start();
  await waitFor(() => worker.getState().phase === WORKER_PHASES.EXECUTING, {
    label: "EXECUTING"
  });
  worker.requestStop("cierre de test");
  await startP;

  // never in any human-facing log line
  for (const line of logs) {
    assert.ok(!String(line).includes(CLAIM_TOKEN), `log filtró el claimToken: ${line}`);
  }
  // never handed to the execution
  assert.ok(!JSON.stringify(exec.ctx).includes(CLAIM_TOKEN));
  assert.equal("claimToken" in exec.ctx, false);
  assert.equal("claimToken" in exec.ctx.run, false);

  // but the Core DID use it to talk to Rail
  assert.equal(api.calls.finishRun[0].payload.claimToken, CLAIM_TOKEN);

  // and getState() never surfaces it
  assert.ok(!JSON.stringify(worker.getState()).includes(CLAIM_TOKEN));
});

// ─────────────────────────────────────────────────────────────────────────
// Placeholder execution.
// ─────────────────────────────────────────────────────────────────────────

test("createPlaceholderExecution: no toca nada y sólo resuelve al cancelarse", async () => {
  const logs = [];
  const handle = createPlaceholderExecution(
    { ref: "RAIL-D-00002", run: { id: "run-1" }, branch: "rail/rail-d-00002" },
    { logger: l => logs.push(l) }
  );

  let settled = false;
  handle.done.then(() => {
    settled = true;
  });
  await delay(10);
  assert.equal(settled, false, "no resuelve por sí sola");

  handle.cancel("SIGINT");
  const result = await handle.done;
  assert.equal(result.outcome, "RELEASED");
  assert.ok(logs.some(l => /PLACEHOLDER/.test(l)));
  assert.ok(logs.some(l => /no se toca el repositorio/.test(l)));
});

test("integración: Worker Core + placeholder + parada controlada", async () => {
  const api = fakeRail();
  const logs = [];
  let worker;
  worker = createWorkerCore({
    api,
    projectId: PID,
    createExecution: ctx => createPlaceholderExecution(ctx, { logger: l => logs.push(l) }),
    sleep: async () => worker.requestStop("fin de test"),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: l => logs.push(l)
  });
  const startP = worker.start();
  await waitFor(() => worker.getState().phase === WORKER_PHASES.EXECUTING, {
    label: "EXECUTING"
  });
  worker.requestStop("Señal SIGTERM recibida");
  await startP;

  assert.equal(api.calls.claim.length, 1);
  assert.equal(api.calls.finishRun.length, 1);
  assert.equal(api.calls.finishRun[0].payload.outcome, "RELEASED");
  assert.equal(worker.getState().phase, WORKER_PHASES.STOPPED);
});

// ─────────────────────────────────────────────────────────────────────────
// N2 — an UNKNOWN execution outcome closes the Run FAILED, never RELEASED
// (aligned with mapOrchestrationOutcome's `<unknown> -> FAILED`).
// ─────────────────────────────────────────────────────────────────────────

test("N2: execution resuelve un outcome desconocido => finishRun(FAILED), nunca RELEASED por default", async () => {
  const api = fakeRail();
  let worker;
  worker = createWorkerCore({
    api,
    projectId: PID,
    createExecution: () => ({
      done: Promise.resolve({ outcome: "WAT", note: "outcome interno no reconocido" }),
      cancel() {}
    }),
    sleep: async () => worker.requestStop("fin de test"),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    logger: () => {}
  });

  await worker.start();

  assert.equal(api.calls.finishRun.length, 1);
  assert.equal(api.calls.finishRun[0].payload.outcome, "FAILED", "unknown -> FAILED, no RELEASED");
});

test("N2: shutdown/release genuino sigue cerrando RELEASED; COMPLETED y FAILED pasan igual", async () => {
  for (const [outcome, expected] of [
    ["COMPLETED", "COMPLETED"],
    ["FAILED", "FAILED"],
    ["RELEASED", "RELEASED"]
  ]) {
    const api = fakeRail();
    let worker;
    worker = createWorkerCore({
      api,
      projectId: PID,
      createExecution: () => ({ done: Promise.resolve({ outcome, note: "x" }), cancel() {} }),
      sleep: async () => worker.requestStop("fin de test"),
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
      logger: () => {}
    });
    await worker.start();
    assert.equal(api.calls.finishRun[0].payload.outcome, expected, `${outcome} pasa como ${expected}`);
  }
});
