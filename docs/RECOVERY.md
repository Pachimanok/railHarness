# RECOVERY.md

Governed **continuation of ownership** on a `WorkCycle` — RAIL-D-00006.
RailSoft has **two distinct endpoints** and the Harness uses **`/resume`** as
the general path required by the AC:

- **`/resume`** — the GENERAL continuation on **any non-terminal cycle except
  `BLOCKED`**, preserving `WorkCycle.state` EXACTLY. Primary for RAIL-D-00006.
- **`/recover`** — a COMPATIBILITY path for the classic orphaned `IN_PROGRESS`
  case (`activeRun == null`, last Run `FAILED` / `ABANDONED`). Kept, but it
  does **not** replace `/resume`.

Implemented in `src/worker/recovery-preflight.js` (pure, read-only target
resolution: `resolveResumeTarget` and `resolveRecoveryTarget`) and
`src/worker/recovery.js` (`createResumeRunner` / `createRecoveryRunner` — the
one governed mutation + ownership / heartbeat / fencing / `finishRun`). Wired
into `npm run worker` by `RAIL_RESUME_REF` (`/resume`) or `RAIL_RECOVER_REF`
(`/recover`).

**RailSoft is the authority** and re-validates every precondition
server-side; this document mirrors only what the Harness checks *before*
asking.

> **Language:** every state / `Run` state / `code` / RailSoft field name here
> is a machine-readable identifier and is **never** translated, even though the
> runtime logs in Spanish (docs/HARNESS.md).

## `claim` ≠ `resume` ≠ `recover`

Three **distinct governed operations**, never substituted for one another:

| | `claim` | `resume` | `recover` |
|---|---|---|---|
| Endpoint | `POST …/claim` | `POST …/resume` | `POST …/recover` |
| Starts from | `state === READY` | any NON-terminal state except `BLOCKED` | `state === IN_PROGRESS` (orphaned) |
| Cycle state after | `READY → CLAIMED` | **UNCHANGED — preserved EXACTLY** (`REVIEWING → REVIEWING`, …) | **UNCHANGED** (stays `IN_PROGRESS`) |
| Ownerless last Run | — | `state != ACTIVE` — `COMPLETED` / `RELEASED` / `FAILED` / `ABANDONED` **all valid** | `FAILED` / `ABANDONED` only |
| Body | `{ branch }` | `{ branch, worktreePath, lastRunId, reason }` | `{ branch, worktreePath, lastRunId, reason }` |

- A **refused `resume` is NEVER retried as a `recover` or a `claim`.**
- A **refused `recover` is NEVER retried as a `resume` or a `claim`.**
- A **refused `claim` is NEVER retried as a `resume` or a `recover`.**
- `RAIL_TICKET_REF`, `RAIL_RESUME_REF` and `RAIL_RECOVER_REF` are **mutually
  exclusive** (`resolveMode` throws otherwise).
- A continuation is always for **one exact ref** — it never lists `READY` and
  never falls back to discovery.
- There is always **exactly one new Rail Run per continuation**. Subagents
  never claim, resume, recover, heartbeat, transition, check or finish.

## `/resume` — when a cycle can be resumed

`resolveResumeTarget` accepts a cycle that is **non-terminal and not
`BLOCKED`** (`CLAIMED` / `IN_PROGRESS` / `REVIEWING` / `TESTING` /
`SANDBOX_READY` / any other non-terminal state). Two targets:

### A) `RESUME_STALE_TAKEOVER`
- `activeRun != null` **and not lease-live**
- `lastRunId` = `activeRun.id` (Rail abandons it as part of `/resume`)
- if `activeRun.branch` is set it must equal `rail/<ticket-code>`

### B) `RESUME_OWNERLESS`
- `activeRun == null`
- the cycle's **most recent Run** (by `startedAt`) has `state != ACTIVE` —
  **`COMPLETED` / `RELEASED` / `FAILED` / `ABANDONED` are ALL valid**. The old
  Run stays terminal and is never touched or rewritten.
