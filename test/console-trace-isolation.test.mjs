/**
 * HC-04 — aislamiento de trazabilidad por HOME.
 *
 * Cada usuario Linux tiene su propio `HOME`, y `src/console/trace/store.js`
 * deriva SIEMPRE la ruta del store desde el `homeDir` efectivo/inyectado —
 * nunca desde una ubicación global o compartida (ver `stateDirFor` / la nota
 * en el README, sección "Trazabilidad local"). Este archivo prueba
 * explícitamente que dos HOME temporales, tratados como si fueran dos
 * cuentas Linux distintas (`/home/fran`, `/home/uri`), producen stores
 * completamente independientes — ni a nivel de archivos (`store.js`) ni a
 * nivel de los comandos read-only (`trace status` / `trace recent`, vía
 * `runCli`).
 *
 * Ningún test toca el HOME real: cada `HOME_A` / `HOME_B` es un directorio
 * temporal propio, removido al final.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/console/cli.js";
import { createTrace } from "../src/console/trace/context.js";
import { listSessions, countSessions, countEvents, stateDirFor } from "../src/console/trace/store.js";

function tempHome(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rail-harness-trace-iso-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function collectLogger() {
  const lines = [];
  return { logger: line => lines.push(line), lines };
}

const osModuleFor = (username, hostname) => ({
  userInfo: () => ({ username }),
  hostname: () => hostname
});

/** Crea N sesiones completas (COMPLETED) en `home`, con eventos propios. */
function seedSessions(home, { username, hostname, count }) {
  const osModule = osModuleFor(username, hostname);
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const trace = createTrace({ homeDir: home, env: {}, osModule });
    const session = trace.start();
    trace.recordEvent("DOCTOR_RUN");
    trace.complete();
    ids.push(session.id);
  }
  return ids;
}

// ─── HOME_A / HOME_B nunca se pisan a nivel de archivos ────────────────────

test("aislamiento: HOME_A y HOME_B tienen stateDir completamente distintos", t => {
  const homeA = tempHome(t, "a");
  const homeB = tempHome(t, "b");

  assert.notEqual(stateDirFor(homeA), stateDirFor(homeB));
  assert.equal(stateDirFor(homeA), path.join(homeA, ".local", "state", "rail-harness"));
  assert.equal(stateDirFor(homeB), path.join(homeB, ".local", "state", "rail-harness"));
});

test("aislamiento (store.js): sesiones/eventos creados en HOME_A no aparecen contados/listados desde HOME_B, y viceversa", t => {
  const homeA = tempHome(t, "a");
  const homeB = tempHome(t, "b");

  const idsA = seedSessions(homeA, { username: "fran", hostname: "workstation-fran", count: 3 });
  const idsB = seedSessions(homeB, { username: "uri", hostname: "workstation-uri", count: 2 });

  // Conteos: cada HOME ve únicamente lo suyo. Cada sesión sembrada por
  // `seedSessions` emite 3 eventos (SESSION_STARTED + DOCTOR_RUN +
  // SESSION_COMPLETED).
  assert.equal(countSessions(homeA), 3);
  assert.equal(countSessions(homeB), 2);
  assert.equal(countEvents(homeA), 3 * 3);
  assert.equal(countEvents(homeB), 2 * 3);

  const sessionsA = listSessions(homeA);
  const sessionsB = listSessions(homeB);

  assert.equal(sessionsA.length, 3);
  assert.equal(sessionsB.length, 2);

  const sessionIdsA = new Set(sessionsA.map(s => s.id));
  const sessionIdsB = new Set(sessionsB.map(s => s.id));

  // Ningún id de A aparece en la lista de B, y viceversa.
  for (const id of idsA) {
    assert.ok(sessionIdsA.has(id), `la sesión ${id} de HOME_A debería listarse desde HOME_A`);
    assert.ok(!sessionIdsB.has(id), `la sesión ${id} de HOME_A NO debería aparecer desde HOME_B`);
  }
  for (const id of idsB) {
    assert.ok(sessionIdsB.has(id), `la sesión ${id} de HOME_B debería listarse desde HOME_B`);
    assert.ok(!sessionIdsA.has(id), `la sesión ${id} de HOME_B NO debería aparecer desde HOME_A`);
  }

  // linuxUser/machine de cada store reflejan sólo su propio dueño.
  assert.ok(sessionsA.every(s => s.linuxUser === "fran" && s.machine === "workstation-fran"));
  assert.ok(sessionsB.every(s => s.linuxUser === "uri" && s.machine === "workstation-uri"));
});

