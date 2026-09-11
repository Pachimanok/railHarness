/**
 * Rail Harness Developer Console — CLI entry point (HC-01 + HC-02).
 *
 * `rail-harness` / `rail-harness doctor` / `rail-harness setup` /
 * `rail-harness projects` / `rail-harness ready <projectId>`.
 *
 * Strictly additive and isolated from the Worker Core: this module never
 * imports the Worker Core, Orchestration, Workspace Manager or Adapters
 * layers, and never launches the worker process. Since HC-02 it DOES talk to
 * RailSoft, but STRICTLY READ-ONLY, and only through the read-only facade
 * (`rail-readonly.js` — `createReadonlyRail` exposes just `listProjects` /
 * `listReady` / `getTicket`). "Empezar a trabajar" lets the user browse
 * projects and READY tickets and inspect one; it NEVER claims a ticket and
 * NEVER starts the Worker — see `docs/HARNESS.md`.
 *
 * Everything that touches the outside world (`logger`, `menu`, `env`,
 * `homeDir`, `rail`, doctor's `runGit` / `runClaude`) is injectable so tests
 * never block on real stdin/network or depend on real binaries / the real
 * HOME.
 */

import os from "node:os";

import { renderBanner, selectMenu, formatCheckLine } from "./ui.js";
import {
  runDoctorChecks,
  runRailChecks,
  getIdentity,
  doctorPassCount,
  doctorExitCode,
  condensedChecks
} from "./doctor.js";
import { ensureConfig, configFilePathFor } from "./config-store.js";
import { buildReadonlyRailFromEnv } from "./rail-readonly.js";
import { selectProject, normalizeProjects, sortProjects } from "./project-selector.js";
import { selectTicket, normalizeReadyTickets, TICKET_SELECTOR_BACK } from "./ticket-selector.js";

export const MENU_ITEMS = Object.freeze([
  { label: "Empezar a trabajar", value: "start" },
  { label: "Configurar entorno", value: "setup" },
  { label: "Doctor", value: "doctor" },
  { label: "Salir", value: "exit" }
]);

const RAIL_NOT_CONFIGURED_LINES = Object.freeze([
  "RailSoft no está configurado para este usuario.",
  "",
  "Falta configurar las credenciales de Rail.",
  "Contactá al administrador del Harness."
]);

/**
 * Resolve `{ rail, error }` for a command: an explicitly injected `rail`
 * (tests) wins outright; otherwise it's built from `env`, validating
 * `RAIL_API_URL` (HTTPS, or HTTP only for `localhost`) BEFORE any request is
 * possible — see `rail-readonly.js`'s `buildReadonlyRailFromEnv`.
 */
function resolveRail({ env, rail }) {
  return rail ? { rail, error: null } : buildReadonlyRailFromEnv(env);
}

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

/**
 * `railChecks` (HC-02, optional) are printed AFTER the local-checks summary
 * line and never affect `X/Y checks PASS` / the exit code — RailSoft being
 * unreachable or unconfigured must never fail the local environment doctor.
 */
function printDoctorReport(logger, checks, identity, isTTY, railChecks = []) {
  logger("Rail Harness Doctor");
  logger("");
  logger(formatCheckLine({ label: `Linux user: ${identity.username}`, ok: true }, { isTTY }));
  logger(formatCheckLine({ label: `Machine: ${identity.hostname}`, ok: true }, { isTTY }));
  for (const c of checks) {
    logger(formatCheckLine(c, { isTTY }));
  }
  logger("");
  logger(`${doctorPassCount(checks)}/${checks.length} checks PASS`);
  if (railChecks.length) {
    logger("");
    for (const c of railChecks) {
      logger(formatCheckLine(c, { isTTY }));
    }
  }
}

function runDoctor({ env, osModule, runGit, runClaude, homeDir }) {
  return runDoctorChecks({ env, osModule, runGit, runClaude, homeDir });
}

