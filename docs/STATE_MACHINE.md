# STATE_MACHINE.md

The `WorkCycle` and `Run` state model the Harness operates against. **Rail
owns this machine and re-validates every transition server-side.** The
Harness only *mirrors* the rules it needs to decide, read-only, whether an
action is safe before asking Rail to perform it.

Derived from the approved reference (`~/rail-runner/harness`:
`scripts/harness.mjs`, `RECOVERY.md`).

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
| `IN_PROGRESS` | Adapter is working. | heartbeat; on success `→ REVIEWING` |
| `REVIEWING` | Handed to Code Review. | Harness bootstrap frontier — later tickets own the tail |
| `BLOCKED` | A blocking Agent Query is open. | wait for human resolution; never claim/recover while blocked |

**Rewind:** on `RELEASE` / `FAILED` in a normal claim flow, the reference
walks `REVIEWING → IN_PROGRESS → READY → BACKLOG` with a reason. Recovery
flows never rewind (see below).

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

## Outcome → Rail mapping (reference behaviour, for the Orchestration ticket)

| `ExecutionResult.outcome` | Rail effect |
|---|---|
| `IMPLEMENTED` | `createCheck(IMPLEMENTATION/PASS)` + `transition → REVIEWING` |
| `BLOCKED` | `createQuery({blocking:true})`, wait for human, resume adapter |
| `RELEASE` | `finishRun(RELEASED)` + rewind (claim flow) / keep `IN_PROGRESS` (recovery flow) |
| `FAILED` | `finishRun(FAILED)` + rewind (claim flow) / keep `IN_PROGRESS` (recovery flow) |