- `lastRunId` = that Run's id
- `activeRun == null` **with** an `ACTIVE` candidate ⇒
  `RESUME_CANDIDATE_ACTIVE_INCONSISTENT`, fail-closed (a Rail inconsistency the
  Harness does not resolve by inference)

**Lease-live rule (exact mirror of RailSoft) — shared by `/resume` and
`/recover`:**

```
leaseLive =
  run.state === "ACTIVE"
  && run.leaseExpiresAt != null
  && Date.parse(run.leaseExpiresAt) > now      // strictly greater; == now is NOT live
```

If the `activeRun` **is** lease-live the preflight fails closed with
`RESUME_LEASE_STILL_ACTIVE` **before any POST** — the Harness never
reconstructs ownership by inference and never steals a live Run. The log
prints `run.id` and `leaseExpiresAt`, never a secret.

### `/resume` fail-closed refusals (no mutation, no `/recover`, no `claim`)

| `code` | Meaning |
|---|---|
| `RESUME_CYCLE_TERMINAL` | the cycle state is terminal (`DONE` / `MERGED` / `CLOSED` / `CANCELLED` / `ARCHIVED` / `REJECTED` / `COMPLETED` / `RELEASED` / `ABANDONED`) |
| `RESUME_CYCLE_BLOCKED` | a blocking Agent Query is open — RailSoft `/resume` rejects `BLOCKED`; resolve it first (no `/recover`/`claim`/`transition` work-around) |
| `RESUME_CYCLE_PRE_OWNERSHIP` | the cycle is `BACKLOG` / `READY` — take initial ownership with `claim`, not `/resume` |
| `RESUME_PROJECT_MISMATCH` | the ticket is not in the configured project |
| `RESUME_LEASE_STILL_ACTIVE` | the `activeRun` lease is still valid |
| `RESUME_CANDIDATE_ACTIVE_INCONSISTENT` | `activeRun == null` but the last Run is `ACTIVE` |
| `RESUME_LAST_RUN_INDETERMINATE` | no concrete `lastRunId` of **this** cycle can be resolved — never a guessed / borrowed id |
| `RESUME_LAST_RUN_NOT_LATEST` | an explicitly-supplied `lastRunId` is a real but **older** Run of this cycle |
| `RESUME_LAST_RUN_FOREIGN` | an explicitly-supplied `lastRunId` belongs to **another** cycle |
| `RESUME_BRANCH_MISMATCH` | `activeRun.branch` ≠ `rail/<ticket-code>` |

## `/recover` — classic compatibility path

`resolveRecoveryTarget` applies **only** to `state === IN_PROGRESS`:

- **`CLASSIC_ORPHAN`** — `activeRun == null`, last Run `FAILED` / `ABANDONED`.
- **`STALE_LEASE_TAKEOVER`** — `activeRun != null` and not lease-live.

A last Run that finished `COMPLETED` / `RELEASED` is **not** a classic-recover
target (`RECOVERY_LAST_RUN_TERMINAL_CLEAN`) — the message redirects to
`/resume`, which **does** accept it (the old Run stays terminal, a new Run
continues the non-terminal cycle). Other non-`FAILED`/`ABANDONED` states give
`RECOVERY_LAST_RUN_NOT_TERMINAL`. Same lease-live rule; same
`RECOVERY_LEASE_STILL_ACTIVE` / `RECOVERY_CYCLE_BLOCKED` /
`RECOVERY_PROJECT_MISMATCH` / `RECOVERY_BRANCH_MISMATCH` /
`RECOVERY_LAST_RUN_INDETERMINATE` fail-closed refusals.

## `lastRunId` — the EXACT previous Run

- It is resolved **only** from this cycle's `runs` / `activeRun` — never an
  env var, never "the most recent Run" of some other ticket, never a
  hard-coded value; the ownerless target always takes the **latest** Run of
  the cycle.
