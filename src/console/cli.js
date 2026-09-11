/**
 * Rail Harness Developer Console — CLI entry point (HC-01, Paso 1).
 *
 * `rail-harness` / `rail-harness doctor` / `rail-harness setup`.
 *
 * Strictly additive and isolated from the Worker Core: this module never
 * imports the Worker Core, Orchestration, Workspace Manager, Rail client or
 * adapters layers, never opens a network connection, and never launches the
 * worker process. "Empezar a trabajar" only prints a placeholder message —
 * project selection / claiming work is a later step.
 *
 * Everything that touches the outside world (`logger`, `menu`, `env`,
 * `homeDir`, doctor's `runGit` / `runClaude`) is injectable so tests never
 * block on real stdin or depend on real binaries / the real HOME.
 */

import os from "node:os";

import { renderBanner, selectMenu, formatCheckLine } from "./ui.js";
import {
  runDoctorChecks,
  getIdentity,
  doctorPassCount,
  doctorExitCode,
  condensedChecks
} from "./doctor.js";
import { ensureConfig, configFilePathFor } from "./config-store.js";

export const MENU_ITEMS = Object.freeze([
  { label: "Empezar a trabajar", value: "start" },
  { label: "Configurar entorno", value: "setup" },
  { label: "Doctor", value: "doctor" },
  { label: "Salir", value: "exit" }
]);

const NEXT_STEP_MESSAGE = "La selección de proyectos se habilitará en el próximo paso.";

function printBanner(logger, identity) {
  logger(renderBanner("Rail Harness"));
  logger("");
  logger(`Usuario: ${identity.username}`);
  logger(`Servidor: ${identity.hostname}`);
  logger("");
}

function printCondensed(logger, checks, isTTY) {
  logger("Chequeando entorno...");
  logger("");
  for (const c of condensedChecks(checks)) {
    logger(formatCheckLine(c, { isTTY }));
  }
  logger("");
}

function printDoctorReport(logger, checks, identity, isTTY) {
  logger("Rail Harness Doctor");
  logger("");
  logger(formatCheckLine({ label: `Linux user: ${identity.username}`, ok: true }, { isTTY }));
  logger(formatCheckLine({ label: `Machine: ${identity.hostname}`, ok: true }, { isTTY }));
  for (const c of checks) {
    logger(formatCheckLine(c, { isTTY }));
  }
  logger("");
  logger(`${doctorPassCount(checks)}/${checks.length} checks PASS`);
}

function runDoctor({ env, osModule, runGit, runClaude, homeDir }) {
  return runDoctorChecks({ env, osModule, runGit, runClaude, homeDir });
}

async function doctorCommand({ logger, env, osModule, runGit, runClaude, homeDir, output }) {
  const identity = getIdentity({ osModule, env });
  const checks = runDoctor({ env, osModule, runGit, runClaude, homeDir });
  printDoctorReport(logger, checks, identity, !!output?.isTTY);
  return doctorExitCode(checks);
}

async function setupCommand({ logger, env, osModule, runGit, runClaude, homeDir, output }) {
  const dir = homeDir || env.HOME || osModule.homedir?.();
  let result;
  try {
    result = ensureConfig(dir);
  } catch (err) {
    logger(`✗ No se pudo preparar la configuración local: ${err.message}`);
    return 1;
  }

  logger(
    result.created
      ? `Configuración creada en ${configFilePathFor(dir)}.`
      : `Configuración ya existente en ${configFilePathFor(dir)} (sin cambios).`
  );
  logger("");

  const checks = runDoctor({ env, osModule, runGit, runClaude, homeDir: dir });
  printCondensed(logger, checks, !!output?.isTTY);
  return 0;
}

async function mainMenuLoop({ logger, env, osModule, runGit, runClaude, homeDir, menu, output }) {
  const identity = getIdentity({ osModule, env });
  printBanner(logger, identity);

  const checks = runDoctor({ env, osModule, runGit, runClaude, homeDir });
  printCondensed(logger, checks, !!output?.isTTY);

  for (;;) {
    let choice;
    try {
      choice = await menu({ question: "¿Qué querés hacer?", items: MENU_ITEMS });
    } catch (err) {
      if (err?.code === "CANCELLED") {
        logger("Cancelado.");
        return 0;
      }
      throw err;
    }

    if (choice === "start") {
      logger("");
      logger(NEXT_STEP_MESSAGE);
      logger("");
      continue;
    }
    if (choice === "setup") {
      logger("");
      await setupCommand({ logger, env, osModule, runGit, runClaude, homeDir, output });
      logger("");
      continue;
    }
    if (choice === "doctor") {
      logger("");
      await doctorCommand({ logger, env, osModule, runGit, runClaude, homeDir, output });
      logger("");
      continue;
    }
    if (choice === "exit") {
      logger("Hasta luego.");
      return 0;
    }
  }
}

/**
 * Run the Developer Console. Returns a numeric exit code, never calls
 * `process.exit` itself (that's `bin/rail-harness.js`'s job).
 */
export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  logger = line => console.log(line),
  input = process.stdin,
  output = process.stdout,
  osModule = os,
  homeDir,
  runGit,
  runClaude,
  menu = opts => selectMenu({ ...opts, input, output })
} = {}) {
  const [command, ...rest] = argv;

  if (command === "doctor") {
    return doctorCommand({ logger, env, osModule, runGit, runClaude, homeDir, output });
  }
  if (command === "setup") {
    return setupCommand({ logger, env, osModule, runGit, runClaude, homeDir, output });
  }
  if (command) {
    logger(`Comando desconocido: "${command}".`);
    logger("Uso: rail-harness [doctor|setup]");
    return 1;
  }
  if (rest.length > 0) {
    logger(`Argumentos inesperados: ${rest.join(" ")}`);
    return 1;
  }

  return mainMenuLoop({ logger, env, osModule, runGit, runClaude, homeDir, menu, output });
}

export { NEXT_STEP_MESSAGE };
