/**
 * Rail Harness Developer Console — local trace store (HC-04).
 *
 * Persists `HarnessSession` / `HarnessEvent` under:
 *
 *   ~/.local/state/rail-harness/
 *     sessions/rhs_<uuid>.json
 *     events/<YYYY-MM-DD>.jsonl
 *
 * Deliberately separate from `~/.config/rail-harness/` (HC-01/HC-03's
 * `config-store.js` / `credential-store.js`) — this is telemetry, not
 * configuration or credentials.
 *
 * Hardened like `credential-store.js`:
 *   - directories forced to `0700`, files forced to `0600`;
 *   - session writes are atomic (temp file + rename);
 *   - event appends never follow a symlink at the target path;
 *   - `homeDir` is always a parameter (defaults to `os.homedir()`) so tests
 *     never touch the real HOME;
 *   - every read tolerates a corrupt/missing file or line — a bad past
 *     record must never prevent starting a new session or block reads.
 *
 * Every export here is best-effort from the CALLER's point of view in the
 * sense that failures throw plain, secret-free Errors (never embedding file
 * contents) — it is `context.js`'s job to catch them and keep the console
 * usable. This module itself never swallows errors silently on WRITE (a
 * caller needs to know a write failed); it DOES swallow per-record corruption
 * on READ (see `listSessions` / `countEvents`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export const STATE_DIR_SEGMENTS = [".local", "state", "rail-harness"];

export function stateDirFor(homeDir = os.homedir()) {
  return path.join(homeDir, ...STATE_DIR_SEGMENTS);
}

export function sessionsDirFor(homeDir = os.homedir()) {
  return path.join(stateDirFor(homeDir), "sessions");
}

export function eventsDirFor(homeDir = os.homedir()) {
  return path.join(stateDirFor(homeDir), "events");
}

export function sessionFilePathFor(homeDir, sessionId) {
  return path.join(sessionsDirFor(homeDir), `${sessionId}.json`);
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

export function eventsFilePathFor(homeDir, dateStamp = todayStamp()) {
  return path.join(eventsDirFor(homeDir), `${dateStamp}.jsonl`);
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`trace-store: no pude inspeccionar ${path.basename(p)}: ${err.code || err.message}`);
  }
}

function assertNotSymlink(p, humanLabel) {
  const st = lstatOrNull(p);
  if (st?.isSymbolicLink()) {
    throw new Error(`trace-store: ${humanLabel} es un symlink inseguro — operación rechazada.`);
  }
  return st;
}

/** Ensure one leaf directory exists, is real (never a symlink) and is `0700`. */
function ensureSecureDir(dir, humanLabel) {
  const st = assertNotSymlink(dir, humanLabel);
  if (!st) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
    return;
  }
  if (!st.isDirectory()) {
    throw new Error(`trace-store: ${humanLabel} no es un directorio válido.`);
  }
  if ((st.mode & 0o777) !== DIR_MODE) {
    fs.chmodSync(dir, DIR_MODE);
  }
}

/** Ensure `sessions/` and `events/` (and their parent) exist, secure, `0700`. */
export function ensureStateDirsSecure(homeDir = os.homedir()) {
  ensureSecureDir(stateDirFor(homeDir), "el directorio de estado local");
  ensureSecureDir(sessionsDirFor(homeDir), "el directorio de sesiones");
  ensureSecureDir(eventsDirFor(homeDir), "el directorio de eventos");
}

/**
 * Atomically persist `session` (mode `0600`). Refuses to follow a symlink at
 * the target path. Throws a plain, secret-free Error on failure — the
 * session object never contains a secret, so this is safe.
 */
export function writeSessionAtomic(homeDir, session) {
  ensureStateDirsSecure(homeDir);
  const dir = sessionsDirFor(homeDir);
  const file = sessionFilePathFor(homeDir, session.id);
  assertNotSymlink(file, "el archivo de sesión");

  const tmp = path.join(dir, `.${session.id}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const payload = JSON.stringify(session, null, 2) + "\n";

  fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: FILE_MODE });
  fs.chmodSync(tmp, FILE_MODE);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, FILE_MODE);
  return file;
}

/**
 * Append one event line to today's `events/<date>.jsonl`. Never follows a
 * symlink at the target path; creates the file at `0600` on first write and
 * corrects its mode if it drifted. Throws on failure — corruption of
 * PREVIOUS lines is a read-time concern (see `readEventsFile`), not a
 * write-time one.
 */
export function appendEventSafe(homeDir, event) {
  ensureStateDirsSecure(homeDir);
  const file = eventsFilePathFor(homeDir);
  const st = assertNotSymlink(file, "el archivo de eventos del día");

  if (!st) {
    fs.writeFileSync(file, "", { mode: FILE_MODE });
  } else if ((st.mode & 0o777) !== FILE_MODE) {
    fs.chmodSync(file, FILE_MODE);
  }

  fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
  return file;
}

/**
 * Read one session file. Returns `{ ok:true, session }` or `{ ok:false,
 * reason }` (`"missing" | "unreadable" | "corrupt" | "insecure"`). Never
 * throws.
 */
export function readSessionSafe(homeDir, sessionId) {
  const file = sessionFilePathFor(homeDir, sessionId);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    return { ok: false, reason: err.code === "ENOENT" ? "missing" : "unreadable" };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: "insecure" };

  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const session = JSON.parse(raw);
    if (!session || typeof session !== "object" || !session.id) return { ok: false, reason: "corrupt" };
    return { ok: true, session };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

/**
 * List every readable, well-formed session, most recent (`startedAt`) first,
 * capped at `limit`. Corrupt/unreadable files are silently skipped — one bad
 * past record never blocks reading the rest, or starting a new session.
 */
export function listSessions(homeDir = os.homedir(), { limit } = {}) {
  const dir = sessionsDirFor(homeDir);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const sessions = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const sessionId = name.slice(0, -".json".length);
    const result = readSessionSafe(homeDir, sessionId);
    if (result.ok) sessions.push(result.session);
  }

  sessions.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return typeof limit === "number" ? sessions.slice(0, limit) : sessions;
}

export function countSessions(homeDir = os.homedir()) {
  return listSessions(homeDir).length;
}

export function getLastSession(homeDir = os.homedir()) {
  const [last] = listSessions(homeDir, { limit: 1 });
  return last || null;
}

/**
 * Read one events file as an array of parsed events, skipping any line that
 * fails to parse (a truncated/corrupt append from a crash) instead of
 * failing the whole read.
 */
function readEventsFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // corrupt line: skip, never blocks the rest of the file.
    }
  }
  return events;
}

/** Total event count across every day file. Best-effort, never throws. */
export function countEvents(homeDir = os.homedir()) {
  const dir = eventsDirFor(homeDir);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    total += readEventsFile(path.join(dir, name)).length;
  }
  return total;
}
