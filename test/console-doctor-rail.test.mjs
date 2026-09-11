/**
 * HC-02 — Doctor's optional RailSoft checks (`runRailChecks` in
 * `src/console/doctor.js`). Extends HC-01's local Doctor WITHOUT touching
 * its 6 local checks / exit code (see `console-doctor.test.mjs`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runRailChecks } from "../src/console/doctor.js";

test("runRailChecks: sin credenciales configuradas => un único check RailSoft en falla, con mensaje claro y sin secretos", async () => {
  const checks = await runRailChecks({ env: {} });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, "railConnectivity");
  assert.equal(checks[0].ok, false);
  // El detalle es un mensaje humano genérico — nunca nombra RAIL_API_URL ni
  // RAIL_TOKEN (ni, por supuesto, un valor real).
  assert.match(checks[0].detail, /credenciales/);
  assert.ok(!String(checks[0].detail).includes("RAIL_TOKEN"));
  assert.ok(!String(checks[0].detail).includes("RAIL_API_URL"));
});

test("runRailChecks: con un rail fake que responde OK => RailSoft + Identidad Rail autorizada, ambos PASS", async () => {
  const rail = { async listProjects() { return { items: [] }; } };
  const checks = await runRailChecks({ rail });
  assert.deepEqual(checks.map(c => c.id), ["railConnectivity", "railIdentity"]);
  assert.ok(checks.every(c => c.ok === true));
});

test("runRailChecks: token rechazado (401) => RailSoft PASS (se pudo contactar) pero Identidad Rail autorizada FALLA", async () => {
  const err = Object.assign(new Error("unauthorized"), { status: 401 });
  const rail = { async listProjects() { throw err; } };
  const checks = await runRailChecks({ rail });

  const byId = Object.fromEntries(checks.map(c => [c.id, c]));
  assert.equal(byId.railConnectivity.ok, true);
  assert.equal(byId.railIdentity.ok, false);
});

test("runRailChecks: RailSoft inalcanzable (error de red) => ambos checks FALLAN, sin crash", async () => {
  const rail = { async listProjects() { throw new Error("ECONNREFUSED"); } };
  const checks = await runRailChecks({ rail });
  assert.ok(checks.every(c => c.ok === false));
});

test("runRailChecks: nunca hace una mutación — el fake ni siquiera expone claim/resume/recover", async () => {
  const rail = {
    async listProjects() {
      return { items: [] };
    }
  };
  await runRailChecks({ rail });
  assert.equal(rail.claim, undefined);
  assert.equal(rail.resume, undefined);
  assert.equal(rail.recover, undefined);
});
