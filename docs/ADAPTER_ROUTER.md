# ADAPTER_ROUTER.md

The **AdapterRouter** and the executable **Claude Code adapter** — RAIL-D-00004.
Implemented in `src/adapters/adapter-router.js` and `src/adapters/claude-code.js`.
The contract every adapter satisfies is `docs/ADAPTER_CONTRACT.md`.

> **Language:** this document and the code comments are English by repo
> convention. Every human-facing line these modules emit at runtime (logs,
> `Error` messages, and the prompt handed to the runtime) is Spanish. The
> `ADAPTER_ROUTER_ERROR_CODES` and every protocol enum are never translated.

## Where it sits

```
Rail  ──governs──▶  Harness (Worker Core owns the Run + lease, Workspace
                     Manager owns the isolated worktree)
                        │  builds an ExecutionEnvelope (no claimToken, ticket
                        │  secret-stripped, languagePolicy injected)
                        ▼
                  AdapterRouter   ── selects a provider by explicit config
                        │             rejects unknown providers deterministically
                        ▼
                  Claude Code adapter  ── runs `claude` inside workspace.path,
                                          returns a validated ExecutionResult
```

The adapter **never governs Rail**: no Rail client, no transitions, no checks,
no queries, no `claimToken`. Mapping `ExecutionResult.outcome` onto Rail is the
Orchestration ticket's job.

## AdapterRouter — `createAdapterRouter({ provider?, adapters? })`

| Member | Purpose |
|---|---|
| `provider` (getter) | the explicitly-configured provider, or `null`. |
| `knownProviders()` | registered provider names. |
| `select(provider?)` | resolve the adapter module; throws on unknown / missing. |
| `preflight(opts?)` | delegate `preflight()` to the selected adapter. |
| `run(envelope, opts?)` | `assertNoSecrets(envelope)`, then delegate `run()`. |
| `createExecution(envelope, opts?)` | delegate to `adapter.createExecution` (a cancelable `{ done, cancel }`), else a thin `run()` wrapper. |

- **Explicit selection.** `provider` comes from the constructor; a per-call
  `opts.provider` overrides it. No implicit default beyond what the caller
  configures.
- **Deterministic rejection.** An unknown provider always throws the same
  `Error` with `code = ADAPTER_UNKNOWN_PROVIDER`; no provider configured at all
  throws `ADAPTER_NO_PROVIDER`; an adapter missing `preflight` / `run` throws
  `ADAPTER_BAD_INTERFACE` at construction.
- **Extensible without touching the Worker Core.** Add an entry to the
  `adapters` map (`{ ...DEFAULT_ADAPTERS, codex: codexAdapter }`); the router
  interface does not change.
- **No secret crosses it.** Every envelope passed to `run` / `createExecution`
  is re-checked with `assertNoSecrets`; a `claimToken` (or any secret-looking
  key) anywhere in the envelope is a hard error before the adapter is called.

`ADAPTER_ROUTER_ERROR_CODES`: `ADAPTER_NO_PROVIDER`, `ADAPTER_UNKNOWN_PROVIDER`,
`ADAPTER_BAD_INTERFACE`.

## Claude Code adapter — `src/adapters/claude-code.js`

Exports `claudeCodeAdapter = { provider: "claude-code", preflight, run,
createExecution }` plus the pure builders (`buildPrompt`, `buildClaudeArgs`,
`isResumingSession`), `assertClaudeJsonSchemaCompatible`, and the tool-list
constants.

### `preflight({ runCli? })`

Runs `claude --version` and `claude --help` (injectable), checks every flag in
`REQUIRED_CLAUDE_FLAGS` via `missingClaudeFlags`, then calls
`assertClaudeJsonSchemaCompatible(EXECUTION_RESULT_JSON_SCHEMA)`, and throws a
Spanish `Error` ending `No claim was created.` if the binary is missing, a flag
is absent, or the structured-output schema is one the CLI would reject.
`--permission-prompts` is **never** checked. Returns `{ version, flags }`.

