/**
 * HC-01-AC-05 / HC-02-AC-05 — the Developer Console never invokes the Worker
 * Core, Orchestration, Workspace Manager or Adapters, and any Rail access it
 * makes is STRICTLY READ-ONLY.
 *
 * HC-01 originally asserted "the console never imports Rail at all". HC-02
 * INTENTIONALLY introduces a read-only Rail integration (project / READY
 * ticket browsing), so that blanket rule is evolved — not removed — into:
 * "the console may only reach Rail through the read-only facade
 * (`rail-readonly.js`), and no console/bin file may ever mention a Rail
 * mutation method or mutating endpoint."
 *
 * Three layers of protection:
 *   1. Static (imports): every console/bin file is still forbidden from
 *      importing Worker/Orchestration/Workspace/Adapters. Only
 *      `rail-readonly.js` may import `src/rail/rail-api-client.js` — every
 *      OTHER console/bin file must go through that facade instead.
 *   2. Static (mutation vocabulary): no console/bin file — INCLUDING
 *      `rail-readonly.js` — may mention a Rail mutation method name or a
 *      mutating endpoint path. The facade must not expose them; this guards
 *      against someone widening it later.
 *   3. Dynamic: driving the CLI through every menu path with a spied-on
 *      `global.fetch` must never issue anything but a GET, and with no Rail
 *      credentials configured must never call `fetch` at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/console/cli.js";
import { createReadonlyRail } from "../src/console/rail-readonly.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const FORBIDDEN_IMPORT_SUBSTRINGS = [
  "src/worker/",
  "src/orchestration/",
  "src/workspace/",
  "src/adapters/",
  "../worker/",
  "../orchestration/",
  "../workspace/",
  "../adapters/"
];

// Only rail-readonly.js may import the Rail client — every other
// console/bin file must go through the read-only facade instead.
const RAIL_IMPORT_SUBSTRINGS = ["src/rail/", "../rail/"];
const RAIL_IMPORT_ALLOWED_FILE = "rail-readonly.js";

// Never allowed anywhere under src/console/** or bin/**, not even in
// rail-readonly.js: the facade must never expose a mutation.
const FORBIDDEN_MUTATION_MENTIONS = [
  "claim(",
  "resume(",
  "recover(",
  "transition(",
  "addComment(",
  "createQuery(",
  "createCheck(",
  "createDeployment(",
  "updateDeployment(",
  "heartbeat(",
  "finishRun(",
  "/claim",
  "/resume",
  "/recover",
  "/transitions",
  "/comments",
  "/queries",
  "/checks",
  "/deployments",
  "/heartbeat",
  "/finish",
  "createWorkerCore",
  "createOrchestrationExecution",
  "createOrchestrator",
  "createAdapterRouter",
  "prepareWorkspace",
  "npm run worker"
];

function consoleSourceFiles() {
  // HC-04's `src/console/trace/` is included: it must be held to the exact
  // same isolation guarantees as the rest of the Developer Console.
  const dirs = [
    path.join(REPO_ROOT, "src", "console"),
    path.join(REPO_ROOT, "src", "console", "trace"),
    path.join(REPO_ROOT, "bin")
  ];
  const files = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".js")) files.push(path.join(dir, name));
    }
  }
  return files;
}

test("HC-01/HC-02-AC-05 (estático): la Developer Console no importa Worker/Orchestration/Workspace/Adapters", () => {
  const files = consoleSourceFiles();
  assert.ok(files.length >= 6, "se esperaban al menos cli.js, ui.js, doctor.js, config-store.js, rail-readonly.js + bin");

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const bad of FORBIDDEN_IMPORT_SUBSTRINGS) {
      assert.ok(!src.includes(bad), `${path.relative(REPO_ROOT, file)} no debería referenciar "${bad}"`);
    }
  }
});

test("HC-02-AC-05 (estático): sólo rail-readonly.js importa src/rail — el resto de la consola pasa por la fachada", () => {
  const files = consoleSourceFiles();

  for (const file of files) {
    const base = path.basename(file);
    const src = fs.readFileSync(file, "utf8");
    for (const bad of RAIL_IMPORT_SUBSTRINGS) {
      const allowed = base === RAIL_IMPORT_ALLOWED_FILE;
      if (allowed) continue;
      assert.ok(
        !src.includes(bad),
        `${path.relative(REPO_ROOT, file)} no debería importar Rail directamente ("${bad}") — debe usar rail-readonly.js`
      );
    }
  }
});

test("HC-02-AC-05 (estático): ningún archivo de consola/bin — ni siquiera la fachada — menciona una mutación Rail", () => {
  const files = consoleSourceFiles();

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    // `ui.js` legitimately calls Node's stdin `input.resume()` (stream flow
    // control) — nothing to do with Rail's `resume()` mutation. Strip that
    // one known-benign call before scanning so the guard below stays exact.
    const scanned = src.split("input.resume()").join("");
    for (const bad of FORBIDDEN_MUTATION_MENTIONS) {
      assert.ok(
        !scanned.includes(bad),
        `${path.relative(REPO_ROOT, file)} no debería mencionar "${bad}" (mutación Rail)`
      );
    }
  }
});

test("HC-02-AC-05: la fachada read-only expone EXACTAMENTE listProjects/listReady/getTicket", () => {
  const rail = createReadonlyRail({ apiUrl: "https://rail.example/api/rail", token: "t" });
  assert.deepEqual(Object.keys(rail).sort(), ["getTicket", "listProjects", "listReady"]);
  assert.equal(rail.claim, undefined);
  assert.equal(rail.resume, undefined);
  assert.equal(rail.recover, undefined);
  assert.equal(rail.finishRun, undefined);
  assert.equal(rail.heartbeat, undefined);
});

test("HC-01-AC-05 (dinámico): recorrer todo el menú sin credenciales de Rail nunca dispara un fetch / llamada de red", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-noworker-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = (...args) => {
    fetchCalls += 1;
    throw new Error(`fetch() no debería llamarse jamás desde la Developer Console sin credenciales (args=${JSON.stringify(args)})`);
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const values = ["start", "setup", "doctor", "exit"];
  let i = 0;
  const menu = async () => values[i++];

  const exitCode = await runCli({
    argv: [],
    env: { HOME: home },
    osModule: { userInfo: () => ({ username: "fran" }), hostname: () => "harness-prod-01" },
    homeDir: home,
    runGit: () => "git version 2.43.0",
    runClaude: () => "1.0.0",
    logger: () => {},
    output: { isTTY: false },
    menu
  });

  assert.equal(exitCode, 0);
  assert.equal(fetchCalls, 0, "sin RAIL_API_URL/RAIL_TOKEN la Developer Console no debe hacer ninguna llamada de red");
});

test("HC-02-AC-05 (dinámico): con credenciales configuradas, todo request real a Rail es GET — nunca POST/PATCH/PUT/DELETE", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-readonly-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const seenMethods = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    seenMethods.push(opts.method || "GET");
    if (String(url).endsWith("/projects")) {
      return { ok: true, status: 200, async text() { return JSON.stringify({ items: [{ id: "proj_1", name: "TotalView" }] }); } };
    }
    if (String(url).includes("/tickets?")) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ items: [{ item: { code: "TV-D-00125", title: "Corregir rentabilidad" } }] });
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          projectId: "proj_1",
          state: "READY",
          activeRun: null,
          item: { code: "TV-D-00125", title: "Corregir rentabilidad" },
          targetRepository: { repoFullName: "Pachimanok/totalview" }
        });
      }
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const labels = [
    "Empezar a trabajar",
    "TotalView",
    "TV-D-00125  Corregir rentabilidad",
    "Volver",
    "Volver",
    "Salir"
  ];
  let i = 0;
  const menu = async ({ items }) => {
    const label = labels[i++];
    const found = items.find(it => it.label === label);
    if (!found) throw new Error(`menu: no se encontró "${label}" entre [${items.map(it => it.label).join(", ")}]`);
    return found.value;
  };

  const exitCode = await runCli({
    argv: [],
    env: { HOME: home, RAIL_API_URL: "https://rail.example/api/rail", RAIL_TOKEN: "should-never-print" },
    osModule: { userInfo: () => ({ username: "fran" }), hostname: () => "harness-prod-01" },
    homeDir: home,
    runGit: () => "git version 2.43.0",
    runClaude: () => "1.0.0",
    logger: () => {},
    output: { isTTY: false },
    menu
  });

  assert.equal(exitCode, 0);
  assert.ok(seenMethods.length >= 3, "se esperaban al menos listProjects + listReady + getTicket");
  for (const method of seenMethods) {
    assert.equal(method, "GET", `todo request desde la Developer Console debe ser GET, se vio ${method}`);
  }
});

test("HC-01/HC-02-AC-06: no imprime secretos (token / claimToken / RAIL_*) aunque estén en el entorno", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-nosecret-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const lines = [];
  const values = ["doctor", "exit"];
  let i = 0;

  await runCli({
    argv: [],
    env: {
      HOME: home,
      RAIL_TOKEN: "rag_supersecret_should_never_print",
      CLAIM_TOKEN: "CT-supersecret-should-never-print"
    },
    osModule: { userInfo: () => ({ username: "fran" }), hostname: () => "harness-prod-01" },
    homeDir: home,
    runGit: () => "git version 2.43.0",
    runClaude: () => "1.0.0",
    logger: line => lines.push(line),
    output: { isTTY: false },
    menu: async () => values[i++]
  });

  const text = lines.join("\n");
  assert.ok(!text.includes("rag_supersecret_should_never_print"));
  assert.ok(!text.includes("CT-supersecret-should-never-print"));
  assert.ok(!text.includes("RAIL_TOKEN"));
});
