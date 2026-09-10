# ORCHESTRATION.md

The **Orchestration** layer — RAIL-D-00005. Implemented in
`src/orchestration/` (`orchestrator.js`, `roles.js`, `rail-effects.js`).

> **Language:** this document and the code comments are English by repo
> convention. Every human-facing line these modules emit at runtime (logs,
> `Error` messages, Agent Query / check / transition text) is Spanish
> (docs/HARNESS.md). Every protocol enum — `WorkCycle` / `Run` state, check
> type, `outcome` — is never translated.

## Where it sits

```
RailSoft            ← authority: re-validates every state / gate server-side
  │
Worker Core         ← owns the Run + lease + heartbeat + fencing + shutdown
  │  createExecution({ ref, ticket, branch, run:{id} })   (NO claimToken)
  ▼
Orchestration       ← THIS layer: runs the roles, turns their results into
  │                    GOVERNED requests to Rail (checks / transitions / queries)
  ├─▶ Workspace Manager   ← isolated git worktree + ticket branch
  └─▶ AdapterRouter       ← provider-independent role execution
        └─▶ Implementer / Reviewer / Tester
```

The orchestrator works on the Run the Worker Core **already owns**. It never
claims, never recovers, never heartbeats, never finishes the Run, and never
creates a real Agent Query in Rail on its own initiative — only in response to
a subagent's `BLOCKED`.

`RailApiClient` lives in the Harness / Core / Orchestration tier. The
AdapterRouter and every subagent stay **provider-independent and
Rail-blind**: they receive an `ExecutionEnvelope` with no token, no
`claimToken`, no API URL (`assertNoSecrets` runs before any adapter sees it).

## The flow

| Step | Role (via AdapterRouter) | On PASS → governed Rail effect |
|---|---|---|
| 0 | — | `transition CLAIMED → IN_PROGRESS` (the Core just claimed) |
| 1 | **IMPLEMENTER** (write access) | `createCheck IMPLEMENTATION/PASS` → `transition IN_PROGRESS → REVIEWING` |
| 2 | **REVIEWER** (read-only on the repo) | `createCheck CODE_REVIEW/PASS` → `transition REVIEWING → TESTING` |
| 3 | **TESTER** (read-only + test runners) | `createCheck AUTOMATED_TESTS/PASS` + `createCheck ACCEPTANCE_CRITERIA/PASS` → `transition TESTING → SANDBOX_READY` |

Every gating check is created **with evidence** and **before** the transition
it gates (**T5-AC-01**). Evidence is folded into the check `note` (the checks
endpoint only carries free-text `note` + `detailsUrl`):

- `IMPLEMENTATION` — a non-empty summary of what was implemented.
- `CODE_REVIEW` — the Reviewer's `PASS` decision + assessment summary.
- `AUTOMATED_TESTS` — a non-empty list of `"command : result"` the Tester ran.
- `ACCEPTANCE_CRITERIA` — every `{ id, status }` from the ticket's
  `planning.acceptance_criteria`, each `status === "PASS"`.

`assertCheckEvidence` refuses to create a check the evidence does not back —
a Tester that returns `IMPLEMENTED` **without any test command** does not get
an `AUTOMATED_TESTS` PASS and the flow does not advance.

## Roles are separate — semantically and in execution

- Each role is its **own adapter execution** with its **own fresh session id**
  (except a governed resume / rework — see below). Reviewer ≠ Tester.
- The `ExecutionEnvelope` carries an additive `role`
  (`IMPLEMENTER` | `REVIEWER` | `TESTER`, default `IMPLEMENTER`) and an
  optional `roleBrief` (implementation summary, changed files, Acceptance
  Criteria — secret-stripped).
- The claude-code adapter maps the role onto tool posture: `REVIEWER` /
  `TESTER` run with **no `Edit` / `Write`** (`CLAUDE_REVIEW_TOOLS`), a
  read-only `git` allow-list, and the base deny-list plus `Edit` / `Write`.
  The Tester additionally gets the test / lint / build runners.
- A role returns the approved `ExecutionResult`. The orchestrator normalizes
  it into a `RoleResult` with a fixed `decision`:

  | `ExecutionResult.outcome` | IMPLEMENTER | REVIEWER / TESTER |
  |---|---|---|
  | `IMPLEMENTED` | `PASS` | `PASS` (approves) |
  | `RELEASE` | `RELEASE` | `REWORK` (send back) |
  | `BLOCKED` | `BLOCKED` | `BLOCKED` |
  | `FAILED` | `FAILED` | `FAILED` |

