# ADAPTER_CONTRACT.md

The contract every coding adapter (claude-code, codex, …) must satisfy so the
future **AdapterRouter** can drive them interchangeably. Derived from the
approved reference (`~/rail-runner/harness/adapters/claude-code.mjs`).

## Roles

- **Rail** governs the workflow.
- **The Harness** owns the Run, the workspace, and all Rail I/O.
- **An adapter** only transforms code inside a given worktree and returns a
  structured result. An adapter **must not** call Rail, use `curl`, commit,
  push, merge, switch branch, or widen scope.

## Interface

An adapter module exports:

```
preflight(): { version: string, flags: string[] }        // throws if the tool is unusable
run(envelope: ExecutionEnvelope): Promise<{ sessionId: string, result: ExecutionResult }>
```

### `preflight()`

Verify the underlying CLI/tool is installed and supports the flags the
adapter needs, **before** any Run is claimed. On failure, throw an `Error`
that names what is missing and ends with `No claim was created.`

The pure flag-detection helpers are in `src/adapters/claude-preflight.js`
(`REQUIRED_CLAUDE_FLAGS`, `flagPresent`, `missingClaudeFlags`). The executable
`preflight({ runCli? })` that shells out to `claude --version` / `--help` is
in `src/adapters/claude-code.js` (RAIL-D-00004): it throws a Spanish `Error`
ending `No claim was created.` when the binary is missing or a required flag
is absent, and never inspects `--permission-prompts`.

**`--permission-prompts` is intentionally excluded.** Adapter permission
posture is expressed with `--permission-mode` only.

### `run(envelope)`

Input: a validated **`ExecutionEnvelope`** (`src/contracts/execution-envelope.js`):

```jsonc
{
  "schemaVersion": "0.1",
  "kind": "IMPLEMENT" | "RECOVERY",
  "run":       { "id": "…", "branch": "rail/<ticket-code>" },
  "ticket":    { /* Rail ticket detail, secret-keys stripped */ },
  "workspace": { "path": "/abs/path/to/isolated/worktree" },
  "session":   { "id": "<uuid>" },
  "continuation": null | {
    "priorImplementationNote": "…" | null,
    "failedReviewNote": "…" | null,
    "pendingFeedback": [ "…" ],
    "changedFiles": [ "…" ],
    "feedbackSource": "…" | null
  },
  "resumeAnswer": null | "human answer that unblocks a prior BLOCKED run",
  "languagePolicy": {
    "version": "0.1",
    "humanLanguage": "es",
    "instruction": "IDIOMA: toda comunicación humana debe ser en español. …",
    "doNotTranslate": [ "READY", "CLAIMED", "IN_PROGRESS", "BLOCKED",
                        "SUCCESS", "FAILED", "CODE_REVIEW",
                        "AUTOMATED_TESTS", "ACCEPTANCE_CRITERIA" ]
  }
}
```

Rules the envelope guarantees:
- It carries **no** Rail credentials, token, `claimToken`, or API URL
  (`assertNoSecrets` runs at build time).
- `kind: "RECOVERY"` ⇒ `continuation` is present; `kind: "IMPLEMENT"` ⇒ it is
  `null`.
- `run.branch` is mandatory; the adapter must confirm the worktree is on it
  and must never change branch.
- `languagePolicy` is always present (`src/i18n/language-policy.js`).

### Language — the adapter MUST

- Render `envelope.languagePolicy.instruction` verbatim into the runtime
  prompt, before the task body.
- Produce every human-facing part of the `ExecutionResult` — `summary`,
  `question`, `context`, `impact`, and any explanation — **in Spanish**.
- Leave every machine-readable value untranslated: `outcome`
  (`IMPLEMENTED` / `BLOCKED` / `RELEASE` / `FAILED`), any `WorkCycle` / `Run`
  state, check type, or Rail protocol field name — and everything in
  `languagePolicy.doNotTranslate`.

Output: `{ sessionId, result }` where `result` is a valid **`ExecutionResult`**.

## ExecutionResult

`src/contracts/execution-result.js`. Structured output the adapter must
return (JSON, `additionalProperties: false`, every field required):