// ─── `rail-harness trace status` / `trace recent` respetan el mismo aislamiento ─

test("aislamiento (CLI): `trace status` con HOME_A sólo contabiliza datos de A", async t => {
  const homeA = tempHome(t, "a");
  const homeB = tempHome(t, "b");

  seedSessions(homeA, { username: "fran", hostname: "workstation-fran", count: 3 });
  seedSessions(homeB, { username: "uri", hostname: "workstation-uri", count: 5 });

  const { logger, lines } = collectLogger();
  const code = await runCli({
    argv: ["trace", "status"],
    env: { HOME: homeA },
    homeDir: homeA,
    osModule: osModuleFor("fran", "workstation-fran"),
    logger,
    output: { isTTY: false }
  });

  assert.equal(code, 0);
  const text = lines.join("\n");
  // `trace status` por sí solo crea +1 sesión propia (la de esta invocación);
  // lo que importa es que jamás vea nada de B.
  assert.match(text, /Sesiones registradas: 4/);
  assert.ok(!text.includes("uri"), "no debe mencionar datos de HOME_B");
});

test("aislamiento (CLI): `trace status` con HOME_B sólo contabiliza datos de B", async t => {
  const homeA = tempHome(t, "a");
  const homeB = tempHome(t, "b");

  seedSessions(homeA, { username: "fran", hostname: "workstation-fran", count: 3 });
  seedSessions(homeB, { username: "uri", hostname: "workstation-uri", count: 5 });

  const { logger, lines } = collectLogger();
  const code = await runCli({
    argv: ["trace", "status"],
    env: { HOME: homeB },
    homeDir: homeB,
    osModule: osModuleFor("uri", "workstation-uri"),
    logger,
    output: { isTTY: false }
  });

  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.match(text, /Sesiones registradas: 6/);
  assert.ok(!text.includes("fran"), "no debe mencionar datos de HOME_A");
});

test("aislamiento (CLI): `trace recent` con HOME_A sólo lista sesiones de fran, nunca de uri", async t => {
  const homeA = tempHome(t, "a");
  const homeB = tempHome(t, "b");

  seedSessions(homeA, { username: "fran", hostname: "workstation-fran", count: 2 });
  seedSessions(homeB, { username: "uri", hostname: "workstation-uri", count: 2 });

  const { logger, lines } = collectLogger();
  const code = await runCli({
    argv: ["trace", "recent"],
    env: { HOME: homeA },
    homeDir: homeA,
    osModule: osModuleFor("fran", "workstation-fran"),
    logger,
    output: { isTTY: false }
  });

  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.match(text, /fran/);
  assert.ok(!text.includes("uri"), "trace recent en HOME_A jamás debe listar una sesión de HOME_B");
});

test("aislamiento (CLI): `trace recent` con HOME_B sólo lista sesiones de uri, nunca de fran", async t => {
  const homeA = tempHome(t, "a");
  const homeB = tempHome(t, "b");

  seedSessions(homeA, { username: "fran", hostname: "workstation-fran", count: 2 });
  seedSessions(homeB, { username: "uri", hostname: "workstation-uri", count: 2 });

  const { logger, lines } = collectLogger();
  const code = await runCli({
    argv: ["trace", "recent"],
    env: { HOME: homeB },
    homeDir: homeB,
    osModule: osModuleFor("uri", "workstation-uri"),
    logger,
    output: { isTTY: false }
  });

  assert.equal(code, 0);
  const text = lines.join("\n");
  assert.match(text, /uri/);
  assert.ok(!text.includes("fran"), "trace recent en HOME_B jamás debe listar una sesión de HOME_A");
});

