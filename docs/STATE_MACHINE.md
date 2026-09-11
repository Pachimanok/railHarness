# STATE_MACHINE.md

The `WorkCycle` and `Run` state model the Harness operates against. **Rail
owns this machine and re-validates every transition server-side.** The
Harness only *mirrors* the rules it needs to decide, read-only, whether an
action is safe before asking Rail to perform it.

Derived from the approved reference (`~/rail-runner/harness`:
`scripts/harness.mjs`, `RECOVERY.md`).

> **Language:** every state / `Run` state / `outcome` / check type on this
> page is a machine-readable protocol value and is **never** translated, even
> in Spanish-language logs or prompts (see `docs/HARNESS.md`).

## WorkCycle states

```
BACKLOG ──▶ READY ──▶ CLAIMED ──▶ IN_PROGRESS ──▶ REVIEWING ──▶ … (Rail-owned tail)
   ▲                                   │
   └───────────────(rewind)────────────┘
                          │
                       BLOCKED   (orthogonal: a blocking Agent Query is open)
```

| State | Meaning | Harness action |
|---|---|---|
| `BACKLOG` | Not ready to be worked. | none |
| `READY` | Claimable. | `claim` (only from here) → `CLAIMED` |
| `CLAIMED` | A Run exists; work not started. | `transition → IN_PROGRESS` |
| `IN_PROGRESS` | Adapter is working. | Orchestration: `IMPLEMENTER` PASS ⇒ `createCheck(IMPLEMENTATION)` then `→ REVIEWING` |
| `REVIEWING` | Handed to Code Review. | Orchestration: `REVIEWER` PASS ⇒ `createCheck(CODE_REVIEW)` then `→ TESTING`; `REWORK` ⇒ governed rewind `→ IN_PROGRESS`, re-run IMPLEMENTER, then a fresh independent REVIEWER |
| `TESTING` | Handed to the Tester. | Orchestration: `TESTER` PASS ⇒ `createCheck(AUTOMATED_TESTS)` + `createCheck(ACCEPTANCE_CRITERIA)` then `→ SANDBOX_READY`; `REWORK` ⇒ governed rewind `→ IN_PROGRESS`, re-run IMPLEMENTER, then a fresh REVIEWER **and** TESTER (re-review is mandatory) |
| `SANDBOX_READY` | Automated flow done; evidence recorded. | Harness frontier — the deploy / `SANDBOX` gate past it is `humanOnly`: hand off, never fabricate an approval |
| `BLOCKED` | A blocking Agent Query is open. | wait for human resolution; never claim/recover while blocked |

Every check above is created **with evidence** and **before** the transition
it gates (RAIL-D-00005, T5-AC-01). A check the evidence does not back is not
created and the cycle does not advance. See `docs/ORCHESTRATION.md`.

**Rewind:** on `RELEASE` / `FAILED` in a normal claim flow, the reference
walks `REVIEWING → IN_PROGRESS → READY → BACKLOG` with a reason. `resume` /
`recover` flows never rewind the cycle to `READY` / `CLAIMED`; `/resume`
preserves the state exactly (see below).

**REWORK rewind (RAIL-D-00005):** a `REWORK` from the REVIEWER or TESTER first
requests a **governed** `REVIEWING → IN_PROGRESS` (or `TESTING → IN_PROGRESS`)
from Rail. The IMPLEMENTER is re-run **only if Rail accepts** that transition;
if Rail rejects it, no IMPLEMENTER runs, no `IMPLEMENTATION` PASS is published,
and the orchestration ends `FAILED` (or `HANDOFF` on a `humanOnly` rewind). The
Harness never re-runs the IMPLEMENTER while Rail still sits in `REVIEWING` /
`TESTING`, and never fabricates the backward transition.

## Run states

| State | Meaning |
|---|---|
| `ACTIVE` | Live Run holding a lease. |
| `RELEASED` | Cleanly finished without a completed change (voluntary release). |
| `FAILED` | Technical failure. |
| `ABANDONED` | Lease expired; Rail's sweeper reclaimed it. |

A `WorkCycle` may have at most one `activeRun`.

## Lease-live rule (exact mirror of Rail)

```
leaseLive =
  activeRun.state === "ACTIVE"
  && activeRun.leaseExpiresAt != null
  && activeRun.leaseExpiresAt > now      // strictly greater; == now is NOT live
```

Any other case is **stale**: `ACTIVE` + expired lease, `ACTIVE` + null lease,
or `state != ACTIVE`. The Harness must not invent a different rule.

