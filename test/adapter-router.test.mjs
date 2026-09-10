/**
 * AdapterRouter — RAIL-D-00004 acceptance tests. Fully offline: fake adapters,
 * no CLI, no Rail.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAdapterRouter,
  DEFAULT_ADAPTERS,
  ADAPTER_ROUTER_ERROR_CODES
} from "../src/adapters/adapter-router.js";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { buildExecutionEnvelope } from "../src/contracts/execution-envelope.js";

const BRANCH = "rail/rail-d-00004";

function makeEnvelope(overrides = {}) {
  return buildExecutionEnvelope({
    kind: "IMPLEMENT",
    run: { id: "run-1", branch: BRANCH },
    ticket: { item: { code: "RAIL-D-00004" } },
    workspace: { path: "/tmp/ws/rail-d-00004" },
    session: { id: "11111111-2222-4333-8444-555555555555" },
    ...overrides
  });
}

/** Minimal spy adapter honouring the stable interface. */
function fakeAdapter(name) {
  const calls = { preflight: 0, run: [], createExecution: [] };
  return {
    calls,
    adapter: {
      provider: name,
      preflight(opts) {
        calls.preflight += 1;
        return { version: `${name}-1.0`, flags: [] };
      },
      run(envelope, opts) {
        calls.run.push({ envelope, opts });
        return Promise.resolve({ sessionId: envelope.session.id, result: { via: name } });
      }
    }
  };
}

// ── 1. provider claude => adapter correcto ─────────────────────────

test("provider 'claude-code' resuelve al adapter de Claude Code", () => {
  const router = createAdapterRouter({ provider: "claude-code" });
  assert.equal(router.select(), claudeCodeAdapter);
  assert.equal(router.select("claude-code"), claudeCodeAdapter);
  assert.equal(router.provider, "claude-code");
  assert.deepEqual(router.knownProviders(), ["claude-code"]);
});

test("DEFAULT_ADAPTERS registra únicamente claude-code en este ticket", () => {
  assert.deepEqual(Object.keys(DEFAULT_ADAPTERS), ["claude-code"]);
});

// ── 2. provider desconocido => rechazo determinista ───────────────

test("provider desconocido => UNKNOWN_PROVIDER de forma determinista", () => {
  const router = createAdapterRouter({ provider: "claude-code" });
  for (let i = 0; i < 3; i++) {
    assert.throws(
      () => router.select("codex"),
      err => {
        assert.equal(err.code, ADAPTER_ROUTER_ERROR_CODES.UNKNOWN_PROVIDER);
        assert.match(err.message, /desconocido: "codex"/);
        return true;
      }
    );
  }
});

test("sin provider configurado ni por llamada => NO_PROVIDER", () => {
  const router = createAdapterRouter();
  assert.throws(
    () => router.run(makeEnvelope()),
    err => {
      assert.equal(err.code, ADAPTER_ROUTER_ERROR_CODES.NO_PROVIDER);
      return true;
    }
  );
});

test("adapter que no cumple la interfaz => BAD_INTERFACE al construir", () => {
  assert.throws(
    () => createAdapterRouter({ adapters: { broken: { run: () => {} } } }),
    err => {
      assert.equal(err.code, ADAPTER_ROUTER_ERROR_CODES.BAD_ADAPTER);
      return true;
    }
  );
});

// ── 3. interfaz estable e independiente del provider ──────────────

test("un provider nuevo (codex fake) se enchufa sin tocar el resto", async () => {
  const codex = fakeAdapter("codex");
  const router = createAdapterRouter({
    provider: "codex",
    adapters: { ...DEFAULT_ADAPTERS, codex: codex.adapter }
  });

  const env = makeEnvelope();
  const out = await router.run(env);
  assert.deepEqual(out.result, { via: "codex" });
  assert.equal(codex.calls.run.length, 1);

  // claude-code sigue disponible por la misma interfaz.
  assert.equal(router.select("claude-code"), claudeCodeAdapter);
  router.preflight({ provider: "codex" });
  assert.equal(codex.calls.preflight, 1);
});

test("opts.provider overridea al provider configurado", async () => {
  const a = fakeAdapter("a");
  const b = fakeAdapter("b");
  const router = createAdapterRouter({
    provider: "a",
    adapters: { a: a.adapter, b: b.adapter }
  });
  await router.run(makeEnvelope(), { provider: "b" });
  assert.equal(a.calls.run.length, 0);
  assert.equal(b.calls.run.length, 1);
});

// ── 4. no claimToken / secreto cruza el router ────────────────────

test("router.run rechaza un envelope con una clave secreta (claimToken)", () => {
  const a = fakeAdapter("a");
  const router = createAdapterRouter({ provider: "a", adapters: { a: a.adapter } });
  const tainted = { ...makeEnvelope(), claimToken: "CT-secret" };
  assert.throws(() => router.run(tainted), /must not contain secrets/i);
  assert.equal(a.calls.run.length, 0, "el adapter no debe recibir el envelope contaminado");
});

test("el envelope limpio no lleva secretos y el adapter lo recibe intacto", async () => {
  const a = fakeAdapter("a");
  const router = createAdapterRouter({ provider: "a", adapters: { a: a.adapter } });
  const env = makeEnvelope({
    ticket: { item: { code: "RAIL-D-00004" }, token: "rag_secret", claimToken: "CT-x" }
  });
  await router.run(env);
  const seen = a.calls.run[0].envelope;
  assert.equal(seen, env);
  assert.ok(!JSON.stringify(seen).includes("rag_secret"));
  assert.ok(!JSON.stringify(seen).includes("CT-x"));
});

// ── 5. createExecution delega en el adapter cancelable ───────────

test("createExecution delega en adapter.createExecution cuando existe", () => {
  const handle = { done: Promise.resolve(), cancel() {} };
  const adapter = {
    provider: "x",
    preflight() {},
    run() {},
    createExecution(env, opts) {
      return handle;
    }
  };
  const router = createAdapterRouter({ provider: "x", adapters: { x: adapter } });
  assert.equal(router.createExecution(makeEnvelope()), handle);
});

test("createExecution usa un wrapper cuando el adapter sólo tiene run()", async () => {
  const a = fakeAdapter("a");
  const router = createAdapterRouter({ provider: "a", adapters: { a: a.adapter } });
  const exec = router.createExecution(makeEnvelope());
  assert.equal(typeof exec.cancel, "function");
  assert.equal(exec.cancelled, false);
  exec.cancel();
  assert.equal(exec.cancelled, true);
  await exec.done;
});

// ── 6. sin lógica Rail en el módulo ─────────────────────────────

test("el módulo del router no importa el cliente Rail ni expone lógica Rail", async () => {
  const mod = await import("../src/adapters/adapter-router.js");
  const exportNames = Object.keys(mod).join(" ");
  assert.ok(!/rail/i.test(exportNames), "ningún export menciona Rail");
  assert.equal(typeof mod.createAdapterRouter, "function");
});
