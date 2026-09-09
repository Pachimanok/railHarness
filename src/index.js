/**
 * Rail Harness — public surface (bootstrap).
 *
 * This barrel is the stable import point the follow-up tickets build against:
 *   - Worker Core         — DELIVERED HERE: discovery, preflight, atomic claim,
 *                           heartbeat supervisor, fencing, controlled shutdown
 *                           (docs/WORKER_CORE.md). Runs against an injected
 *                           execution collaborator.
 *   - Workspace Manager    — fills ExecutionEnvelope.workspace.path
 *   - AdapterRouter        — routes an ExecutionEnvelope to an adapter, gets back
 *                            an ExecutionResult
 *   - Orchestration        — drives the WorkCycle state machine (docs/STATE_MACHINE.md)
 *
 * The Worker Core owns the Run lease; it does NOT yet create a real workspace,
 * spawn a real adapter, or drive WorkCycle transitions — those stay with the
 * later tickets.
 */

export {
  loadRuntimeConfig,
  describeConfig,
  resolveMode,
  HARNESS_MODES,
  REQUIRED_ENV,
  OPTIONAL_ENV
} from "./config/runtime-config.js";

export { RailApiClient, normalizeRunHandoff } from "./rail/rail-api-client.js";

export {
  buildExecutionEnvelope,
  validateExecutionEnvelope,
  assertNoSecrets,
  EXECUTION_KINDS,
  EXECUTION_ENVELOPE_SCHEMA_VERSION
} from "./contracts/execution-envelope.js";

export {
  validateExecutionResult,
  assertValidExecutionResult,
  parseExecutionResult,
  EXECUTION_OUTCOMES,
  EXECUTION_RESULT_JSON_SCHEMA,
  EXECUTION_RESULT_SCHEMA_VERSION
} from "./contracts/execution-result.js";

export {
  stripSecretKeys,
  sanitizeTicket,
  safeTopLevelKeys,
  redactSecrets,
  safeEnvironment,
  SECRET_KEY_RE
} from "./security/sanitize.js";

export {
  REQUIRED_CLAUDE_FLAGS,
  flagPresent,
  missingClaudeFlags
} from "./adapters/claude-preflight.js";

export {
  HUMAN_LANGUAGE,
  PROTOCOL_TERMS,
  LANGUAGE_INSTRUCTION,
  LANGUAGE_POLICY_VERSION,
  buildLanguagePolicy,
  validateLanguagePolicy
} from "./i18n/language-policy.js";

export {
  createWorkerCore,
  defaultBranchFor,
  WORKER_PHASES,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_DISCOVERY_POLL_MS,
  DEFAULT_DISCOVERY_LIMIT
} from "./worker/worker-core.js";

export {
  assertTicketClaimable,
  isTicketClaimable,
  pickDiscoveryRef
} from "./worker/ticket-preflight.js";

export { createPlaceholderExecution } from "./worker/placeholder-execution.js";