## Agent Queries — a subagent BLOCKED (T5-AC-02)

> **Authority: RailSoft.** The contract below was verified against the current
> `Pachimanok/railSoft` code. `~/rail-runner/harness` may be a historical
> reference, but it is **not** the contract.

RailSoft's `RailQueryStatus` enum is exactly:

```
PENDING | RESOLVED | DISMISSED
```

There is **no `ANSWERED`** and **no `CLOSED`**. `createQuery()` creates a
`PENDING` query and — when `blocking: true` — blocks the WorkCycle; it **always**
returns `{ queryId, blocking, cycleState }`. `answerQuery()` accepts a human
actor only: unless `dismiss === true`, a non-empty `answer.trim()` is
**mandatory** (empty ⇒ `invalid_input`) and the final status is `RESOLVED`; with
`dismiss === true` the final status is `DISMISSED`, meaning explicitly *"discard
without answering"*. When no blocking `PENDING` query remains, RailSoft's
`recomputeBlocked()` restores the WorkCycle to `stateBeforeBlock` — but a
`DISMISSED` clearing `BLOCKED` is **not** a human answer for the agent.

When a role returns `BLOCKED`:

1. **Budget first.** Before creating a *new* Agent Query the orchestrator checks
   the `maxQueryResumes` budget (default 1). If it is already spent, **no query
   is created** (an unwaitable query would be an orphan) — the advance stops
   `BLOCKED` (→ Run `FAILED`).
