/**
 * HC-02 — read-only Rail facade (`src/console/rail-readonly.js`).
 *
 * `railCredentialsFromEnv` never guesses/falls back to a hardcoded value,
 * and `createReadonlyRail` exposes strictly `listProjects`/`listReady`/
 * `getTicket` — no mutation is reachable through it, even though the
 * underlying `RailApiClient` has mutating methods.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  railCredentialsFromEnv,
  createReadonlyRail,
  buildReadonlyRailFromEnv,
  RAIL_INSECURE_URL_MESSAGE
} from "../src/console/rail-readonly.js";

// ─── railCredentialsFromEnv ────────────────────────────────────────────────

test("railCredentialsFromEnv: null si falta RAIL_API_URL", () => {
  assert.equal(railCredentialsFromEnv({ RAIL_TOKEN: "t" }), null);
});

test("railCredentialsFromEnv: null si falta RAIL_TOKEN", () => {
  assert.equal(railCredentialsFromEnv({ RAIL_API_URL: "https://rail.example" }), null);
});

test("railCredentialsFromEnv: null con env vacío", () => {
  assert.equal(railCredentialsFromEnv({}), null);
});

test("railCredentialsFromEnv: arma {apiUrl,token,agent,machine} sólo con lo que RAIL_* trae", () => {
  const creds = railCredentialsFromEnv({
    RAIL_API_URL: "https://rail.example/api/rail",
    RAIL_TOKEN: "secret-token",
    RAIL_AGENT: "agent-x",
    RAIL_MACHINE: "machine-x"
  });
  assert.deepEqual(creds, {
    apiUrl: "https://rail.example/api/rail",
    token: "secret-token",
    agent: "agent-x",
    machine: "machine-x"
  });
});

test("railCredentialsFromEnv: agent/machine son opcionales", () => {
  const creds = railCredentialsFromEnv({
    RAIL_API_URL: "https://rail.example/api/rail",
    RAIL_TOKEN: "secret-token"
  });
  assert.equal(creds.apiUrl, "https://rail.example/api/rail");
  assert.equal(creds.token, "secret-token");
  assert.equal(creds.agent, undefined);
  assert.equal(creds.machine, undefined);
});

// ─── createReadonlyRail ─────────────────────────────────────────────────

test("createReadonlyRail: expone EXACTAMENTE listProjects/listReady/getTicket", () => {
  const rail = createReadonlyRail({ apiUrl: "https://rail.example/api/rail", token: "t" });
  assert.deepEqual(Object.keys(rail).sort(), ["getTicket", "listProjects", "listReady"]);
});

test("createReadonlyRail: no expone NINGUNA operación mutante, aunque RailApiClient sí las tenga", () => {
  const rail = createReadonlyRail({ apiUrl: "https://rail.example/api/rail", token: "t" });
  for (const method of [
    "claim",
    "resume",
    "recover",
    "transition",
    "addComment",
    "createQuery",
    "createCheck",
    "createDeployment",
    "updateDeployment",
    "heartbeat",
    "finishRun",
    "request"
  ]) {
    assert.equal(rail[method], undefined, `createReadonlyRail no debería exponer "${method}"`);
  }
});

test("createReadonlyRail: el objeto devuelto está congelado (no se le puede agregar claim() después)", () => {
  const rail = createReadonlyRail({ apiUrl: "https://rail.example/api/rail", token: "t" });
  assert.ok(Object.isFrozen(rail));
  try {
    rail.claim = () => {};
  } catch {
    // strict-mode assignment to a frozen object throws — either way it must not stick.
  }
  assert.equal(rail.claim, undefined);
});

test("createReadonlyRail: listProjects/listReady/getTicket hacen GET real (fetch espiado) y nunca escriben el token en la URL", async () => {
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), method: opts?.method || "GET", headers: opts?.headers || {} });
    if (String(url).endsWith("/projects")) {
      return { ok: true, status: 200, async text() { return JSON.stringify({ items: [] }); } };
    }
    if (String(url).includes("/tickets?")) {
      return { ok: true, status: 200, async text() { return JSON.stringify({ items: [] }); } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ state: "READY" }); } };
  };
  try {
    const rail = createReadonlyRail({ apiUrl: "https://rail.example/api/rail", token: "secret-token" });
    await rail.listProjects();
    await rail.listReady("proj_1", 10);
    await rail.getTicket("ABC-1");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(seen.length, 3);
  for (const call of seen) {
    assert.equal(call.method, "GET");
    assert.ok(!call.url.includes("secret-token"), "el token nunca debe viajar en la URL");
    assert.equal(call.headers.Authorization, "Bearer secret-token");
  }
});

// ─── política de transporte seguro (RAIL_API_URL) — deuda de seguridad ────
//
// HC-02 lee RAIL_API_URL directamente (no pasa por runtime-config.js), así
// que debe aplicar la MISMA política que el Worker: HTTPS, o HTTP sólo para
// localhost. La validación ocurre ANTES de construir RailApiClient, así que
// un fetch espiado en 0 es evidencia directa de que nunca se intentó red.

function spyFetch(t) {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls += 1;
    throw new Error(`fetch() no debería llamarse jamás (args=${JSON.stringify(args)})`);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return () => calls;
}

test("1. HTTPS remoto => permitido (RAIL_API_URL válida y segura)", () => {
  const { rail, error } = buildReadonlyRailFromEnv({
    RAIL_API_URL: "https://railsoft.vercel.app/api/rail",
    RAIL_TOKEN: "t"
  });
  assert.equal(error, null);
  assert.ok(rail);
  assert.deepEqual(Object.keys(rail).sort(), ["getTicket", "listProjects", "listReady"]);
});

test("2. HTTP + localhost => permitido (desarrollo local)", () => {
  const { rail, error } = buildReadonlyRailFromEnv({
    RAIL_API_URL: "http://localhost:3000/api/rail",
    RAIL_TOKEN: "t"
  });
  assert.equal(error, null);
  assert.ok(rail);
});

test("3. HTTP remoto (no localhost) => rechazado ANTES de red, fetch === 0", t => {
  const fetchCalls = spyFetch(t);
  const { rail, error } = buildReadonlyRailFromEnv({
    RAIL_API_URL: "http://railsoft.example.com/api/rail",
    RAIL_TOKEN: "t"
  });
  assert.equal(rail, null);
  assert.equal(error, RAIL_INSECURE_URL_MESSAGE);
  assert.equal(fetchCalls(), 0);
});

test("4. RAIL_API_URL inválida (no es una URL) => rechazada ANTES de red, fetch === 0", t => {
  const fetchCalls = spyFetch(t);
  const { rail, error } = buildReadonlyRailFromEnv({ RAIL_API_URL: "not-a-url", RAIL_TOKEN: "t" });
  assert.equal(rail, null);
  assert.equal(error, RAIL_INSECURE_URL_MESSAGE);
  assert.equal(fetchCalls(), 0);
});

test("5. En ningún caso de URL inválida/insegura aparece RAIL_TOKEN ni su valor en el error", t => {
  spyFetch(t);
  const token = "rag_supersecret_should_never_appear";

  for (const apiUrl of ["http://railsoft.example.com/api/rail", "not-a-url", "ftp://also-bad.example"]) {
    const { error } = buildReadonlyRailFromEnv({ RAIL_API_URL: apiUrl, RAIL_TOKEN: token });
    assert.ok(error, `se esperaba un error para "${apiUrl}"`);
    assert.ok(!error.includes(token), `el error para "${apiUrl}" no debe contener el token`);
    assert.ok(!error.includes("RAIL_TOKEN"), `el error para "${apiUrl}" no debe mencionar RAIL_TOKEN`);
  }

  // createReadonlyRail() también falla cerrado, ANTES de construir el
  // cliente Rail — y su Error tampoco lleva el token.
  assert.throws(() => createReadonlyRail({ apiUrl: "http://railsoft.example.com/api/rail", token }), err => {
    assert.ok(!err.message.includes(token));
    return true;
  });
});

test("createReadonlyRail: nunca llega a construir RailApiClient con una URL insegura (fetch === 0)", t => {
  const fetchCalls = spyFetch(t);
  assert.throws(() => createReadonlyRail({ apiUrl: "http://railsoft.example.com/api/rail", token: "t" }));
  assert.equal(fetchCalls(), 0);
});

test("buildReadonlyRailFromEnv: sigue distinguiendo 'sin credenciales' (error null, rail null) de 'URL insegura' (error string)", () => {
  const noCreds = buildReadonlyRailFromEnv({});
  assert.deepEqual(noCreds, { rail: null, error: null });

  const insecure = buildReadonlyRailFromEnv({ RAIL_API_URL: "http://railsoft.example.com/api/rail", RAIL_TOKEN: "t" });
  assert.equal(insecure.rail, null);
  assert.equal(typeof insecure.error, "string");
});
