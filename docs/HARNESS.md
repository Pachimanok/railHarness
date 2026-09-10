# HARNESS.md

Rail Harness — architecture overview. **Bootstrap scope (this ticket).**

## What the Harness is

The Rail Harness is the process that turns a Rail work item into a governed
execution against a code repository. It claims a unit of work from Rail, runs
an AI coding adapter inside an isolated workspace, and reports the outcome
back to Rail through the documented protocol.

**Rail is the authority of the work.** The Harness never decides what is
"done", never invents scope, and never mutates work state on its own
judgement. Every state change is a governed Rail operation; Rail re-checks
every precondition server-side and remains authoritative for states and
gates. If Rail does not expose an operation the Harness needs, the Harness
identifies the limitation and aborts **without improvising a direct
mutation**.

## Política global de idioma

**Toda comunicación humana del Rail Harness es en español.** Lo
machine-readable no se traduce nunca.

Fuente de verdad en código: `src/i18n/language-policy.js`
(`LANGUAGE_INSTRUCTION`, `PROTOCOL_TERMS`, `buildLanguagePolicy()`).

### En español

- Todo prompt / `ExecutionEnvelope` que se envía a un runtime lleva la
  instrucción de responder en español (`envelope.languagePolicy`). El adapter
  la renderiza en el prompt (`docs/ADAPTER_CONTRACT.md`).
- Lo que produce un adapter para humanos: `question`, `context`, `impact`,
  `summary` y cualquier explicación.
- Los logs human-facing del Worker Core y de la Orchestration, y
  `describeConfig()`.
- El contenido de las Agent Queries y los `reason` / `note` que el Harness
  redacta.

### Sin traducir (machine-readable)

Enums, estados del `WorkCycle` y del `Run`, `outcome`s, tipos de check y
nombres de campos del protocolo Rail se dejan **exactamente** como están —
p. ej.: `READY`, `CLAIMED`, `IN_PROGRESS`, `BLOCKED`, `SUCCESS`, `FAILED`,
`CODE_REVIEW`, `AUTOMATED_TESTS`, `ACCEPTANCE_CRITERIA`. Tampoco se traducen
identificadores de código/configuración ni las claves JSON de los contratos.

> Los documentos de `docs/` y los comentarios de código se mantienen en
> inglés por convención de repositorio; esta política aplica a la
> comunicación operativa (prompts, logs, salidas del runtime, mensajes a
> personas), no a la documentación técnica.

## Components

