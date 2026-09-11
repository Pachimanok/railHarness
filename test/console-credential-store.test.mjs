/**
 * HC-03 — local credential store (`src/console/credential-store.js`).
 *
 * Every test points `homeDir` at a throwaway `os.tmpdir()` directory and
 * removes it afterwards. The real HOME is never touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  credentialsFilePathFor,
  ensureCredentialDirSecure,
  readCredentials,
  writeCredentialsAtomic,
  deleteCredentials
} from "../src/console/credential-store.js";
import { configDirFor } from "../src/console/config-store.js";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-cred-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

// ─── HC-03-AC-06 / AC-07: permissions ──────────────────────────────────────

test("HC-03-AC-07: ensureCredentialDirSecure crea el directorio con mode 0700", t => {
  const home = tempHome(t);
  const dir = ensureCredentialDirSecure(home);
  assert.equal(dir, configDirFor(home));
  assert.equal(modeOf(dir), 0o700);
});

test("HC-03-AC-07: corrige un directorio existente con permisos inseguros (0755) a 0700", t => {
  const home = tempHome(t);
  fs.mkdirSync(configDirFor(home), { recursive: true, mode: 0o755 });
  assert.equal(modeOf(configDirFor(home)), 0o755);

  ensureCredentialDirSecure(home);
  assert.equal(modeOf(configDirFor(home)), 0o700);
});

test("HC-03-AC-06: writeCredentialsAtomic crea el archivo con mode 0600", t => {
  const home = tempHome(t);
  const file = writeCredentialsAtomic(home, "rag_supersecret_token");

  assert.equal(file, credentialsFilePathFor(home));
  assert.equal(modeOf(file), 0o600);
  assert.notEqual(modeOf(file), 0o644);
});

test("writeCredentialsAtomic nunca deja el archivo group/world-readable", t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_supersecret_token");
  const mode = modeOf(credentialsFilePathFor(home));

  assert.equal(mode & 0o077, 0, "no debe haber bits de grupo/otros habilitados");
});

// ─── formato / atomicidad ──────────────────────────────────────────────────

test("writeCredentialsAtomic escribe {version:1, token} y readCredentials lo recupera", t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_abc123");

  const onDisk = JSON.parse(fs.readFileSync(credentialsFilePathFor(home), "utf8"));
  assert.deepEqual(onDisk, { version: 1, token: "rag_abc123" });

  const result = readCredentials(home);
  assert.equal(result.ok, true);
  assert.equal(result.token, "rag_abc123");
});

test("writeCredentialsAtomic no deja un archivo temporal residual", t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_abc123");

  const entries = fs.readdirSync(configDirFor(home));
  assert.deepEqual(entries, ["credentials.json"]);
});

test("writeCredentialsAtomic rechaza un token vacío y no crea el archivo", t => {
  const home = tempHome(t);
  assert.throws(() => writeCredentialsAtomic(home, ""));
  assert.equal(fs.existsSync(credentialsFilePathFor(home)), false);
});

test("writeCredentialsAtomic sobrescribe un token anterior atómicamente", t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_old");
  writeCredentialsAtomic(home, "rag_new");

  assert.equal(readCredentials(home).token, "rag_new");
});

// ─── lectura sin secretos accidentales ─────────────────────────────────────

test("readCredentials: 'missing' cuando no hay archivo, sin tirar", t => {
  const home = tempHome(t);
  const result = readCredentials(home);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing");
});

test("readCredentials: 'corrupt' con JSON inválido, sin tirar", t => {
  const home = tempHome(t);
  fs.mkdirSync(configDirFor(home), { recursive: true });
  fs.writeFileSync(credentialsFilePathFor(home), "{ no es json", { mode: 0o600 });

  const result = readCredentials(home);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "corrupt");
});

// ─── symlinks inseguros ─────────────────────────────────────────────────────

test("writeCredentialsAtomic rechaza escribir a través de un symlink en la ruta del archivo", t => {
  const home = tempHome(t);
  ensureCredentialDirSecure(home);
  const outside = path.join(os.tmpdir(), `rail-harness-outside-${process.pid}.json`);
  t.after(() => fs.rmSync(outside, { force: true }));

  fs.symlinkSync(outside, credentialsFilePathFor(home));

  assert.throws(() => writeCredentialsAtomic(home, "rag_should_not_write"), /symlink/i);
  assert.equal(fs.existsSync(outside), false, "el archivo symlink-eado nunca debe crearse");
});

test("readCredentials rechaza (reason 'insecure') leer a través de un symlink, nunca lo sigue", t => {
  const home = tempHome(t);
  ensureCredentialDirSecure(home);
  const outside = path.join(os.tmpdir(), `rail-harness-outside-read-${process.pid}.json`);
  fs.writeFileSync(outside, JSON.stringify({ version: 1, token: "rag_outside_secret" }));
  t.after(() => fs.rmSync(outside, { force: true }));

  fs.symlinkSync(outside, credentialsFilePathFor(home));

  const result = readCredentials(home);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "insecure");
});

test("ensureCredentialDirSecure rechaza un directorio de config que en realidad es un symlink", t => {
  const home = tempHome(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-outsidedir-"));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(home, ".config"), { recursive: true });
  fs.symlinkSync(outsideDir, configDirFor(home));

  assert.throws(() => ensureCredentialDirSecure(home), /symlink/i);
});

// ─── delete / logout (HC-03-AC-11) ─────────────────────────────────────────

test("deleteCredentials elimina el archivo y devuelve true", t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_abc123");

  assert.equal(deleteCredentials(home), true);
  assert.equal(fs.existsSync(credentialsFilePathFor(home)), false);
});

test("deleteCredentials es idempotente: false cuando no había nada, sin tirar", t => {
  const home = tempHome(t);
  assert.equal(deleteCredentials(home), false);
  assert.equal(deleteCredentials(home), false);
});

test("deleteCredentials nunca toca config.json", t => {
  const home = tempHome(t);
  ensureCredentialDirSecure(home);
  const configPath = path.join(configDirFor(home), "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ version: 1 }));
  writeCredentialsAtomic(home, "rag_abc123");

  deleteCredentials(home);

  assert.ok(fs.existsSync(configPath), "config.json debe seguir existiendo");
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { version: 1 });
});

// ─── nunca imprime / serializa el token en un error ────────────────────────

test("ningún Error lanzado por el store incluye el valor del token", t => {
  const home = tempHome(t);
  const secret = "rag_should_never_appear_in_any_error";

  try {
    writeCredentialsAtomic(home, "");
  } catch (err) {
    assert.ok(!err.message.includes(secret));
  }

  ensureCredentialDirSecure(home);
  const outside = path.join(os.tmpdir(), `rail-harness-err-${process.pid}.json`);
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, credentialsFilePathFor(home));

  try {
    writeCredentialsAtomic(home, secret);
    assert.fail("se esperaba que tirara por symlink inseguro");
  } catch (err) {
    assert.ok(!err.message.includes(secret));
  }
});
