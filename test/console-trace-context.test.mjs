/**
 * HC-04 — injectable trace facade (`src/console/trace/context.js`).
 *
 * Every test points `homeDir` at a throwaway `os.tmpdir()` directory and
 * removes it afterwards (HC-04-AC-15). Covers the fail-safe contract
 * (HC-04-AC-14): a broken trace store must never throw out of any method.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTrace, detectSessionContext, createNoopTrace } from "../src/console/trace/context.js";
import { listSessions, countEvents, sessionFilePathFor } from "../src/console/trace/store.js";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-trace-ctx-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const fakeOsModule = { userInfo: () => ({ username: "fran" }), hostname: () => "harness-prod-01" };

// ─── HC-04-AC-06: identidad automática ─────────────────────────────────────

test("HC-04-AC-06: detectSessionContext detecta linuxUser/machine sin preguntar", () => {
  const ctx = detectSessionContext({ osModule: fakeOsModule, env: {} });
  assert.equal(ctx.linuxUser, "fran");
  assert.equal(ctx.machine, "harness-prod-01");
  assert.equal(ctx.sshSession, false);
});

test("SSH: sshSession es un booleano — nunca guarda el valor real de la variable", () => {
  const ctx = detectSessionContext({
    osModule: fakeOsModule,
    env: { SSH_CONNECTION: "10.0.0.5 22 10.0.0.9 22" }
  });
  assert.equal(ctx.sshSession, true);
  assert.equal(typeof ctx.sshSession, "boolean");
});

test("detectSessionContext cae a env.USER si osModule.userInfo() falla", () => {
  const throwing = { userInfo: () => { throw new Error("no info"); }, hostname: () => "m1" };
  const ctx = detectSessionContext({ osModule: throwing, env: { USER: "fallback-user" } });
  assert.equal(ctx.linuxUser, "fallback-user");
});

// ─── HC-04-AC-01 / AC-02: sesión + SESSION_STARTED exactamente una vez ─────

test("HC-04-AC-01/AC-02: start() crea una sesión única y SESSION_STARTED exactamente una vez", t => {
  const home = tempHome(t);
  const trace = createTrace({ homeDir: home, env: {}, osModule: fakeOsModule });

  const session = trace.start();
  trace.start(); // idempotent — no debería crear una segunda sesión ni un segundo evento
  trace.start();

  assert.match(session.id, /^rhs_/);
  assert.equal(listSessions(home).length, 1);
  assert.equal(countEvents(home), 1, "SESSION_STARTED debe registrarse exactamente una vez");
});

// ─── HC-04-AC-03/04/05: fin de sesión ───────────────────────────────────────

test("HC-04-AC-03: complete() dos veces persiste COMPLETED sin duplicar SESSION_COMPLETED", t => {
  const home = tempHome(t);
  const trace = createTrace({ homeDir: home, env: {}, osModule: fakeOsModule });
  trace.start();
  trace.complete();
  trace.complete();

  const [session] = listSessions(home);
  assert.equal(session.status, "COMPLETED");
  assert.equal(countEvents(home), 2, "SESSION_STARTED + SESSION_COMPLETED, sin duplicados");
});

test("HC-04-AC-04: fail() persiste FAILED + SESSION_FAILED", t => {
  const home = tempHome(t);
  const trace = createTrace({ homeDir: home, env: {}, osModule: fakeOsModule });
  trace.start();
  trace.fail();

  const [session] = listSessions(home);
  assert.equal(session.status, "FAILED");
  assert.equal(countEvents(home), 2);
});

test("HC-04-AC-05: abort() persiste ABORTED + SESSION_ABORTED", t => {
  const home = tempHome(t);
  const trace = createTrace({ homeDir: home, env: {}, osModule: fakeOsModule });
  trace.start();
  trace.abort();

  const [session] = listSessions(home);
  assert.equal(session.status, "ABORTED");
  assert.equal(countEvents(home), 2);
});

test("una sesión ya terminada por abort() no puede luego marcarse complete()", t => {
  const home = tempHome(t);
  const trace = createTrace({ homeDir: home, env: {}, osModule: fakeOsModule });
  trace.start();
  trace.abort();
  trace.complete();

  const [session] = listSessions(home);
  assert.equal(session.status, "ABORTED");
  assert.equal(countEvents(home), 2, "complete() tras abort() no debe agregar un SESSION_COMPLETED");
});

// ─── HC-04-AC-07/AC-08: proyecto / ticket seleccionados ────────────────────

test("HC-04-AC-07: recordEvent(PROJECT_SELECTED) persiste projectId/projectName en la sesión", t => {
  const home = tempHome(t);
  const trace = createTrace({ homeDir: home, env: {}, osModule: fakeOsModule });
  trace.start();
  trace.recordEvent("PROJECT_SELECTED", { projectId: "proj_1", metadata: { projectName: "TotalView" } });

  const [session] = listSessions(home);
  assert.equal(session.projectId, "proj_1");
  assert.equal(session.projectName, "TotalView");
});

test("HC-04-AC-08: recordEvent(TICKET_SELECTED) persiste ticketRef en la sesión", t => {
  const home = tempHome(t);
  const trace = createTrace({ homeDir: home, env: {}, osModule: fakeOsModule });
  trace.start();
  trace.recordEvent("TICKET_SELECTED", { projectId: "proj_1", ticketRef: "TV-D-00125" });

  const [session] = listSessions(home);
  assert.equal(session.ticketRef, "TV-D-00125");
});

test("recordEvent antes de start() es un no-op seguro", () => {
  const trace = createTrace({ homeDir: "/nonexistent", env: {}, osModule: fakeOsModule });
  assert.doesNotThrow(() => trace.recordEvent("DOCTOR_RUN"));
  assert.equal(trace.getSession(), null);
});

// ─── HC-04-AC-09: nunca guarda RAIL_TOKEN ni equivalentes ──────────────────

test("HC-04-AC-09: ningún evento ni sesión contiene RAIL_TOKEN o un valor equivalente", t => {
  const home = tempHome(t);
  const trace = createTrace({ homeDir: home, env: { RAIL_TOKEN: "rag_supersecret_should_never_persist" }, osModule: fakeOsModule });
  trace.start();
  trace.recordEvent("LOGIN_SUCCEEDED", { metadata: { result: "token=rag_supersecret_should_never_persist" } });
  trace.complete();

  const sessionRaw = fs.readFileSync(sessionFilePathFor(home, trace.getSession().id), "utf8");
  assert.ok(!sessionRaw.includes("rag_supersecret_should_never_persist"));

  const eventsDir = path.join(home, ".local", "state", "rail-harness", "events");
  const [file] = fs.readdirSync(eventsDir);
  const eventsRaw = fs.readFileSync(path.join(eventsDir, file), "utf8");
  assert.ok(!eventsRaw.includes("rag_supersecret_should_never_persist"));
  assert.ok(!eventsRaw.includes("RAIL_TOKEN"));
});

// ─── HC-04-AC-14: fail-safe ─────────────────────────────────────────────────

test("HC-04-AC-14: un trace store roto avisa una sola vez y nunca lanza", t => {
  const home = tempHome(t);
  // Fuerza que ensureStateDirsSecure() falle: un ARCHIVO regular donde
  // store.js necesita crear un directorio.
  fs.writeFileSync(path.join(home, ".local"), "esto no es un directorio");

  const warnings = [];
  const trace = createTrace({ homeDir: home, env: {}, osModule: fakeOsModule, onWarning: w => warnings.push(w) });

  assert.doesNotThrow(() => trace.start());
  assert.doesNotThrow(() => trace.recordEvent("DOCTOR_RUN"));
  assert.doesNotThrow(() => trace.recordEvent("SETUP_RUN"));
  assert.doesNotThrow(() => trace.complete());

  assert.equal(warnings.length, 1, "el warning debe mostrarse a lo sumo una vez");
  assert.match(warnings[0], /trazabilidad local/);
  assert.ok(!warnings[0].includes(home), "el warning no debe filtrar rutas locales");
});

test("createNoopTrace: todos los métodos son no-ops seguros", () => {
  const trace = createNoopTrace();
  assert.doesNotThrow(() => {
    trace.start();
    trace.recordEvent("DOCTOR_RUN");
    trace.complete();
    trace.fail();
    trace.abort();
  });
  assert.equal(trace.getSession(), null);
});
