/**
 * HC-04 — `rail-harness trace status` / `rail-harness trace recent`
 * (`src/console/trace/commands.js`). Read-only, 100% local (HC-04-AC-16).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { traceStatusCommand, traceRecentCommand } from "../src/console/trace/commands.js";
import { createTrace } from "../src/console/trace/context.js";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-trace-cmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function collectLogger() {
  const lines = [];
  return { logger: line => lines.push(line), lines };
}

const fakeOsModule = { userInfo: () => ({ username: "fran" }), hostname: () => "harness-prod-01" };

test("trace status: sin sesiones previas reporta 0/0 y 'ninguna'", t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();
  const code = traceStatusCommand({ logger, homeDir: home });
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.match(text, /Rail Harness Trace/);
  assert.match(text, /Sesiones registradas: 0/);
  assert.match(text, /Eventos registrados: 0/);
  assert.match(text, /Última sesión: \(ninguna\)/);
});

test("HC-04-AC-16: trace status refleja sesiones/eventos reales sin hacer fetch", async t => {
  const home = tempHome(t);
  const originalFetch = global.fetch;
  global.fetch = () => {
    throw new Error("trace status no debería llamar a fetch()");
  };
  t.after(() => { global.fetch = originalFetch; });

  const trace = createTrace({ homeDir: home, env: {}, osModule: fakeOsModule });
  trace.start();
  trace.recordEvent("DOCTOR_RUN");
  trace.complete();

  const { logger, lines } = collectLogger();
  const code = traceStatusCommand({ logger, homeDir: home });
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.match(text, /Sesiones registradas: 1/);
  assert.match(text, /Eventos registrados: 3/); // SESSION_STARTED + DOCTOR_RUN + SESSION_COMPLETED
  assert.match(text, /Última sesión: rhs_/);
});

test("trace recent: sin sesiones informa que no hay ninguna", t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();
  const code = traceRecentCommand({ logger, homeDir: home });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /No hay sesiones registradas/);
});

test("HC-04-AC-16: trace recent lista las últimas sesiones, sin tocar la red", async t => {
  const home = tempHome(t);
  const originalFetch = global.fetch;
  global.fetch = () => {
    throw new Error("trace recent no debería llamar a fetch()");
  };
  t.after(() => { global.fetch = originalFetch; });

  const trace = createTrace({ homeDir: home, env: {}, osModule: fakeOsModule });
  trace.start();
  trace.complete();

  const { logger, lines } = collectLogger();
  const code = traceRecentCommand({ logger, homeDir: home });
  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.match(text, /Fecha\s+Usuario\s+Máquina\s+Estado/);
  assert.match(text, /fran/);
  assert.match(text, /harness-prod-01/);
  assert.match(text, /COMPLETED/);
});

test("trace status/recent nunca imprimen el contenido de metadata ni secretos", t => {
  const home = tempHome(t);
  const trace = createTrace({ homeDir: home, env: { RAIL_TOKEN: "rag_should_never_print" }, osModule: fakeOsModule });
  trace.start();
  trace.recordEvent("LOGIN_SUCCEEDED", { metadata: { result: "ok" } });
  trace.complete();

  const { logger: l1, lines: statusLines } = collectLogger();
  traceStatusCommand({ logger: l1, homeDir: home });
  const { logger: l2, lines: recentLines } = collectLogger();
  traceRecentCommand({ logger: l2, homeDir: home });

  const text = [...statusLines, ...recentLines].join("\n");
  assert.ok(!text.includes("rag_should_never_print"));
  assert.ok(!text.includes("RAIL_TOKEN"));
});
