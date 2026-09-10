# Rail Harness

Bootstrap of the Rail Harness — the process that turns a Rail work item into a
governed execution against a code repository.

> **Rail is the authority of the work.** The Harness claims work, runs a
> coding adapter in an isolated workspace, and reports outcomes back through
> the documented protocol. It never decides what is "done", never invents
> scope, and never mutates work state on its own judgement.

## Status

The **base**, the **Worker Core**, the **Workspace Manager**, the
**AdapterRouter**, and — as of RAIL-D-00005 — the **Orchestration** layer.
`npm run worker` now runs the real flow end to end: discover `READY` → claim →
isolated workspace → `IMPLEMENTER → REVIEWER → TESTER` with governed
checks / transitions → `SANDBOX_READY`.

| Delivered | Notes |
|---|---|
| `src/config/` — runtime configuration | — |
| `src/rail/` — `RailApiClient` | Harness / Core / Orchestration tier only |
| `src/contracts/` — `ExecutionEnvelope` (+ `role` / `roleBrief`) / `ExecutionResult` | — |
| `src/security/` — secret sanitization | used everywhere |
| `src/adapters/` — **AdapterRouter** + Claude Code adapter (role-aware tool posture) | `docs/ADAPTER_ROUTER.md` |
| `src/worker/` — **Worker Core**: discovery, preflight, atomic claim, heartbeat, fencing, shutdown | `docs/WORKER_CORE.md` |
| `src/workspace/` — **Workspace Manager**: isolated `git worktree` + ticket branch, repo validation | `docs/WORKSPACE_MANAGER.md` |
| `src/orchestration/` — **Orchestration**: roles, Agent Queries, checks, transitions, humanOnly hand-off | `docs/ORCHESTRATION.md` |
| — | Full resume / recovery of an orphaned `IN_PROGRESS` cycle — later ticket |

## Documentation

- [`docs/HARNESS.md`](docs/HARNESS.md) — architecture overview and scope.
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the Rail ⇄ Harness wire protocol.
- [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md) — `WorkCycle` / `Run` states, lease rule, recovery targets.
- [`docs/ADAPTER_CONTRACT.md`](docs/ADAPTER_CONTRACT.md) — the interface every coding adapter must satisfy.
- [`docs/WORKER_CORE.md`](docs/WORKER_CORE.md) — the persistent worker: discovery, claim, heartbeat, fencing, shutdown.
- [`docs/WORKSPACE_MANAGER.md`](docs/WORKSPACE_MANAGER.md) — isolated `git worktree` + ticket branch, repo validation, safe reuse/cleanup.
- [`docs/ADAPTER_ROUTER.md`](docs/ADAPTER_ROUTER.md) — provider-independent adapter routing and the Claude Code adapter.
- [`docs/ORCHESTRATION.md`](docs/ORCHESTRATION.md) — roles, Agent Queries, checks, transitions, humanOnly hand-off.

## Running the Worker Core

```bash
npm run worker   # node src/worker/cli.js
```

Reads `.env` (see Configuration). Polls the `READY` queue for the configured
project, claims one ticket at a time, prepares an isolated workspace, and runs
the Orchestration flow (`IMPLEMENTER → REVIEWER → TESTER`, governed checks and
transitions — `docs/ORCHESTRATION.md`), holding the Run with a heartbeat and
tearing down cleanly on `SIGINT` / `SIGTERM`. Optional overrides:
`RAIL_HEARTBEAT_INTERVAL_MS` (default `300000`), `RAIL_DISCOVERY_POLL_MS`
(default `30000`), `RAIL_ADAPTER_PROVIDER` (default `claude-code`). Requires
`RAIL_WORKSPACE_ROOT`. The token and any per-Run `claimToken` are never printed.

## Configuration

Copy `.env.example` to `.env` and fill it in. Required: `RAIL_API_URL`,
`RAIL_TOKEN`, `RAIL_PROJECT_ID`, `RAIL_REPO_PATH`. `RAIL_TICKET_REF` and
`RAIL_RECOVER_REF` are mutually exclusive. The token is never logged — use
`describeConfig()` for human-facing output.

## Tests / validation

Reproducible, zero-dependency, offline. Node 18+.

```bash
npm test        # node --test test/*.test.mjs
npm run validate
```

## Public surface

Everything the next tickets should import comes from a single entry point:

```js
import {
  loadRuntimeConfig, describeConfig,
  RailApiClient, normalizeRunHandoff,
  buildExecutionEnvelope, parseExecutionResult, EXECUTION_OUTCOMES,
  stripSecretKeys, redactSecrets, safeEnvironment,
  createWorkerCore, WORKER_PHASES,
  assertTicketClaimable, isTicketClaimable, pickDiscoveryRef,
  createPlaceholderExecution,
  prepareWorkspace, createWorkspaceExecution,
  createAdapterRouter,
  createOrchestrator, createOrchestrationExecution,
  ROLES, interpretExecutionResult, createRailEffects
} from "rail-harness"; // ./src/index.js
```

## Provenance

The reference implementation approved for this bootstrap is
`~/rail-runner/harness` (`rail-harness-test-kit` v0.1). Where a later ticket
carries a Rail-issued SPEC, that SPEC supersedes the derived docs here.
