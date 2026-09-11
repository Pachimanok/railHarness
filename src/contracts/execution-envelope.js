/**
 * ExecutionEnvelope — the normalized INPUT the Harness hands to an adapter
 * for one execution.
 *
 * The approved reference passes these fields ad hoc as function arguments to
 * `runClaudeImplementer` / `runClaudeRecovery`
 * (`~/rail-runner/harness/adapters/claude-code.mjs`). This contract freezes
 * that surface into one object so the future AdapterRouter can route the same
 * envelope to any adapter.
 *
 * Hard rule: the envelope carries NO Rail control-plane credentials. The
 * `ticket` is passed through `stripSecretKeys` before it goes in, and there
 * is no field for a token, claimToken, or API URL. Adapters work on code,
 * not on Rail.
 *
 * Every envelope also carries `languagePolicy` (see `src/i18n/language-policy.js`
 * and docs/HARNESS.md): the instruction that all human communication the
 * runtime produces must be in Spanish, while machine-readable protocol values
 * stay untranslated. This is additive and non-breaking — callers never pass
 * it; `buildExecutionEnvelope` always injects it.
 */

import { stripSecretKeys, SECRET_KEY_RE } from "../security/sanitize.js";
import {
  buildLanguagePolicy,
  validateLanguagePolicy
} from "../i18n/language-policy.js";

export const EXECUTION_ENVELOPE_SCHEMA_VERSION = "0.1";

/** What kind of execution the adapter is being asked to perform. */
export const EXECUTION_KINDS = Object.freeze([
  "IMPLEMENT", // fresh implementation of a claimed ticket
  "RECOVERY" // continuation of an already-started cycle (worktree is dirty)
]);

/**
 * Which governed role the adapter is being asked to play for this execution
 * (see `docs/ORCHESTRATION.md`). Additive and backward-compatible: callers that
 * omit `role` get `"IMPLEMENTER"`, which is exactly the pre-RAIL-D-00005
 * behaviour. `REVIEWER` and `TESTER` are independent, read-only-on-the-repo
 * executions the Orchestration layer drives through the same AdapterRouter.
 * Machine-readable identifiers — never translated.
 */
export const EXECUTION_ROLES = Object.freeze(["IMPLEMENTER", "REVIEWER", "TESTER"]);

function frozenContinuation(input) {
  if (input == null) return null;
  if (typeof input !== "object") {
    throw new Error("continuation must be an object or null");
  }
  return Object.freeze({
    priorImplementationNote: input.priorImplementationNote ?? null,
    failedReviewNote: input.failedReviewNote ?? null,
    pendingFeedback: Object.freeze([...(input.pendingFeedback ?? [])]),
    changedFiles: Object.freeze([...(input.changedFiles ?? [])]),
    feedbackSource: input.feedbackSource ?? null
  });
}

/**
 * Build a validated, frozen ExecutionEnvelope.
 *
 * @param {object}   p
 * @param {"IMPLEMENT"|"RECOVERY"} p.kind
 * @param {{id:string, branch:string}} p.run     Run id + mandatory branch
 * @param {object}   p.ticket                    Rail ticket detail (will be secret-stripped)
 * @param {{path:string}} p.workspace            isolated worktree path (Workspace Manager ticket fills this)
 * @param {{id:string}}   p.session              adapter session id
 * @param {object|null}   [p.continuation]       RECOVERY context; null for IMPLEMENT
 * @param {string|null}   [p.resumeAnswer]       human answer resuming a prior BLOCKED execution
 * @param {"IMPLEMENTER"|"REVIEWER"|"TESTER"} [p.role]  governed role (default IMPLEMENTER)
 * @param {object|null}   [p.roleBrief]          extra, secret-stripped context a REVIEWER /
 *                                                TESTER needs (implementation summary, changed
 *                                                files, Acceptance Criteria). Never carries Rail
 *                                                credentials — passed through `stripSecretKeys`.
 */
