/**
 * Developer Console — Doctor (HC-01-AC-02, HC-01-AC-03).
 *
 * Node/Git/Claude Code checks never depend on the real binaries: `runGit` /
 * `runClaude` are injected fakes. `homeDir` always points at a throwaway
 * temp directory, never the real HOME.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getIdentity,
  checkNode,
  checkGit,
  checkClaudeCode,
  checkHome,
  runDoctorChecks,
  doctorPassCount,
  doctorExitCode,
  condensedChecks,
  parseMinNodeRange
} from "../src/console/doctor.js";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-doc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── HC-01-AC-02: identity, no manual prompt ─────────────────────────────

test("getIdentity: detecta usuario y hostname sin pedirlos (vía os inyectado)", () => {
  const fakeOs = {
    userInfo: () => ({ username: "fran" }),
    hostname: () => "harness-prod-01",
    homedir: () => "/home/fran"
  };
  const identity = getIdentity({ osModule: fakeOs, env: {} });
  assert.deepEqual(identity, { username: "fran", hostname: "harness-prod-01", home: "/home/fran" });
});

test("getIdentity: usa el HOME real del sistema cuando no se inyecta nada", () => {
  const identity = getIdentity();
  assert.equal(typeof identity.username, "string");
  assert.equal(typeof identity.hostname, "string");
  assert.ok(identity.username.length > 0);
});

// ── HC-01-AC-03: Node / Git / Claude Code ───────────────────────────────

test("parseMinNodeRange: parsea '>=18' y '>=18.2'", () => {
  assert.deepEqual(parseMinNodeRange(">=18"), { major: 18, minor: 0 });
  assert.deepEqual(parseMinNodeRange(">=18.2"), { major: 18, minor: 2 });
  assert.equal(parseMinNodeRange("nope"), null);
});

test("checkNode: PASS cuando la versión cumple engines.node", () => {
  const pkgPath = path.join(os.tmpdir(), `rail-harness-pkg-${process.pid}.json`);
  fs.writeFileSync(pkgPath, JSON.stringify({ engines: { node: ">=18" } }));
  try {
    assert.equal(checkNode({ nodeVersion: "22.4.0", packageJsonPath: pkgPath }).ok, true);
    assert.equal(checkNode({ nodeVersion: "16.0.0", packageJsonPath: pkgPath }).ok, false);
  } finally {
    fs.rmSync(pkgPath, { force: true });
  }
});

test("checkGit: PASS con un runner fake que simula git instalado", () => {
  const result = checkGit({ runGit: () => "git version 2.43.0" });
  assert.equal(result.ok, true);
  assert.match(result.detail, /2\.43\.0/);
});

test("checkGit: FAIL cuando el runner fake tira ENOENT", () => {
  const err = Object.assign(new Error("not found"), { code: "ENOENT" });
  const result = checkGit({ runGit: () => { throw err; } });
  assert.equal(result.ok, false);
});

test("checkClaudeCode: PASS con un runner fake — NUNCA depende del binario real", () => {
  const result = checkClaudeCode({ runClaude: () => "1.2.3" });
  assert.equal(result.ok, true);
});

test("checkClaudeCode: FAIL cuando 'claude' no está en PATH (fake ENOENT)", () => {
  const err = Object.assign(new Error("not found"), { code: "ENOENT" });
  const result = checkClaudeCode({ runClaude: () => { throw err; } });
  assert.equal(result.ok, false);
  assert.match(result.detail, /PATH/);
});

test("checkHome: PASS cuando HOME apunta a un directorio existente", t => {
  const home = tempHome(t);
  assert.equal(checkHome({ env: { HOME: home } }).ok, true);
});

test("checkHome: FAIL cuando HOME no está definido", () => {
  assert.equal(checkHome({ env: {}, osModule: { homedir: () => undefined } }).ok, false);
});

test("runDoctorChecks: 6 checks, todo inyectado — nunca toca binarios reales ni el HOME real", t => {
  const home = tempHome(t);
  const checks = runDoctorChecks({
    env: { HOME: home },
    homeDir: home,
    nodeVersion: "22.0.0",
    runGit: () => "git version 2.43.0",
    runClaude: () => "1.0.0"
  });

  assert.equal(checks.length, 6);
  assert.deepEqual(
    checks.map(c => c.id),
    ["node", "git", "claudeCode", "home", "configDirAccessible", "configDirWritable"]
  );
  assert.equal(doctorPassCount(checks), 6);
  assert.equal(doctorExitCode(checks), 0);
});

test("doctorExitCode: distinto de 0 si algún check falla", t => {
  const home = tempHome(t);
  const err = Object.assign(new Error("nope"), { code: "ENOENT" });
  const checks = runDoctorChecks({
    env: { HOME: home },
    homeDir: home,
    nodeVersion: "22.0.0",
    runGit: () => "git version 2.43.0",
    runClaude: () => { throw err; }
  });

  assert.equal(doctorExitCode(checks), 1);
  assert.ok(doctorPassCount(checks) < checks.length);
});

test("condensedChecks: resume a 4 líneas (Node, Git, Claude Code, Configuración local)", t => {
  const home = tempHome(t);
  const checks = runDoctorChecks({
    env: { HOME: home },
    homeDir: home,
    nodeVersion: "22.0.0",
    runGit: () => "git version 2.43.0",
    runClaude: () => "1.0.0"
  });
  const condensed = condensedChecks(checks);
  assert.deepEqual(condensed.map(c => c.label), ["Node", "Git", "Claude Code", "Configuración local"]);
  assert.ok(condensed.every(c => c.ok === true));
});
