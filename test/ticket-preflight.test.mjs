import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertTicketClaimable,
  isTicketClaimable,
  pickDiscoveryRef
} from "../src/worker/ticket-preflight.js";

const PID = "proj_worker_core";

function readyTicket(overrides = {}) {
  return {
    projectId: PID,
    state: "READY",
    blocked: false,
    activeRun: null,
    item: { code: "RAIL-D-00002", id: "tkt_1", title: "Worker Core" },
    ...overrides
  };
}

// ─── assertTicketClaimable ───────────────────────────────────────────────

test("assertTicketClaimable: acepta un ticket READY del proyecto correcto sin activeRun", () => {
  assert.doesNotThrow(() => assertTicketClaimable(readyTicket(), PID, "RAIL-D-00002"));
});

test("assertTicketClaimable: rechaza detalle ausente", () => {
  assert.throws(() => assertTicketClaimable(null, PID, "X-1"), /no existe o Rail no devolvió detalle/);
});

test("assertTicketClaimable: rechaza project mismatch", () => {
  assert.throws(
    () => assertTicketClaimable(readyTicket({ projectId: "otro" }), PID, "X-1"),
    /Project mismatch/
  );
});

test("assertTicketClaimable: rechaza si no está READY (valor de estado sin traducir)", () => {
  assert.throws(
    () => assertTicketClaimable(readyTicket({ state: "BACKLOG" }), PID, "X-1"),
    err => {
      assert.match(err.message, /no está READY/);
      assert.match(err.message, /state=BACKLOG/);
      return true;
    }
  );
});

test("assertTicketClaimable: rechaza si está BLOCKED", () => {
  assert.throws(
    () => assertTicketClaimable(readyTicket({ blocked: true, stateBeforeBlock: "IN_PROGRESS" }), PID, "X-1"),
    /BLOCKED/
  );
});

test("assertTicketClaimable: rechaza si ya hay activeRun", () => {
  assert.throws(
    () => assertTicketClaimable(readyTicket({ activeRun: { id: "run_9", agent: "otro" } }), PID, "X-1"),
    /ya tiene un activeRun/
  );
});

test("assertTicketClaimable: todo mensaje de rechazo termina con 'No claim was created.'", () => {
  for (const bad of [
    null,
    readyTicket({ projectId: "otro" }),
    readyTicket({ state: "CLAIMED" }),
    readyTicket({ blocked: true }),
    readyTicket({ activeRun: { id: "r" } })
  ]) {
    assert.throws(() => assertTicketClaimable(bad, PID, "X-1"), /No claim was created\.$/);
  }
});

// ─── isTicketClaimable ──────────────────────────────────────────────────

test("isTicketClaimable: forma no-lanzadora", () => {
  assert.deepEqual(isTicketClaimable(readyTicket(), PID, "X-1"), { claimable: true, reason: null });

  const bad = isTicketClaimable(readyTicket({ state: "REVIEWING" }), PID, "X-1");
  assert.equal(bad.claimable, false);
  assert.match(bad.reason, /no está READY/);
});

// ─── pickDiscoveryRef ──────────────────────────────────────────────────

test("pickDiscoveryRef: toma el primer code de items[].item", () => {
  assert.equal(
    pickDiscoveryRef({ items: [{ item: { code: "RAIL-D-7", id: "x" } }, { item: { code: "RAIL-D-8" } }] }),
    "RAIL-D-7"
  );
});

test("pickDiscoveryRef: cae a item.id si no hay code", () => {
  assert.equal(pickDiscoveryRef({ items: [{ item: { id: "tkt_abc" } }] }), "tkt_abc");
});

test("pickDiscoveryRef: acepta un array plano y saltea entradas sin ref", () => {
  assert.equal(pickDiscoveryRef([{ item: {} }, { item: { code: "RAIL-D-9" } }]), "RAIL-D-9");
});

test("pickDiscoveryRef: devuelve null si no hay nada READY", () => {
  assert.equal(pickDiscoveryRef({ items: [] }), null);
  assert.equal(pickDiscoveryRef(null), null);
  assert.equal(pickDiscoveryRef(undefined), null);
});
