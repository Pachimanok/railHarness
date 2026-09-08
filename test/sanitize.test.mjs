import { test } from "node:test";
import assert from "node:assert/strict";

import {
  stripSecretKeys,
  sanitizeTicket,
  safeTopLevelKeys,
  redactSecrets,
  safeEnvironment,
  SECRET_KEY_RE,
  REDACTION
} from "../src/security/sanitize.js";

test("stripSecretKeys removes secret-looking keys at any depth", () => {
  const input = {
    id: "T-1",
    claimToken: "rag_abc123",
    nested: { authorization: "Bearer x", ok: 1, apiKey: "k" },
    list: [{ password: "p", keep: true }]
  };
  const out = stripSecretKeys(input);
  assert.deepEqual(out, {
    id: "T-1",
    nested: { ok: 1 },
    list: [{ keep: true }]
  });
  // original is untouched
  assert.equal(input.claimToken, "rag_abc123");
});

test("sanitizeTicket is an alias of stripSecretKeys", () => {
  assert.equal(sanitizeTicket, stripSecretKeys);
});

test("SECRET_KEY_RE matches the expected key families", () => {
  for (const k of [
    "token",
    "claimToken",
    "claim_token",
    "apiKey",
    "api_key",
    "authorization",
    "password",
    "bearer",
    "credential"
  ]) {
    assert.ok(SECRET_KEY_RE.test(k), `expected ${k} to match`);
  }
  for (const k of ["id", "state", "branch", "note", "summary"]) {
    assert.ok(!SECRET_KEY_RE.test(k), `expected ${k} NOT to match`);
  }
});

test("safeTopLevelKeys redacts secret keys and never prints values", () => {
  const s = safeTopLevelKeys({ id: 1, claimToken: "secret", run: {} });
  assert.equal(s, "id, claimToken=<redacted>, run");
  assert.ok(!s.includes("secret"));
});

test("safeTopLevelKeys handles empty / non-object", () => {
  assert.equal(safeTopLevelKeys(null), "(no payload)");
  assert.equal(safeTopLevelKeys({}), "(empty payload)");
  assert.equal(safeTopLevelKeys("x"), "(payload string)");
});

test("redactSecrets scrubs bearer tokens, rag_ tokens and explicit values", () => {
  const line =
    "Authorization: Bearer eyJabc.def-ghi called with token rag_supersecretvalue and x=rag_supersecretvalue";
  const out = redactSecrets(line, ["rag_supersecretvalue"]);
  assert.ok(!out.includes("rag_supersecretvalue"));
  assert.ok(!out.includes("eyJabc.def-ghi"));
  assert.ok(out.includes(REDACTION));
});

test("redactSecrets ignores short extra values", () => {
  const out = redactSecrets("hello world", ["a"]);
  assert.equal(out, "hello world");
});

test("safeEnvironment strips RAIL_* and known extras", () => {
  const env = safeEnvironment({
    PATH: "/usr/bin",
    RAIL_TOKEN: "t",
    RAIL_API_URL: "u",
    CLAIM_TOKEN: "c",
    RAIL_HUMAN_TOKEN: "h",
    HOME: "/home/x"
  });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/x" });
});