`assertClaudeJsonSchemaCompatible` (pure, offline, no version detection) is the
guard against the RAIL-D-00004 Tester finding: CLI 2.1.266 bundles a **draft-07**
JSON-Schema validator and rejects an unknown `$schema` meta-ref (e.g. draft
2020-12) with `no schema with key or ref "..."`, failing the whole run. Rule:
`$schema` must be absent (preferred, reference-aligned) or pin draft-07, and the
schema stays a closed object. `EXECUTION_RESULT_JSON_SCHEMA` no longer declares
`$schema`.

Smoke (2026-09-09, CLI `2.1.266 (Claude Code)`):
- `claude --help` → all nine required flags present; `--permission-mode`
  choices include `auto` (`acceptEdits, auto, bypassPermissions, manual,
  dontAsk, plan`); `--permission-prompts` exists but is not used.
- Real `AdapterRouter.run(envelope)` against a throwaway git worktree,
  read-only task, no Rail / no secrets: exit `0`, returns `{ sessionId, result }`
  with `result.outcome = "IMPLEMENTED"`, Spanish `summary`, `tests: []`,
  `filesChanged: []`; `validateExecutionResult` passes; worktree `git status`
  clean and `HEAD` unchanged; no interactive prompt; ~11 s.
- Denied-tool probes: `WebFetch` (absent from `--tools`) and `Bash(curl …)`
  (deny-listed) are refused with no prompt and no hang; the run still returns a
  structured result. A command that is *neither* allow- nor deny-listed
  (`uname && id`) is **auto-approved** by `--permission-mode auto` — see the
  security note below.

### `run(envelope, opts?)` → `{ sessionId, result }`

1. `validateExecutionEnvelope` + `assertNoSecrets`.
2. `workspace.path` must exist on disk.
3. `git rev-parse --abbrev-ref HEAD` in the workspace must equal
   `run.branch` — otherwise reject **before** spawning anything.
4. Spawn `claude` with a structured argv (no shell), `cwd = workspace.path`,
   `env = safeEnvironment(process.env)` + `GIT_TERMINAL_PROMPT=0`,
   `stdio: ["ignore","pipe","pipe"]`.
5. Capture stdout/stderr in a bounded buffer.
6. `code !== 0` → reject (technical failure, never `IMPLEMENTED`).
7. `parseExecutionResult(stdout)` — rejects on empty / invalid JSON / bad
   wrapper / schema-invalid.
8. Resolve `{ sessionId: envelope.session.id, result }`.

`opts`: `spawn`, `bin`, `existsSync`, `runGit`, `killGraceMs`, `logger`,
`signal` (`AbortSignal` that cancels the run). All injectable — the test suite
never touches the real `claude` binary.

### Prompt & language

`buildPrompt(envelope)` renders `envelope.languagePolicy.instruction`
**verbatim as the first line**, then the IMPLEMENT / RECOVERY / resume body,
the hard rules (no `git` mutation, no branch switch, no network, no Rail, no
scope creep), the secret-stripped `ticket`, and the JSON-only output decision
(`IMPLEMENTED` / `BLOCKED` / `RELEASE` / `FAILED`; `BLOCKED` requires a
non-empty `question`). The full prompt and the ticket are never logged.

### Cancellation / fencing

`createClaudeCodeExecution(envelope, opts?)` returns `{ sessionId, done,
cancel }`. `cancel(reason)` sends `SIGTERM`; if the child has **not really
closed** by `killGraceMs` it escalates to `SIGKILL`; `done` then rejects — so
the Worker Core can kill the run on fencing / shutdown and leave no orphan
child. "Really closed" is tracked by an internal `closed` flag set from the
`close` / `error` events — **never** by `child.killed`, which Node flips the
instant a signal is *sent*, regardless of whether the process obeyed
(RAIL-D-00004 Tester finding: the old `!child.killed` guard made the SIGKILL
escalation dead code). `cancel()` is idempotent: only the first call signals or
schedules the escalation, so repeated calls send at most one `SIGTERM` and at
most one `SIGKILL`. Heartbeat is **not** implemented here (Worker Core owns it).