## Claim preconditions (all read-only; any failure ⇒ abort, no mutation)

1. Ticket exists and `projectId` matches the configured project.
2. `state === READY`.
3. Not `BLOCKED`.
4. No existing `activeRun`.
5. `targetRepository` matches the configured repo's `origin`.

## Continuation of ownership — `claim` ≠ `resume` ≠ `recover`

Three distinct governed operations. **RAIL-D-00006 uses `/resume`** for the
general case; `/recover` is a compatibility path. Full runbook:
`docs/RECOVERY.md`.

| | `claim` | `resume` (RAIL-D-00006) | `recover` (compat) |
|---|---|---|---|
| From | `READY` | **any non-terminal state except `BLOCKED`** | `IN_PROGRESS` orphaned |
| Cycle state after | `READY → CLAIMED` | **preserved EXACTLY** (`REVIEWING → REVIEWING`, …) | unchanged (`IN_PROGRESS`) |
| Ownerless last Run | — | `state != ACTIVE` — **`COMPLETED`/`RELEASED`/`FAILED`/`ABANDONED` all valid** | `FAILED`/`ABANDONED` only |
| Env | `RAIL_TICKET_REF` | `RAIL_RESUME_REF` | `RAIL_RECOVER_REF` |

### `/resume` targets (governed `POST /resume`)

The cycle must be **non-terminal and not `BLOCKED`**. Worktree must be on disk
(read-only checks; a dirty worktree is expected).

**A) `RESUME_STALE_TAKEOVER`** — `activeRun != null` **and not lease-live**;
`lastRunId = activeRun.id`; `activeRun.branch` (if set) must equal
`rail/<code>`. A lease-live `activeRun` ⇒ abort `RESUME_LEASE_STILL_ACTIVE`
**before** any POST.

**B) `RESUME_OWNERLESS`** — `activeRun == null`; the cycle's **latest** Run has
`state != ACTIVE` (`COMPLETED` / `RELEASED` / `FAILED` / `ABANDONED` all
valid — the old Run stays terminal and untouched); `lastRunId` = that Run's
id. `activeRun == null` with an `ACTIVE` candidate ⇒
`RESUME_CANDIDATE_ACTIVE_INCONSISTENT`, fail-closed.

Refused fail-closed (no POST, no fallback): `RESUME_CYCLE_TERMINAL`,
`RESUME_CYCLE_BLOCKED`, `RESUME_CYCLE_PRE_OWNERSHIP` (`BACKLOG`/`READY` — use
`claim`), `RESUME_LEASE_STILL_ACTIVE`, `RESUME_LAST_RUN_INDETERMINATE`,
`RESUME_LAST_RUN_NOT_LATEST`, `RESUME_LAST_RUN_FOREIGN`,
`RESUME_BRANCH_MISMATCH`, `RESUME_PROJECT_MISMATCH`.

### `/recover` targets (governed `POST /recover` — compat)

`state === IN_PROGRESS` only. **A) Classic orphan** — `activeRun == null`, last
Run `FAILED`/`ABANDONED`. **B) Stale-lease takeover** — `activeRun != null` and
not lease-live. A `COMPLETED`/`RELEASED` last Run ⇒
`RECOVERY_LAST_RUN_TERMINAL_CLEAN` (message redirects to `/resume`, which
accepts it).

### Continuation invariants (RAIL-D-00006 — implemented; runbook in `docs/RECOVERY.md`)
- `claim`, `resume` and `recover` are **distinct**. A refused one is **never**
  retried as either of the others. **There is no fallback, ever.**
- `RAIL_TICKET_REF`, `RAIL_RESUME_REF` and `RAIL_RECOVER_REF` are mutually
  exclusive.
- A continuation never falls back to discovery / another `READY` ticket; it is
  always for one exact ref.
- **`lastRunId`** is resolved **only** from *this* cycle's `runs` / `activeRun`
  (never an env var, never another ticket's Run, never a guess; the ownerless
  target always takes the **latest** Run). Unresolvable ⇒ fail-closed
  (`*_LAST_RUN_INDETERMINATE`).
- `/resume` **preserves the cycle state EXACTLY** — it never rewinds to
  `READY` / `CLAIMED` / `IN_PROGRESS`; the orchestration continues from that
  state and never re-runs / re-publishes a stage Rail already accepted.
- An `activeRun` that **is** lease-live ⇒ abort `*_LEASE_STILL_ACTIVE`
  **before** any POST; print `run.id` + `leaseExpiresAt`, never secrets.
