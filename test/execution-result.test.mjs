import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateExecutionResult,
  assertValidExecutionResult,
  parseExecutionResult,
  EXECUTION_OUTCOMES,
  EXECUTION_RESULT_JSON_SCHEMA
} from "../src/contracts/execution-result.js";

function ok(overrides = {}) {
  return {
    outcome: "IMPLEMENTED",
    summary: "did the thing",
    question: null,
    context: null,
    impact: null,
    tests: ["npm test : pass"],
    filesChanged: ["src/a.js"],
    ...overrides
  };
}

test("EXECUTION_OUTCOMES is the fixed set", () => {
  assert.deepEqual(EXECUTION_OUTCOMES, ["IMPLEMENTED", "BLOCKED", "RELEASE", "FAILED"]);
});

test("schema is strict (additionalProperties false, all required)", () => {
  assert.equal(EXECUTION_RESULT_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(EXECUTION_RESULT_JSON_SCHEMA.required.sort(), [
    "context",
    "filesChanged",
    "impact",
    "outcome",
    "question",
    "summary",
    "tests"
  ]);
});

test("CLI schema does not declare an incompatible $schema (draft 2020-12)", () => {
  // RAIL-D-00004 Tester finding: Claude Code 2.1.266 bundles a draft-07
  // validator and rejects an unknown $schema meta-ref, failing the whole run.
  // The schema must omit $schema (reference-aligned) or pin draft-07.
  const meta = EXECUTION_RESULT_JSON_SCHEMA.$schema;
  assert.ok(
    meta === undefined || /draft-07/.test(String(meta)),
    `EXECUTION_RESULT_JSON_SCHEMA.$schema must be absent or draft-07, got ${JSON.stringify(meta)}`
  );
  // Still a closed, complete ExecutionResult schema.
  assert.equal(EXECUTION_RESULT_JSON_SCHEMA.type, "object");
  assert.equal(EXECUTION_RESULT_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(EXECUTION_RESULT_JSON_SCHEMA.properties.outcome.enum, [...EXECUTION_OUTCOMES]);
  assert.deepEqual(EXECUTION_RESULT_JSON_SCHEMA.properties.tests, {
    type: "array",
    items: { type: "string" }
  });
  assert.deepEqual([...EXECUTION_RESULT_JSON_SCHEMA.required].sort(), [
    "context",
    "filesChanged",
    "impact",
    "outcome",
    "question",
    "summary",
    "tests"
  ]);
});

test("a well-formed result validates (schema unchanged internally)", () => {
  const { valid, errors } = validateExecutionResult(ok());
  assert.ok(valid, JSON.stringify(errors));
});

test("unknown property is rejected", () => {
  const { valid, errors } = validateExecutionResult({ ...ok(), extra: 1 });
  assert.ok(!valid);
  assert.ok(errors.some(e => e.includes('unexpected property "extra"')));
});

test("bad outcome is rejected", () => {
  const { valid } = validateExecutionResult(ok({ outcome: "DONE" }));
  assert.ok(!valid);
});

test("empty summary is rejected", () => {
  const { valid } = validateExecutionResult(ok({ summary: "  " }));
  assert.ok(!valid);
});

test("tests/filesChanged must be string arrays", () => {
  assert.ok(!validateExecutionResult(ok({ tests: "x" })).valid);
  assert.ok(!validateExecutionResult(ok({ filesChanged: [1] })).valid);
});

test("BLOCKED without a question is rejected", () => {
  const { valid, errors } = validateExecutionResult(
    ok({ outcome: "BLOCKED", question: null })
  );
  assert.ok(!valid);
  assert.ok(errors.some(e => e.includes("BLOCKED requires")));
});

test("BLOCKED with a question passes", () => {
  assert.ok(
    validateExecutionResult(ok({ outcome: "BLOCKED", question: "which db?" })).valid
  );
});

test("assertValidExecutionResult throws with a joined message", () => {
  assert.throws(() => assertValidExecutionResult({ outcome: "x" }), /Invalid ExecutionResult:/);
});

test("parseExecutionResult reads a bare object", () => {
  const r = parseExecutionResult(JSON.stringify(ok()));
  assert.equal(r.outcome, "IMPLEMENTED");
});

test("parseExecutionResult unwraps structured_output / result wrappers", () => {
  assert.equal(
    parseExecutionResult(JSON.stringify({ structured_output: ok() })).outcome,
    "IMPLEMENTED"
  );
  assert.equal(
    parseExecutionResult(JSON.stringify({ result: ok({ outcome: "RELEASE" }) })).outcome,
    "RELEASE"
  );
});

test("parseExecutionResult unwraps a stringified inner result", () => {
  const r = parseExecutionResult(JSON.stringify({ result: JSON.stringify(ok()) }));
  assert.equal(r.outcome, "IMPLEMENTED");
});

test("parseExecutionResult rejects empty / non-JSON / invalid", () => {
  assert.throws(() => parseExecutionResult(""), /no output/);
  assert.throws(() => parseExecutionResult("not json"), /not valid JSON/);
  assert.throws(
    () => parseExecutionResult(JSON.stringify({ outcome: "IMPLEMENTED" })),
    /Invalid ExecutionResult/
  );
});
