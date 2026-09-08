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
| **Adapter preflight** (`src/adapters/claude-preflight.js`) | partial | Pure CLI-flag detection helpers. Executable preflight + runner come later. |
| **Worker Core** | later ticket | Owns one Run: claim → heartbeat → drive adapter → finish. |
| **Workspace Manager** | later ticket | Create/reuse the isolated git worktree + branch; fill `ExecutionEnvelope.workspace.path`. |
| **AdapterRouter** | later ticket | Route an `ExecutionEnvelope` to the right adapter (claude-code, codex, …); return an `ExecutionResult`. |
| **Orchestration** | later ticket | Drive the `WorkCycle` state machine end to end (`docs/STATE_MACHINE.md`), including recovery. |

## What this bootstrap deliberately does NOT do

- No autonomous worker loop (no `claim` → `finish` control flow).
- No git worktree creation / branch management.
- No adapter process spawning.
- No AdapterRouter, no Orchestration.

Those are the next tickets. This bootstrap gives them a stable, tested surface
to build on: `src/index.js` is the single import point.

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
