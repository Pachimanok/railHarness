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

import { runCli, MENU_ITEMS, NEXT_STEP_MESSAGE } from "../src/console/cli.js";

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

/** Menu that returns queued values in order, one per call. */
function scriptedMenu(values) {
  let i = 0;
  return async () => {
    if (i >= values.length) throw new Error("scriptedMenu: se quedó sin respuestas");
    return values[i++];
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

test("'Empezar a trabajar' NO arranca el Worker: solo muestra el mensaje de próximo paso", async t => {
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
  assert.ok(lines.includes(NEXT_STEP_MESSAGE));
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
