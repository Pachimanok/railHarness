import { test } from "node:test";
import assert from "node:assert/strict";

import * as harness from "../src/index.js";

// The public surface the follow-up tickets (Worker Core, Workspace Manager,
// AdapterRouter, Orchestration) import from.
const EXPECTED_EXPORTS = [
  "loadRuntimeConfig",
  "describeConfig",
  "resolveMode",
  "HARNESS_MODES",
  "REQUIRED_ENV",
  "OPTIONAL_ENV",
  "RailApiClient",
  "normalizeRunHandoff",
  "buildExecutionEnvelope",
  "validateExecutionEnvelope",
  "assertNoSecrets",
  "EXECUTION_KINDS",
  "EXECUTION_ENVELOPE_SCHEMA_VERSION",
  "validateExecutionResult",
  "assertValidExecutionResult",
  "parseExecutionResult",
  "EXECUTION_OUTCOMES",
  "EXECUTION_RESULT_JSON_SCHEMA",
  "EXECUTION_RESULT_SCHEMA_VERSION",
  "stripSecretKeys",
  "sanitizeTicket",
  "safeTopLevelKeys",
  "redactSecrets",
  "safeEnvironment",
  "SECRET_KEY_RE",
  "REQUIRED_CLAUDE_FLAGS",
  "flagPresent",
  "missingClaudeFlags",
  "HUMAN_LANGUAGE",
  "PROTOCOL_TERMS",
  "LANGUAGE_INSTRUCTION",
  "LANGUAGE_POLICY_VERSION",
  "buildLanguagePolicy",
  "validateLanguagePolicy",
  "createWorkerCore",
  "defaultBranchFor",
  "WORKER_PHASES",
  "DEFAULT_HEARTBEAT_INTERVAL_MS",
  "DEFAULT_DISCOVERY_POLL_MS",
  "DEFAULT_DISCOVERY_LIMIT",
  "assertTicketClaimable",
  "isTicketClaimable",
  "pickDiscoveryRef",
  "createPlaceholderExecution",
  "prepareWorkspace",
  "cleanupWorkspace",
  "createWorkspaceExecution",
  "workspacePathFor",
  "assertInsideRoot",
  "normalizeRepoSlug",
  "resolveTargetRepo",
  "assertWorkspaceCleanOfSecrets",
  "WORKSPACE_ERROR_CODES"
];

test("src/index.js exposes the whole bootstrap surface", () => {
  for (const name of EXPECTED_EXPORTS) {
    assert.ok(name in harness, `missing export: ${name}`);
  }
});

test("no unexpected exports (surface stays intentional)", () => {
  const actual = Object.keys(harness).sort();
  assert.deepEqual(actual, [...EXPECTED_EXPORTS].sort());
});

test("end-to-end wiring: config -> client -> envelope, no secret leak", () => {
  const cfg = harness.loadRuntimeConfig(
    {
      RAIL_API_URL: "https://rail.example/api/rail",
      RAIL_TOKEN: "rag_do_not_print_me",
      RAIL_PROJECT_ID: "p1",
      RAIL_REPO_PATH: "/repo"
    },
    { machineFallback: "host" }
  );

  const client = harness.RailApiClient.fromRuntimeConfig(cfg);
  assert.equal(client.baseUrl, "https://rail.example/api/rail");

  const envelope = harness.buildExecutionEnvelope({
    kind: "IMPLEMENT",
    run: { id: "r1", branch: "rail/abc-1" },
    ticket: { item: { code: "ABC-1" }, token: "rag_do_not_print_me" },
    workspace: { path: "/repo/.wt/abc-1" },
    session: { id: "22222222-2222-4222-8222-222222222222" }
  });

  const serialized = JSON.stringify(envelope) + harness.describeConfig(cfg);
  assert.ok(!serialized.includes("rag_do_not_print_me"));
});
