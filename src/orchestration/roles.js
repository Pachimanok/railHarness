/**
 * Orchestration roles — RAIL-D-00005.
 *
 * The Orchestration layer runs three INDEPENDENT roles, each as its own
 * governed adapter execution through the AdapterRouter (never a hard-coded
 * provider):
 *
 *   IMPLEMENTER  — produces the change (write access to the workspace).
 *   REVIEWER     — reviews the produced work; read-only on the repo. NOT a
 *                  second silent Implementer.
 *   TESTER       — validates tests / Acceptance Criteria; independent of the
 *                  Reviewer, semantically and in execution.
 *
 * Every role returns an `ExecutionResult` (the approved contract,
 * `src/contracts/execution-result.js`). This module normalizes that into a
 * `RoleResult` the orchestrator can act on WITHOUT parsing free text:
 *
 *   { role, decision, summary, evidence, question, context, impact, sessionId }
 *
 * `decision` is a fixed enum. Machine-readable — never translated.
 */

import {
  validateExecutionResult
} from "../contracts/execution-result.js";
import { buildExecutionEnvelope } from "../contracts/execution-envelope.js";
import { stripSecretKeys } from "../security/sanitize.js";

/** The three governed roles. Identifiers — never translated. */
export const ROLES = Object.freeze({
  IMPLEMENTER: "IMPLEMENTER",
  REVIEWER: "REVIEWER",
  TESTER: "TESTER"
});

export const ROLE_LIST = Object.freeze(Object.values(ROLES));

/**
 * Structured decision the orchestrator consumes.
 *
 *   PASS    — the role succeeded: implementation done / review approved /
 *             tests + Acceptance Criteria green.
 *   REWORK  — review or tests did NOT approve; hand back to the IMPLEMENTER.
 *             (An IMPLEMENTER never produces REWORK.)
 *   BLOCKED — a concrete human answer is required (question/context/impact set).
 *   RELEASE — ticket / SPEC / repo do not correspond; do not proceed.
 *   FAILED  — technical failure, not a judgement.
 */
export const ROLE_DECISIONS = Object.freeze([
  "PASS",
  "REWORK",
  "BLOCKED",
  "RELEASE",
  "FAILED"
]);

/**
 * Map one `ExecutionResult.outcome` onto a `RoleResult.decision` for a role.
 * The `outcome` enum is NEVER translated or rewritten; this is only an
 * orchestration-side interpretation.
 *
 *   IMPLEMENTED -> PASS        (for every role: "this role is done / approves")
 *   BLOCKED     -> BLOCKED
 *   FAILED      -> FAILED
 *   RELEASE     -> RELEASE for the IMPLEMENTER (the ticket does not correspond)
 *               -> REWORK  for the REVIEWER / TESTER (work must go back)
 */
export function decisionFor(role, outcome) {
  switch (outcome) {
    case "IMPLEMENTED":
      return "PASS";
    case "BLOCKED":
      return "BLOCKED";
    case "FAILED":
      return "FAILED";
    case "RELEASE":
      return role === ROLES.IMPLEMENTER ? "RELEASE" : "REWORK";
    default:
      return "FAILED";
  }
}

/**
 * Normalize an adapter `ExecutionResult` into a `RoleResult`. Throws (Spanish)
 * if the adapter returned something that is not a valid `ExecutionResult` —
 * the orchestrator must never guess.
 *
 * @param {"IMPLEMENTER"|"REVIEWER"|"TESTER"} role
 * @param {object} executionResult  a validated-or-not ExecutionResult
 * @param {string|null} sessionId   the adapter session that produced it
 * @returns {Readonly<object>} RoleResult
 */
export function interpretExecutionResult(role, executionResult, sessionId = null) {
  if (!ROLE_LIST.includes(role)) {
    throw new Error(`Rol desconocido para interpretar un resultado: ${JSON.stringify(role)}`);
  }
  const check = validateExecutionResult(executionResult);
  if (!check.valid) {
    throw new Error(
      `El rol ${role} devolvió un ExecutionResult inválido: ${check.errors.join("; ")}`
    );
  }

  const decision = decisionFor(role, executionResult.outcome);
  return Object.freeze({
    role,
    decision,
    outcome: executionResult.outcome,
    summary: executionResult.summary,
    question: executionResult.question ?? null,
    context: executionResult.context ?? null,
    impact: executionResult.impact ?? null,
    evidence: Object.freeze({
      tests: Object.freeze([...(executionResult.tests ?? [])]),
      filesChanged: Object.freeze([...(executionResult.filesChanged ?? [])]),
      findings:
        decision === "REWORK" && executionResult.summary
          ? Object.freeze([executionResult.summary])
          : Object.freeze([])
    }),
    sessionId: sessionId ?? null
  });
}

/** Throwing guard: `value` must be a well-formed RoleResult for `role`. */
export function assertRoleResult(role, value) {
  if (!value || typeof value !== "object") {
    throw new Error(`El rol ${role} no devolvió un RoleResult.`);
  }
  if (value.role !== role) {
    throw new Error(
      `RoleResult con rol inconsistente: esperaba ${role}, recibí ${JSON.stringify(value.role)}.`
    );
  }
  if (!ROLE_DECISIONS.includes(value.decision)) {
    throw new Error(
      `RoleResult.decision inválida para ${role}: ${JSON.stringify(value.decision)}.`
    );
  }
  if (
    value.decision === "BLOCKED" &&
    (typeof value.question !== "string" || value.question.trim() === "")
  ) {
    throw new Error(`El rol ${role} devolvió BLOCKED sin 'question'.`);
  }
  return value;
}

/**
 * Build the `ExecutionEnvelope` for one role execution. Thin wrapper over
 * `buildExecutionEnvelope` (which strips ticket secret keys and runs
 * `assertNoSecrets`). The `roleBrief` is additionally secret-stripped here.
 */
export function buildRoleEnvelope({
  role,
  kind = "IMPLEMENT",
  runId,
  branch,
  ticket,
  workspacePath,
  sessionId,
  continuation = null,
  resumeAnswer = null,
  roleBrief = null
}) {
  return buildExecutionEnvelope({
    kind,
    role,
    run: { id: runId, branch },
    ticket: ticket ?? {},
    workspace: { path: workspacePath },
    session: { id: sessionId },
    continuation,
    resumeAnswer,
    roleBrief: roleBrief == null ? null : stripSecretKeys(roleBrief)
  });
}

/**
 * The default role runner: drive the AdapterRouter (provider-independent) and
 * normalize its `ExecutionResult` into a `RoleResult`. Injected into the
 * orchestrator; tests pass a fake instead.
 *
 * NOTE: this seam receives ONLY `{ role, envelope, signal }` — never the Rail
 * client, never a `claimToken`, never a token. The AdapterRouter re-checks the
 * envelope with `assertNoSecrets` before any adapter sees it.
 */
export function defaultRunRole({ adapterRouter, provider } = {}) {
  if (!adapterRouter || typeof adapterRouter.run !== "function") {
    throw new Error("defaultRunRole requiere un adapterRouter con run()");
  }
  return async ({ role, envelope, signal }) => {
    const { sessionId, result } = await adapterRouter.run(envelope, { provider, signal });
    return interpretExecutionResult(role, result, sessionId ?? envelope.session.id);
  };
}
