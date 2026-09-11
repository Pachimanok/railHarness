import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildExecutionEnvelope,
  validateExecutionEnvelope,
  assertNoSecrets,
  EXECUTION_KINDS,
  EXECUTION_ENVELOPE_SCHEMA_VERSION
} from "../src/contracts/execution-envelope.js";
import { LANGUAGE_INSTRUCTION } from "../src/i18n/language-policy.js";

function implementArgs(overrides = {}) {
  return {
    kind: "IMPLEMENT",
    run: { id: "run_1", branch: "rail/abc-1" },
    ticket: { item: { code: "ABC-1" }, claimToken: "rag_secret", state: "IN_PROGRESS" },
    workspace: { path: "/home/x/.rail-harness/worktrees/p/abc-1" },
    session: { id: "11111111-1111-4111-8111-111111111111" },
    ...overrides
  };
}

test("EXECUTION_KINDS is the fixed set", () => {
  assert.deepEqual(EXECUTION_KINDS, ["IMPLEMENT", "RECOVERY"]);
});

test("builds a frozen IMPLEMENT envelope with secrets stripped from the ticket", () => {
  const env = buildExecutionEnvelope(implementArgs());
  assert.equal(env.schemaVersion, EXECUTION_ENVELOPE_SCHEMA_VERSION);
  assert.equal(env.kind, "IMPLEMENT");
  assert.equal(env.run.branch, "rail/abc-1");
  assert.equal(env.continuation, null);
  assert.equal(env.resumeAnswer, null);
  assert.equal(env.ticket.claimToken, undefined);
  assert.equal(env.ticket.item.code, "ABC-1");
  assert.ok(Object.isFrozen(env));
  assert.ok(Object.isFrozen(env.run));
  assert.ok(Object.isFrozen(env.workspace));
});

test("missing run.branch is rejected", () => {
  assert.throws(
    () => buildExecutionEnvelope(implementArgs({ run: { id: "r" } })),
    /run\.branch is required/
  );
});

test("missing workspace.path is rejected", () => {
  assert.throws(
    () => buildExecutionEnvelope(implementArgs({ workspace: {} })),
    /workspace\.path is required/
  );
});

test("bad kind is rejected", () => {
  assert.throws(() => buildExecutionEnvelope(implementArgs({ kind: "X" })), /kind must be one of/);
});

test("IMPLEMENT with a continuation is rejected", () => {
  assert.throws(
    () => buildExecutionEnvelope(implementArgs({ continuation: { pendingFeedback: [] } })),
    /must not carry a continuation/
  );
});

test("RECOVERY without a continuation is rejected", () => {
  assert.throws(
    () => buildExecutionEnvelope(implementArgs({ kind: "RECOVERY" })),
    /require a continuation/
  );
});

test("RECOVERY envelope freezes the continuation and its arrays", () => {
  const env = buildExecutionEnvelope(
    implementArgs({
      kind: "RECOVERY",
      continuation: {
        failedReviewNote: "AC-02 failed",
        pendingFeedback: ["AC-02", "RBAC"],
        changedFiles: ["app/x.php"]
      }
    })
  );
  assert.equal(env.kind, "RECOVERY");
  assert.deepEqual(env.continuation.pendingFeedback, ["AC-02", "RBAC"]);
  assert.equal(env.continuation.priorImplementationNote, null);
  assert.ok(Object.isFrozen(env.continuation));
  assert.ok(Object.isFrozen(env.continuation.pendingFeedback));
});

test("resumeAnswer must be a string or null", () => {
  assert.throws(
    () => buildExecutionEnvelope(implementArgs({ resumeAnswer: 42 })),
    /resumeAnswer must be a string or null/
  );
  const env = buildExecutionEnvelope(implementArgs({ resumeAnswer: "use postgres" }));
  assert.equal(env.resumeAnswer, "use postgres");
});

test("RAIL-D-00006 §16C: an empty / whitespace resumeAnswer is rejected (never a valid resume)", () => {
  for (const bad of ["", "   ", "\t\n"]) {
    assert.throws(
      () => buildExecutionEnvelope(implementArgs({ resumeAnswer: bad })),
      /resumeAnswer must be null or a non-empty string/,
      JSON.stringify(bad)
    );
    const check = validateExecutionEnvelope({
      ...buildExecutionEnvelope(implementArgs()),
      resumeAnswer: bad
    });
    assert.ok(!check.valid);
    assert.ok(check.errors.some(e => /non-empty string/.test(e)));
  }
  // null is still fine; a real answer is still fine
  assert.equal(buildExecutionEnvelope(implementArgs({ resumeAnswer: null })).resumeAnswer, null);
  assert.equal(
    buildExecutionEnvelope(implementArgs({ resumeAnswer: "  usá PostgreSQL  " })).resumeAnswer,
    "  usá PostgreSQL  "
  );
});

