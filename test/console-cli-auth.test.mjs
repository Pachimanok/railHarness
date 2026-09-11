/**
 * HC-03 — CLI integration: `rail-harness login` / `logout` / `auth status`,
 * the auth-aware main menu, and `projects`/`ready`/"Empezar a trabajar"
 * working off a locally stored credential (no `RAIL_TOKEN` in env).
 *
 * Never blocks on real stdin/network: `menu`/`readSecret`/`rail` are always
 * injected fakes, `homeDir` always points at a throwaway temp directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/console/cli.js";
import { writeCredentialsAtomic, credentialsFilePathFor } from "../src/console/credential-store.js";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-cliauth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function collectLogger() {
  const lines = [];
  return { logger: line => lines.push(line), lines };
}

const fakeOsModule = { userInfo: () => ({ username: "fran" }), hostname: () => "harness-prod-01" };
const fakeRunGit = () => "git version 2.43.0";
const fakeRunClaude = () => "1.0.0";

function scriptedMenu(values) {
  let i = 0;
  return async () => {
    if (i >= values.length) throw new Error("scriptedMenu: se quedó sin respuestas");
    return values[i++];
  };
}

function menuByLabel(labels) {
  let i = 0;
  return async ({ items }) => {
    if (i >= labels.length) throw new Error("menuByLabel: se quedó sin respuestas");
    const label = labels[i++];
    const found = items.find(it => it.label === label);
    if (!found) {
      throw new Error(`menuByLabel: no se encontró "${label}" entre [${items.map(it => it.label).join(", ")}]`);
    }
    return found.value;
  };
}

// ─── HC-03-AC-01: sin credenciales, ofrece login ───────────────────────────

test("HC-03-AC-01: sin credenciales, el menú principal ofrece 'Iniciar sesión'", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  await runCli({
    argv: [],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false },
    menu: menuByLabel(["Iniciar sesión", "Salir"]),
    readSecret: async () => { throw new Error("no debería pedirse token en este flujo"); }
  });

  const text = lines.join("\n");
  assert.match(text, /no autenticado/);
  assert.match(text, /Rail Harness Login/);
});

test("HC-03-AC-01: autenticado (token en store), el menú muestra 'Empezar a trabajar' y 'Cerrar sesión'", async t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_stored_token");
  const { lines } = collectLogger();

  await runCli({
    argv: [],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger: line => lines.push(line),
    output: { isTTY: false },
    menu: menuByLabel(["Salir"])
  });

  assert.match(lines.join("\n"), /Credencial personal/);
});

// ─── comando login/logout/auth status ──────────────────────────────────────

test("rail-harness login: comando directo valida y persiste", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();
  const rail = { async listProjects() { return { items: [{ id: "p1" }] }; } };

  const exitCode = await runCli({
    argv: ["login"],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    osModule: fakeOsModule,
    homeDir: home,
    logger,
    output: { isTTY: false },
    readSecret: async () => "rag_direct_login",
    rail
  });

  assert.equal(exitCode, 0);
  assert.ok(fs.existsSync(credentialsFilePathFor(home)));
  assert.match(lines.join("\n"), /Sesión configurada correctamente/);
});

test("rail-harness login: argumentos inesperados => exit 1", async t => {
  const home = tempHome(t);
  const exitCode = await runCli({
    argv: ["login", "algo"],
    env: { HOME: home },
    homeDir: home,
    logger: () => {},
    output: { isTTY: false }
  });
  assert.equal(exitCode, 1);
});

test("rail-harness logout: comando directo elimina la credencial", async t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_x");
  const { logger, lines } = collectLogger();

  const exitCode = await runCli({ argv: ["logout"], env: { HOME: home }, homeDir: home, logger, output: { isTTY: false } });

  assert.equal(exitCode, 0);
  assert.equal(fs.existsSync(credentialsFilePathFor(home)), false);
  assert.match(lines.join("\n"), /Credencial local eliminada/);
});

test("rail-harness auth status: comando directo", async t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_x");
  const { logger, lines } = collectLogger();
  const rail = { async listProjects() { return { items: [] }; } };

  const exitCode = await runCli({
    argv: ["auth", "status"],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    homeDir: home,
    osModule: fakeOsModule,
    logger,
    output: { isTTY: false },
    rail
  });

  assert.equal(exitCode, 0);
  assert.match(lines.join("\n"), /Rail Harness Auth/);
});

test("rail-harness auth: subcomando desconocido muestra uso, exit 1", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();
  const exitCode = await runCli({ argv: ["auth", "bogus"], env: { HOME: home }, homeDir: home, logger, output: { isTTY: false } });

  assert.equal(exitCode, 1);
  assert.match(lines.join("\n"), /Uso: rail-harness auth status/);
});

// ─── HC-03-AC-13: projects/ready/start funcionan con stored token ──────────

test("HC-03-AC-13: 'rail-harness projects' funciona con el token guardado, sin RAIL_TOKEN en env", async t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_stored_for_projects");
  const { logger, lines } = collectLogger();
  const rail = {
    async listProjects() {
      return { items: [{ id: "p1", name: "TotalView" }] };
    }
  };

  const exitCode = await runCli({
    argv: ["projects"],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    homeDir: home,
    logger,
    output: { isTTY: false },
    rail
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(lines, ["p1  TotalView"]);
});

test("HC-03-AC-13: 'rail-harness projects' realmente resuelve el token guardado (sin inyectar rail)", async t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_stored_for_projects_real");
  const { logger, lines } = collectLogger();

  const originalFetch = global.fetch;
  const seenAuthHeaders = [];
  global.fetch = async (url, opts) => {
    seenAuthHeaders.push(opts?.headers?.Authorization);
    return { ok: true, status: 200, async text() { return JSON.stringify({ items: [] }); } };
  };
  t.after(() => { global.fetch = originalFetch; });

  const exitCode = await runCli({
    argv: ["projects"],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    homeDir: home,
    logger,
    output: { isTTY: false }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(seenAuthHeaders, ["Bearer rag_stored_for_projects_real"]);
  assert.deepEqual(lines, ["No tenés proyectos disponibles en RailSoft."]);
});

test("HC-03-AC-13: 'rail-harness ready <projectId>' funciona con el token guardado", async t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_stored_for_ready");
  const { logger, lines } = collectLogger();
  const rail = { async listReady() { return { items: [{ item: { code: "TV-1", title: "Corregir" } }] }; } };

  const exitCode = await runCli({
    argv: ["ready", "proj_1"],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    homeDir: home,
    logger,
    output: { isTTY: false },
    rail
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(lines, ["TV-1  Corregir"]);
});

test("HC-03-AC-13: 'Empezar a trabajar' desde el menú funciona con el token guardado", async t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_stored_for_start");
  const { logger, lines } = collectLogger();
  const rail = {
    async listProjects() { return { items: [{ id: "proj_1", name: "TotalView" }] }; },
    async listReady() { return { items: [] }; }
  };

  const exitCode = await runCli({
    argv: [],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false },
    rail,
    menu: menuByLabel(["Empezar a trabajar", "TotalView", "Volver", "Salir"])
  });

  assert.equal(exitCode, 0);
  assert.match(lines.join("\n"), /RailSoft conectado/);
});

// ─── HC-03-AC-08: config.json nunca contiene el token ──────────────────────

test("HC-03-AC-08: después de login, config.json nunca contiene el token", async t => {
  const home = tempHome(t);
  const rail = { async listProjects() { return { items: [] }; } };

  await runCli({
    argv: ["login"],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    homeDir: home,
    logger: () => {},
    output: { isTTY: false },
    readSecret: async () => "rag_must_not_leak_to_config",
    rail
  });

  await runCli({
    argv: ["setup"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger: () => {},
    output: { isTTY: false }
  });

  const configPath = path.join(home, ".config", "rail-harness", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(config, { version: 1 });
  const raw = fs.readFileSync(configPath, "utf8");
  assert.ok(!raw.includes("rag_must_not_leak_to_config"));
});

// ─── doctor: distingue NO_CREDENTIAL ────────────────────────────────────────

test("rail-harness doctor: sin credencial reporta 'Credencial Rail' en falla, sin tocar 6/6 checks PASS", async t => {
  const home = tempHome(t);
  const { logger, lines } = collectLogger();

  const exitCode = await runCli({
    argv: ["doctor"],
    env: { HOME: home },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false }
  });

  assert.equal(exitCode, 0);
  const text = lines.join("\n");
  assert.match(text, /6\/6 checks PASS/);
  assert.match(text, /Credencial Rail/);
});

test("rail-harness doctor: con credencial guardada reporta 'Credencial Rail' OK", async t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_doctor_ok");
  const { logger, lines } = collectLogger();
  const rail = { async listProjects() { return { items: [] }; } };

  const exitCode = await runCli({
    argv: ["doctor"],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    osModule: fakeOsModule,
    homeDir: home,
    runGit: fakeRunGit,
    runClaude: fakeRunClaude,
    logger,
    output: { isTTY: false },
    rail
  });

  assert.equal(exitCode, 0);
  const text = lines.join("\n");
  assert.match(text, /6\/6 checks PASS/);
  const credentialLine = lines.find(l => l.includes("Credencial Rail"));
  assert.ok(credentialLine);
  assert.match(credentialLine, /✓/);
});

// ─── HC-03-AC-15: toda interacción sigue siendo GET-only ───────────────────

test("HC-03-AC-15: login + auth status + projects con el store real => todo fetch es GET", async t => {
  const home = tempHome(t);
  const originalFetch = global.fetch;
  const methods = [];
  global.fetch = async (url, opts = {}) => {
    methods.push(opts.method || "GET");
    return { ok: true, status: 200, async text() { return JSON.stringify({ items: [] }); } };
  };
  t.after(() => { global.fetch = originalFetch; });

  await runCli({
    argv: ["login"],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    homeDir: home,
    logger: () => {},
    output: { isTTY: false },
    readSecret: async () => "rag_get_only_check"
  });

  await runCli({
    argv: ["auth", "status"],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    homeDir: home,
    osModule: fakeOsModule,
    logger: () => {},
    output: { isTTY: false }
  });

  await runCli({
    argv: ["projects"],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail" },
    homeDir: home,
    logger: () => {},
    output: { isTTY: false }
  });

  assert.ok(methods.length >= 3);
  for (const m of methods) assert.equal(m, "GET");
});
