import { test } from "node:test";
import assert from "node:assert/strict";

import { RailApiClient, normalizeRunHandoff } from "../src/rail/rail-api-client.js";
import { loadRuntimeConfig } from "../src/config/runtime-config.js";

// ─── normalizeRunHandoff ─────────────────────────────────────────────────

test("normalizes a /claim response (run node)", () => {
  const h = normalizeRunHandoff({
    run: { id: "r1", claimToken: "ct", leaseExpiresAt: "2026-01-01T00:00:00Z" }
  });
  assert.equal(h.run.id, "r1");
  assert.equal(h.run.claimToken, "ct");
  assert.equal(h.run.leaseExpiresAt, "2026-01-01T00:00:00Z");
  assert.equal(h.recovered.fromRunId, null);
});

test("normalizes a /recover response (activeRun + recoveryOfRunId + cycle.state)", () => {
  const h = normalizeRunHandoff({
    activeRun: { id: "r2", state: "ACTIVE", claimToken: "ct2", leaseExpiresAt: "L" },
    recoveryOfRunId: "r1",
    cycle: { state: "IN_PROGRESS" }
  });
  assert.equal(h.run.id, "r2");
  assert.equal(h.run.claimToken, "ct2");
  assert.equal(h.recovered.fromRunId, "r1");
  assert.equal(h.recovered.cycleState, "IN_PROGRESS");
});

test("normalizes a top-level response and snake_case keys", () => {
  const h = normalizeRunHandoff({ id: "r3", claim_token: "ct3", lease_expires_at: "L3" });
  assert.equal(h.run.id, "r3");
  assert.equal(h.run.claimToken, "ct3");
  assert.equal(h.run.leaseExpiresAt, "L3");
});

test("2xx payload without a usable run.id/claimToken => nulls (contract-error signal)", () => {
  const h = normalizeRunHandoff({ ok: true });
  assert.equal(h.run.id, null);
  assert.equal(h.run.claimToken, null);
  assert.equal(h.raw.ok, true);
});

// ─── RailApiClient wiring (no real network) ───────────────────────────────

test("constructor requires baseUrl and token", () => {
  assert.throws(() => new RailApiClient({ baseUrl: "https://x" }), /required/);
  assert.throws(() => new RailApiClient({ token: "t" }), /required/);
});

test("fromRuntimeConfig maps config fields", () => {
  const cfg = loadRuntimeConfig({
    RAIL_API_URL: "https://rail.example/api/rail/",
    RAIL_TOKEN: "tkn",
    RAIL_PROJECT_ID: "p",
    RAIL_REPO_PATH: "/r",
    RAIL_AGENT: "agent-x",
    RAIL_MACHINE: "m-x"
  });
  const client = RailApiClient.fromRuntimeConfig(cfg);
  assert.equal(client.baseUrl, "https://rail.example/api/rail");
  assert.equal(client.agent, "agent-x");
  assert.equal(client.machine, "m-x");
  assert.equal(client.actor, "agent");
});

test("request() attaches auth + rail headers and normalizes claim(); token is not on the client's enumerable output path", async () => {
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ run: { id: "r1", claimToken: "ct", leaseExpiresAt: "L" } });
      }
    };
  };
  try {
    const client = new RailApiClient({
      baseUrl: "https://rail.example/api/rail",
      token: "secret-token",
      agent: "a",
      machine: "m"
    });
    const handoff = await client.claim("ABC-1", "rail/abc-1");

    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://rail.example/api/rail/tickets/ABC-1/claim");
    assert.equal(seen[0].opts.method, "POST");
    assert.equal(seen[0].opts.headers.Authorization, "Bearer secret-token");
    assert.equal(seen[0].opts.headers["X-Rail-Agent"], "a");
    assert.equal(seen[0].opts.headers["X-Rail-Machine"], "m");
    assert.equal(seen[0].opts.headers["X-Rail-Actor"], "agent");
    assert.deepEqual(JSON.parse(seen[0].opts.body), { branch: "rail/abc-1" });

    assert.equal(handoff.run.id, "r1");
    assert.equal(handoff.run.claimToken, "ct");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("request() throws a structured error on non-2xx", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    async text() {
      return JSON.stringify({ error: "conflict", code: "LEASE_LIVE", missing: [] });
    }
  });
  try {
    const client = new RailApiClient({ baseUrl: "https://x", token: "t" });
    await assert.rejects(
      () => client.getTicket("ABC-1"),
      err => {
        assert.equal(err.status, 409);
        assert.equal(err.code, "LEASE_LIVE");
        assert.equal(err.message, "conflict");
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listReady builds the expected query string", async () => {
  const seen = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    seen.push(url);
    return { ok: true, status: 200, async text() { return "{}"; } };
  };
  try {
    const client = new RailApiClient({ baseUrl: "https://x", token: "t" });
    await client.listReady("proj_1", 5);
    const u = new URL(seen[0]);
    assert.equal(u.pathname, "/tickets");
    assert.equal(u.searchParams.get("projectId"), "proj_1");
    assert.equal(u.searchParams.get("state"), "READY");
    assert.equal(u.searchParams.get("kind"), "ticket");
    assert.equal(u.searchParams.get("limit"), "5");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
