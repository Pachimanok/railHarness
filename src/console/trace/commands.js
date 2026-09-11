/**
 * Rail Harness Developer Console — `trace status` / `trace recent` (HC-04).
 *
 * Read-only, 100% local reports over the trace store (`store.js`). NEVER
 * contacts RailSoft, NEVER issues a `fetch`, NEVER prints a secret or the
 * full contents of any event's `metadata`.
 */

import os from "node:os";

import { listSessions, countSessions, countEvents, getLastSession } from "./store.js";

function pad(value, width) {
  const s = String(value ?? "");
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

/** `rail-harness trace status` — counts + last session id. */
export function traceStatusCommand({ logger, homeDir, env = process.env, osModule = os } = {}) {
  const effectiveHomeDir = homeDir || env.HOME || osModule.homedir?.();

  logger("Rail Harness Trace");
  logger("");

  let sessions = 0;
  let events = 0;
  let last = null;
  let ok = true;
  try {
    sessions = countSessions(effectiveHomeDir);
    events = countEvents(effectiveHomeDir);
    last = getLastSession(effectiveHomeDir);
  } catch {
    ok = false;
  }

  logger(ok ? "✓ Trazabilidad local habilitada" : "✗ Trazabilidad local no disponible");
  logger("");
  logger(`Sesiones registradas: ${sessions}`);
  logger(`Eventos registrados: ${events}`);
  logger(`Última sesión: ${last ? last.id : "(ninguna)"}`);
  return 0;
}

/** `rail-harness trace recent` — last 10 sessions, local only. */
export function traceRecentCommand({ logger, homeDir, env = process.env, osModule = os } = {}) {
  const effectiveHomeDir = homeDir || env.HOME || osModule.homedir?.();

  logger("Rail Harness Trace — sesiones recientes");
  logger("");

  let sessions = [];
  try {
    sessions = listSessions(effectiveHomeDir, { limit: 10 });
  } catch {
    logger("No se pudo leer la trazabilidad local.");
    return 1;
  }

  if (sessions.length === 0) {
    logger("No hay sesiones registradas todavía.");
    return 0;
  }

  logger(`${pad("Fecha", 12)} ${pad("Usuario", 10)} ${pad("Máquina", 16)} Estado`);
  for (const s of sessions) {
    const date = String(s.startedAt || "").slice(0, 10) || "(desconocida)";
    logger(`${pad(date, 12)} ${pad(s.linuxUser, 10)} ${pad(s.machine, 16)} ${s.status}`);
  }
  return 0;
}
