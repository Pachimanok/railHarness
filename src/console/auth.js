/**
 * Rail Harness Developer Console — personal credential commands (HC-03).
 *
 * `rail-harness login` / `rail-harness logout` / `rail-harness auth status`.
 * Manages ONLY the developer's personal Rail token: detects the Linux user
 * automatically (never asks for it), reads the token once without echoing
 * it, and validates it against RailSoft using nothing but `listProjects()`
 * (GET, read-only) through the same read-only facade the rest of the
 * console uses (`rail-readonly.js`). The token is never persisted until
 * RailSoft accepts it, and is never printed anywhere — not to stdout, not to
 * stderr, not inside an error message.
 */

import os from "node:os";

import { getIdentity } from "./doctor.js";
import { createReadonlyRail, RAIL_INSECURE_URL_MESSAGE } from "./rail-readonly.js";
import { writeCredentialsAtomic, deleteCredentials } from "./credential-store.js";
import { resolveCredentials } from "./credential-resolve.js";
import { normalizeProjects } from "./project-selector.js";
import { promptSecret } from "./secret-input.js";

function clean(value) {
  const v = (value ?? "").toString().trim();
  return v.length ? v : null;
}

function pluralize(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * `rail-harness login`. `rail`, when injected, overrides the facade built
 * from `env.RAIL_API_URL` + the freshly-read token — tests only, never
 * touches the network. `readSecret`, when injected, replaces the real
 * hidden-input prompt — tests only, never reads real stdin. Returns a
 * numeric exit code; only ever writes the credential file on a confirmed
 * RailSoft acceptance.
 */
export async function loginCommand({
  logger,
  env = process.env,
  homeDir,
  osModule = os,
  input,
  output,
  readSecret,
  rail
} = {}) {
  const identity = getIdentity({ osModule, env });

  logger("Rail Harness Login");
  logger("");
  logger(`Usuario Linux: ${identity.username}`);
  logger(`Servidor: ${identity.hostname}`);
  logger("");
  logger("Pegá tu token personal de Rail.");
  logger("El token no se mostrará mientras escribís.");
  logger("");

  const apiUrl = clean(env.RAIL_API_URL);
  if (!rail && !apiUrl) {
    logger("RAIL_API_URL no está configurada. Contactá al administrador del Harness.");
    return 1;
  }

  const read = readSecret || (() => promptSecret({ prompt: "Token: ", input, output }));
  let rawToken;
  try {
    rawToken = await read();
  } catch (err) {
    if (err?.code === "CANCELLED") {
      logger("Cancelado.");
      return 1;
    }
    throw err;
  }

  const token = clean(rawToken);
  if (!token) {
    logger("");
    logger("El token no puede estar vacío.");
    return 1;
  }

  let activeRail = rail;
  if (!activeRail) {
    try {
      activeRail = createReadonlyRail({ apiUrl, token });
    } catch {
      logger("");
      logger(RAIL_INSECURE_URL_MESSAGE);
      return 1;
    }
  }

  logger("");
  logger("Validando...");

  let projects;
  try {
    const raw = await activeRail.listProjects();
    projects = normalizeProjects(raw);
  } catch (err) {
    logger("");
    if (err?.status === 401 || err?.status === 403) {
      logger("Credencial rechazada por RailSoft.");
    } else {
      logger("No se pudo conectar con RailSoft.");
    }
    return 1;
  }

  writeCredentialsAtomic(homeDir, token);

  logger("");
  logger("✓ RailSoft conectado");
  logger("✓ Credencial válida");
  logger("✓ Acceso autorizado");
  logger(`✓ ${pluralize(projects.length, "proyecto")} disponible${projects.length === 1 ? "" : "s"}`);
  logger("");
  logger("Sesión configurada correctamente.");
  return 0;
}

/**
 * `rail-harness logout`. Idempotent: removes only the local credential file,
 * never touches `config.json`, never contacts RailSoft (no server-side
 * revocation — see HARNESS docs for the deferred scope).
 */
export function logoutCommand({ logger, homeDir } = {}) {
  const deleted = deleteCredentials(homeDir);
  logger(deleted ? "Credencial local eliminada." : "No había una credencial local configurada.");
  return 0;
}

/**
 * `rail-harness auth status`. `rail`, when injected, overrides the facade —
 * tests only. Never prints the token; only reports where it came from
 * (`environment` / `credencial local`).
 */
export async function authStatusCommand({ logger, env = process.env, homeDir, osModule = os, rail } = {}) {
  const identity = getIdentity({ osModule, env });

  logger("Rail Harness Auth");
  logger("");
  logger(`Linux user: ${identity.username}`);
  logger(`Machine: ${identity.hostname}`);
  logger("");

  const { token, source } = resolveCredentials({ env, homeDir });
  if (!token) {
    logger("✗ Credencial local encontrada");
    logger("");
    logger("RailSoft: no autenticado");
    return 1;
  }
  logger("✓ Credencial local encontrada");

  const apiUrl = clean(env.RAIL_API_URL);
  let activeRail = rail;
  if (!activeRail) {
    if (!apiUrl) {
      logger("✗ RailSoft conectado — RAIL_API_URL no configurada");
      return 1;
    }
    try {
      activeRail = createReadonlyRail({ apiUrl, token });
    } catch {
      logger(`✗ RailSoft conectado — ${RAIL_INSECURE_URL_MESSAGE}`);
      return 1;
    }
  }

  try {
    await activeRail.listProjects();
  } catch (err) {
    const reachedServer = typeof err?.status === "number";
    logger(reachedServer ? "✓ RailSoft conectado" : "✗ RailSoft conectado");
    logger("✗ Credencial autorizada");
    return 1;
  }

  logger("✓ RailSoft conectado");
  logger("✓ Credencial autorizada");
  logger("");
  logger(`Fuente: ${source}`);
  return 0;
}