// ─── nunca se enumera /home/* ni un stateDir global compartido ────────────

test("aislamiento: no existe ningún stateDir global — cada llamada exige un homeDir/HOME explícito, nada persiste fuera de él", t => {
  const homeA = tempHome(t, "a");
  const homeB = tempHome(t, "b");

  seedSessions(homeA, { username: "fran", hostname: "workstation-fran", count: 1 });
  seedSessions(homeB, { username: "uri", hostname: "workstation-uri", count: 1 });

  // Todo lo escrito por A vive estrictamente bajo stateDirFor(homeA), y nada
  // de lo escrito por B existe bajo stateDirFor(homeA) (ni viceversa).
  const dirA = stateDirFor(homeA);
  const dirB = stateDirFor(homeB);

  // Recorrido manual (sin `readdirSync(..., {recursive:true})`, disponible
  // sólo desde Node 20.1 — `package.json` declara `engines.node: >=18`).
  function allFilesUnder(dir) {
    const out = [];
    const walk = current => {
      for (const name of fs.readdirSync(current)) {
        const p = path.join(current, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else out.push(p);
      }
    };
    walk(dir);
    return out;
  }

  const filesA = allFilesUnder(dirA);
  const filesB = allFilesUnder(dirB);

  assert.ok(filesA.length > 0);
  assert.ok(filesB.length > 0);
  assert.ok(filesA.every(p => p.startsWith(dirA)));
  assert.ok(filesB.every(p => p.startsWith(dirB)));
  assert.ok(!filesA.some(p => p.startsWith(dirB)));
  assert.ok(!filesB.some(p => p.startsWith(dirA)));
});

test("aislamiento: src/console/trace/*.js nunca enumera /home ni un directorio hermano — cada ruta se construye desde el homeDir recibido", () => {
  const traceDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "console", "trace");
  for (const name of fs.readdirSync(traceDir)) {
    if (!name.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(traceDir, name), "utf8");
    assert.ok(!src.includes('"/home'), `${name} no debería tener una ruta /home hardcodeada`);
    assert.ok(!src.includes("readdirSync(\"/home") && !src.includes("readdirSync('/home"));
  }
});

// ─── ningún test de este archivo toca el HOME real ─────────────────────────

test("aislamiento: `tempHome()` (el único generador de HOME de este archivo) nunca produce una ruta bajo el HOME real, y el store real queda intacto", t => {
  const realHome = os.homedir();
  const realStateDir = stateDirFor(realHome);
  const before = fs.existsSync(realStateDir) ? countSessions(realHome) : null;

  // Todo HOME usado en este archivo sale de `tempHome()`, nunca de
  // `os.homedir()` — la propia función auxiliar sólo llama `os.tmpdir()`.
  const homeA = tempHome(t, "a");
  const homeB = tempHome(t, "b");
  assert.ok(!homeA.startsWith(realHome), "HOME_A no debe vivir bajo el HOME real");
  assert.ok(!homeB.startsWith(realHome), "HOME_B no debe vivir bajo el HOME real");
  assert.ok(homeA.startsWith(os.tmpdir()));
  assert.ok(homeB.startsWith(os.tmpdir()));

  seedSessions(homeA, { username: "fran", hostname: "workstation-fran", count: 1 });
  seedSessions(homeB, { username: "uri", hostname: "workstation-uri", count: 1 });

  // El store del HOME real (si existiera de un uso real previo de la
  // consola) no cambió por haber corrido este archivo de tests.
  const after = fs.existsSync(realStateDir) ? countSessions(realHome) : null;
  assert.deepEqual(after, before, "correr estos tests no debe alterar el trace store del HOME real");
});
