# Rail Harness

Bootstrap of the Rail Harness — the process that turns a Rail work item into a
governed execution against a code repository.

> **Rail is the authority of the work.** The Harness claims work, runs a
> coding adapter in an isolated workspace, and reports outcomes back through
> the documented protocol. It never decides what is "done", never invents
> scope, and never mutates work state on its own judgement.

## Status: bootstrap ticket

This repository currently contains only the **base** the follow-up tickets
build on. It does **not** run an autonomous worker yet.

| Delivered here | Later ticket |
|---|---|
| Base structure, docs, contracts | — |
| `src/config/` — runtime configuration | consumed by Worker Core |
| `src/rail/` — `RailApiClient` | consumed by Worker Core / Orchestration |
| `src/contracts/` — `ExecutionEnvelope` / `ExecutionResult` | consumed by AdapterRouter |
| `src/security/` — secret sanitization | used everywhere |
| `src/adapters/claude-preflight.js` — pure flag checks | AdapterRouter completes it |
| — | **Worker Core**, **Workspace Manager**, **AdapterRouter**, **Orchestration** |

## Documentation

- [`docs/HARNESS.md`](docs/HARNESS.md) — architecture overview and scope.
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the Rail ⇄ Harness wire protocol.
- [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md) — `WorkCycle` / `Run` states, lease rule, recovery targets.
- [`docs/ADAPTER_CONTRACT.md`](docs/ADAPTER_CONTRACT.md) — the interface every coding adapter must satisfy.

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
  stripSecretKeys, redactSecrets, safeEnvironment
} from "rail-harness"; // ./src/index.js
```

## Provenance

The reference implementation approved for this bootstrap is
`~/rail-runner/harness` (`rail-harness-test-kit` v0.1). Where a later ticket
carries a Rail-issued SPEC, that SPEC supersedes the derived docs here.