- Worktree checks are **read-only** (`rev-parse` / `status` / `worktree list` /
  `remote get-url`). A continuation never runs `git reset` / `clean` /
  `checkout` / `commit`, never recreates a lost worktree; **a dirty worktree is
  expected and preserved** (uncommitted work is never discarded).
- The worktree branch must equal `rail/<ticket-code>` (and, for a stale
  takeover, also `activeRun.branch` when present); any mismatch ⇒
  `RECOVERY_WORKSPACE_MISMATCH`, fail-closed, no POST.
- Only the chosen `POST /resume` (or `/recover`) mutates. If the endpoint is
  absent (404/405/501) the Harness reports the limitation and aborts with **no
  alternative mutation** (`RECOVERY_ENDPOINT_UNAVAILABLE`) — no fallback to the
  other endpoint, no `claim`.
- The response must reference the **same** prior Run — `fromRunId` ≠
  `lastRunId`, or a new `run.id` == `lastRunId`, ⇒
  `RECOVERY_RESPONSE_CONTRACT_ERROR` (a continuation must create a **new** Run).
- After a granted continuation: exactly **one new Run**; the **new
  `claimToken`** is runner-closure-only (never in the envelope / prompt /
  adapter / logs / child env); heartbeat uses **only the new token**; branch +
  worktree + governed state are **preserved**; the orchestration runs **from
  the preserved state** (`IN_PROGRESS` → IMPLEMENTER as a `RECOVERY`
  continuation; `REVIEWING` → REVIEWER; `TESTING` → TESTER; `SANDBOX_READY` →
  nothing) — a RUN continuation, **not** an adapter-session resume, no
  fabricated answer/approval, and **no stage Rail already accepted is re-run or
  re-published**; `finishRun` closes the **new** Run **exactly once** (unknown
  outcome → `FAILED`, never `RELEASED`); the **previous Run is never finished**.
- Heartbeat rejection during the new execution ⇒ fencing: cancel the child,
  **no `finishRun`** for the lost Run, no later mutation.

## Outcome → Rail mapping (implemented in `src/orchestration/`, RAIL-D-00005)

An adapter `ExecutionResult.outcome` is normalized per role into a
`RoleResult.decision` (`docs/ORCHESTRATION.md`); the orchestrator then acts:

| role decision | Rail effect (governed; Rail re-validates) |
|---|---|
| `PASS` (IMPLEMENTER) | `createCheck(IMPLEMENTATION/PASS, evidence)` → `transition IN_PROGRESS → REVIEWING` |
| `PASS` (REVIEWER) | `createCheck(CODE_REVIEW/PASS, evidence)` → `transition REVIEWING → TESTING` |
| `PASS` (TESTER) | `createCheck(AUTOMATED_TESTS/PASS)` + `createCheck(ACCEPTANCE_CRITERIA/PASS)` → `transition TESTING → SANDBOX_READY` |
| `BLOCKED` (any role) | `createQuery({ blocking:true, runId })`; `execute()` stays **pending** while the query is open (the Core keeps heartbeating, `finishRun` is not called); governed resume only — same `session.id` + role framing — never an invented answer |
| `REWORK` (REVIEWER / TESTER) | governed rewind `REVIEWING`/`TESTING → IN_PROGRESS`, then IMPLEMENTER `RECOVERY` + fresh `IMPLEMENTATION` PASS + `IN_PROGRESS → REVIEWING` + a fresh independent REVIEWER (a TESTER rework also re-runs the TESTER only after that review). Rail rejecting the rewind ⇒ `FAILED`, **no IMPLEMENTER, no PASS check** |
| `RELEASE` (IMPLEMENTER) | orchestration ends `RELEASED`; the Worker Core closes the Run `RELEASED` |
| `FAILED` (any role) | orchestration ends `FAILED`; the Worker Core closes the Run `FAILED` |
| `humanOnly` frontier | governed factual note + hand-off; **no approval fabricated**; orchestration `HANDOFF` ⇒ Worker Core `finishRun(COMPLETED)` (a valid frontier reached, not a catch-all `RELEASED`) |

The happy path ends `finishRun(COMPLETED)` — **not** `RELEASED`. The Worker Core
still owns `finishRun`; the orchestrator never calls it. RailSoft's Run outcomes
are `COMPLETED` / `FAILED` / `ABANDONED` / `RELEASED` (RailSoft is authoritative
above this mirror). A rejected check / transition / query / rewind is respected —
never forced, never simulated.
