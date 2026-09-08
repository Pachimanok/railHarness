/**
 * ExecutionResult — the normalized OUTPUT an adapter returns to the Harness
 * for one execution.
 *
 * This is the exact structured-output contract from the approved reference
 * (`~/rail-runner/harness/adapters/claude-code.mjs` `RESULT_SCHEMA`), lifted
 * into a shared contract so the future AdapterRouter and every adapter
 * (claude-code, codex, …) agree on one shape.
 *
 * The Harness maps `outcome` onto Rail transitions/checks (see
 * docs/STATE_MACHINE.md); it is NOT the adapter's job to call Rail.
 */

/** Terminal outcomes an adapter may report for a single execution. */
export const EXECUTION_OUTCOMES = Object.freeze([
  "IMPLEMENTED", // change is done and reasonably verified
  "BLOCKED", // needs a concrete human answer (question/context/impact set)
  "RELEASE", // ticket/SPEC/repo do not correspond, or continuing is wrong
  "FAILED" // technical failure, not a business decision
]);

export const EXECUTION_RESULT_SCHEMA_VERSION = "0.1";

/**
 * JSON Schema an adapter is asked to satisfy when producing structured
 * output. Kept `additionalProperties: false` and fully `required` so a
 * partial/loose object is rejected at the boundary.
 */
export const EXECUTION_RESULT_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ExecutionResult",
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: [...EXECUTION_OUTCOMES] },
    summary: { type: "string" },
    question: { type: ["string", "null"] },
    context: { type: ["string", "null"] },
    impact: { type: ["string", "null"] },
    tests: { type: "array", items: { type: "string" } },
    filesChanged: { type: "array", items: { type: "string" } }
  },
  required: [
    "outcome",
    "summary",
    "question",
    "context",
    "impact",
    "tests",
    "filesChanged"
  ]
});

function isStringOrNull(v) {
  return v === null || typeof v === "string";
}

function isStringArray(v) {
  return Array.isArray(v) && v.every(x => typeof x === "string");
}

/**
 * Validate `value` against the ExecutionResult contract. Returns
 * `{ valid, errors }` — never throws. `errors` is a list of short strings.
 */
export function validateExecutionResult(value) {
  const errors = [];

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["result must be a non-null object"] };
  }

  const allowed = new Set(EXECUTION_RESULT_JSON_SCHEMA.required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`unexpected property "${key}"`);
  }

  if (!EXECUTION_OUTCOMES.includes(value.outcome)) {
    errors.push(
      `outcome must be one of ${EXECUTION_OUTCOMES.join("|")} (got ${JSON.stringify(
        value.outcome
      )})`
    );
  }
  if (typeof value.summary !== "string" || value.summary.trim() === "") {
    errors.push("summary must be a non-empty string");
  }
  for (const field of ["question", "context", "impact"]) {
    if (!isStringOrNull(value[field])) {
      errors.push(`${field} must be a string or null`);
    }
  }
  if (!isStringArray(value.tests)) errors.push("tests must be an array of strings");
  if (!isStringArray(value.filesChanged)) {
    errors.push("filesChanged must be an array of strings");
  }

  // Cross-field: BLOCKED requires an actual question.
  if (
    value.outcome === "BLOCKED" &&
    (typeof value.question !== "string" || value.question.trim() === "")
  ) {
    errors.push('outcome BLOCKED requires a non-empty "question"');
  }

  return { valid: errors.length === 0, errors };
}

/** Throwing wrapper. Returns `value` on success. */
export function assertValidExecutionResult(value) {
  const { valid, errors } = validateExecutionResult(value);
  if (!valid) {
    throw new Error(`Invalid ExecutionResult: ${errors.join("; ")}`);
  }
  return value;
}

/**
 * Extract the ExecutionResult object from an adapter's raw stdout. Mirrors
 * the reference's `parseClaudeResult`: accepts either a bare result object or
 * a wrapper envelope exposing `structured_output` / `structuredOutput` /
 * `result`. Validates before returning.
 */
export function parseExecutionResult(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) throw new Error("adapter produced no output");

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error(`adapter output is not valid JSON:\n${text.slice(0, 2000)}`);
  }

  let candidate =
    envelope?.structured_output ??
    envelope?.structuredOutput ??
    envelope?.result ??
    envelope;

  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new Error(
        `adapter "result" is not structured JSON:\n${candidate.slice(0, 2000)}`
      );
    }
  }

  return assertValidExecutionResult(candidate);
}
