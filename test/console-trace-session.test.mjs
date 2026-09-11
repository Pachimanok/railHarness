/**
 * HC-04 — HarnessSession (`src/console/trace/session.js`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSession, withProject, withTicket, endSession, isTerminal, SESSION_STATUS } from "../src/console/trace/session.js";

test("HC-04-AC-01/AC-06: createSession arma el esquema exacto con id único", () => {
  const s1 = createSession({ linuxUser: "fran", machine: "harness-prod-01", sshSession: false });
  const s2 = createSession({ linuxUser: "fran", machine: "harness-prod-01", sshSession: false });

  assert.match(s1.id, /^rhs_/);
  assert.notEqual(s1.id, s2.id, "cada sesión debe tener un id único");
  assert.equal(s1.version, 1);
  assert.equal(s1.linuxUser, "fran");
  assert.equal(s1.machine, "harness-prod-01");
  assert.equal(s1.sshSession, false);
  assert.ok(!Number.isNaN(Date.parse(s1.startedAt)));
  assert.equal(s1.endedAt, null);
  assert.equal(s1.status, SESSION_STATUS.ACTIVE);
  assert.equal(s1.projectId, null);
  assert.equal(s1.projectName, null);
  assert.equal(s1.ticketRef, null);
});

test("HC-04: sólo existen los 4 estados documentados", () => {
  assert.deepEqual(Object.values(SESSION_STATUS).sort(), ["ABORTED", "ACTIVE", "COMPLETED", "FAILED"]);
});

test("HC-04-AC-07: withProject setea projectId/projectName sin mutar el original", () => {
  const s = createSession({ linuxUser: "fran", machine: "m1" });
  const s2 = withProject(s, { projectId: "proj_1", projectName: "TotalView" });
  assert.equal(s.projectId, null, "el original no debe mutar");
  assert.equal(s2.projectId, "proj_1");
  assert.equal(s2.projectName, "TotalView");
});

test("HC-04-AC-08: withTicket setea ticketRef sin mutar el original", () => {
  const s = createSession({ linuxUser: "fran", machine: "m1" });
  const s2 = withTicket(s, { ticketRef: "TV-D-00125" });
  assert.equal(s.ticketRef, null);
  assert.equal(s2.ticketRef, "TV-D-00125");
});

test("HC-04-AC-03: endSession(COMPLETED) fija status + endedAt", () => {
  const s = createSession({ linuxUser: "fran", machine: "m1" });
  const done = endSession(s, SESSION_STATUS.COMPLETED);
  assert.equal(done.status, "COMPLETED");
  assert.ok(!Number.isNaN(Date.parse(done.endedAt)));
  assert.ok(isTerminal(done));
});

test("HC-04-AC-04: endSession(FAILED) fija status + endedAt", () => {
  const s = createSession({ linuxUser: "fran", machine: "m1" });
  const failed = endSession(s, SESSION_STATUS.FAILED);
  assert.equal(failed.status, "FAILED");
  assert.ok(failed.endedAt);
});

test("HC-04-AC-05: endSession(ABORTED) fija status + endedAt", () => {
  const s = createSession({ linuxUser: "fran", machine: "m1" });
  const aborted = endSession(s, SESSION_STATUS.ABORTED);
  assert.equal(aborted.status, "ABORTED");
  assert.ok(aborted.endedAt);
});

test("HC-04: una sesión terminal no puede volver a transicionar (idempotente)", () => {
  const s = endSession(createSession({ linuxUser: "fran", machine: "m1" }), SESSION_STATUS.COMPLETED);
  const again = endSession(s, SESSION_STATUS.FAILED);
  assert.equal(again.status, "COMPLETED", "una sesión ya terminal no cambia de estado");
  assert.equal(again.endedAt, s.endedAt);
});

test("HC-04: endSession rechaza un estado no terminal", () => {
  const s = createSession({ linuxUser: "fran", machine: "m1" });
  assert.throws(() => endSession(s, "ACTIVE"));
  assert.throws(() => endSession(s, "PAUSED"));
});
