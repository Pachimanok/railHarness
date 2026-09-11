/**
 * Rail Harness Developer Console — CLI entry point (HC-01 + HC-02 + HC-03 + HC-04).
 *
 * `rail-harness` / `rail-harness doctor` / `rail-harness setup` /
 * `rail-harness projects` / `rail-harness ready <projectId>` /
 * `rail-harness login` / `rail-harness logout` / `rail-harness auth status` /
 * `rail-harness trace status` / `rail-harness trace recent`.
 *
 * Since HC-04, every invocation creates its own local `HarnessSession`
 * (`trace/` — `src/console/trace/context.js`'s injectable `trace` facade)
 * recording WHO ran the console, WHERE, WHEN and WHICH functional screens
 * were used — never keystrokes, shell commands, stdin, source code or
 * secrets. Purely local (`~/.local/state/rail-harness/`), best-effort (a
 * broken trace store degrades to a warning, never blocks the console) and
 * fully separate from RailSoft — see `docs/HARNESS.md`.
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
 * Since HC-03, the Rail token itself may come from `env.RAIL_TOKEN` (HC-02,
 * unchanged) OR from the developer's own locally stored personal credential
 * (`rail-harness login` — `credential-store.js`, resolved by
 * `credential-resolve.js`); `env.RAIL_TOKEN` always wins when present. The
 * interactive main menu reflects this: unauthenticated shows "Iniciar
 * sesión", authenticated shows "Empezar a trabajar" / "Proyectos" /
 * "Cerrar sesión".
 *
 * Everything that touches the outside world (`logger`, `menu`, `env`,
 * `homeDir`, `rail`, `readSecret`, doctor's `runGit` / `runClaude`) is
 * injectable so tests never block on real stdin/network or depend on real
 * binaries / the real HOME.
 */

import os from "node:os";

import { renderBanner, selectMenu, formatCheckLine } from "./ui.js";
import {
  runDoctorChecks,
  runCredentialCheck,
  runRailIdentityChecks,
  getIdentity,
  doctorPassCount,
  doctorExitCode,
  condensedChecks
} from "./doctor.js";
import { ensureConfig, configFilePathFor } from "./config-store.js";
import { buildReadonlyRailFromCredentials } from "./rail-readonly.js";
import { resolveCredentials } from "./credential-resolve.js";
import { loginCommand, logoutCommand, authStatusCommand } from "./auth.js";
import { selectProject, normalizeProjects, sortProjects } from "./project-selector.js";
import { selectTicket, normalizeReadyTickets, TICKET_SELECTOR_BACK } from "./ticket-selector.js";
import { createTrace } from "./trace/context.js";
import { traceStatusCommand, traceRecentCommand } from "./trace/commands.js";
import { isUserCancelled } from "./cancellation.js";

// Kept for backward compatibility (HC-01/HC-02): the HC-03 interactive main
// menu is now auth-aware and picks between `AUTHENTICATED_MENU_ITEMS` /
// `UNAUTHENTICATED_MENU_ITEMS` below instead of this fixed list.
export const MENU_ITEMS = Object.freeze([
  { label: "Empezar a trabajar", value: "start" },
  { label: "Configurar entorno", value: "setup" },
  { label: "Doctor", value: "doctor" },
  { label: "Salir", value: "exit" }
]);

const AUTHENTICATED_MENU_ITEMS = Object.freeze([
  { label: "Empezar a trabajar", value: "start" },
  { label: "Proyectos", value: "projects" },
  { label: "Configurar entorno", value: "setup" },
  { label: "Doctor", value: "doctor" },
  { label: "Cerrar sesión", value: "logout" },
  { label: "Salir", value: "exit" }
]);