- If it cannot be determined unambiguously the continuation is **BLOCKED /
  fail-closed**, never invented.
- `POST /resume` (or `/recover`) carries it as `body.lastRunId`. RailSoft
  re-checks it server-side.
- The response must reference the **same** prior Run: if `recovered.fromRunId`
  is present and ≠ `body.lastRunId`, or the new `run.id` **equals**
  `body.lastRunId`, the Harness fails closed with
  `RECOVERY_RESPONSE_CONTRACT_ERROR` (a continuation must create a **new** Run).

## The worktree — read-only, dirty is expected

Before the POST the Harness inspects the isolated worktree
(`inspectWorktree`, **read-only** git: `rev-parse` / `status --porcelain` /
`worktree list` / `remote get-url` — never `checkout` / `reset` / `clean` /
`worktree add`):

- must **exist** (recovery does **not** recreate a lost worktree),
- must be a registered worktree of the primary clone, at its own root,
- must be on the `rail/<ticket-code>` branch,
- its `origin` must match `targetRepository.repoFullName`,
- **a dirty worktree is EXPECTED and PRESERVED** — uncommitted work is never
  discarded, never `reset`/`clean`ed, never `checkout`ed away.

Any mismatch → `RECOVERY_WORKSPACE_MISMATCH`, fail-closed, **no POST**.

## What `POST /resume` (or `/recover`) does / returns

```
POST /tickets/:ref/resume            (or /recover)
Body: { branch, worktreePath, lastRunId, reason }

Effect (RailSoft, authoritative):
  - audit event (operator, machine, fromRunId, reason)
  - a NEW Run, state = ACTIVE, bound to the SAME WorkCycle,
    recoveryOfRunId = <old Run>
  - cycle state UNCHANGED — /resume PRESERVES it EXACTLY
    (REVIEWING → REVIEWING, …); classic /recover leaves it IN_PROGRESS
  - the OLD Run keeps its terminal state / outcome untouched
  - fresh claimToken + leaseExpiresAt

Response (normalized like claim() via normalizeRunHandoff):
  { run: { id, claimToken, leaseExpiresAt },
    recovered: { fromRunId, cycleState } }     // cycleState is the PRESERVED state
```

### If the continuation fails

| Situation | Result `code` | Behaviour |
|---|---|---|
| endpoint absent — `404` / `405` / `501` (or a `NOT_FOUND` / `NOT_IMPLEMENTED` / `UNKNOWN_ROUTE` / `METHOD_NOT_ALLOWED` code) | `RECOVERY_ENDPOINT_UNAVAILABLE` | **fail-closed, exit 2**, NO alternative mutation, **NO `/recover` fallback, NO `claim`**. Deploy the endpoint in RailSoft. |
| another `activeRun` / lease still live (`409` / `423` / an `ACTIVE_RUN` / `CONFLICT` / `OWNERSHIP` code) | `RECOVERY_REJECTED_ACTIVE_RUN` | rejection respected: no ownership stolen, **no fallback**, no adapter run |
| any other rejection | `RECOVERY_REJECTED` | rejection respected: **no fallback**, no compensating transition, no branch/workspace deletion |
| `2xx` without a usable `run.id` / `claimToken` | `RECOVERY_RESPONSE_CONTRACT_ERROR` | **not** retried; a read-only `GET` reports whether Rail *did* create an `activeRun`; the `claimToken` is never printed |

**There is no fallback, ever.** `resume` failing never triggers `recover` or
`claim`; `recover` failing never triggers `resume` or `claim`.

## After a successful continuation

- The **new** `claimToken` lives **only** in the runner's closure
  (`heartbeatOnce()` / `finish()`). It never enters:
  the execution context, the `ExecutionEnvelope`, prompts, the adapter, logs,
  `getState()`, or the child env.
