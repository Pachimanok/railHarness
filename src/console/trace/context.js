/**
 * Rail Harness Developer Console — trace facade (HC-04).
 *
 * `createTrace(...)` is the single injectable object the CLI depends on
 * (`trace` — see `cli.js` / `auth.js` / `project-selector.js` /
 * `ticket-selector.js`). It wires `session.js` + `event.js` + `store.js`
 * together and is the ONLY place that decides "best-effort": every method
 * here catches its own I/O failures, warns at most once per session via
 * `onWarning`, and then goes quiet (no repeated warnings, no throws) — a
 * broken trace store must never block login/doctor/projects/navigation.
 *
 * Detects `linuxUser` / `machine` automatically (never prompts). SSH is
 * recorded as a bare boolean (`sshSession`) derived from the PRESENCE of
 * `SSH_CONNECTION` / `SSH_CLIENT` / `SSH_TTY` — their values (which can carry
 * a real IP) are never read or stored.
 */

import os from "node:os";

import { createSession, withProject, withTicket, endSession, isTerminal, SESSION_STATUS } from "./session.js";
import { createEvent } from "./event.js";
import { writeSessionAtomic, appendEventSafe } from "./store.js";

const WARNING_MESSAGE = "Advertencia: no se pudo registrar la trazabilidad local.";

/** `{ linuxUser, machine, sshSession }` — detected, never asked for. */
export function detectSessionContext({ osModule = os, env = process.env } = {}) {
  let linuxUser;
  try {
    linuxUser = osModule.userInfo().username;
  } catch {
    linuxUser = env.USER || env.LOGNAME || null;
  }
  const machine = osModule.hostname?.() ?? null;
  const sshSession = !!(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
  return { linuxUser, machine, sshSession };
}

/**
 * Build the injectable trace facade. Nothing here does I/O eagerly — it
 * only happens once `start()` is called.
 */
export function createTrace({
  homeDir,
  env = process.env,
  osModule = os,
  onWarning
} = {}) {
  const effectiveHomeDir = homeDir || env.HOME || osModule.homedir?.();
  let session = null;
  let warned = false;

  const warn = () => {
    if (warned) return;
    warned = true;
    onWarning?.(WARNING_MESSAGE);
  };

  const persistSession = () => {
    if (!session) return;
    try {
      writeSessionAtomic(effectiveHomeDir, session);
    } catch {
      warn();
    }
  };

  const persistEvent = (type, { projectId, ticketRef, metadata } = {}) => {
    if (!session) return;
    try {
      const event = createEvent({ sessionId: session.id, type, projectId, ticketRef, metadata });
      appendEventSafe(effectiveHomeDir, event);
    } catch {
      warn();
    }
  };

  return {
    /** Start a new ACTIVE session and record `SESSION_STARTED`. Idempotent. */
    start() {
      if (session) return session;
      const { linuxUser, machine, sshSession } = detectSessionContext({ osModule, env });
      session = createSession({ linuxUser, machine, sshSession });
      persistSession();
      persistEvent("SESSION_STARTED");
      return session;
    },

    /** Current in-memory session, or `null` before `start()`. */
    getSession() {
      return session;
    },

    /**
     * Record a functional event. `PROJECT_SELECTED` / `TICKET_SELECTED` also
     * update (and persist) the session's own `projectId`/`projectName` /
     * `ticketRef` fields, matching the HarnessSession schema.
     */
    recordEvent(type, { projectId, ticketRef, metadata } = {}) {
      if (!session) return;
      if (type === "PROJECT_SELECTED") {
        session = withProject(session, { projectId, projectName: metadata?.projectName });
        persistSession();
      } else if (type === "TICKET_SELECTED") {
        session = withTicket(session, { ticketRef });
        persistSession();
      }
      persistEvent(type, { projectId, ticketRef, metadata });
    },

    /** End the session as `COMPLETED` + `SESSION_COMPLETED`. Idempotent — a
     * session already terminal (e.g. `abort()`ed) is left untouched. */
    complete() {
      if (!session || isTerminal(session)) return;
      session = endSession(session, SESSION_STATUS.COMPLETED);
      persistSession();
      persistEvent("SESSION_COMPLETED");
    },

    /** End the session as `FAILED` + `SESSION_FAILED`. Idempotent. */
    fail() {
      if (!session || isTerminal(session)) return;
      session = endSession(session, SESSION_STATUS.FAILED);
      persistSession();
      persistEvent("SESSION_FAILED");
    },

    /** End the session as `ABORTED` + `SESSION_ABORTED`. Idempotent. */
    abort() {
      if (!session || isTerminal(session)) return;
      session = endSession(session, SESSION_STATUS.ABORTED);
      persistSession();
      persistEvent("SESSION_ABORTED");
    }
  };
}

/** A trace facade whose every method is a safe no-op — used as a default
 * fallback only in contexts where injecting a real `createTrace(...)` is
 * not appropriate (never used by the CLI itself, which always gets a real
 * one; exported for tests / tools that want to disable tracing outright). */
export function createNoopTrace() {
  return {
    start: () => null,
    getSession: () => null,
    recordEvent: () => {},
    complete: () => {},
    fail: () => {},
    abort: () => {}
  };
}