async function doctorCommand({ logger, env, osModule, runGit, runClaude, homeDir, output, rail }) {
  const identity = getIdentity({ osModule, env });
  const checks = runDoctor({ env, osModule, runGit, runClaude, homeDir });
  const railChecks = await runRailChecks({ env, rail });
  printDoctorReport(logger, checks, identity, !!output?.isTTY, railChecks);
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

/**
 * "Empezar a trabajar" (HC-02): browse Rail projects → READY tickets →
 * read-only ticket detail. STRICTLY READ-ONLY — only ever calls
 * `rail.listProjects()` / `rail.listReady()` / `rail.getTicket()` (via
 * `project-selector.js` / `ticket-selector.js`). Never claims, never starts
 * the Worker. `rail`, when given, overrides the facade built from `env`
 * (tests inject a fake so this never touches the network).
 */
async function startCommand({ logger, env, osModule, runGit, runClaude, homeDir, menu, output, rail }) {
  const isTTY = !!output?.isTTY;
  logger("");

  const localChecks = runDoctor({ env, osModule, runGit, runClaude, homeDir });
  logger(formatCheckLine({ label: "Entorno local", ok: localChecks.every(c => c.ok) }, { isTTY }));

  const { rail: activeRail, error: railError } = resolveRail({ env, rail });
  if (railError) {
    logger(formatCheckLine({ label: "RailSoft conectado", ok: false }, { isTTY }));
    logger("");
    logger(railError);
    logger("");
    return;
  }
  if (!activeRail) {
    logger(formatCheckLine({ label: "RailSoft conectado", ok: false }, { isTTY }));
    logger("");
    for (const line of RAIL_NOT_CONFIGURED_LINES) logger(line);
    logger("");
    return;
  }

  for (;;) {
    let project;
    try {
      project = await selectProject({
        rail: activeRail,
        menu,
        logger,
        onConnected: () => logger(formatCheckLine({ label: "RailSoft conectado", ok: true }, { isTTY }))
      });
    } catch (err) {
      logger(formatCheckLine({ label: "RailSoft conectado", ok: false }, { isTTY }));
      logger("");
      logger(`No se pudo conectar a RailSoft (${err.message}).`);
      logger("");
      return;
    }

    if (!project) return; // "Volver" al menú principal (o sin proyectos disponibles)

    for (;;) {
      const outcome = await selectTicket({ rail: activeRail, project, menu, logger });
      if (outcome === TICKET_SELECTOR_BACK) break;
    }
  }
}

/**
 * `rail-harness projects` — read-only, lists accessible projects and exits.
 */
async function projectsCommand({ logger, env, rail }) {
  const { rail: activeRail, error: railError } = resolveRail({ env, rail });
  if (railError) {
    logger(railError);
    return 1;
  }
  if (!activeRail) {
    for (const line of RAIL_NOT_CONFIGURED_LINES) logger(line);
    return 1;
  }

  let raw;
  try {
    raw = await activeRail.listProjects();
  } catch (err) {
    logger(`No se pudo conectar a RailSoft (${err.message}).`);
    return 1;
  }

  const projects = sortProjects(normalizeProjects(raw));
  if (projects.length === 0) {
    logger("No tenés proyectos disponibles en RailSoft.");
    return 0;
  }
  for (const p of projects) {
    logger(`${p.id}  ${p.label}`);
  }
  return 0;
}

/**
 * `rail-harness ready <projectId>` — read-only, lists READY tickets for a
 * project and exits.
 */
async function readyCommand({ logger, env, rail, projectId }) {
  if (!projectId) {
    logger("Uso: rail-harness ready <projectId>");
    return 1;
  }

  const { rail: activeRail, error: railError } = resolveRail({ env, rail });
  if (railError) {
    logger(railError);
    return 1;
  }
  if (!activeRail) {
    for (const line of RAIL_NOT_CONFIGURED_LINES) logger(line);
    return 1;
  }

  let raw;
  try {
    raw = await activeRail.listReady(projectId);
  } catch (err) {
    logger(`No se pudo conectar a RailSoft (${err.message}).`);
    return 1;
  }

  const tickets = normalizeReadyTickets(raw);
  if (tickets.length === 0) {
    logger("No hay tickets READY para este proyecto.");
    return 0;
  }
  for (const t of tickets) {
    logger(`${t.ref}  ${t.title}`);
  }
  return 0;
}

async function mainMenuLoop({ logger, env, osModule, runGit, runClaude, homeDir, menu, output, rail }) {
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
      await startCommand({ logger, env, osModule, runGit, runClaude, homeDir, menu, output, rail });
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
      await doctorCommand({ logger, env, osModule, runGit, runClaude, homeDir, output, rail });
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
  rail,
  menu = opts => selectMenu({ ...opts, input, output })
} = {}) {
  const [command, ...rest] = argv;

  if (command === "doctor") {
    return doctorCommand({ logger, env, osModule, runGit, runClaude, homeDir, output, rail });
  }
  if (command === "setup") {
    return setupCommand({ logger, env, osModule, runGit, runClaude, homeDir, output });
  }
  if (command === "projects") {
    if (rest.length > 0) {
      logger(`Argumentos inesperados: ${rest.join(" ")}`);
      return 1;
    }
    return projectsCommand({ logger, env, rail });
  }
  if (command === "ready") {
    return readyCommand({ logger, env, rail, projectId: rest[0] });
  }
  if (command) {
    logger(`Comando desconocido: "${command}".`);
    logger("Uso: rail-harness [doctor|setup|projects|ready <projectId>]");
    return 1;
  }
  if (rest.length > 0) {
    logger(`Argumentos inesperados: ${rest.join(" ")}`);
    return 1;
  }

  return mainMenuLoop({ logger, env, osModule, runGit, runClaude, homeDir, menu, output, rail });
}
