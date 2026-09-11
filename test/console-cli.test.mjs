/**
 * Developer Console — CLI (HC-01-AC-01).
 *
 * Never blocks on real stdin: `menu` is always an injected fake that
 * resolves immediately, and `homeDir` always points at a throwaway temp
 * directory so `setup` / `doctor` never touch the real HOME.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli, MENU_ITEMS } from "../src/console/cli.js";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-cli-"));
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

/** Menu that returns queued VALUES in order, one per call — ignores `items`. */
function scriptedMenu(values) {
  let i = 0;
  return async () => {
    if (i >= values.length) throw new Error("scriptedMenu: se quedó sin respuestas");
    return values[i++];
  };
}

/**
 * Menu that picks queued LABELS out of the real `items` on each call and
 * returns the matching item's `.value` — needed whenever the menu's values
 * aren't the labels themselves (project objects, ticket refs), unlike
 * `MENU_ITEMS` where label and value happen to differ but the caller already
 * knows the value directly.
 */
function menuByLabel(labels) {
  let i = 0;
  return async ({ items }) => {
    if (i >= labels.length) throw new Error("menuByLabel: se quedó sin respuestas");
    const label = labels[i++];
    const found = items.find(it => it.label === label);
    if (!found) {
      throw new Error(`menuByLabel: no se encontró "${label}" entre [${items.map(it => it.label).join(", ")}]`);
    }
    return found.value;
  };
}

test("HC-01-AC-01: rail-harness (sin args) abre el menú principal y sale con 'Salir'", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = await runCli({
    argv: [],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false },
    menu: scriptedMenu(["exit"])
  });

  assert.equal(exitCode, 0);
  const text = lines.join("\n");
  assert.match(text, /Rail Harness/);
  assert.match(text, /Usuario: fran/);
  assert.match(text, /Servidor: harness-prod-01/);
  assert.match(text, /Chequeando entorno/);
  assert.match(text, /Hasta luego/);
});

test("MENU_ITEMS: expone exactamente las 4 opciones esperadas, en español", () => {
  assert.deepEqual(MENU_ITEMS.map(i => i.label), [
    "Empezar a trabajar",
    "Configurar entorno",
    "Doctor",
    "Salir"
  ]);
});

test("HC-02: 'Empezar a trabajar' sin credenciales de Rail NO arranca el Worker: muestra el aviso y vuelve segura al menú", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = await runCli({
    argv: [],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false },
    menu: scriptedMenu(["start", "exit"])
  });

  assert.equal(exitCode, 0);
  const text = lines.join("\n");
  assert.match(text, /RailSoft no está configurado para este usuario/);
  assert.match(text, /Contactá al administrador del Harness/);
  assert.match(text, /Hasta luego/, "vuelve al menú principal y permite salir con normalidad");
});

test("HC-02-AC-01/02/03/04: 'Empezar a trabajar' con Rail fake recorre proyecto -> ticket READY -> detalle, sin claim", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const calls = { listProjects: 0, listReady: [], getTicket: [] };
  const rail = {
    async listProjects() {
      calls.listProjects += 1;
      return { items: [{ id: "proj_totalview", name: "TotalView" }] };
    },
    async listReady(projectId) {
      calls.listReady.push(projectId);
      return { items: [{ item: { code: "TV-D-00125", id: "tkt_1", title: "Corregir rentabilidad" } }] };
    },
    async getTicket(ref) {
      calls.getTicket.push(ref);
      return {
        projectId: "proj_totalview",
        state: "READY",
        activeRun: null,
        item: { code: "TV-D-00125", title: "Corregir rentabilidad" },
        targetRepository: { repoFullName: "Pachimanok/totalview" }
      };
    }
  };

  const exitCode = await runCli({
    argv: [],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail", RAIL_TOKEN: "should-never-print" },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false },
    rail,
    menu: menuByLabel([
      "Empezar a trabajar",
      "TotalView",
      "TV-D-00125  Corregir rentabilidad",
      "Volver",
      "Volver",
      "Salir"
    ])
  });

  assert.equal(exitCode, 0);
  // "Volver" desde la lista de tickets vuelve al selector de proyectos, que
  // vuelve a consultar listProjects()/listReady() (siempre lectura fresca) —
  // por eso 2 llamadas, no 1. getTicket() sí se llama una sola vez: sólo
  // cuando el usuario elige efectivamente un ticket.
  assert.equal(calls.listProjects, 2);
  assert.deepEqual(calls.listReady, ["proj_totalview", "proj_totalview"]);
  assert.deepEqual(calls.getTicket, ["TV-D-00125"]);
  assert.equal(rail.claim, undefined, "el fake Rail ni siquiera expone claim()");

  const text = lines.join("\n");
  assert.match(text, /RailSoft conectado/);
  assert.match(text, /TotalView/);
  assert.match(text, /Ticket: TV-D-00125/);
  assert.match(text, /Estado: READY/);
  assert.match(text, /Proyecto: TotalView/);
  assert.match(text, /Repositorio: Pachimanok\/totalview/);
  assert.match(text, /El lanzamiento del Worker se habilitará en un próximo paso\./);
  assert.match(text, /Hasta luego/);
});

