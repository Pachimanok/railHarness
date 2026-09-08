/**
 * Rail Harness — public surface (bootstrap).
 *
 * This barrel is the stable import point the follow-up tickets build against:
 *   - Worker Core         — consumes runtime config + RailApiClient + contracts
 *   - Workspace Manager    — fills ExecutionEnvelope.workspace.path
 *   - AdapterRouter        — routes an ExecutionEnvelope to an adapter, gets back
 *                            an ExecutionResult
 *   - Orchestration        — drives the WorkCycle state machine (docs/STATE_MACHINE.md)
 *
 * The autonomous worker loop itself is intentionally NOT part of this bootstrap.
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