export function buildExecutionEnvelope({
  kind,
  run,
  ticket,
  workspace,
  session,
  continuation = null,
  resumeAnswer = null,
  role = "IMPLEMENTER",
  roleBrief = null
}) {
  if (!EXECUTION_KINDS.includes(kind)) {
    throw new Error(
      `kind must be one of ${EXECUTION_KINDS.join("|")} (got ${JSON.stringify(kind)})`
    );
  }
  if (!EXECUTION_ROLES.includes(role)) {
    throw new Error(
      `role must be one of ${EXECUTION_ROLES.join("|")} (got ${JSON.stringify(role)})`
    );
  }
  if (roleBrief != null && typeof roleBrief !== "object") {
    throw new Error("roleBrief must be an object or null");
  }
  if (!run || typeof run.id !== "string" || !run.id) {
    throw new Error("run.id is required");
  }
  if (typeof run.branch !== "string" || !run.branch) {
    throw new Error("run.branch is required (adapters must never switch branch)");
  }
  if (!workspace || typeof workspace.path !== "string" || !workspace.path) {
    throw new Error("workspace.path is required");
  }
  if (!session || typeof session.id !== "string" || !session.id) {
    throw new Error("session.id is required");
  }
  if (resumeAnswer !== null && typeof resumeAnswer !== "string") {
    throw new Error("resumeAnswer must be a string or null");
  }
  // A resume is driven by a REAL, non-empty human answer (RailSoft's
  // `answerQuery` rejects empty `answer` as `invalid_input`). `""` / whitespace
  // is never a valid resume — make it a contract invariant, not just a
  // production convention.
  if (typeof resumeAnswer === "string" && resumeAnswer.trim() === "") {
    throw new Error("resumeAnswer must be null or a non-empty string (after trim)");
  }
  if (kind === "RECOVERY" && continuation == null) {
    throw new Error("RECOVERY envelopes require a continuation context");
  }
  if (kind === "IMPLEMENT" && continuation != null) {
    throw new Error("IMPLEMENT envelopes must not carry a continuation context");
  }

  const envelope = {
    schemaVersion: EXECUTION_ENVELOPE_SCHEMA_VERSION,
    kind,
    role,
    run: Object.freeze({ id: run.id, branch: run.branch }),
    ticket: stripSecretKeys(ticket ?? {}),
    workspace: Object.freeze({ path: workspace.path }),
    session: Object.freeze({ id: session.id }),
    continuation: frozenContinuation(continuation),
    resumeAnswer,
    // REVIEWER / TESTER context. Secret keys stripped, deep-frozen. null for a
    // plain IMPLEMENTER execution.
    roleBrief:
      roleBrief == null ? null : Object.freeze(stripSecretKeys(roleBrief)),
    // Toda comunicación humana del runtime va en español; lo machine-readable
    // no se traduce. Se inyecta siempre — no es un parámetro del caller.
    languagePolicy: buildLanguagePolicy()
  };

  assertNoSecrets(envelope);
  return Object.freeze(envelope);
}

/**
 * Defense in depth: walk the whole envelope and throw if any key looks like a
 * secret. Runs at build time; exported so the AdapterRouter can re-check
 * anything it assembles itself.
 */
export function assertNoSecrets(node, path = "envelope") {
  if (node == null || typeof node !== "object") return;

  for (const [key, value] of Object.entries(node)) {
    if (SECRET_KEY_RE.test(key)) {
      throw new Error(`ExecutionEnvelope must not contain secrets: ${path}.${key}`);
    }
    assertNoSecrets(value, `${path}.${key}`);
  }
}

/** Non-throwing structural check. Returns `{ valid, errors }`. */
export function validateExecutionEnvelope(value) {
  const errors = [];
  try {
    if (!value || typeof value !== "object") throw new Error("must be an object");
    if (value.schemaVersion !== EXECUTION_ENVELOPE_SCHEMA_VERSION) {
      errors.push(`schemaVersion must be "${EXECUTION_ENVELOPE_SCHEMA_VERSION}"`);
    }
    if (!EXECUTION_KINDS.includes(value.kind)) errors.push("kind is invalid");
    if (value.role != null && !EXECUTION_ROLES.includes(value.role)) {
      errors.push("role is invalid");
    }
    if (!value.run?.id) errors.push("run.id is required");
    if (!value.run?.branch) errors.push("run.branch is required");
    if (!value.workspace?.path) errors.push("workspace.path is required");
    if (!value.session?.id) errors.push("session.id is required");
    if (value.kind === "RECOVERY" && value.continuation == null) {
      errors.push("RECOVERY requires continuation");
    }
    if (value.kind === "IMPLEMENT" && value.continuation != null) {
      errors.push("IMPLEMENT must not carry continuation");
    }
    if (value.resumeAnswer !== null && value.resumeAnswer !== undefined) {
      if (typeof value.resumeAnswer !== "string") {
        errors.push("resumeAnswer must be a string or null");
      } else if (value.resumeAnswer.trim() === "") {
        errors.push("resumeAnswer must be null or a non-empty string (after trim)");
      }
    }
    const lang = validateLanguagePolicy(value.languagePolicy);
    if (!lang.valid) errors.push(...lang.errors);
    assertNoSecrets(value);
  } catch (err) {
    errors.push(err.message);
  }
  return { valid: errors.length === 0, errors };
}
