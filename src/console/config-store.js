/**
 * Rail Harness Developer Console — local, non-secret config store (HC-01).
 *
 * Reads/writes a single file: `~/.config/rail-harness/config.json`. This is
 * ONLY ever `{ "version": 1 }` at this stage — never a token, a claimToken,
 * or any credential. Every write is validated against
 * `SECRET_KEY_RE` (src/security/sanitize.js) as a defensive backstop, and
 * every write is atomic (write to a sibling temp file, then rename).
 *
 * Fully isolated from the Worker Core and Rail: no network, no Rail API
 * client, no Worker/Orchestration import. `homeDir` is always a parameter (defaults to
 * `os.homedir()`) so tests can point this at a throwaway temp directory and
 * never touch the real HOME.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { SECRET_KEY_RE } from "../security/sanitize.js";

export const CONFIG_DIR_SEGMENTS = [".config", "rail-harness"];
export const CONFIG_FILE_NAME = "config.json";
export const DEFAULT_CONFIG = Object.freeze({ version: 1 });

/** Directory that holds the Developer Console's local config. */
export function configDirFor(homeDir = os.homedir()) {
  return path.join(homeDir, ...CONFIG_DIR_SEGMENTS);
}

/** Full path to `config.json`. */
export function configFilePathFor(homeDir = os.homedir()) {
  return path.join(configDirFor(homeDir), CONFIG_FILE_NAME);
}

/** Throws if `obj` (recursively) carries any key that looks like a secret. */
function assertNoSecretKeys(obj) {
  const walk = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) {
        throw new Error(
          `config-store: rechazado — la clave "${key}" parece un secreto y nunca debe guardarse.`
        );
      }
      walk(val);
    }
  };
  walk(obj);
}

/**
 * Ensure the config directory exists and is writable. Read-only-ish: does
 * NOT touch config.json. Throws a Spanish, secret-free Error on failure.
 */
export function ensureConfigDir(homeDir = os.homedir()) {
  const dir = configDirFor(homeDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`No pude crear el directorio de configuración local (${dir}): ${err.code || err.message}`);
  }

  const probe = path.join(dir, `.write-probe-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
  } catch (err) {
    throw new Error(`El directorio de configuración local no es escribible (${dir}): ${err.code || err.message}`);
  }

  return dir;
}

/**
 * Read `config.json`. Returns `{ ok: true, config }` when present and a
 * valid JSON object, `{ ok: false, reason }` otherwise (missing / corrupt).
 * Never throws.
 */
export function readConfig(homeDir = os.homedir()) {
  const file = configFilePathFor(homeDir);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, reason: err.code === "ENOENT" ? "missing" : "unreadable" };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, config: parsed };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

/**
 * Ensure `config.json` exists with a valid config. If a valid config is
 * already there, it is left untouched (no unnecessary rewrite). Otherwise
 * `DEFAULT_CONFIG` is written atomically. Never stores secrets.
 *
 * @returns {{ created: boolean, config: object, dir: string, path: string }}
 */
export function ensureConfig(homeDir = os.homedir()) {
  const dir = ensureConfigDir(homeDir);
  const file = configFilePathFor(homeDir);

  const existing = readConfig(homeDir);
  if (existing.ok) {
    return { created: false, config: existing.config, dir, path: file };
  }

  assertNoSecretKeys(DEFAULT_CONFIG);
  writeConfigAtomic(homeDir, DEFAULT_CONFIG);
  return { created: true, config: DEFAULT_CONFIG, dir, path: file };
}

/** Atomically overwrite `config.json` with `config`. Never stores secrets. */
export function writeConfigAtomic(homeDir = os.homedir(), config) {
  assertNoSecretKeys(config);
  const dir = ensureConfigDir(homeDir);
  const file = configFilePathFor(homeDir);
  const tmp = path.join(dir, `.${CONFIG_FILE_NAME}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);

  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return file;
}
