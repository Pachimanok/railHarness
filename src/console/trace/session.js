/**
 * Rail Harness Developer Console — HarnessSession (HC-04).
 *
 * One `HarnessSession` per `rail-harness` invocation (interactive or a single
 * subcommand). Pure data + pure transitions — no I/O here, `store.js` owns
 * persistence and `context.js` owns wiring it into the CLI.
 *
 *   {
 *     id, version, linuxUser, machine, sshSession,
 *     startedAt, endedAt, status,
 *     projectId, projectName, ticketRef
 *   }
 */

import crypto from "node:crypto";

export const SESSION_VERSION = 1;

export const SESSION_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  ABORTED: "ABORTED"
});

const TERMINAL_STATUSES = new Set([SESSION_STATUS.COMPLETED, SESSION_STATUS.FAILED, SESSION_STATUS.ABORTED]);

function clean(value) {
  const v = (value ?? "").toString().trim();
  return v.length ? v : null;
}

/** Create a new ACTIVE session. `linuxUser`/`machine` are detected, never prompted for. */
export function createSession({ linuxUser, machine, sshSession = false } = {}) {
  return {
    id: `rhs_${crypto.randomUUID()}`,
    version: SESSION_VERSION,
    linuxUser: clean(linuxUser) || "(desconocido)",
    machine: clean(machine) || "(desconocido)",
    sshSession: !!sshSession,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: SESSION_STATUS.ACTIVE,
    projectId: null,
    projectName: null,
    ticketRef: null
  };
}

/** Pure: return a copy with `projectId`/`projectName` set. */
export function withProject(session, { projectId, projectName } = {}) {
  return { ...session, projectId: clean(projectId), projectName: clean(projectName) };
}

/** Pure: return a copy with `ticketRef` set. */
export function withTicket(session, { ticketRef } = {}) {
  return { ...session, ticketRef: clean(ticketRef) };
}

/**
 * Pure: return a copy transitioned to a terminal status. No-op (returns the
 * same session unchanged) if it is already terminal — a session ends once.
 */
export function endSession(session, status) {
  if (!TERMINAL_STATUSES.has(status)) {
    throw new Error(`endSession: estado terminal inválido "${status}".`);
  }
  if (TERMINAL_STATUSES.has(session.status)) return session;
  return { ...session, status, endedAt: new Date().toISOString() };
}

export function isTerminal(session) {
  return TERMINAL_STATUSES.has(session?.status);
}
