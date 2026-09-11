/**
 * HC-01-AC-05 — the Developer Console never invokes the Worker Core nor any
 * Rail mutation.
 *
 * Two layers of protection:
 *   1. Static: the console's source files must never import from
 *      `src/worker/`, `src/orchestration/`, `src/workspace/`, `src/rail/`,
 *      `src/adapters/`, and must never mention a Rail mutation endpoint or
 *      `npm run worker`.
 *   2. Dynamic: driving the CLI through every menu path (start / setup /
 *      doctor / exit) with a spied-on `global.fetch` must never make a
 *      single network call.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/console/cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const FORBIDDEN_IMPORT_SUBSTRINGS = [
  "src/worker/",
  "src/orchestration/",
  "src/workspace/",
  "src/rail/",
  "src/adapters/",
  "../worker/",
  "../orchestration/",
  "../workspace/",
  "../rail/",
  "../adapters/"
];

const FORBIDDEN_MENTIONS = [
  "createWorkerCore",
  "createOrchestrationExecution",
  "createOrchestrator",
  "RailApiClient",
  "createAdapterRouter",
  "prepareWorkspace",
  "finishRun",
  "npm run worker",
  "/claim",
  "/resume",
  "/recover"
];

function consoleSourceFiles() {
  const dirs = [path.join(REPO_ROOT, "src", "console"), path.join(REPO_ROOT, "bin")];
  const files = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".js")) files.push(path.join(dir, name));
    }
  }
  return files;
}

test("HC-01-AC-05 (estático): la Developer Console no importa Worker/Orchestration/Workspace/Rail/Adapters", () => {
  const files = consoleSourceFiles();
  assert.ok(files.length >= 4, "se esperaban al menos cli.js, ui.js, doctor.js, config-store.js + bin");

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const bad of FORBIDDEN_IMPORT_SUBSTRINGS) {
      assert.ok(
        !src.includes(bad),
        `${path.relative(REPO_ROOT, file)} no debería referenciar "${bad}"`
      );
    }
    for (const bad of FORBIDDEN_MENTIONS) {
      assert.ok(
        !src.includes(bad),
        `${path.relative(REPO_ROOT, file)} no debería mencionar "${bad}"`
      );
    }
  }
});

test("HC-01-AC-05 (dinámico): recorrer todo el menú nunca dispara un fetch / llamada de red", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-noworker-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  let fetchCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = (...args) => {
    fetchCalls += 1;
    throw new Error(`fetch() no debería llamarse jamás desde la Developer Console (args=${JSON.stringify(args)})`);
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
  assert.equal(fetchCalls, 0, "la Developer Console no debe hacer ninguna llamada de red en HC-01");
});

test("HC-01-AC-05: no imprime secretos (token / claimToken / RAIL_*) aunque estén en el entorno", async t => {
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
