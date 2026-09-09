# WORKER_CORE.md

The **Worker Core** — the persistent process that consumes Rail's `READY`
queue. Implemented in `src/worker/`; entry point `npm run worker`
(`src/worker/cli.js`). Derived from the approved reference
(`~/rail-runner/harness/scripts/harness.mjs` `main()` + `startHeartbeat`),
reshaped from a one-shot script into a supervised, long-running loop.

> **Language:** this document and the code comments are English by repo
> convention. Every human-facing line the Worker Core *emits at runtime* is in
> Spanish (docs/HARNESS.md). Machine-readable values — `READY`, `CLAIMED`,
> `RELEASED`, `FAILED`, `ABANDONED`, the `WORKER_PHASES` identifiers, Rail
> field names — are never translated.

## Responsibility

Own **exactly one Run at a time**, from discovery to a clean end:

```
connect + validate Rail
  └─> discovery loop ──(no READY)──> idle: sleep, re-poll   [no Run, no workspace]
        │
        └─(READY candidate)─> getTicket + preflight (read-only)
              └─(claimable)─> atomic claim  ── Rail creates the Run ──┐
                                                                       │
        ┌──────────────────────────────────────────────────────────────┘
        v
   heartbeat supervisor  +  one active execution (injected collaborator)
        │
        ├─ execution finishes ........ finishRun + back to discovery
        ├─ ownership lost (fencing) .. cancel execution, NO Rail mutation, back to discovery
        └─ SIGINT / SIGTERM ......... stop claiming, cancel execution, finishRun(RELEASED), exit
```

## Scope of this ticket (RAIL-D-00002)

**In:** CLI / persistent process, `npm run worker`, Rail connectivity
validation, `READY` discovery scoped to the configured project, ticket
preflight + traceability before the claim, atomic claim, `runId` /
`claimToken` / `leaseExpiresAt` kept **only** in the Core, heartbeat
supervisor, fencing on lost ownership, idle loop that creates no Run and no
workspace, `SIGINT` / `SIGTERM` with controlled teardown of the supervised
execution.

**Out (later tickets):**

| Deferred | Ticket |
|---|---|
| Real isolated git worktree + branch | Workspace Manager (TMP-003) |
| Real Claude Code adapter execution | AdapterRouter (TMP-004) |
| Implementer / Reviewer / Tester orchestration and `WorkCycle` transitions (`CLAIMED → IN_PROGRESS → REVIEWING …`) | Orchestration (TMP-005) |
| Full resume / recovery of an orphaned `IN_PROGRESS` cycle | TMP-006 |

The Worker Core therefore **does not** call `POST /transitions`,
`POST /checks`, `POST /queries`, or `POST /recover`. It only uses:
`listProjects`, `listReady`, `getTicket` (read-only) and `claim`,
`heartbeat`, `finishRun` (governed).

## The execution collaborator

Everything between `claim` and `finish` is delegated to an injected factory:

```js
createExecution({ ref, ticket, branch, run: { id } }) -> { done, cancel }
```

- The context carries **no `claimToken`** and the `ticket` is passed through
  `stripSecretKeys` first; `assertNoSecretKeys` re-checks it.
- `done` is a `Promise`. It resolves with an optional `{ outcome, note }`
  (`outcome: "FAILED"` maps to a `FAILED` Run; anything else → `RELEASED`), or
  rejects on a technical failure (→ `FAILED` Run).
- `cancel(reason)` must make `done` settle promptly; the Core calls it on
  shutdown and on fencing.

Until Workspace Manager / AdapterRouter / Orchestration land, `npm run worker`
wires **`createPlaceholderExecution`** (`src/worker/placeholder-execution.js`):
it touches nothing (no git, no filesystem, no Rail) and simply holds — the
Core keeps the Run alive by heartbeat — until `cancel()` (SIGINT/SIGTERM or
fencing).

## Claim preconditions (preflight)

Read-only, pure, in `src/worker/ticket-preflight.js`
(`assertTicketClaimable` / `isTicketClaimable`). Mirrors docs/STATE_MACHINE.md
1–4; any failure ⇒ skip the candidate, **no mutation**, message ends with
`No claim was created.`:

1. Ticket exists and `projectId` matches the configured project.
2. `state === "READY"`.
3. Not `blocked` (no open blocking Agent Query).
4. No existing `activeRun`.

Precondition 5 (`targetRepository` vs the local git `origin`) needs the
Workspace Manager and is intentionally **not** wired here yet.

## Atomic claim & the claimToken

`claim(ref, branch)` is the first and only mutation of the discovery path.
Rail creates the Run atomically from `state === "READY"`; two workers racing
the same ticket produce exactly one winner, and the loser's `claim` throws —
the Core logs it and returns to discovery.