| Component | Status | Responsibility |
|---|---|---|
| **Runtime config** (`src/config/runtime-config.js`) | bootstrapped | Read + validate the environment once; produce a frozen, secret-free config. `describeConfig()` output is Spanish. |
| **Language policy** (`src/i18n/language-policy.js`) | bootstrapped | Single source of the Spanish-communication instruction; injected into every `ExecutionEnvelope`. |
| **RailApiClient** (`src/rail/rail-api-client.js`) | bootstrapped | Speak the Rail protocol (`docs/PROTOCOL.md`). Read-only vs governed-mutating calls. Normalizes the Run handoff. |
| **Contracts** (`src/contracts/`) | bootstrapped | `ExecutionEnvelope` (input to an adapter) and `ExecutionResult` (output from an adapter). |
| **Secret sanitization** (`src/security/sanitize.js`) | bootstrapped | Strip secret keys from tickets, redact log strings, build a safe child environment. |
| **Adapter preflight** (`src/adapters/claude-preflight.js`) | bootstrapped | Pure CLI-flag detection helpers. Consumed by the executable preflight in `src/adapters/claude-code.js`. |
| **Claude Code adapter** (`src/adapters/claude-code.js`) | bootstrapped | Executable `preflight()` (real `claude --version` / `--help` + `REQUIRED_CLAUDE_FLAGS` check, never `--permission-prompts`) and `run(envelope)` — spawns the CLI non-interactively inside `workspace.path`, on `run.branch`, with `safeEnvironment()`, structured JSON output (`--json-schema` from `ExecutionResult`), parses with `parseExecutionResult()`, returns `{ sessionId, result }`. Cancelable child (SIGTERM→SIGKILL). See `docs/ADAPTER_ROUTER.md`. |
| **Worker Core** (`src/worker/`, `npm run worker`) | bootstrapped | Persistent process. Owns one Run at a time: validate Rail → discover `READY` → preflight → atomic claim → heartbeat supervisor + one supervised execution → fencing / controlled shutdown. Drives an injected execution collaborator (placeholder for now). Keeps `claimToken` inside the Core. Human logs Spanish. See `docs/WORKER_CORE.md`. |
| **Workspace Manager** (`src/workspace/workspace-manager.js`) | bootstrapped | Create/reuse an isolated `git worktree` + ticket branch under `RAIL_WORKSPACE_ROOT`, validating the ticket's `targetRepository` against the primary clone's `origin`. Runs only after a valid claim; never sees a `claimToken`; never writes a credential into the tree. Returns the workspace path. Injectable as the Worker Core's `createExecution`. See `docs/WORKSPACE_MANAGER.md`. |
| **AdapterRouter** (`src/adapters/adapter-router.js`) | bootstrapped | Provider-agnostic seam: select an adapter by explicit config, reject unknown providers deterministically, forward a secret-checked `ExecutionEnvelope` to `adapter.preflight` / `run` / `createExecution`. No Rail logic, no `claimToken`. claude-code is the only provider wired in this ticket; codex/others slot into the `adapters` map without touching the Worker Core. See `docs/ADAPTER_ROUTER.md`. |
| **Orchestration** (`src/orchestration/`) | bootstrapped (RAIL-D-00005) | Runs `IMPLEMENTER → REVIEWER → TESTER` as separate governed adapter executions on the Run the Worker Core owns; publishes `IMPLEMENTATION` / `CODE_REVIEW` / `AUTOMATED_TESTS` / `ACCEPTANCE_CRITERIA` **with evidence, before** each gated transition; turns a subagent `BLOCKED` into a blocking Agent Query and **waits** for a governed human resolution (`execute()` stays pending — the Core keeps heartbeating, the Run is not finished; no invented answer); routes a REVIEWER / TESTER `REWORK` through a governed rewind to `IN_PROGRESS`; hands off a `humanOnly` frontier without fabricating an approval; respects every Rail rejection. The happy path finishes the Run `COMPLETED`. Wired into `npm run worker` as the Core's `createExecution`. Never claims / recovers / heartbeats / finishes the Run. See `docs/ORCHESTRATION.md`. |
| Full resume / recovery of an orphaned `IN_PROGRESS` cycle | later ticket | — |

## What this bootstrap deliberately does NOT do

- No full resume / recovery of an orphaned `IN_PROGRESS` cycle (later ticket).
- No deploy / `SANDBOX` / `STAGING` / `PRODUCTION` handling — the Orchestration
  flow ends at `SANDBOX_READY`; the manual gates past it are a hand-off, never
  a fabricated approval.
- The `BACKLOG → READY` dependency re-evaluation gap is **not** solved here —
  the Worker Core only discovers `READY`.

As of RAIL-D-00005 `npm run worker` runs the real flow:
`validate → discover → preflight → claim → heartbeat → **Orchestration
(Implementer → Reviewer → Tester, governed checks + transitions)** →
fence/shutdown`. `src/index.js` is the single import point.

## Authority sources

The reference implementation approved for this bootstrap is
`~/rail-runner/harness` (`rail-harness-test-kit` v0.1). The normative
documents in `docs/` are derived from that code's observed behaviour. When a
later ticket carries a Rail-issued SPEC, that SPEC supersedes anything here.

## Security invariants (all enforced in code)

1. The Rail agent token, any per-Run `claimToken`, and any human token are
   **never** logged and **never** placed in an `ExecutionEnvelope`.
2. Adapters receive an environment with every `RAIL_*` variable removed
   (`safeEnvironment`).
3. Ticket detail is passed through `stripSecretKeys` before it reaches an
   adapter or disk.
4. Human-facing diagnostics go through `redactSecrets` / `describeConfig`.
5. The Harness does not use the `--permission-prompts` CLI flag; adapter
   permission posture is expressed via `--permission-mode` only.
