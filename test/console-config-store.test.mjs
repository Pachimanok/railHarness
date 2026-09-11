/**
 * Developer Console — config-store (HC-01-AC-04).
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
  configDirFor,
  configFilePathFor,
  ensureConfig,
  ensureConfigDir,
  readConfig,
  writeConfigAtomic,
  DEFAULT_CONFIG
} from "../src/console/config-store.js";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-cfg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("ensureConfig: crea el directorio y config.json con {version:1}", t => {
  const home = tempHome(t);
  const result = ensureConfig(home);

  assert.equal(result.created, true);
  assert.deepEqual(result.config, DEFAULT_CONFIG);
  assert.ok(fs.existsSync(configDirFor(home)));
  assert.ok(fs.existsSync(configFilePathFor(home)));

  const onDisk = JSON.parse(fs.readFileSync(configFilePathFor(home), "utf8"));
  assert.deepEqual(onDisk, { version: 1 });
});

test("ensureConfig: no sobrescribe una config válida ya existente", t => {
  const home = tempHome(t);
  ensureConfigDir(home);
  fs.writeFileSync(configFilePathFor(home), JSON.stringify({ version: 1, note: "custom" }));

  const before = fs.statSync(configFilePathFor(home)).mtimeMs;
  const result = ensureConfig(home);

  assert.equal(result.created, false);
  assert.deepEqual(result.config, { version: 1, note: "custom" });
  assert.equal(fs.statSync(configFilePathFor(home)).mtimeMs, before);
});

test("ensureConfig: recrea la config si el archivo está corrupto", t => {
  const home = tempHome(t);
  ensureConfigDir(home);
  fs.writeFileSync(configFilePathFor(home), "{ esto no es json");

  const result = ensureConfig(home);
  assert.equal(result.created, true);
  assert.deepEqual(readConfig(home).config, { version: 1 });
});

test("readConfig: reporta 'missing' cuando no hay archivo, sin tirar", t => {
  const home = tempHome(t);
  const result = readConfig(home);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing");
});

test("writeConfigAtomic / readConfig: nunca hay claves de tipo secreto", t => {
  const home = tempHome(t);
  writeConfigAtomic(home, { version: 1, note: "sin datos sensibles" });

  const raw = fs.readFileSync(configFilePathFor(home), "utf8");
  for (const bad of ["token", "secret", "password", "claimToken", "authorization"]) {
    assert.ok(!raw.toLowerCase().includes(bad.toLowerCase()), `no debería contener "${bad}"`);
  }
});

test("writeConfigAtomic: rechaza escribir una clave que parece un secreto", t => {
  const home = tempHome(t);
  assert.throws(() => writeConfigAtomic(home, { version: 1, token: "nope" }), /secreto/);
});

test("ensureConfig: crea el directorio de forma idempotente (llamadas repetidas)", t => {
  const home = tempHome(t);
  ensureConfig(home);
  const second = ensureConfig(home);
  assert.equal(second.created, false);
});