A `2xx` claim whose normalized `run.id` / `run.claimToken` is missing is a
**contract error** (`CLAIM_CONTRACT_ERROR`): the Core does **not** retry and
does **not** continue without a `claimToken` — it aborts fatally
(docs/PROTOCOL.md).

**`claimToken` confinement.** The token is captured **only** in the closure of
the active-run record's `heartbeatOnce()` / `finish()` methods. It is never an
enumerable property, never logged, never in `getState()`, never handed to
`createExecution`. Tests assert its absence from every log line and from the
execution context, and its presence on the `heartbeat` / `finishRun` calls the
Core makes.

## Heartbeat supervisor

While a Run is active, a periodic timer renews the lease before
`leaseExpiresAt`:

- Interval: `heartbeatIntervalMs` (default `300000`; env
  `RAIL_HEARTBEAT_INTERVAL_MS`). **Must be shorter than the lease Rail
  grants** — otherwise the sweeper marks the Run `ABANDONED`.
- On success the Core stores the new `leaseExpiresAt` (in the closure only).
- The timer is `unref`'d: it never keeps the process alive on its own.
- No heartbeat is ever sent after the Run is finished or after ownership is
  lost.

## Fencing (lost ownership)

If `heartbeat` comes back as a **definitive ownership rejection** — HTTP
`401 / 403 / 404 / 409 / 410`, or an error `code` matching
`OWNERSHIP | NOT_OWNER | LEASE | ABANDONED | FENCED | FORBIDDEN | NOT_FOUND |
CONFLICT | EXPIRED` — the Core:

1. stops the heartbeat timer,
2. sets a fenced flag that blocks **all** further mutation of that Run,
3. cancels the active execution (`execution.cancel`),
4. does **not** call `finishRun` (it no longer owns the Run; Rail is
   authoritative),
5. returns to discovery to look for new work.

A transient failure (network error, `5xx`) is **not** fencing: it is logged
and retried on the next interval. If the lease truly lapsed, the following
heartbeat gets a definitive rejection and fencing happens then.

## Idle

When `listReady` returns nothing claimable, the Core logs an idle line,
sleeps `discoveryPollMs` (default `30000`; env `RAIL_DISCOVERY_POLL_MS`) and
polls again. It creates **no Run and no workspace** while idle. The sleep is
interruptible — a stop request wakes it immediately.

## Shutdown (SIGINT / SIGTERM)

`src/worker/cli.js` maps both signals to `worker.requestStop(reason)`:

- The Core stops claiming new work immediately.
- If an execution is active: `execution.cancel(reason)`, then — only if still
  owned — `finishRun({ outcome: "RELEASED", note, branch })`, then stop the
  heartbeat.
- If idle: the poll sleep is interrupted and the loop exits cleanly; no Run,
  nothing to finish.
- A **second** signal forces an immediate `process.exit`.

The Worker Core does **not** rewind the `WorkCycle` on shutdown (that is a
state-machine / Orchestration concern). A released Run leaves the cycle in
`CLAIMED` with no `activeRun`; Rail or a later ticket handles the tail.

## Observability

`worker.getState()` returns a secret-free snapshot:
`{ phase, stopRequested, stopReason, fenced, pollCount, claimsWon,
hasActiveExecution, activeRef, activeRunId, activeLeaseExpiresAt, lastError }`.

`WORKER_PHASES` (identifiers, untranslated): `INIT`, `CONNECTING`, `IDLE`,
`CLAIMING`, `EXECUTING`, `FENCING`, `STOPPING`, `STOPPED`.

## Configuration

| Env | Required | Default | Meaning |
|---|---|---|---|
| `RAIL_API_URL`, `RAIL_TOKEN`, `RAIL_PROJECT_ID`, `RAIL_REPO_PATH` | yes | — | see docs/PROTOCOL.md / `.env.example` |
| `RAIL_HEARTBEAT_INTERVAL_MS` | no | `300000` | lease-renewal interval (ms), must be `<` the Rail lease |
| `RAIL_DISCOVERY_POLL_MS` | no | `30000` | idle `READY`-queue poll interval (ms) |

## Tests

`test/worker-core.test.mjs`, `test/ticket-preflight.test.mjs`,
`test/worker-cli.test.mjs` — offline, zero-dependency, driven by an in-memory
Rail fake and injected timers/clock/sleep. Coverage: idle (no Run/workspace),
preflight-before-claim ordering, claim race (winner keeps ownership / loser
re-discovers), heartbeat lease renewal, heartbeat-rejection fencing (execution
cancelled, no post-fencing mutation), `SIGINT`/`SIGTERM` with and without an
active execution, claim contract error, connectivity validation, and
`claimToken` confinement.
