/**
 * HC-04 — HarnessEvent (`src/console/trace/event.js`).
 *
 * HC-04-AC-09: no event may ever contain RAIL_TOKEN or an equivalent secret
 * value. HC-04-AC-10: metadata with a secret-looking key is rejected /
 * sanitized, not merely warned about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HARNESS_EVENT_TYPES,
  isValidEventType,
  SAFE_METADATA_KEYS,
  sanitizeMetadata,
  createEvent
} from "../src/console/trace/event.js";

test("HC-04: HARNESS_EVENT_TYPES es un set explícito y cerrado", () => {
  assert.ok(Array.isArray(HARNESS_EVENT_TYPES));
  assert.ok(HARNESS_EVENT_TYPES.length > 0);
  assert.deepEqual(HARNESS_EVENT_TYPES, [...new Set(HARNESS_EVENT_TYPES)], "sin duplicados");
  for (const t of [
    "SESSION_STARTED",
    "AUTH_STATUS_CHECKED",
    "LOGIN_SUCCEEDED",
    "LOGIN_FAILED",
    "LOGOUT",
    "PROJECT_LIST_VIEWED",
    "PROJECT_SELECTED",
    "READY_LIST_VIEWED",
    "TICKET_SELECTED",
    "TICKET_DETAIL_VIEWED",
    "DOCTOR_RUN",
    "SETUP_RUN",
    "COMMAND_FAILED",
    "SESSION_COMPLETED",
    "SESSION_FAILED",
    "SESSION_ABORTED"
  ]) {
    assert.ok(isValidEventType(t), `falta el tipo requerido "${t}"`);
  }
  assert.equal(isValidEventType("KEYSTROKE"), false);
  assert.equal(isValidEventType("SHELL_COMMAND"), false);
});

test("HC-04-AC-10: sanitizeMetadata descarta cualquier key fuera del allowlist", () => {
  const out = sanitizeMetadata({ projectName: "TotalView", notAllowed: "x", nested: { anything: 1 } });
  assert.deepEqual(Object.keys(out).sort(), ["projectName"]);
  assert.equal(out.projectName, "TotalView");
});

test("HC-04-AC-10: sanitizeMetadata rechaza toda key con aspecto secreto, incluso anidada", () => {
  for (const secretKey of ["token", "authorization", "password", "secret", "credential", "apiKey", "cookie", "sessionToken", "claimToken"]) {
    const out = sanitizeMetadata({ [secretKey]: "should-never-appear", command: "doctor" });
    assert.ok(!(secretKey in out), `"${secretKey}" no debería sobrevivir el saneo`);
    assert.equal(out.command, "doctor");
  }
});

test("HC-04-AC-09/AC-10: sanitizeMetadata sanea un objeto anidado dentro de un valor permitido", () => {
  const out = sanitizeMetadata({ result: { ok: true, token: "rag_should_not_leak" } });
  assert.ok(out.result && typeof out.result === "object");
  assert.equal(out.result.ok, true);
  assert.ok(!("token" in out.result));
});

test("HC-04-AC-09: sanitizeMetadata redacta un valor de string con forma de secreto aunque la key sea segura", () => {
  const out = sanitizeMetadata({ result: "Authorization: Bearer rag_supersecret123456" });
  assert.ok(!out.result.includes("rag_supersecret123456"));
});

test("HC-04-AC-10: sanitizeMetadata nunca lanza con entradas raras (funciones, undefined, arrays)", () => {
  assert.doesNotThrow(() => sanitizeMetadata(null));
  assert.doesNotThrow(() => sanitizeMetadata(undefined));
  assert.doesNotThrow(() => sanitizeMetadata({ command: () => {} }));
  const out = sanitizeMetadata({ count: [1, 2, { token: "x" }] });
  assert.deepEqual(out.count, [1, 2, {}]);
});

test("HC-04: SAFE_METADATA_KEYS es exactamente la lista documentada", () => {
  assert.deepEqual(
    [...SAFE_METADATA_KEYS].sort(),
    ["command", "count", "projectId", "projectName", "reasonCode", "result", "ticketRef", "ticketTitle"].sort()
  );
});

test("HC-04: createEvent arma un HarnessEvent con el esquema exacto", () => {
  const ev = createEvent({
    sessionId: "rhs_test",
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    metadata: { projectName: "TotalView" }
  });
  assert.match(ev.id, /^rhe_/);
  assert.equal(ev.sessionId, "rhs_test");
  assert.equal(ev.type, "PROJECT_SELECTED");
  assert.equal(typeof ev.timestamp, "string");
  assert.ok(!Number.isNaN(Date.parse(ev.timestamp)));
  assert.equal(ev.projectId, "proj_1");
  assert.equal(ev.ticketRef, null);
  assert.deepEqual(ev.metadata, { projectName: "TotalView" });
});

test("HC-04: createEvent rechaza un tipo inválido y exige sessionId", () => {
  assert.throws(() => createEvent({ sessionId: "rhs_x", type: "NOT_A_TYPE" }));
  assert.throws(() => createEvent({ type: "SESSION_STARTED" }));
});