### Security posture — what this is and is not

`--permission-mode auto` + deny-list + no `--permission-prompts` gives, on CLI
2.1.266 (measured):

- **Enforced:** deny-listed tools (`curl` / `wget` / `nc` / `ssh` / `WebFetch` /
  `WebSearch`, mutating `git`) are hard-refused, no prompt, no hang. Nothing
  waits for interactive input in `--print` mode.
- **Not enforced:** `--allowedTools` is not a closed set under `auto` — the
  classifier auto-approves other non-deny-listed commands. `Read` / `Edit` /
  `Write` are auto-approved for **any path** (not confined to `workspace.path`).
  Agent-authored code run through an allow-listed test runner
  (`npm test` / `pytest`) executes with full filesystem + network access.
- This is deliberately **not** an OS sandbox — the guard rails are the
  sanitized env (`safeEnvironment`), the fixed `cwd`, the pre-spawn branch
  check, the deny-list and the prompt rules.

### Follow-ups for hardening (out of scope for RAIL-D-00004, before production)

Recorded from the Tester run; **not** to be built in this ticket:

1. Filesystem isolation — `Write` / `Edit` are not confined to `workspace.path`.
   Candidate: `--restricted` + `--add-dir <workspace>`, or an OS sandbox.
2. Network isolation — `npm test` / `pytest` can open sockets. Candidate:
   network namespace / no-egress sandbox at `SANDBOX` / `STAGING`.
3. `--permission-mode auto` auto-approves beyond the allow-list. Candidate: a
   stricter mode + explicit allow-list, or `--permission-prompts none` behind a
   contract change.
4. Operator MCP servers (Gmail / Drive / Calendar, from user/project settings)
   are inherited by the child. Candidate: `--strict-mcp-config` / `--bare` /
   `--setting-sources`.
5. No wall-clock execution timeout in the adapter — a wedged child relies on
   Worker Core fencing / SIGTERM. Candidate: an optional `timeoutMs` in `opts`.

## Tests

`test/adapter-router.test.mjs`, `test/claude-code-adapter.test.mjs` — offline,
zero real CLI, injected `spawn` / `runGit` / `runCli` / `existsSync`. Coverage:
provider selection, deterministic unknown-provider rejection, extensibility
with a fake `codex` adapter, preflight (version ok / flag missing /
`--permission-prompts` never required / binary missing), IMPLEMENT vs
RECOVERY/`--resume` argv, `cwd === workspace.path`, branch-mismatch rejection
before spawn, `safeEnvironment` (no `RAIL_*` / `CLAIM_TOKEN`), prompt carries
`languagePolicy.instruction`, valid JSON → valid `ExecutionResult`, invalid /
empty JSON and non-zero exit → reject (no false `IMPLEMENTED`), tool config
forbids mutating `git` / network, `sessionId` preserved, `claimToken` never in
logs / argv / env / prompt.

`assertClaudeJsonSchemaCompatible` — rejects a draft-2020-12 `$schema`, accepts
draft-07 / absent, and `EXECUTION_RESULT_JSON_SCHEMA` passes it (so
`buildClaudeArgs` never emits a payload the CLI throws on); `preflight` fails
before the claim on an incompatible schema.

`cancel()` — cooperative close ⇒ `SIGTERM` only, no `SIGKILL`; a child that
ignores `SIGTERM` ⇒ `SIGKILL` after `killGraceMs`, `done` rejects; repeated
`cancel()` ⇒ one `SIGTERM`, ≤ one `SIGKILL`, no throw; `cancel()` after the
child already closed ⇒ no new signal.
