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
| `src/worker/recovery*.js` — **Continuation**: governed `/resume` (general, any non-terminal cycle, state preserved) + `/recover` (compat) (RAIL-D-00006) | `docs/RECOVERY.md` |

## Documentation

- [`docs/HARNESS.md`](docs/HARNESS.md) — architecture overview and scope.
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the Rail ⇄ Harness wire protocol.
- [`docs/STATE_MACHINE.md`](docs/STATE_MACHINE.md) — `WorkCycle` / `Run` states, lease rule, recovery targets.
- [`docs/ADAPTER_CONTRACT.md`](docs/ADAPTER_CONTRACT.md) — the interface every coding adapter must satisfy.
- [`docs/WORKER_CORE.md`](docs/WORKER_CORE.md) — the persistent worker: discovery, claim, heartbeat, fencing, shutdown.
- [`docs/WORKSPACE_MANAGER.md`](docs/WORKSPACE_MANAGER.md) — isolated `git worktree` + ticket branch, repo validation, safe reuse/cleanup.
- [`docs/ADAPTER_ROUTER.md`](docs/ADAPTER_ROUTER.md) — provider-independent adapter routing and the Claude Code adapter.
- [`docs/ORCHESTRATION.md`](docs/ORCHESTRATION.md) — roles, Agent Queries, checks, transitions, humanOnly hand-off.
- [`docs/RECOVERY.md`](docs/RECOVERY.md) — governed continuation of ownership: `claim` ≠ `resume` ≠ `recover`, `/resume` (general, preserves cycle state, ownerless last Run in any non-`ACTIVE` state), `/recover` (compat), `lastRunId`, fail-closed rules, state-aware orchestration, ownership / heartbeat / fencing, runbook.

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

### Resume / recover modes

```bash
RAIL_RESUME_REF="RAIL-D-00006"  npm run worker   # GENERAL /resume, then exit
RAIL_RECOVER_REF="RAIL-D-00006" npm run worker   # classic /recover compat, then exit
```

`RAIL_RESUME_REF`, `RAIL_RECOVER_REF` and `RAIL_TICKET_REF` are **mutually
exclusive** and each uses a **distinct endpoint** with **no fallback between
them** (`docs/RECOVERY.md`).

- **`/resume`** (RAIL-D-00006 AC-11 / AC-12) — a stale `activeRun` in **any
  non-terminal state** (`REVIEWING` / `TESTING` / …) or an ownerless cycle
  whose last Run finished in **any** non-`ACTIVE` state
  (`COMPLETED` / `RELEASED` / `FAILED` / `ABANDONED`). The cycle state is
  **preserved exactly** and the orchestration continues from the real stage
  (no re-run / re-publish of an already-accepted check). Old Run untouched.
- **`/recover`** — compat for the classic orphaned `IN_PROGRESS`
  (`activeRun == null`, last Run `FAILED` / `ABANDONED`).

Both: read-only preflight → read-only worktree check → **one** governed POST
(`claim` is never a fallback) → heartbeat with the new `claimToken` + one
governed execution from the preserved state → `finishRun` for the new Run
exactly once. Optional `RAIL_RESUME_NOTES` / `RAIL_RECOVER_NOTES` → the
`reason`. Exit `0` (new Run `COMPLETED`), `2` (fail-closed no-op, nothing
mutated), `1` (otherwise).

## Developer Console

`src/console/` — an interactive terminal UI for developers, added by HC-01
(Paso 1), extended by HC-02 (Paso 2, read-only Rail) and HC-03 (Paso 3,
personal developer identity/credentials). Fully additive: it still lives
outside `src/worker/`, `src/orchestration/`, `src/workspace/` and
`src/adapters/`, and never runs `npm run worker`. Since HC-02 it **does**
talk to RailSoft, but **strictly read-only**: `src/console/rail-readonly.js`
is the only console file that imports `src/rail/rail-api-client.js`, and it
exposes exactly `listProjects()` / `listReady()` / `getTicket()` — none of
`RailApiClient`'s mutating methods (`claim`, `resume`, `recover`,
`transition`, `addComment`, `createQuery`, `createCheck`,
`createDeployment`, `updateDeployment`, `heartbeat`, `finishRun`) are
reachable from the console. **La consola consulta RailSoft en modo
read-only. No reclama tickets ni inicia el Worker.**

