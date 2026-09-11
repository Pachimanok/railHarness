/**
 * Rail Harness Developer Console — local credential store (HC-03).
 *
 * Stores ONLY the developer's personal Rail token — fully separate from the
 * non-secret `config.json` (`config-store.js`), which must never carry a
 * `token` key. Lives in the same directory (`~/.config/rail-harness/`) but
 * as its own file, `credentials.json`, `{ "version": 1, "token": "<secret>" }`.
 *
 * Hardened on purpose:
 *   - directory forced to mode `0700`, file forced to mode `0600` — created
 *     that way, and corrected back to it if something looser is found;
 *   - every write is atomic (temp file in the same directory, then rename);
 *   - never follows a symlink at either the directory or file position — an
 *     attacker-planted symlink is refused outright, not followed;
 *   - never logs, never throws an Error that embeds the token value;
 *   - `homeDir` is always a parameter (defaults to `os.homedir()`) so tests
 *     can point this at a throwaway temp directory and never touch the real
 *     HOME.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { configDirFor } from "./config-store.js";

export const CREDENTIALS_FILE_NAME = "credentials.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Full path to `credentials.json`, in the same directory as `config.json`. */
export function credentialsFilePathFor(homeDir = os.homedir()) {
  return path.join(configDirFor(homeDir), CREDENTIALS_FILE_NAME);
}

/** `fs.lstatSync` (never follows a symlink) that returns `null` on ENOENT. */
function lstatOrNull(p, humanLabel) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`No pude inspeccionar ${humanLabel}: ${err.code || err.message}`);
  }
}

function assertNotSymlink(p, humanLabel) {
  const st = lstatOrNull(p, humanLabel);
  if (st?.isSymbolicLink()) {
    throw new Error(`${humanLabel} es un symlink inseguro — operación rechazada.`);
  }
  return st;
}

/**
 * Ensure `~/.config/rail-harness/` exists, is a real directory (never a
 * symlink) and has mode `0700` — creating it if missing, correcting the mode
 * if it drifted (e.g. inherited a looser umask from HC-01's `config-store.js`,
 * which does not force a mode). Returns the directory path.
 */
export function ensureCredentialDirSecure(homeDir = os.homedir()) {
  const dir = configDirFor(homeDir);
  const st = assertNotSymlink(dir, "el directorio de configuración local");

  if (!st) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
    return dir;
  }
  if (!st.isDirectory()) {
    throw new Error("El directorio de configuración local no es un directorio válido.");
  }
  if ((st.mode & 0o777) !== DIR_MODE) {
    fs.chmodSync(dir, DIR_MODE);
  }
  return dir;
}

/**
 * Read the stored token. Returns `{ ok: true, token }` or `{ ok: false,
 * reason }` (`"missing" | "unreadable" | "corrupt" | "insecure"`). Never
 * throws, never follows a symlink, never logs the token.
 */
export function readCredentials(homeDir = os.homedir()) {
  const file = credentialsFilePathFor(homeDir);
  const st = lstatOrNull(file, "el archivo de credenciales");
  if (!st) return { ok: false, reason: "missing" };
  if (st.isSymbolicLink()) return { ok: false, reason: "insecure" };

  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  try {
    const parsed = JSON.parse(raw);
    const token = typeof parsed?.token === "string" ? parsed.token.trim() : "";
    if (!token) return { ok: false, reason: "corrupt" };
    return { ok: true, token };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

/**
 * Atomically persist `token` (mode `0600`, in a `0700` directory). Refuses
 * to follow a symlink sitting at the target path — throws instead of
 * overwriting through it. Never logs the token, never embeds it in a thrown
 * Error.
 */
export function writeCredentialsAtomic(homeDir = os.homedir(), token) {
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("credential-store: token vacío — operación rechazada.");
  }
  const dir = ensureCredentialDirSecure(homeDir);
  const file = credentialsFilePathFor(homeDir);
  assertNotSymlink(file, "el archivo de credenciales");

  const tmp = path.join(
    dir,
    `.${CREDENTIALS_FILE_NAME}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
  );
  const payload = JSON.stringify({ version: 1, token: token.trim() }, null, 2) + "\n";

  fs.writeFileSync(tmp, payload, { encoding: "utf8", mode: FILE_MODE });
  fs.chmodSync(tmp, FILE_MODE);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, FILE_MODE);
  return file;
}

/**
 * Remove the stored credential, if any. Idempotent — returns `false` (no
 * error) when there was nothing to delete. Never touches `config.json`,
 * never reaches RailSoft.
 */
export function deleteCredentials(homeDir = os.homedir()) {
  const file = credentialsFilePathFor(homeDir);
  const st = lstatOrNull(file, "el archivo de credenciales");
  if (!st) return false;
  if (!st.isSymbolicLink() && !st.isFile()) {
    throw new Error("credential-store: la ruta de credenciales no es un archivo regular — operación rechazada.");
  }
  fs.unlinkSync(file);
  return true;
}
