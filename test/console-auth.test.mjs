/**
 * HC-03 — `rail-harness login` / `logout` / `auth status`
 * (`src/console/auth.js`).
 *
 * `readSecret` is always an injected fake (never real stdin). `rail`, when
 * injected, overrides the read-only Rail facade so validation never touches
 * the network. `homeDir` always points at a throwaway temp directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loginCommand, logoutCommand, authStatusCommand } from "../src/console/auth.js";
import { readCredentials, writeCredentialsAtomic, credentialsFilePathFor } from "../src/console/credential-store.js";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function collectLogger() {
  const lines = [];
  return { logger: line => lines.push(line), lines };
}

const fakeOsModule = { userInfo: () => ({ username: "fran" }), hostname: () => "harness-prod-01" };
const ENV_WITH_URL = { HOME: "", RAIL_API_URL: "https://rail.example/api/rail" };

function okRail(projectCount = 2) {
  return { async listProjects() { return { items: Array.from({ length: projectCount }, (_, i) => ({ id: `p${i}` })) }; } };
}

function rejectingRail(status) {
  return { async listProjects() { throw Object.assign(new Error("nope"), { status }); } };
}

function networkErrorRail() {
  return { async listProjects() { throw new Error("ECONNREFUSED"); } };
}

// ─── HC-03-AC-02: login válido ──────────────────────────────────────────────

test("HC-03-AC-02: login válido valida vía GET y RECIÉN DESPUÉS persiste el token", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = await loginCommand({
    logger,
    env: ENV_WITH_URL,
    homeDir: home,
    osModule: fakeOsModule,
    readSecret: async () => "rag_valid_token",
    rail: okRail(2)
  });

  assert.equal(exitCode, 0);
  const stored = readCredentials(home);
  assert.equal(stored.ok, true);
  assert.equal(stored.token, "rag_valid_token");

  const text = lines.join("\n");
  assert.match(text, /RailSoft conectado/);
  assert.match(text, /Credencial válida/);
  assert.match(text, /Acceso autorizado/);
  assert.match(text, /2 proyectos disponibles/);
  assert.match(text, /Sesión configurada correctamente/);
});

// ─── HC-03-AC-03: login inválido (401/403) ─────────────────────────────────

test("HC-03-AC-03: login rechazado (401) NO persiste el token", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = await loginCommand({
    logger,
    env: ENV_WITH_URL,
    homeDir: home,
    osModule: fakeOsModule,
    readSecret: async () => "rag_invalid_token",
    rail: rejectingRail(401)
  });

  assert.equal(exitCode, 1);
  assert.equal(fs.existsSync(credentialsFilePathFor(home)), false);
  assert.match(lines.join("\n"), /Credencial rechazada por RailSoft/);
});

test("HC-03-AC-03: login rechazado (403) NO persiste el token", async t => {
  const home = tempHome(t);
  const exitCode = await loginCommand({
    logger: () => {},
    env: ENV_WITH_URL,
    homeDir: home,
    osModule: fakeOsModule,
    readSecret: async () => "rag_invalid_token",
    rail: rejectingRail(403)
  });

  assert.equal(exitCode, 1);
  assert.equal(fs.existsSync(credentialsFilePathFor(home)), false);
});

// ─── HC-03-AC-04: error de red ─────────────────────────────────────────────

test("HC-03-AC-04: error de red NO persiste el token", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = await loginCommand({
    logger,
    env: ENV_WITH_URL,
    homeDir: home,
    osModule: fakeOsModule,
    readSecret: async () => "rag_some_token",
    rail: networkErrorRail()
  });

  assert.equal(exitCode, 1);
  assert.equal(fs.existsSync(credentialsFilePathFor(home)), false);
  assert.match(lines.join("\n"), /No se pudo conectar con RailSoft/);
});

// ─── input vacío ────────────────────────────────────────────────────────────

test("login: token vacío es rechazado, no persiste nada, no llama a Rail", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();
  let called = false;
  const rail = { async listProjects() { called = true; return { items: [] }; } };

  const exitCode = await loginCommand({
    logger,
    env: ENV_WITH_URL,
    homeDir: home,
    osModule: fakeOsModule,
    readSecret: async () => "   ",
    rail
  });

  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.equal(fs.existsSync(credentialsFilePathFor(home)), false);
  assert.match(lines.join("\n"), /no puede estar vacío/);
});

// ─── HC-03-AC-14: URL insegura ─────────────────────────────────────────────

test("HC-03-AC-14: RAIL_API_URL HTTP remoto => rechazo ANTES de leer/enviar el token, fetch nunca se llama", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = () => { fetchCalls += 1; throw new Error("fetch no debería llamarse"); };
  t.after(() => { global.fetch = originalFetch; });

  const exitCode = await loginCommand({
    logger,
    env: { RAIL_API_URL: "http://railsoft.example.com/api/rail" },
    homeDir: home,
    osModule: fakeOsModule,
    readSecret: async () => "rag_some_token"
  });

  assert.equal(exitCode, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(fs.existsSync(credentialsFilePathFor(home)), false);
  assert.match(lines.join("\n"), /HTTPS/);
});

test("login sin RAIL_API_URL configurada: mensaje claro, no prompt inútil hacia Rail, no persiste", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();
  let promptCalled = false;

  const exitCode = await loginCommand({
    logger,
    env: {},
    homeDir: home,
    osModule: fakeOsModule,
    readSecret: async () => { promptCalled = true; return "rag_x"; }
  });

  assert.equal(exitCode, 1);
  assert.equal(promptCalled, false);
  assert.match(lines.join("\n"), /RAIL_API_URL no está configurada/);
});

// ─── nunca imprime el token ─────────────────────────────────────────────────

test("login nunca imprime el token, ni en éxito ni en fallo", async t => {
  const home = tempHome(t);
  const secret = "rag_should_never_be_printed_anywhere";
  const { logger: loggerOk, lines: linesOk } = collectLogger();
  await loginCommand({
    logger: loggerOk,
    env: ENV_WITH_URL,
    homeDir: home,
    osModule: fakeOsModule,
    readSecret: async () => secret,
    rail: okRail(1)
  });
  assert.ok(!linesOk.join("\n").includes(secret));

  const home2 = tempHome(t);
  const { logger: loggerFail, lines: linesFail } = collectLogger();
  await loginCommand({
    logger: loggerFail,
    env: ENV_WITH_URL,
    homeDir: home2,
    osModule: fakeOsModule,
    readSecret: async () => secret,
    rail: rejectingRail(401)
  });
  assert.ok(!linesFail.join("\n").includes(secret));
});

// ─── HC-03-AC-11: logout ───────────────────────────────────────────────────

test("HC-03-AC-11: logout elimina la credencial y preserva config.json", async t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_to_remove");
  const configDir = path.dirname(credentialsFilePathFor(home));
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ version: 1 }));

  const { logger, lines } = collectLogger();
  const exitCode = logoutCommand({ logger, homeDir: home });

  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(credentialsFilePathFor(home)), false);
  assert.ok(fs.existsSync(configPath));
  assert.match(lines.join("\n"), /Credencial local eliminada/);
});

test("logout es idempotente y muestra un mensaje distinto cuando no había sesión", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = logoutCommand({ logger, homeDir: home });

  assert.equal(exitCode, 0);
  assert.match(lines.join("\n"), /No había una credencial local configurada/);
});

// ─── HC-03-AC-12: auth status nunca imprime el token ───────────────────────

test("HC-03-AC-12: auth status (autenticado, OK) nunca imprime el token y muestra la fuente", async t => {
  const home = tempHome(t);
  const secret = "rag_should_never_appear_in_status";
  writeCredentialsAtomic(home, secret);
  const { logger, lines } = collectLogger();

  const exitCode = await authStatusCommand({
    logger,
    env: ENV_WITH_URL,
    homeDir: home,
    osModule: fakeOsModule,
    rail: okRail(1)
  });

  assert.equal(exitCode, 0);
  const text = lines.join("\n");
  assert.ok(!text.includes(secret));
  assert.match(text, /Credencial local encontrada/);
  assert.match(text, /RailSoft conectado/);
  assert.match(text, /Credencial autorizada/);
  assert.match(text, /Fuente: credencial local/);
});

test("auth status: token de environment reporta 'Fuente: environment', nunca el valor", async t => {
  const home = tempHome(t);
  const secret = "rag_env_should_never_print";
  const { logger, lines } = collectLogger();

  await authStatusCommand({
    logger,
    env: { ...ENV_WITH_URL, RAIL_TOKEN: secret },
    homeDir: home,
    osModule: fakeOsModule,
    rail: okRail(0)
  });

  const text = lines.join("\n");
  assert.ok(!text.includes(secret));
  assert.match(text, /Fuente: environment/);
});

test("auth status sin credencial: NOT_AUTHENTICATED, sin llamar a Rail", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();
  let called = false;
  const rail = { async listProjects() { called = true; return { items: [] }; } };

  const exitCode = await authStatusCommand({ logger, env: {}, homeDir: home, osModule: fakeOsModule, rail });

  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.match(lines.join("\n"), /no autenticado/);
});

test("auth status con credencial rechazada por RailSoft reporta la falla sin imprimir el token", async t => {
  const home = tempHome(t);
  const secret = "rag_rejected_should_not_print";
  writeCredentialsAtomic(home, secret);
  const { logger, lines } = collectLogger();

  const exitCode = await authStatusCommand({
    logger,
    env: ENV_WITH_URL,
    homeDir: home,
    osModule: fakeOsModule,
    rail: rejectingRail(401)
  });

  assert.equal(exitCode, 1);
  const text = lines.join("\n");
  assert.ok(!text.includes(secret));
  assert.match(text, /Credencial autorizada/);
});

// ─── HC-03-AC-16: identidad local, nunca inventa identidad Rail remota ─────

test("HC-03-AC-16: login/status muestran linuxUser/hostname detectados, nunca 'rail-harness-<user>' inventado", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  await loginCommand({
    logger,
    env: ENV_WITH_URL,
    homeDir: home,
    osModule: fakeOsModule,
    readSecret: async () => "rag_x",
    rail: okRail(0)
  });

  const text = lines.join("\n");
  assert.match(text, /Usuario Linux: fran/);
  assert.match(text, /Servidor: harness-prod-01/);
  assert.ok(!text.includes("rail-harness-fran"), "no debe fabricar una identidad Rail a partir del usuario Linux");
});