```jsonc
{
  "outcome": "IMPLEMENTED" | "BLOCKED" | "RELEASE" | "FAILED",
  "summary": "what was done / why it stopped",
  "question": string | null,   // required non-empty when outcome === "BLOCKED"
  "context":  string | null,
  "impact":   string | null,
  "tests":        [ "command : result", … ],
  "filesChanged": [ "path", … ]
}
```

| `outcome` | When |
|---|---|
| `IMPLEMENTED` | Change is done and reasonably verified. |
| `BLOCKED` | A concrete human answer is required. Fill `question` / `context` / `impact`. |
| `RELEASE` | Ticket / SPEC / project / repo do not correspond, or continuing would be conceptually wrong. Do not implement. |
| `FAILED` | Technical problem preventing completion — not a business decision. |

`parseExecutionResult(stdout)` accepts either a bare result object or a
wrapper exposing `structured_output` / `structuredOutput` / `result`, then
validates it.

`summary`, `question`, `context` and `impact` are human-facing → **Spanish**.
`outcome` is a fixed enum → never translated.

## Execution environment

The AdapterRouter runs the adapter with `safeEnvironment()`
(`src/security/sanitize.js`): every `RAIL_*` variable plus `CLAIM_TOKEN` /
`RAIL_HUMAN_TOKEN` removed. Adapters never see the control plane.

## Tooling posture (claude-code, `src/adapters/claude-code.js`)

- Non-interactive: `--print`, `--output-format json`,
  `--json-schema <EXECUTION_RESULT_JSON_SCHEMA>`. The schema is serialized
  verbatim; it carries **no `$schema` meta-ref** because the installed CLI
  (verified 2.1.266) bundles a draft-07 validator and rejects an unknown one,
  failing the whole run (`assertClaudeJsonSchemaCompatible` guards this).
- `--permission-mode auto`, and **`--permission-prompts` is never passed** — in
  `--print` mode with no SDK host, anything that *would* prompt is denied
  automatically instead of hanging.
- **What the permission layer actually enforces** (measured against CLI 2.1.266,
  RAIL-D-00004 Tester):
  - `--disallowedTools` is a hard block — `curl` / `wget` / `nc` / `ssh` /
    `WebFetch` / `WebSearch` and the mutating `git` verbs are refused, no prompt.
  - `--tools` limits the built-in set, so `WebFetch` / `WebSearch` are not even
    available.
  - `--allowedTools` is **not** a closed allow-list under `--permission-mode
    auto`: the `auto` classifier may auto-approve other commands that are
    neither allow- nor deny-listed (e.g. `uname`, `id`, a `pytest` invocation,
    even `pip install`). `Read` / `Edit` / `Write` are auto-approved for **any
    path**, not confined to `workspace.path`.
  - Therefore this posture is **not** an OS sandbox. Code the agent writes and
    then runs via an allow-listed test runner (`npm test`, `pytest`) executes
    with full filesystem and network access. Strong filesystem / network
    isolation is deferred to the `SANDBOX` / `STAGING` manual gates (candidate
    hardening: `--restricted`, `--add-dir`, `--strict-mcp-config`, an OS-level
    sandbox). See the follow-up list in `docs/ADAPTER_ROUTER.md`.
- `--allowedTools` (`CLAUDE_ALLOWED_TOOLS`): read/edit/search + read-only `git`
  + common `test` / `lint` / `build` / `typecheck` runners.
- `--disallowedTools` (`CLAUDE_DISALLOWED_TOOLS`): every mutating `git` verb
  (`commit` / `push` / `merge` / `rebase` / `reset` / `checkout` / `switch` /
  `clean` / `stash`), `curl` / `wget` / `nc` / `ssh`, `WebFetch`, `WebSearch`.
- Session: a fresh IMPLEMENT uses `--session-id <uuid>` + `--name rail-<8>`;
  a RECOVERY continuation or a resume after a human-answered Agent Query
  (`envelope.resumeAnswer != null`) uses `--resume <uuid>` — it never mints a
  new conversation for an existing session.
- `cwd` is `envelope.workspace.path`; the child env is `safeEnvironment()`
  plus `GIT_TERMINAL_PROMPT=0`; the branch is verified `=== envelope.run.branch`
  before the CLI is spawned.
- Exit `code !== 0`, empty output, invalid JSON, an unexpected wrapper, or a
  schema-invalid object all REJECT with a technical error — never a fabricated
  `IMPLEMENTED`.
