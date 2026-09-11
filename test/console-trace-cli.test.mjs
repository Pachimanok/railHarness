/**
 * HC-04 — trace integration through `runCli` (`src/console/cli.js`).
 *
 * Every test points `homeDir` at a throwaway `os.tmpdir()` directory and
 * removes it afterwards (HC-04-AC-15). Uses the REAL, injectable `trace`
 * (built by `createTrace`) unless a test needs to assert something about the
 * facade itself — never mocks away the store, so these tests exercise the
 * genuine file-based trace.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/console/cli.js";
import { listSessions, countEvents, eventsDirFor } from "../src/console/trace/store.js";
import { createTrace } from "../src/console/trace/context.js";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-trace-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function collectLogger() {
  const lines = [];
  return { logger: line => lines.push(line), lines };
}

const fakeOsModule = { userInfo: () => ({ username: "fran" }), hostname: () => "harness-prod-01" };
const fakeRunGit = () => "git version 2.43.0";
const fakeRunClaude = () => "1.0.0";

function allEvents(home) {
  const dir = eventsDirFor(home);
  let events = [];
  for (const name of fs.readdirSync(dir)) {
    const raw = fs.readFileSync(path.join(dir, name), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  return events;
}

// ─── HC-04-AC-01 / AC-15: cada invocación crea su propia sesión ───────────

test("HC-04-AC-01/AC-15: rail-harness doctor crea un HarnessSession con id único, en homeDir temporal", async t => {
  const home = tempHome(t);
  const { logger } = collectLogger();

  await runCli({
    argv: ["doctor"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false }
  });

  const sessions = listSessions(home);
  assert.equal(sessions.length, 1);
  assert.match(sessions[0].id, /^rhs_/);
});

test("HC-04-AC-01: dos invocaciones separadas producen dos sesiones con id distinto", async t => {
  const home = tempHome(t);
  const { logger } = collectLogger();
  const opts = {
    argv: ["doctor"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false }
  };
  await runCli(opts);
  await runCli(opts);

  const sessions = listSessions(home);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].id, sessions[1].id);
});

// ─── HC-04-AC-06: identidad automática vía CLI ─────────────────────────────

test("HC-04-AC-06: la sesión registra linuxUser/machine detectados, no pedidos", async t => {
  const home = tempHome(t);
  await runCli({
    argv: ["doctor"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger: () => {},
    output: { isTTY: false }
  });

  const [session] = listSessions(home);
  assert.equal(session.linuxUser, "fran");
  assert.equal(session.machine, "harness-prod-01");
});

// ─── HC-04-AC-03: salida normal => COMPLETED + SESSION_COMPLETED ──────────

test("HC-04-AC-03: rail-harness doctor (salida normal) => COMPLETED + SESSION_COMPLETED", async t => {
  const home = tempHome(t);
  await runCli({
    argv: ["doctor"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger: () => {},
    output: { isTTY: false }
  });

  const [session] = listSessions(home);
  assert.equal(session.status, "COMPLETED");
  const events = allEvents(home);
  assert.ok(events.some(e => e.type === "SESSION_STARTED"));
  assert.ok(events.some(e => e.type === "SESSION_COMPLETED"));
  assert.ok(events.some(e => e.type === "DOCTOR_RUN"));
});

test("HC-04-AC-03: salir del menú interactivo con 'Salir' => COMPLETED", async t => {
  const home = tempHome(t);
  await runCli({
    argv: [],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger: () => {},
    output: { isTTY: false },
    menu: async () => "exit"
  });

  const [session] = listSessions(home);
  assert.equal(session.status, "COMPLETED");
});

// ─── HC-04-AC-04: error controlado => FAILED + SESSION_FAILED ────────────

test("HC-04-AC-04: una excepción no controlada durante el dispatch => FAILED + SESSION_FAILED, y se re-lanza", async t => {
  const home = tempHome(t);
  const boom = new Error("fallo simulado del menú");

  await assert.rejects(
    () =>
      runCli({
        argv: [],
        env: { HOME: home },
        osModule: fakeOsModule,
        homeDir: home,
        runGit: fakeRunGit,
        runClaude: fakeRunClaude,
        logger: () => {},
        output: { isTTY: false },
        menu: async () => {
          throw boom;
        }
      }),
    boom
  );

  const [session] = listSessions(home);
  assert.equal(session.status, "FAILED");
  const events = allEvents(home);
  assert.ok(events.some(e => e.type === "SESSION_FAILED"));
});

// ─── HC-04-AC-05: SIGINT / cancelación => ABORTED ─────────────────────────

test("HC-04-AC-05: cancelar el menú principal (Ctrl+C simulado) => ABORTED + SESSION_ABORTED", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const code = await runCli({
    argv: [],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false },
    menu: async () => {
      throw Object.assign(new Error("Cancelado por el usuario."), { code: "CANCELLED" });
    }
  });

  assert.equal(code, 0);
  assert.match(lines.join("\n"), /Cancelado\./);
  const [session] = listSessions(home);
  assert.equal(session.status, "ABORTED");
});

test("HC-04-AC-05: un SIGINT de proceso durante un comando en curso => ABORTED + processExit(130)", async t => {
  const home = tempHome(t);
  let exitCode = null;

  let resolveMenu;
  const hangingMenu = () => new Promise(resolve => { resolveMenu = resolve; });

  const runPromise = runCli({
    argv: [],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger: () => {},
    output: { isTTY: false },
    menu: hangingMenu,
    processExit: code => {
      exitCode = code;
    }
  });

  // Deja que runCli entre en el menú principal (banner + doctor + primer `menu()`).
  await new Promise(resolve => setImmediate(resolve));
  process.emit("SIGINT");
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(exitCode, 130);
  const [session] = listSessions(home);
  assert.equal(session.status, "ABORTED");

  // Libera el menú colgado para no dejar una promesa pendiente indefinidamente.
  resolveMenu?.("exit");
  await runPromise.catch(() => {});
});

// ─── Regresión: `rail-harness login` standalone cancelado en promptSecret ──
//
// Bug reportado: cancelar mientras `promptSecret` esperaba el token dejaba la
// HarnessSession como COMPLETED en vez de ABORTED, porque `loginCommand`
// atrapaba la cancelación internamente y devolvía un simple exit code 1 —
// indistinguible, desde `runCli`, de cualquier otro fallo "normal" (token
// vacío, credencial rechazada). La corrección general: la cancelación se
// propaga como `UserCancelledError` (`src/console/cancellation.js`) en vez
// de swallowearse, y es `runCli` quien decide el destino de la sesión.
test("HC-04-AC-05: `rail-harness login` standalone — promptSecret cancelado => sesión ABORTED", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = await runCli({
    argv: ["login"],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    osModule: fakeOsModule,
    homeDir: home,
    logger,
    output: { isTTY: false },
    readSecret: async () => {
      throw Object.assign(new Error("Cancelado por el usuario."), { code: "CANCELLED" });
    }
  });

  // Mensaje al usuario sin cambios respecto de HC-03.
  assert.match(lines.join("\n"), /Cancelado\./);

  // Control de salida: código de salida numérico normal, `runCli` nunca
  // rechaza por una cancelación del usuario (eso quedaría gobernado por
  // `bin/rail-harness.js` como "error fatal", lo cual sería incorrecto aquí).
  assert.equal(typeof exitCode, "number");
  assert.equal(exitCode, 1);

  // HC-04-AC-05: exactamente una sesión, terminada ABORTED con endedAt.
  const sessions = listSessions(home);
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(session.status, "ABORTED");
  assert.ok(session.endedAt, "endedAt debe estar seteado");

  // Exactamente un SESSION_ABORTED; cero SESSION_COMPLETED / SESSION_FAILED.
  const events = allEvents(home);
  const byType = type => events.filter(e => e.type === type).length;
  assert.equal(byType("SESSION_ABORTED"), 1);
  assert.equal(byType("SESSION_COMPLETED"), 0);
  assert.equal(byType("SESSION_FAILED"), 0);
  assert.equal(byType("SESSION_STARTED"), 1);

  // Ninguna credencial fue persistida.
  assert.equal(fs.existsSync(path.join(home, ".config", "rail-harness", "credentials.json")), false);
});

test("HC-04-AC-05: cancelar el login DESDE el menú interactivo NO termina la sesión (sólo cancela ese sub-paso)", async t => {
  const home = tempHome(t);

  const labels = ["Iniciar sesión", "Salir"];
  let i = 0;
  const menu = async ({ items }) => {
    const label = labels[i++];
    const found = items.find(it => it.label === label);
    if (!found) throw new Error(`no se encontró "${label}" entre [${items.map(it => it.label).join(", ")}]`);
    return found.value;
  };

  const code = await runCli({
    argv: [],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger: () => {},
    output: { isTTY: false },
    menu,
    readSecret: async () => {
      throw Object.assign(new Error("Cancelado por el usuario."), { code: "CANCELLED" });
    }
  });

  assert.equal(code, 0, "elegir 'Salir' después de cancelar el login debe salir normalmente");
  const [session] = listSessions(home);
  assert.equal(session.status, "COMPLETED", "cancelar el login anidado no debe abortar toda la sesión");

  const events = allEvents(home);
  const byType = type => events.filter(e => e.type === type).length;
  assert.equal(byType("SESSION_ABORTED"), 0);
  assert.equal(byType("SESSION_COMPLETED"), 1);
  assert.equal(byType("LOGIN_FAILED"), 1, "el intento de login cancelado sigue quedando registrado como evento funcional");
});

// ─── Requisito 8: credencial inválida NO debe clasificarse como ABORTED ────

test("HC-04-AC-05 / item 8: `rail-harness login` con credencial RECHAZADA (401) => COMPLETED, no ABORTED", async t => {
  const home = tempHome(t);

  const rail = {
    listProjects: async () => {
      throw Object.assign(new Error("Unauthorized"), { status: 401 });
    }
  };

  const exitCode = await runCli({
    argv: ["login"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    logger: () => {},
    output: { isTTY: false },
    rail,
    readSecret: async () => "rag_invalid_token"
  });

  assert.equal(exitCode, 1, "credencial rechazada sigue siendo exit code 1 (resultado funcional, no excepción)");

  const [session] = listSessions(home);
  assert.equal(session.status, "COMPLETED", "una credencial rechazada es un resultado normal del comando, no una cancelación");

  const events = allEvents(home);
  const byType = type => events.filter(e => e.type === type).length;
  assert.equal(byType("SESSION_ABORTED"), 0);
  assert.equal(byType("SESSION_FAILED"), 0);
  assert.equal(byType("SESSION_COMPLETED"), 1);
  assert.ok(events.some(e => e.type === "LOGIN_FAILED" && e.metadata?.reasonCode === "REJECTED"));

  assert.equal(fs.existsSync(path.join(home, ".config", "rail-harness", "credentials.json")), false);
});

// ─── HC-04-AC-07 / AC-08: proyecto y ticket seleccionados ─────────────────

test("HC-04-AC-07/AC-08: navegar proyecto + ticket registra PROJECT_SELECTED y TICKET_SELECTED con los datos correctos", async t => {
  const home = tempHome(t);

  const rail = {
    listProjects: async () => [{ id: "proj_1", name: "TotalView" }],
    listReady: async () => [{ item: { code: "TV-D-00125", title: "Corregir rentabilidad" } }],
    getTicket: async () => ({
      projectId: "proj_1",
      state: "READY",
      activeRun: null,
      item: { code: "TV-D-00125", title: "Corregir rentabilidad" },
      targetRepository: { repoFullName: "Pachimanok/totalview" }
    })
  };

  const labels = ["Empezar a trabajar", "TotalView", "TV-D-00125  Corregir rentabilidad", "Volver", "Volver", "Salir"];
  let i = 0;
  const menu = async ({ items }) => {
    const label = labels[i++];
    const found = items.find(it => it.label === label);
    if (!found) throw new Error(`no se encontró "${label}"`);
    return found.value;
  };

  await runCli({
    argv: [],
    env: { HOME: home, RAIL_TOKEN: "irrelevant-not-used-because-rail-is-injected" },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger: () => {},
    output: { isTTY: false },
    rail,
    menu
  });

  const events = allEvents(home);
  const projectSelected = events.find(e => e.type === "PROJECT_SELECTED");
  assert.ok(projectSelected);
  assert.equal(projectSelected.projectId, "proj_1");
  assert.equal(projectSelected.metadata.projectName, "TotalView");

  const ticketSelected = events.find(e => e.type === "TICKET_SELECTED");
  assert.ok(ticketSelected);
  assert.equal(ticketSelected.projectId, "proj_1");
  assert.equal(ticketSelected.ticketRef, "TV-D-00125");

  assert.ok(events.some(e => e.type === "TICKET_DETAIL_VIEWED" && e.ticketRef === "TV-D-00125"));

  const [session] = listSessions(home);
  assert.equal(session.projectId, "proj_1");
  assert.equal(session.ticketRef, "TV-D-00125");
});

// ─── HC-04-AC-09: nunca RAIL_TOKEN / equivalentes en ningún evento ────────

test("HC-04-AC-09: RAIL_TOKEN presente en el entorno nunca aparece en ningún HarnessEvent/HarnessSession", async t => {
  const home = tempHome(t);

  await runCli({
    argv: ["doctor"],
    env: { HOME: home, RAIL_TOKEN: "rag_supersecret_should_never_persist" },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger: () => {},
    output: { isTTY: false }
  });

  const events = allEvents(home);
  const eventsText = JSON.stringify(events);
  assert.ok(!eventsText.includes("rag_supersecret_should_never_persist"));
  assert.ok(!eventsText.includes("RAIL_TOKEN"));

  const [session] = listSessions(home);
  const sessionText = JSON.stringify(session);
  assert.ok(!sessionText.includes("rag_supersecret_should_never_persist"));
});

// ─── HC-04-AC-14: un trace store roto no bloquea la consola ───────────────

test("HC-04-AC-14: un trace store roto no impide usar `rail-harness doctor`", async t => {
  const home = tempHome(t);
  // Fuerza que el trace store falle: un ARCHIVO regular donde debería ir
  // el directorio de estado local.
  fs.mkdirSync(path.join(home, ".local"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local", "state"), "no es un directorio");

  const { logger, lines } = collectLogger();
  const code = await runCli({
    argv: ["doctor"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false }
  });

  assert.equal(code, 0);
  assert.match(lines.join("\n"), /checks PASS/);
});

// ─── HC-04-AC-17/18: sin fetch, sin worker, con `trace` inyectado explícito ─

test("HC-04-AC-18: pasar un `trace` inyectado explícito reemplaza por completo al real (no toca el filesystem)", async t => {
  const home = tempHome(t);
  const calls = [];
  const fakeTrace = {
    start: () => calls.push("start"),
    getSession: () => null,
    recordEvent: type => calls.push(`event:${type}`),
    complete: () => calls.push("complete"),
    fail: () => calls.push("fail"),
    abort: () => calls.push("abort")
  };

  await runCli({
    argv: ["doctor"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger: () => {},
    output: { isTTY: false },
    trace: fakeTrace
  });

  assert.deepEqual(calls, ["start", "event:DOCTOR_RUN", "complete"]);
  assert.equal(fs.existsSync(path.join(home, ".local")), false, "sin trace real inyectado, no debe escribirse nada");
});

test("HC-04-AC-16: `rail-harness trace status` / `trace recent` son exclusivamente locales", async t => {
  const home = tempHome(t);
  const originalFetch = global.fetch;
  global.fetch = () => {
    throw new Error("no debería llamarse fetch()");
  };
  t.after(() => { global.fetch = originalFetch; });

  const { logger: l1, lines: statusLines } = collectLogger();
  const codeStatus = await runCli({
    argv: ["trace", "status"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    logger: l1,
    output: { isTTY: false }
  });
  assert.equal(codeStatus, 0);
  assert.match(statusLines.join("\n"), /Rail Harness Trace/);

  const { logger: l2, lines: recentLines } = collectLogger();
  const codeRecent = await runCli({
    argv: ["trace", "recent"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    logger: l2,
    output: { isTTY: false }
  });
  assert.equal(codeRecent, 0);
  assert.match(recentLines.join("\n"), /sesiones recientes/);
});
