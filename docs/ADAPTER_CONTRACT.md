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

The pure flag-detection helpers are bootstrapped in
`src/adapters/claude-preflight.js` (`REQUIRED_CLAUDE_FLAGS`, `flagPresent`,
`missingClaudeFlags`). The executable `preflight()` that shells out to the
real CLI is delivered with the AdapterRouter ticket.

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

## Tooling posture (reference default for claude-code)

- Non-interactive: `--print`, `--output-format json`, `--json-schema <ExecutionResult>`.
- `--permission-mode auto`.
- Tools limited to read/edit/search plus an allowlist of read-only `git` and
  common `test` / `lint` / `build` / `typecheck` invocations. No `git`
  mutation, no network, no `curl`.
- A fresh execution uses `--session-id <uuid>` + `--name`; a resume after a
  human-answered Agent Query uses `--resume <uuid>`.