test("assertNoSecrets throws if a secret key is smuggled in", () => {
  assert.throws(
    () => assertNoSecrets({ run: { id: "r", claimToken: "x" } }),
    /must not contain secrets/
  );
});

test("a ticket whose non-secret content mentions a token string still builds (only keys are stripped)", () => {
  const env = buildExecutionEnvelope(
    implementArgs({ ticket: { description: "the word token appears here", id: "T" } })
  );
  assert.equal(env.ticket.description, "the word token appears here");
});

test("validateExecutionEnvelope agrees with buildExecutionEnvelope", () => {
  const env = buildExecutionEnvelope(implementArgs());
  const { valid, errors } = validateExecutionEnvelope(env);
  assert.ok(valid, JSON.stringify(errors));

  const bad = validateExecutionEnvelope({ ...env, kind: "NOPE" });
  assert.ok(!bad.valid);
});

// ─── Política de idioma en el envelope (requisito del ticket) ─────────────

test("every IMPLEMENT envelope carries the Spanish language instruction", () => {
  const env = buildExecutionEnvelope(implementArgs());
  assert.ok(env.languagePolicy, "languagePolicy must be present");
  assert.equal(env.languagePolicy.humanLanguage, "es");
  assert.equal(env.languagePolicy.instruction, LANGUAGE_INSTRUCTION);
  assert.match(env.languagePolicy.instruction, /español/i);
  assert.ok(Object.isFrozen(env.languagePolicy));
});

test("every RECOVERY envelope also carries the language instruction", () => {
  const env = buildExecutionEnvelope(
    implementArgs({ kind: "RECOVERY", continuation: { pendingFeedback: ["AC-02"] } })
  );
  assert.equal(env.languagePolicy.humanLanguage, "es");
  assert.match(env.languagePolicy.instruction, /NO traduzcas/i);
});

test("the language instruction survives serialization to a runtime (reaches the wire)", () => {
  const env = buildExecutionEnvelope(implementArgs());
  const onWire = JSON.parse(JSON.stringify(env));
  assert.equal(onWire.languagePolicy.instruction, LANGUAGE_INSTRUCTION);
  assert.match(onWire.languagePolicy.instruction, /español/i);
});

test("languagePolicy.doNotTranslate carries the machine-readable values verbatim", () => {
  const env = buildExecutionEnvelope(implementArgs());
  for (const term of [
    "READY",
    "CLAIMED",
    "IN_PROGRESS",
    "BLOCKED",
    "SUCCESS",
    "FAILED",
    "CODE_REVIEW",
    "AUTOMATED_TESTS",
    "ACCEPTANCE_CRITERIA"
  ]) {
    assert.ok(
      env.languagePolicy.doNotTranslate.includes(term),
      `doNotTranslate should include ${term}`
    );
  }
});

test("validateExecutionEnvelope rejects an envelope with a missing/wrong language policy", () => {
  const env = buildExecutionEnvelope(implementArgs());

  assert.ok(!validateExecutionEnvelope({ ...env, languagePolicy: undefined }).valid);

  const wrongLang = validateExecutionEnvelope({
    ...env,
    languagePolicy: { ...env.languagePolicy, humanLanguage: "en" }
  });
  assert.ok(!wrongLang.valid);
  assert.ok(wrongLang.errors.some(e => /humanLanguage/.test(e)));
});

// ─── RAIL-D-00005: role / roleBrief (aditivos, backward-compatible) ───────

test("role por defecto es IMPLEMENTER y el envelope sigue siendo válido", () => {
  const env = buildExecutionEnvelope(implementArgs());
  assert.equal(env.role, "IMPLEMENTER");
  assert.equal(env.roleBrief, null);
  assert.ok(validateExecutionEnvelope(env).valid);
});

test("role REVIEWER/TESTER se acepta; un role desconocido se rechaza", () => {
  for (const role of ["REVIEWER", "TESTER"]) {
    const env = buildExecutionEnvelope(implementArgs({ role }));
    assert.equal(env.role, role);
  }
  assert.throws(() => buildExecutionEnvelope(implementArgs({ role: "AUDITOR" })), /role must be one of/);
});

test("roleBrief se congela y se le quitan las claves secretas", () => {
  const env = buildExecutionEnvelope(
    implementArgs({
      role: "REVIEWER",
      roleBrief: { implementationSummary: "hecho X", token: "rag_secret", nested: { claimToken: "CT" } }
    })
  );
  assert.equal(env.roleBrief.implementationSummary, "hecho X");
  assert.equal(env.roleBrief.token, undefined);
  assert.equal(env.roleBrief.nested.claimToken, undefined);
  assert.ok(Object.isFrozen(env.roleBrief));
  assert.doesNotThrow(() => assertNoSecrets(env));
});

test("validateExecutionEnvelope marca un role inválido", () => {
  const env = buildExecutionEnvelope(implementArgs());
  assert.ok(!validateExecutionEnvelope({ ...env, role: "NOPE" }).valid);
});