```bash
npm link              # exposes the `rail-harness` binary globally
rail-harness           # opens the interactive main menu
rail-harness login               # first use: store your personal Rail token
rail-harness auth status         # check whether you're authenticated, and how
rail-harness logout              # remove your local credential
rail-harness doctor
rail-harness setup
rail-harness projects            # read-only: list accessible projects, then exit
rail-harness ready <projectId>   # read-only: list that project's READY tickets, then exit
```

- `rail-harness` — boxed banner, auto-detected Linux user / hostname, a
  condensed environment check, and an auth-aware arrow-key menu:
  unauthenticated shows `Iniciar sesión` / `Configurar entorno` / `Doctor` /
  `Salir`; authenticated shows `Empezar a trabajar` / `Proyectos` /
  `Configurar entorno` / `Doctor` / `Cerrar sesión` / `Salir`.
  - **`Empezar a trabajar`** (HC-02): confirms RailSoft connectivity, lists
    the projects `listProjects()` returns for the current token (never
    invented, never filtered/reordered beyond a stable label sort), lets the
    developer pick one and browse its `state=READY` tickets
    (`listReady(projectId)`), and on picking a ticket re-reads it
    (`getTicket(ref)`) and re-validates it (right project, still `READY`, no
    `activeRun`, valid `targetRepository`) before showing a read-only detail
    screen (`Ticket` / `Título` / `Estado` / `Proyecto` /
    `targetRepository.repoFullName` / `branch` if present) ending with "El
    lanzamiento del Worker se habilitará en un próximo paso." — it **never**
    claims and **never** starts the Worker. Without a Rail token resolved
    (env or local store) it shows "RailSoft no está configurado para este
    usuario." and returns to the menu safely.
- `rail-harness login` (HC-03) — detects the Linux user/host automatically,
  prompts for the personal Rail token WITHOUT echoing it, and validates it
  against RailSoft with a single read-only `listProjects()` call **before**
  ever writing anything to disk. Only on acceptance does it persist the
  token to `~/.config/rail-harness/credentials.json` (mode `0600`, in a
  `0700` directory). A rejected (401/403) or unreachable RailSoft, an empty
  token, or an insecure `RAIL_API_URL` all leave no file behind.
- `rail-harness auth status` (HC-03) — reports Linux user/host, whether a
  local credential was found and its source (`environment` or `credencial
  local`), and whether RailSoft currently accepts it — **never** the token
  itself.
- `rail-harness logout` (HC-03) — idempotent: removes only
  `credentials.json`, never touches `config.json`, never contacts RailSoft
  (no server-side revocation yet — deferred scope).
- `rail-harness doctor` — runs the 6 local checks (Node version vs.
  `engines.node`, Git, Claude Code, `HOME`, `~/.config/rail-harness`
  accessible, writable) and exits non-zero if any of THOSE fails, unchanged
  from HC-01. Since HC-02 it additionally prints `✓/✗ Credencial Rail`
  (HC-03: whether a token was resolved locally, env or store, never its
  value), `✓/✗ RailSoft` and `✓/✗ Identidad Rail autorizada` (a single
  read-only `listProjects()` call) — these never affect the local exit code,
  and RailSoft being unreachable/unconfigured is reported with a clear
  message, never a stack trace, and never a secret.
- `rail-harness setup` — creates/verifies `~/.config/rail-harness/config.json`
  (`{ "version": 1 }`, never a token/secret) and prints the environment
  status.
- `rail-harness projects` / `rail-harness ready <projectId>` — read-only
  one-shot listings for scripting; same credential rules as the interactive
  flow, including the HC-03 local store fallback.

Rail credential resolution (`src/console/credential-resolve.js`): `env.RAIL_TOKEN`
always wins when present (HC-02 backward compatibility — never persisted
automatically just because it was read), otherwise the personal token saved
by `rail-harness login` (`src/console/credential-store.js`). `RAIL_API_URL`
itself is still **only** read from the environment — it is not a secret and
is shared by every developer on the machine (set once by whoever configures
the Harness); only the token is personal, one `RailAgent` per developer,
created ahead of time by the administrator (`rail-harness-fran`,
`rail-harness-uri`, …) — HC-03 never creates or rotates a `RailAgent`, it
only manages where the developer's own token for one lives locally. **Never
share this token between users.** See
`test/console-no-worker-invocation.test.mjs` for the static + dynamic guard
that no console/bin file can ever produce a Rail mutation (no `POST`/`PATCH`/
`PUT`/`DELETE`, only `GET`).

Zero new npm dependencies (raw-mode `readline` keypress navigation for both
menu selection and hidden token input, with a line-based fallback when there
is no TTY).

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