- **Heartbeat** for the new execution uses **only the new token** — never the
  previous Run's token.
- **Preserved:** the branch, the worktree (including uncommitted work), and the
  **governed cycle state EXACTLY as Rail reported it** (`ctx.recovery.cycleState`).
  Nothing is reset, nothing rewinds to `READY` / `CLAIMED` / `IN_PROGRESS`, no
  already-accepted step is repeated.

### State-aware orchestration continuation

The new execution runs the governed orchestration **from the preserved state**
(`orchestrator.execute({ startState: ctx.recovery.cycleState, recovery })`).
It never re-runs — or re-publishes the check for — a stage Rail already
accepted for this HEAD:

| Resumed at | Runs | Publishes | Does NOT |
|---|---|---|---|
| `IN_PROGRESS` | IMPLEMENTER (as a `RECOVERY` continuation — review `git status`/`diff`, don't start cold) → REVIEWER → TESTER | `IMPLEMENTATION` → `CODE_REVIEW` → `AUTOMATED_TESTS` + `ACCEPTANCE_CRITERIA` | — |
| `REVIEWING` | REVIEWER → TESTER | `CODE_REVIEW` → `AUTOMATED_TESTS` + `ACCEPTANCE_CRITERIA` | run IMPLEMENTER; publish `IMPLEMENTATION`; rewind to `IN_PROGRESS` |
| `TESTING` | TESTER only | `AUTOMATED_TESTS` + `ACCEPTANCE_CRITERIA` | run IMPLEMENTER / REVIEWER; publish `IMPLEMENTATION` / `CODE_REVIEW` |
| `SANDBOX_READY` (== target) | nothing | nothing | re-execute or re-publish anything (`HANDOFF` if that state is `humanOnly`, else `COMPLETED`) |

A `REWORK` from a resumed REVIEWER / TESTER still goes through the **governed
rewind** `REVIEWING`/`TESTING → IN_PROGRESS` before the IMPLEMENTER re-runs
(an implementer session id is created on demand) — a code change never skips a
fresh independent review. This is a **RUN continuation**; it is **not** an
adapter-session resume and never fabricates a human answer or a prior approval.

- **`finishRun`** closes the **new** Run **exactly once**, with a defensive
  outcome mapping: `COMPLETED → COMPLETED`, `FAILED → FAILED`, genuine
  `RELEASED → RELEASED`, **unknown → FAILED** (never `RELEASED` as a
  catch-all). The **previous Run is never finished** and its outcome is never
  rewritten.

### Ownership loss / fencing during the new execution

If a heartbeat comes back as a definitive ownership rejection
(`401/403/404/409/410`, or an `OWNERSHIP` / `LEASE` / `ABANDONED` / `FENCED` /
`EXPIRED` / … code):

1. the heartbeat timer stops,
2. `state.fenced` blocks **all** further mutation of that Run,
3. the child execution is cancelled,
4. **`finishRun` is NOT called** for the lost Run — Rail is authoritative,
5. the recovery ends `outcome: "FENCED"`, `code: RECOVERY_OWNERSHIP_LOST`.

A transient network / `5xx` heartbeat failure is **not** fencing: it is logged
and retried on the next interval.

### Shutdown (SIGINT / SIGTERM) during a recovered execution

Controlled teardown: cancel the child, then — only if still owned —
`finishRun({ outcome: "RELEASED" })` once, then stop. A second signal exits
immediately. The cycle is **not** rewound.

### Human gate (T6-AC-04)

A **resumed** run that reaches a `humanOnly` frontier behaves exactly like a
fresh run: the evidence checks are recorded, a governed factual note is left,
the orchestration returns `HANDOFF` → `finishRun(COMPLETED)` — **no approval
is fabricated** and the frontier transition is not forced. A resume that lands
directly on a `humanOnly` `targetState` hands off immediately without running
any role.

## Crash windows (`/resume`)

| Crash point | On restart |
|---|---|
| after `claim`, before work | cycle `CLAIMED` — resumable via `/resume` (stale `activeRun`) from `CLAIMED`; state preserved |
| in any non-terminal state, Run `ACTIVE`, lease **live** | `RESUME_LEASE_STILL_ACTIVE` — wait for the lease / sweeper; never a takeover of a live Run |
| in `REVIEWING` / `TESTING` / `IN_PROGRESS` / `SANDBOX_READY`, Run `ACTIVE`, lease **expired** | `RESUME_STALE_TAKEOVER` on `activeRun.id`; **state preserved**, continuation starts at that stage |
| `activeRun == null`, last Run non-`ACTIVE` (incl. `COMPLETED` / `RELEASED`) | `RESUME_OWNERLESS` on that Run's id; the old Run stays terminal, a new Run continues the non-terminal cycle |
| `activeRun == null` but last Run `ACTIVE` | `RESUME_CANDIDATE_ACTIVE_INCONSISTENT` — fail-closed |
| with **uncommitted work** on disk | the dirty worktree is reused as-is; work preserved |
| after a check / transition | the orchestration continues **from the preserved state**; the stage Rail already accepted is NOT re-run or re-published; Rail re-validates and does not double-apply |
| the cycle itself is terminal (`DONE` / `MERGED` / …) | `RESUME_CYCLE_TERMINAL` — refused |
| the cycle is `BLOCKED` | `RESUME_CYCLE_BLOCKED` — resolve the Agent Query first |
| Rail still shows a lease-live `activeRun` after the POST | `RECOVERY_REJECTED_ACTIVE_RUN` — no takeover, no fallback |

## Operating the Worker

### Normal (discovery) mode

```bash
export RAIL_API_URL="https://<host>/api/rail"
export RAIL_TOKEN="rag_<agent token>"          # control-plane only, never printed
export RAIL_PROJECT_ID="<project id>"
export RAIL_REPO_PATH="$HOME/.../primary-clone"
export RAIL_WORKSPACE_ROOT="$HOME/.rail-harness/worktrees"
export RAIL_MACHINE="$(hostname)"
export RAIL_AGENT="CLAUDE PACHI"
npm run worker
```

### Resume mode — GENERAL continuation (one governed `/resume`, then exit)

```bash
# same env as above, PLUS:
export RAIL_RESUME_REF="RAIL-D-00006"           # mutually exclusive with RAIL_TICKET_REF / RAIL_RECOVER_REF
export RAIL_RESUME_NOTES="continuación tras caída del worker"    # optional -> body.reason
npm run worker
```

Use this for RAIL-D-00006's AC-11 / AC-12: a stale `activeRun` in any
non-terminal state, or an ownerless cycle whose last Run finished in **any**
non-`ACTIVE` state (`COMPLETED` / `RELEASED` / `FAILED` / `ABANDONED`). The
cycle state is preserved and the orchestration continues from the real stage.

### Recover mode — classic compat (one governed `/recover`, then exit)

```bash
export RAIL_RECOVER_REF="RAIL-D-00006"          # mutually exclusive with the other two
export RAIL_RECOVER_NOTES="..."                 # optional -> body.reason
npm run worker
```

Only for the classic orphaned `IN_PROGRESS` case (`activeRun == null`, last
Run `FAILED` / `ABANDONED`).

Exit codes (both modes): `0` the new Run finished `COMPLETED`; `2` a
fail-closed no-op (nothing mutated — not recoverable / workspace mismatch /
endpoint absent / rejected-active-run / ticket read failed); `1` anything else
(new Run finished `FAILED`, fenced, stopped).

### Troubleshooting

| Symptom (log line) | Cause | Action |
|---|---|---|
| `resume de … NO autorizado (RESUME_LEASE_STILL_ACTIVE)` | another worker still holds a live lease | wait for `leaseExpiresAt` / the sweeper; do **not** force |
| `El endpoint de resume no está desplegado en Rail` | `POST /tickets/:ref/resume` missing | deploy it in RailSoft; the Harness will **not** fall back to `/recover` or `claim` |
| `RECOVERY_RESPONSE_CONTRACT_ERROR` + `Rail SÍ creó un activeRun` | the continuation half-succeeded (Rail made the Run, response was malformed) | inspect the timeline; the ownership is Rail-side — do not blindly retry |
| `El worktree de resume … no es consistente` | wrong branch / foreign checkout / missing worktree | fix the worktree on disk; the Harness never resets or recreates it |
| `heartbeat RECHAZADO … Fencing` | the new lease was lost | expected fail-safe: the child is aborted, no `finishRun`; re-run the continuation if the cycle is still resumable |
| `El ciclo … está BLOCKED` | an Agent Query is open | resolve the query (human), then resume |
| `RESUME_CYCLE_TERMINAL` | the cycle is finished | nothing to resume |
| `RESUME_CANDIDATE_ACTIVE_INCONSISTENT` | `activeRun == null` but the last Run is `ACTIVE` | a Rail inconsistency — inspect the timeline, do not force |

### Manual smoke (operator, out of scope for the automated agent)

Against a **disposable** Rail Harness ticket, with real credentials, run
resume mode and verify on the timeline that Runs, resumes, checks, queries and
handoffs are all traceable, that exactly **one** new Run is created, that the
cycle state is unchanged, and that the prior Run's outcome is untouched. This
step is **not** performed by the automated Harness (it never calls real Rail /
real `claude`).

## Tests

`test/recovery.test.mjs` — fully offline (in-memory Rail fake with both
`resume` and `recover`, injected worktree inspector, injected execution
factory, injected timers). Covers:

- **`/resume` pure preflight** — stale takeover from `IN_PROGRESS` /
  `REVIEWING` / `TESTING` / `SANDBOX_READY` (state preserved), ownerless with
  the last Run `COMPLETED` / `RELEASED` / `FAILED` / `ABANDONED`, ownerless +
  `ACTIVE` candidate inconsistency, `BLOCKED` / terminal / pre-ownership cycle
  refusals, lease-still-live, `lastRunId` not-latest / foreign, branch
  mismatch.
- **`/resume` runner** — `api.resume` used and **never** `api.recover` /
  `claim`; exact `lastRunId`; `ctx.recovery.cycleState` preserves the state;
  COMPLETED/RELEASED ownerless allowed and executed; the old Run never mutated
  / never `finishRun`'d; `404/405/501` fail-closed with no `/recover` fallback;
  generic rejection; workspace mismatch; response contract errors;
  new-token-only heartbeat; fencing; one-shot; secret confinement.
- **`/resume` E2E** — REVIEWING resume runs REVIEWER→TESTER only (no
  IMPLEMENTER, no `IMPLEMENTATION` check, no rewind); TESTING resume runs
  TESTER only (no `CODE_REVIEW` / `IMPLEMENTATION`); `SANDBOX_READY` resume
  executes nothing; `humanOnly` frontier hand-off from a resumed run;
  endpoint-absent E2E with zero role runs and zero fallback.
- **classic `/recover`** — still covered separately (the compat path is
  unchanged; a `COMPLETED`/`RELEASED` last Run is refused there and the message
  redirects to `/resume`).

`test/orchestration.test.mjs` adds state-aware entry tests (`startState`
`REVIEWING` / `TESTING` / `SANDBOX_READY`, and a resumed REVIEWER `REWORK`).
`test/workspace-manager.test.mjs` adds real-git coverage of `inspectWorktree`.
`test/rail-api-client.test.mjs` covers `resume()` POSTing `/resume` and reusing
`normalizeRunHandoff`. `test/runtime-config.test.mjs` covers the three-way
mutual exclusion and `RAIL_RESUME_REF`.