test("'Doctor' desde el menú imprime el reporte completo y vuelve al menú", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  await runCli({
    argv: [],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false },
    menu: scriptedMenu(["doctor", "exit"])
  });

  const text = lines.join("\n");
  assert.match(text, /Rail Harness Doctor/);
  assert.match(text, /6\/6 checks PASS/);
});

test("'Configurar entorno' desde el menú crea la config y vuelve al menú", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  await runCli({
    argv: [],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false },
    menu: scriptedMenu(["setup", "exit"])
  });

  assert.ok(fs.existsSync(path.join(home, ".config", "rail-harness", "config.json")));
  assert.match(lines.join("\n"), /Configuración creada/);
});

test("rail-harness doctor: corre los checks y termina (sin abrir el menú)", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = await runCli({
    argv: ["doctor"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false }
  });

  assert.equal(exitCode, 0);
  assert.match(lines.join("\n"), /Rail Harness Doctor/);
});

test("rail-harness doctor: exit code != 0 si un check falla", async t => {
  const home = tempHome(t);
  const { logger } = collectLogger();
  const err = Object.assign(new Error("nope"), { code: "ENOENT" });

  const exitCode = await runCli({
    argv: ["doctor"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: () => { throw err; },
    logger,
    output: { isTTY: false }
  });

  assert.notEqual(exitCode, 0);
});

test("rail-harness setup: prepara config.json y muestra el estado del entorno", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = await runCli({
    argv: ["setup"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false }
  });

  assert.equal(exitCode, 0);
  assert.ok(fs.existsSync(path.join(home, ".config", "rail-harness", "config.json")));
  assert.match(lines.join("\n"), /Configuración creada|Chequeando entorno/);
});

test("comando desconocido: sale con exit code 1 y no abre el menú", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = await runCli({
    argv: ["algo-inexistente"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    logger,
    output: { isTTY: false }
  });

  assert.equal(exitCode, 1);
  assert.match(lines.join("\n"), /Comando desconocido/);
});

// ─── HC-02 ────────────────────────────────────────────────────────────────

test("HC-02-AC-07: 'rail-harness' sin RAIL_API_URL/RAIL_TOKEN muestra el mensaje exacto y no crashea", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = await runCli({
    argv: [],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false },
    menu: scriptedMenu(["start", "exit"])
  });

  assert.equal(exitCode, 0);
  assert.ok(lines.includes("RailSoft no está configurado para este usuario."));
  assert.ok(lines.includes("Falta configurar las credenciales de Rail."));
  assert.ok(lines.includes("Contactá al administrador del Harness."));
});

test("rail-harness projects: lista los proyectos accesibles y termina (sin abrir el menú)", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();
  let calls = 0;
  const rail = {
    async listProjects() {
      calls += 1;
      return { items: [{ id: "p2", name: "Khai" }, { id: "p1", name: "TotalView" }] };
    }
  };

  const exitCode = await runCli({
    argv: ["projects"],
    env: { HOME: home },
    homeDir: home,
    logger,
    output: { isTTY: false },
    rail
  });

  assert.equal(exitCode, 0);
  assert.equal(calls, 1);
  assert.deepEqual(lines, ["p2  Khai", "p1  TotalView"]);
});

test("rail-harness projects: sin credenciales, sin rail inyectado => mensaje claro, exit 1, sin crash", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = await runCli({
    argv: ["projects"],
    env: { HOME: home },
    homeDir: home,
    logger,
    output: { isTTY: false }
  });

  assert.equal(exitCode, 1);
  assert.ok(lines.includes("RailSoft no está configurado para este usuario."));
});

test("rail-harness projects: cero proyectos es un estado válido (HC-02-AC-08)", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();
  const rail = { async listProjects() { return { items: [] }; } };

  const exitCode = await runCli({
    argv: ["projects"],
    env: { HOME: home },
    homeDir: home,
    logger,
    output: { isTTY: false },
    rail
  });

  assert.equal(exitCode, 0);
  assert.ok(lines.includes("No tenés proyectos disponibles en RailSoft."));
});

test("rail-harness doctor: con un rail fake OK agrega ✓ RailSoft / ✓ Identidad Rail autorizada sin tocar 6/6 checks PASS", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();
  const rail = { async listProjects() { return { items: [] }; } };

  const exitCode = await runCli({
    argv: ["doctor"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false },
    rail
  });

  assert.equal(exitCode, 0);
  const text = lines.join("\n");
  assert.match(text, /6\/6 checks PASS/);
  assert.match(text, /RailSoft/);
  assert.match(text, /Identidad Rail autorizada/);
});

test("HC-02-AC-06: después de 'start' (sin credenciales) + 'setup', config.json sigue sin ningún campo de Rail", async t => {
  const home = tempHome(t);
  const { logger } = collectLogger();

  await runCli({
    argv: [],
    env: { HOME: home, RAIL_TOKEN: "rag_should_never_be_persisted" },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false },
    menu: scriptedMenu(["start", "setup", "exit"])
  });

  const configPath = path.join(home, ".config", "rail-harness", "config.json");
  assert.ok(fs.existsSync(configPath));
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(config, { version: 1 });
});
