/**
 * HC-03-AC-09 / AC-10 — credential resolution precedence
 * (`src/console/credential-resolve.js`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveCredentials, CREDENTIAL_SOURCE } from "../src/console/credential-resolve.js";
import { writeCredentialsAtomic } from "../src/console/credential-store.js";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-resolve-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("HC-03-AC-10: sin RAIL_TOKEN en env, usa el token guardado en el store", t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_stored_token");

  const { token, source } = resolveCredentials({ env: {}, homeDir: home });
  assert.equal(token, "rag_stored_token");
  assert.equal(source, CREDENTIAL_SOURCE.STORE);
});

test("HC-03-AC-09: RAIL_TOKEN en env tiene precedencia sobre el token guardado", t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_stored_token");

  const { token, source } = resolveCredentials({ env: { RAIL_TOKEN: "rag_env_token" }, homeDir: home });
  assert.equal(token, "rag_env_token");
  assert.equal(source, CREDENTIAL_SOURCE.ENVIRONMENT);
});

test("sin env token y sin store: NOT_AUTHENTICATED (token null, source null)", t => {
  const home = tempHome(t);
  const result = resolveCredentials({ env: {}, homeDir: home });
  assert.deepEqual(result, { token: null, source: null });
});

test("RAIL_TOKEN vacío/whitespace en env se trata como ausente, cae al store", t => {
  const home = tempHome(t);
  writeCredentialsAtomic(home, "rag_stored_token");

  const { token, source } = resolveCredentials({ env: { RAIL_TOKEN: "   " }, homeDir: home });
  assert.equal(token, "rag_stored_token");
  assert.equal(source, CREDENTIAL_SOURCE.STORE);
});

test("nunca persiste automáticamente el token de env en el store", t => {
  const home = tempHome(t);
  resolveCredentials({ env: { RAIL_TOKEN: "rag_env_only" }, homeDir: home });

  assert.equal(fs.existsSync(path.join(home, ".config", "rail-harness", "credentials.json")), false);
});