2. The orchestrator raises a **blocking** Agent Query with the role's own
   `question` / `context` / `impact` (`createQuery({ blocking: true, runId })`).
   It never invents these. If Rail returns **no `queryId`**, that violates the
   contract → outcome `FAILED`, fail-closed (never a fallback to "some blocking
   query").
3. The advance **stops** and the orchestrator **waits** on **that exact
   `queryId`**. By default it polls `api.listQueries(ref)` on a configurable
   interval (`queryPollMs`, default 15 s — no busy-loop), matching **only**
   `query.id === queryId`. An old query, a query from another Run, a query for
   another block, or one resolved earlier **never** unblocks this wait. A
   transient read error is retried, never turned into an answer. An injected
   `resolveQuery(query)` collaborator can replace the poller.
4. The waiter resolves per RailSoft status:
   - **`PENDING`** — keep waiting. **While the query is open the `execute()`
     Promise stays `pending`** — it never settles, so the Worker Core keeps
     heartbeating and the Run stays `ACTIVE`. `finishRun` is **not** called.
   - **`RESOLVED`** — resume **only** if there is a real, non-empty human
     `answer`. `RESOLVED` **without** answer text contradicts `answerQuery` and
     is treated as a **contract error → `FAILED`** (no `resumeAnswer`, no
     subagent resume, no synthetic text).
   - **`DISMISSED`** — the question was discarded without an answer. The agent
     **cannot** continue from it: **no** adapter resume, **no** `resumeAnswer`,
     **no** new query, **no** invented human instruction. A factual governed
     note is left; the orchestration ends **`FAILED`** and the Worker Core then
     `finishRun(FAILED)`. RailSoft already recomputed `BLOCKED` / restored
     `stateBeforeBlock` — the Harness fabricates **no** Rail transition, it only
     respects the result. `DISMISSED` is **never** mapped to `HANDOFF` /
     `COMPLETED` / `RELEASED`.
   - **Any other status** (`ANSWERED`, `CLOSED`, unknown) — contract violation:
     fail closed → `FAILED`. Never wait forever, never resume.
5. On a real `RESOLVED` answer the **same** role is re-run with `resumeAnswer`
   set and the **same `session.id`** — the adapter resumes the existing
   conversation (`--resume`) with the **same role framing** (`buildResumePrompt`
   is role-aware: a resumed REVIEWER / TESTER keeps its read-only review / test
   framing, not generic IMPLEMENTER text). It does not start a new task. Budget:
   `maxQueryResumes`; if the role stays `BLOCKED` after it, the orchestration
   ends `BLOCKED` (→ Run `FAILED`), never a silent `RELEASED`.
6. If Rail rejects the *creation* of the query, the rejection is respected: the
   advance stops, outcome `FAILED`, nothing forced.
7. A cancel / fencing during the wait aborts it promptly → outcome `CANCELLED`.

## Reviewer / Tester rework — governed rewind (Defect 1)

`REWORK` never re-runs the IMPLEMENTER while Rail still sits in `REVIEWING` /
`TESTING`. The orchestrator first asks Rail for a **governed backward
transition**:

- **REVIEWER `REWORK`:** request `REVIEWING → IN_PROGRESS`. If Rail accepts:
  re-run the IMPLEMENTER as a `RECOVERY` continuation (same implementer
  session, `continuation.failedReviewNote` + `pendingFeedback`), publish a
  fresh `IMPLEMENTATION` check **with evidence**, request `IN_PROGRESS →
  REVIEWING`, then run a **fresh independent REVIEWER** again. Only a REVIEWER
  `PASS` advances to `TESTING`.
- **TESTER `REWORK`:** request `TESTING → IN_PROGRESS`, fix with the IMPLEMENTER
  (as above), `IMPLEMENTATION` PASS, `IN_PROGRESS → REVIEWING`, a fresh
  independent **REVIEWER** (`CODE_REVIEW` PASS), `REVIEWING → TESTING`, then the
  **TESTER** again. A code change requested by the TESTER can **never** go
  straight back to the TESTER without a new independent review.
- **Rail rejects the rewind:** the rejection is respected — the IMPLEMENTER is
  **not** run, **no `IMPLEMENTATION` PASS** is published, no state is invented
  → outcome `FAILED` (or `HANDOFF` if Rail marks the rewind `humanOnly`).

The rewind transition carries `runId`, never a `claimToken`. Budget:
`maxReworks` (default 1). Beyond budget → outcome `FAILED`, **no `CODE_REVIEW` /
`AUTOMATED_TESTS` / `ACCEPTANCE_CRITERIA` PASS is created** and the cycle does
not advance.

## humanOnly frontier — safe hand-off (T5-AC-03)

A `humanOnly` frontier is a state the Harness must **not** enter on its own:

- **Configured** (`humanOnlyStates`, e.g. a state past `SANDBOX_READY`): the
  orchestrator records the evidence checks, leaves a governed factual note,
  and returns outcome `HANDOFF` **without even requesting the transition**.
- **Reported by Rail** (a transition answers `gateResults.humanOnly === true`,
  or throws a `HUMAN_APPROVAL_REQUIRED`-style code): the rejection is
  respected — no retry, no force — a governed note is left, outcome `HANDOFF`.

In neither case is a human approval / `APPROVAL` check ever fabricated
(`humanOnly` "nunca puede ser fabricado por el Harness").

## Rail is authoritative — fail-safe on rejection

A rejected **check**, **transition** or **query** is respected exactly as
Rail returned it. The orchestrator never retries the mutation, never forces
it, and never simulates success. A non-humanOnly gate failure ends the run
with outcome `FAILED` and a Spanish note naming the missing gates.

## Cancellation / fencing

`orchestrator.cancel(reason)` is **idempotent**. After it:

- no **new** role runs, and no **new** checks / transitions / queries / notes
  are started;
- the orchestrator re-checks `cancel` after **every `await`**, before the next
  Rail effect, and does **not** record locally that a later step happened;
- an in-flight role run is aborted via the `AbortSignal` handed to the seam;
  the query waiter is aborted too;
- outcome `CANCELLED`.

An HTTP request that has **already left the process** may still be decided by
Rail — Rail stays the authority for its own state. "Cancel" is a guarantee that
the orchestrator issues no *further* effect and fabricates no local state, not
that a request already on the wire is unsent.

The Worker Core calls `execution.cancel` on `SIGINT` / `SIGTERM` and on
fencing (lost ownership). On fencing the Core makes **no** Rail mutation for
that Run; the orchestrator's own guard means it makes none either.

## Outcome → Worker Core

`mapOrchestrationOutcome` (RailSoft's contract supports `COMPLETED` / `FAILED` /
`ABANDONED` / `RELEASED`; RailSoft is authoritative above this mirror):

| Orchestration outcome | Worker Core `finishRun` outcome | Run |
|---|---|---|
| `COMPLETED` | `COMPLETED` | the automated flow reached `targetState` (`SANDBOX_READY`) |
| `HANDOFF` | `COMPLETED` | automated work finished at a valid `humanOnly` frontier; evidence recorded, a human takes over. **Not** `RELEASED` — the ticket still corresponds — and **not** `FAILED` |
| `RELEASED` | `RELEASED` | a role determined the ticket / SPEC / repo does not correspond (a genuine release) |
| `CANCELLED` | `RELEASED` | fencing / controlled shutdown; Rail is authoritative |
| `BLOCKED` | `FAILED` | governed answers exhausted without unblocking. A *still-open* query never reaches here — `execute()` stays pending and the Run stays `ACTIVE` |
| `FAILED` | `FAILED` | technical failure, or Rail rejected a required mutation |
| *(unknown)* | `FAILED` | explicitly **never** `RELEASED` |

`RELEASED` is **not** a catch-all — at either layer. `mapOrchestrationOutcome`
maps an unknown orchestration outcome to `FAILED`, and the **Worker Core**'s own
fallback for an unrecognized / missing execution outcome is likewise `FAILED`
(not `RELEASED`). `RELEASED` is reserved for a genuine role `RELEASE` and for a
controlled shutdown / fencing teardown. There is always **exactly one Rail Run
per cycle** — the one the Worker Core claimed. Subagents never claim, recover,
heartbeat, transition, check or finish.

## Configuration

| Env / option | Default | Meaning |
|---|---|---|
| `RAIL_ADAPTER_PROVIDER` | `claude-code` | explicit adapter provider, resolved through the AdapterRouter |
| `RAIL_WORKSPACE_ROOT` | — | required: the isolated worktree root (Workspace Manager) |
| `queryPollMs` (option) | `15000` | blocking Agent Query poll interval; injectable, with `sleep`, for tests |
| `maxQueryResumes` (option) | `1` | governed `BLOCKED`→resume budget; checked **before** creating a new Agent Query so an unwaitable query is never created |
| `maxReworks` (option) | `1` | REVIEWER / TESTER `REWORK` budget |

## Tests

`test/orchestration.test.mjs` — fully offline: an in-memory Rail fake, a
scripted role runner, an injected workspace preparer. No real Rail, no real
adapter, no real `claude`. Covers: happy path with the check-before-transition
ordering; every Acceptance Criterion (T5-AC-01/02/03); RELEASE / FAILED;
**REVIEWER / TESTER rework with the governed rewind `REVIEWING`/`TESTING →
IN_PROGRESS` before the IMPLEMENTER re-runs, a TESTER rework forcing a fresh
REVIEWER, and Rail rejecting the rewind (no IMPLEMENTER, no PASS check)**;
tester fail; the evidence guard; Rail-rejection fail-safe (check / transition /
query); the **happy path finishing the Run `COMPLETED`** (E2E) while a genuine
`RELEASE` still finishes `RELEASED` and `HANDOFF` maps to `COMPLETED`; **a
blocking Agent Query keeping `execute()` pending — `finishRun` not called,
heartbeat still Core-owned — and a governed resolution resuming the same Run /
role / `session.id`**; the role-aware resume prompt (REVIEWER / TESTER framing
preserved — see `test/claude-code-adapter.test.mjs`); cancel during the query
wait; no secret or `claimToken` crossing to the role runner or into
Orchestration; `runId` on every governed call; Reviewer ≠ Tester; provider
through the AdapterRouter; cancellation / fencing / idempotent cancel; the E2E
`Worker Core + Orchestration` flow proving a single claim and a single finished
Run; and the E2E timeline (happy + blocked).

The **`FINAL …` block** pins RailSoft's Agent Query resolution semantics:
`PENDING` keeps `execute()` pending (zero resume, zero `finishRun`); `RESOLVED`
with a real answer resumes the same Run / role / `session.id` with the human
text verbatim; `RESOLVED` without answer text ⇒ `FAILED` with **no sentinel**;
`DISMISSED` ⇒ `FAILED` with zero resume / zero `resumeAnswer` / zero new query /
zero invented text; `ANSWERED` and `CLOSED` are contract violations ⇒ `FAILED`;
an old or other-Run query never unblocks the current `queryId`; `createQuery`
without a `queryId` ⇒ `FAILED` fail-closed with no fallback; a transient
`listQueries` error is retried; a cancel mid-poll ⇒ `CANCELLED`; and
`maxQueryResumes` is checked **before** creating an extra query (no orphan).
`test/worker-core.test.mjs` adds **N2**: an unknown execution outcome ⇒
`finishRun(FAILED)`, never `RELEASED` by default.
