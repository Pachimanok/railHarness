import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadRuntimeConfig,
  describeConfig,
  resolveMode,
  HARNESS_MODES,
  REQUIRED_ENV
} from "../src/config/runtime-config.js";

function baseEnv(overrides = {}) {
  return {
    RAIL_API_URL: "https://rail.example/api/rail",
    RAIL_TOKEN: "rag_tokenvalue_should_never_be_printed",
    RAIL_PROJECT_ID: "proj_123",
    RAIL_REPO_PATH: "/home/x/repos/thing",
    ...overrides
  };
}

test("loads a valid discovery-mode config, frozen", () => {
  const cfg = loadRuntimeConfig(baseEnv(), { machineFallback: "host-1" });
  assert.equal(cfg.mode, HARNESS_MODES.DISCOVERY);
  assert.equal(cfg.rail.apiUrl, "https://rail.example/api/rail");
  assert.equal(cfg.rail.projectId, "proj_123");
  assert.equal(cfg.machine, "host-1");
  assert.equal(cfg.agent, "rail-harness");
  assert.ok(Object.isFrozen(cfg));
  assert.ok(Object.isFrozen(cfg.rail));
});

test("strips a trailing slash from apiUrl", () => {
  const cfg = loadRuntimeConfig(baseEnv({ RAIL_API_URL: "https://rail.example/api/rail/" }));
  assert.equal(cfg.rail.apiUrl, "https://rail.example/api/rail");
});

test("missing required vars are all reported", () => {
  assert.throws(
    () => loadRuntimeConfig({ RAIL_API_URL: "https://x.test" }),
    err => {
      for (const name of ["RAIL_TOKEN", "RAIL_PROJECT_ID", "RAIL_REPO_PATH"]) {
        assert.ok(err.message.includes(name), `expected ${name} in message`);
      }
      assert.ok(!err.message.includes("RAIL_API_URL"));
      return true;
    }
  );
});

test("REQUIRED_ENV is the authoritative list", () => {
  assert.deepEqual(REQUIRED_ENV, [
    "RAIL_API_URL",
    "RAIL_TOKEN",
    "RAIL_PROJECT_ID",
    "RAIL_REPO_PATH"
  ]);
});

test("rejects a non-https apiUrl that is not localhost", () => {
  assert.throws(
    () => loadRuntimeConfig(baseEnv({ RAIL_API_URL: "http://rail.example/api" })),
    /must be https/
  );
});

test("allows http for localhost", () => {
  const cfg = loadRuntimeConfig(baseEnv({ RAIL_API_URL: "http://localhost:3000/api/rail" }));
  assert.equal(cfg.rail.apiUrl, "http://localhost:3000/api/rail");
});

test("rejects a malformed apiUrl", () => {
  assert.throws(() => loadRuntimeConfig(baseEnv({ RAIL_API_URL: "not a url" })), /not a valid URL/);
});

test("RAIL_TICKET_REF => explicit mode", () => {
  const cfg = loadRuntimeConfig(baseEnv({ RAIL_TICKET_REF: "ABC-1" }));
  assert.equal(cfg.mode, HARNESS_MODES.EXPLICIT);
  assert.equal(cfg.ticketRef, "ABC-1");
});

test("RAIL_RECOVER_REF => recover mode", () => {
  const cfg = loadRuntimeConfig(baseEnv({ RAIL_RECOVER_REF: "ABC-1" }));
  assert.equal(cfg.mode, HARNESS_MODES.RECOVER);
  assert.equal(cfg.recoverRef, "ABC-1");
});

test("RAIL_RESUME_REF => resume mode (general /resume continuation)", () => {
  const cfg = loadRuntimeConfig(baseEnv({ RAIL_RESUME_REF: "ABC-1", RAIL_RESUME_NOTES: "tras caída" }));
  assert.equal(cfg.mode, HARNESS_MODES.RESUME);
  assert.equal(cfg.resumeRef, "ABC-1");
  assert.equal(cfg.resumeNotes, "tras caída");
});

test("RAIL_TICKET_REF / RAIL_RECOVER_REF / RAIL_RESUME_REF are ALL mutually exclusive", () => {
  assert.throws(
    () => loadRuntimeConfig(baseEnv({ RAIL_TICKET_REF: "A-1", RAIL_RECOVER_REF: "A-1" })),
    /mutually exclusive/
  );
  assert.throws(
    () => loadRuntimeConfig(baseEnv({ RAIL_TICKET_REF: "A-1", RAIL_RESUME_REF: "A-1" })),
    /mutually exclusive/
  );
  assert.throws(
    () => loadRuntimeConfig(baseEnv({ RAIL_RECOVER_REF: "A-1", RAIL_RESUME_REF: "A-1" })),
    /mutually exclusive/
  );
});

test("resolveMode is pure and independent", () => {
  assert.equal(resolveMode({}), HARNESS_MODES.DISCOVERY);
  assert.equal(resolveMode({ ticketRef: "x" }), HARNESS_MODES.EXPLICIT);
  assert.equal(resolveMode({ recoverRef: "x" }), HARNESS_MODES.RECOVER);
  assert.equal(resolveMode({ resumeRef: "x" }), HARNESS_MODES.RESUME);
  assert.throws(() => resolveMode({ ticketRef: "x", recoverRef: "y" }), /mutually exclusive/);
  assert.throws(() => resolveMode({ resumeRef: "x", recoverRef: "y" }), /mutually exclusive/);
});

test("describeConfig never leaks the token and is in Spanish", () => {
  const env = baseEnv();
  const cfg = loadRuntimeConfig(env, { machineFallback: "h" });
  const text = describeConfig(cfg);
  assert.ok(!text.includes(env.RAIL_TOKEN));
  assert.ok(text.includes("token:      presente (<redacted>)"));
  // mode value is an enum → not translated
  assert.ok(text.includes("mode:       discovery"));
  assert.ok(!/\bpresent\b/.test(text), "English 'present' must not appear");
});

test("describeConfig renders unset optionals with Spanish placeholders", () => {
  const cfg = loadRuntimeConfig(baseEnv(), { machineFallback: "h" });
  const text = describeConfig(cfg);
  assert.ok(text.includes("ticketRef:  (ninguno)"));
  assert.ok(text.includes("baseBranch: (autodetección)"));
});

test("whitespace-only optional vars are treated as unset", () => {
  const cfg = loadRuntimeConfig(baseEnv({ RAIL_TICKET_REF: "   ", RAIL_BASE_BRANCH: "" }));
  assert.equal(cfg.mode, HARNESS_MODES.DISCOVERY);
  assert.equal(cfg.ticketRef, null);
  assert.equal(cfg.baseBranch, null);
});