const UNAUTHENTICATED_MENU_ITEMS = Object.freeze([
  { label: "Iniciar sesión", value: "login" },
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
 * (tests) wins outright; otherwise it's built from the HC-03 credential
 * precedence (`env.RAIL_TOKEN` → locally stored personal token) plus
 * `env.RAIL_API_URL`, validating it (HTTPS, or HTTP only for `localhost`)
 * BEFORE any request is possible — see `rail-readonly.js`'s
 * `buildReadonlyRailFromCredentials`.
 */
function resolveRail({ env, rail, homeDir }) {
  return rail ? { rail, error: null } : buildReadonlyRailFromCredentials({ env, homeDir });
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

async function doctorCommand({ logger, env, osModule, runGit, runClaude, homeDir, output, rail, trace }) {
  const identity = getIdentity({ osModule, env });
  const checks = runDoctor({ env, osModule, runGit, runClaude, homeDir });
  const credentialCheck = runCredentialCheck({ env, homeDir });
  const identityChecks = await runRailIdentityChecks({ env, homeDir, rail });
  printDoctorReport(logger, checks, identity, !!output?.isTTY, [credentialCheck, ...identityChecks]);
  trace?.recordEvent("DOCTOR_RUN", { metadata: { result: doctorExitCode(checks) === 0 ? "OK" : "FAILED" } });
  return doctorExitCode(checks);
}

async function setupCommand({ logger, env, osModule, runGit, runClaude, homeDir, output, trace }) {
  const dir = homeDir || env.HOME || osModule.homedir?.();
  let result;
  try {
    result = ensureConfig(dir);
  } catch (err) {
    logger(`✗ No se pudo preparar la configuración local: ${err.message}`);
    trace?.recordEvent("COMMAND_FAILED", { metadata: { command: "setup", reasonCode: "CONFIG_ERROR" } });
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
  trace?.recordEvent("SETUP_RUN", { metadata: { result: result.created ? "CREATED" : "EXISTING" } });
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
async function startCommand({ logger, env, osModule, runGit, runClaude, homeDir, menu, output, rail, trace }) {
  const isTTY = !!output?.isTTY;
  logger("");

  const localChecks = runDoctor({ env, osModule, runGit, runClaude, homeDir });
  logger(formatCheckLine({ label: "Entorno local", ok: localChecks.every(c => c.ok) }, { isTTY }));

  const { rail: activeRail, error: railError } = resolveRail({ env, rail, homeDir });
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
        trace,
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
      const outcome = await selectTicket({ rail: activeRail, project, menu, logger, trace });
      if (outcome === TICKET_SELECTOR_BACK) break;
    }
  }
}

/**
 * `rail-harness projects` — read-only, lists accessible projects and exits.
 */
async function projectsCommand({ logger, env, rail, homeDir, trace }) {
  const { rail: activeRail, error: railError } = resolveRail({ env, rail, homeDir });
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
    trace?.recordEvent("COMMAND_FAILED", { metadata: { command: "projects", reasonCode: "RAIL_UNREACHABLE" } });
    return 1;
  }
  trace?.recordEvent("PROJECT_LIST_VIEWED");

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
async function readyCommand({ logger, env, rail, projectId, homeDir, trace }) {
  if (!projectId) {
    logger("Uso: rail-harness ready <projectId>");
    return 1;
  }

  const { rail: activeRail, error: railError } = resolveRail({ env, rail, homeDir });
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
    trace?.recordEvent("COMMAND_FAILED", { metadata: { command: "ready", reasonCode: "RAIL_UNREACHABLE" } });
    return 1;
  }
  trace?.recordEvent("READY_LIST_VIEWED", { projectId });

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

async function mainMenuLoop({ logger, env, osModule, runGit, runClaude, homeDir, menu, output, rail, readSecret, trace }) {
  const identity = getIdentity({ osModule, env });
  printBanner(logger, identity);

  const checks = runDoctor({ env, osModule, runGit, runClaude, homeDir });
  printCondensed(logger, checks, !!output?.isTTY);

  for (;;) {
    const { token } = resolveCredentials({ env, homeDir });
    const authenticated = !!token;
    logger(authenticated ? "✓ Credencial personal" : "RailSoft: no autenticado");
    logger("");

    const items = authenticated ? AUTHENTICATED_MENU_ITEMS : UNAUTHENTICATED_MENU_ITEMS;

    let choice;
    try {
      choice = await menu({ question: "¿Qué querés hacer?", items });
    } catch (err) {
      if (isUserCancelled(err)) {
        logger("Cancelado.");
        trace?.abort();
        return 0;
      }
      throw err;
    }

    if (choice === "start") {
      await startCommand({ logger, env, osModule, runGit, runClaude, homeDir, menu, output, rail, trace });
      logger("");
      continue;
    }
    if (choice === "projects") {
      logger("");
      await projectsCommand({ logger, env, rail, homeDir, trace });
      logger("");
      continue;
    }
    if (choice === "setup") {
      logger("");
      await setupCommand({ logger, env, osModule, runGit, runClaude, homeDir, output, trace });
      logger("");
      continue;
    }
    if (choice === "doctor") {
      logger("");
      await doctorCommand({ logger, env, osModule, runGit, runClaude, homeDir, output, rail, trace });
      logger("");
      continue;
    }
    if (choice === "login") {
      logger("");
      try {
        await loginCommand({ logger, env, homeDir, osModule, output, readSecret, rail, trace });
      } catch (err) {
        // A cancelled token entry only cancels THIS sub-step (loginCommand
        // already logged "Cancelado.") — the interactive session itself
        // keeps running, so it must NOT end the HarnessSession. Compare
        // with the top-level `menu()` cancel above, which IS terminal.
        if (!isUserCancelled(err)) throw err;
      }
      logger("");
      continue;
    }
    if (choice === "logout") {
      logger("");
      logoutCommand({ logger, homeDir, trace });
      logger("");
      continue;
    }
    if (choice === "exit") {
      logger("Hasta luego.");
      return 0;
    }
  }
}

async function dispatch({
  argv,
  env,
  logger,
  input,
  output,
  osModule,
  homeDir,
  runGit,
  runClaude,
  rail,
  readSecret,
  menu,
  trace
}) {
  const [command, ...rest] = argv;

  if (command === "doctor") {
    return doctorCommand({ logger, env, osModule, runGit, runClaude, homeDir, output, rail, trace });
  }
  if (command === "setup") {
    return setupCommand({ logger, env, osModule, runGit, runClaude, homeDir, output, trace });
  }
  if (command === "projects") {
    if (rest.length > 0) {
      logger(`Argumentos inesperados: ${rest.join(" ")}`);
      return 1;
    }
    return projectsCommand({ logger, env, rail, homeDir, trace });
  }
  if (command === "ready") {
    return readyCommand({ logger, env, rail, projectId: rest[0], homeDir, trace });
  }
  if (command === "login") {
    if (rest.length > 0) {
      logger(`Argumentos inesperados: ${rest.join(" ")}`);
      return 1;
    }
    return loginCommand({ logger, env, homeDir, osModule, input, output, readSecret, rail, trace });
  }
  if (command === "logout") {
    if (rest.length > 0) {
      logger(`Argumentos inesperados: ${rest.join(" ")}`);
      return 1;
    }
    return logoutCommand({ logger, homeDir, trace });
  }
  if (command === "auth") {
    if (rest.length !== 1 || rest[0] !== "status") {
      logger("Uso: rail-harness auth status");
      return 1;
    }
    return authStatusCommand({ logger, env, homeDir, osModule, rail, trace });
  }
  if (command === "trace") {
    if (rest.length !== 1 || (rest[0] !== "status" && rest[0] !== "recent")) {
      logger("Uso: rail-harness trace [status|recent]");
      return 1;
    }
    return rest[0] === "status"
      ? traceStatusCommand({ logger, homeDir, env, osModule })
      : traceRecentCommand({ logger, homeDir, env, osModule });
  }
  if (command) {
    logger(`Comando desconocido: "${command}".`);
    logger("Uso: rail-harness [doctor|setup|projects|ready <projectId>|login|logout|auth status|trace status|trace recent]");
    return 1;
  }
  if (rest.length > 0) {
    logger(`Argumentos inesperados: ${rest.join(" ")}`);
    return 1;
  }

  return mainMenuLoop({ logger, env, osModule, runGit, runClaude, homeDir, menu, output, rail, readSecret, trace });
}

/**
 * Run the Developer Console. Returns a numeric exit code, never calls
 * `process.exit` itself (that's `bin/rail-harness.js`'s job) — EXCEPT for a
 * genuine process-level `SIGINT` (Ctrl+C outside of the interactive menu's
 * own raw-mode key handling, e.g. while a network request is in flight),
 * where exiting immediately is the correct, expected CLI behavior; the
 * trace is marked `ABORTED` first, best-effort, before exiting.
 *
 * HC-04: every invocation gets its own `HarnessSession` (`trace`, injectable
 * for tests — never depends on the real HOME/filesystem when injected).
 * Trace failures are caught here and NEVER propagate — a broken local trace
 * store must never block the console (see `trace/context.js`).
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
  readSecret,
  menu = opts => selectMenu({ ...opts, input, output }),
  trace = createTrace({ homeDir, env, osModule, onWarning: logger }),
  processExit = code => process.exit(code)
} = {}) {
  trace.start();

  const onSigint = () => {
    try {
      trace.abort();
    } finally {
      processExit(130);
    }
  };
  process.once("SIGINT", onSigint);

  try {
    const exitCode = await dispatch({
      argv,
      env,
      logger,
      input,
      output,
      osModule,
      homeDir,
      runGit,
      runClaude,
      rail,
      readSecret,
      menu,
      trace
    });
    trace.complete();
    return exitCode;
  } catch (err) {
    if (isUserCancelled(err)) {
      // A cancellation that reaches all the way here (e.g. `rail-harness
      // login` standalone, cancelled while reading the token) IS terminal
      // for this invocation — end the session as ABORTED, not FAILED, and
      // resolve with a plain exit code instead of rethrowing (a user
      // cancellation is not the "error fatal" `bin/rail-harness.js` prints
      // for a genuinely unexpected exception).
      trace.abort();
      return 1;
    }
    trace.fail();
    throw err;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
