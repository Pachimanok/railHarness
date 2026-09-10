/**
 * Rail Harness — public surface (bootstrap).
 *
 * This barrel is the stable import point:
 *   - Worker Core       — discovery, preflight, atomic claim, heartbeat, fencing,
 *                         controlled shutdown (docs/WORKER_CORE.md).
 *   - Workspace Manager — isolated git worktree + ticket branch (docs/WORKSPACE_MANAGER.md).
 *   - AdapterRouter     — provider-independent adapter routing (docs/ADAPTER_ROUTER.md).
 *   - Orchestration     — IMPLEMENTER → REVIEWER → TESTER, governed checks /
 *                         transitions / Agent Queries, humanOnly hand-off
 *                         (docs/ORCHESTRATION.md). Wired into `npm run worker`.
 *
 * The Worker Core owns the Run lease; Orchestration runs the roles on that Run
 * and never claims / recovers / heartbeats / finishes it. Full resume /
 * recovery of an orphaned IN_PROGRESS cycle stays with a later ticket.
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
  EXECUTION_ROLES,
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
  CLAUDE_PROVIDER,
  CLAUDE_TOOLS,
  CLAUDE_ALLOWED_TOOLS,
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_REVIEW_TOOLS,
  CLAUDE_REVIEW_ALLOWED_TOOLS,
  CLAUDE_TEST_ALLOWED_TOOLS,
  CLAUDE_REVIEW_DISALLOWED_TOOLS,
  FORBIDDEN_CLAUDE_FLAGS,
  claudeCodeAdapter,
  preflight as preflightClaudeCode,
  run as runClaudeCode,
  createClaudeCodeExecution,
  buildPrompt as buildClaudePrompt,
  buildReviewPrompt as buildClaudeReviewPrompt,
  buildTestPrompt as buildClaudeTestPrompt,
  buildClaudeArgs,
  toolPostureFor,
  isResumingSession
} from "./adapters/claude-code.js";

export {
  createAdapterRouter,
  DEFAULT_ADAPTERS,
  ADAPTER_ROUTER_ERROR_CODES
} from "./adapters/adapter-router.js";

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

export {
  createOrchestrator,
  createOrchestrationExecution,
  mapOrchestrationOutcome,
  ORCHESTRATION_OUTCOMES,
  TRANSITION_PLAN
} from "./orchestration/orchestrator.js";

export {
  ROLES,
  ROLE_LIST,
  ROLE_DECISIONS,
  decisionFor,
  interpretExecutionResult,
  assertRoleResult,
  buildRoleEnvelope,
  defaultRunRole
} from "./orchestration/roles.js";

export {
  createRailEffects,
  assertCheckEvidence,
  digestEvidence,
  classifyTransition,
  isHumanOnlyRejection,
  ORCHESTRATION_CHECK_TYPES
} from "./orchestration/rail-effects.js";

export {
  prepareWorkspace,
  cleanupWorkspace,
  createWorkspaceExecution,
  workspacePathFor,
  assertInsideRoot,
  normalizeRepoSlug,
  resolveTargetRepo,
  assertWorkspaceCleanOfSecrets,
  WORKSPACE_ERROR_CODES
} from "./workspace/workspace-manager.js";
