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
walks `REVIEWING → IN_PROGRESS → READY → BACKLOG` with a reason. Recovery
flows never rewind (see below).

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

## Recovery targets (governed `POST /recover` only)

Recovery applies to a `state === IN_PROGRESS` cycle whose real, uncommitted
worktree is still on disk.

### A) Classic orphan
- `state === IN_PROGRESS`
- `activeRun == null`
- last `Run` is `FAILED` or `ABANDONED`
- `lastRunId` = that Run's id

### B) Stale-lease takeover
- `state === IN_PROGRESS`
- `activeRun != null` **and not lease-live** (see rule above)
- `lastRunId` = `activeRun.id` (that Run is abandoned by Rail)
- if `activeRun` **is** lease-live ⇒ abort `RECOVERY_LEASE_STILL_ACTIVE`
  **before** any POST; print `run.id` + `leaseExpiresAt`, never secrets

### Recovery invariants
- `RAIL_TICKET_REF` and `RAIL_RECOVER_REF` are mutually exclusive.
- Recovery never falls back to discovery / another `READY` ticket.
- Recovery never runs `git reset` / `clean` / `checkout` / `commit` / … and
  never recreates the worktree; a dirty worktree is expected.
- Recovery never rewinds the cycle to `READY`; it stays `IN_PROGRESS`.
- The worktree branch must equal `rail/<ticket-code>` (and, in B, also
  `activeRun.branch` when present).
- Only `POST /recover` mutates. If the endpoint is absent (404/405/501) the
  Harness reports the limitation and aborts with no alternative mutation.

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
