# PROTOCOL.md

The Rail ⇄ Harness wire protocol, as implemented by
`src/rail/rail-api-client.js`. Derived from the approved reference
(`~/rail-runner/harness/api/rail-api-client.js`). **Rail is authoritative for
states and gates**; this document describes only what the Harness sends and
expects.

> **Language:** endpoint paths, header names, JSON field names, state names
> and enum values in this document are wire values — never translated (see
> `docs/HARNESS.md`). Free-text the Harness authors (`reason`, `note`,
> `comment`, Agent Query `question` / `context` / `impact`) is in Spanish.

## Transport

- HTTPS JSON. `RAIL_API_URL` is the base (e.g. `https://<host>/api/rail`).
  `http://` is allowed only for `localhost`.
- Node 18+ global `fetch`. No third-party HTTP dependency.

## Headers (every request)

| Header | Value | Source |
|---|---|---|
| `Authorization` | `Bearer <RAIL_TOKEN>` | runtime config |
| `Content-Type` | `application/json` | fixed |
| `X-Rail-Agent` | agent label | `RAIL_AGENT` (default `rail-harness`) |
| `X-Rail-Machine` | machine id | `RAIL_MACHINE` (default hostname) |
| `X-Rail-Actor` | `agent` | fixed |

The token is attached by `RailApiClient` at request time. It is never logged
by the client and never returned to callers except inside a Run-handoff
object.

## Read-only operations (safe, no state change)

| Method | Path | Client method |
|---|---|---|
| GET | `/projects` | `listProjects()` |
| GET | `/projects/:id/environments` | `getEnvironments(projectId)` |
| GET | `/tickets?…` | `listTickets(params)` |
| GET | `/tickets?state=READY&kind=ticket&projectId=…` | `listReady(projectId, limit)` |
| GET | `/tickets/:ref` | `getTicket(ref)` |
| GET | `/tickets/:ref/queries` | `listQueries(ref)` |
| GET | `/tickets/:ref/checks[?all=1]` | `listChecks(ref, all)` |
| GET | `/tickets/:ref/deployments` | `listDeployments(ref)` |
| GET | `/tickets/:ref/approvals` | `listApprovals(ref)` |
| GET | `/tickets/:ref/timeline` | `timeline(ref)` |

All preflight/validation the Harness does before claiming work uses **only**
these.

## Governed mutating operations

| Method | Path | Client method | Effect |
|---|---|---|---|
| POST | `/tickets/:ref/claim` | `claim(ref, branch)` | Rail creates a Run from `state=READY` → `CLAIMED`. Returns a Run handoff. |
| POST | `/tickets/:ref/resume` | `resume(ref, {branch, worktreePath, lastRunId, reason})` | **GENERAL** continuation of ownership on a NON-terminal cycle (RAIL-D-00006). Preserves `WorkCycle.state` EXACTLY. Stale takeover (`activeRun` `ACTIVE`, `leaseExpiresAt <= now`) or ownerless resume (`activeRun == null`, last Run `state != ACTIVE` — `COMPLETED`/`RELEASED`/`FAILED`/`ABANDONED` all valid). Creates a new `ACTIVE` Run with `recoveryOfRunId = <old Run>`; the old Run stays terminal and untouched. Returns a Run handoff. May be absent (404/405/501). See `docs/RECOVERY.md`. |
| POST | `/tickets/:ref/recover` | `recover(ref, {branch, worktreePath, lastRunId, reason})` | **COMPAT** reclaim of an orphaned `IN_PROGRESS` cycle (`activeRun == null`, last Run `FAILED`/`ABANDONED`; RailSoft also allows an `IN_PROGRESS` stale takeover). Does **not** replace `/resume`. Returns a Run handoff. May be absent (404/405/501). See `docs/STATE_MACHINE.md`. |
| POST | `/tickets/:ref/transitions` | `transition(ref, {to, reason, runId})` | Request a `WorkCycle` state change. Rail validates. |
| POST | `/tickets/:ref/checks` | `createCheck(ref, {type, status, note, runId, …})` | Attach a check result (e.g. `IMPLEMENTATION/PASS`). |
| POST | `/tickets/:ref/queries` | `createQuery(ref, {question, context, impact, blocking, runId})` | Raise a blocking Agent Query for a human. |
| POST | `/tickets/:ref/comments` | `addComment(ref, content)` | Add a comment. |
| POST | `/tickets/:ref/deployments` | `createDeployment(…)` | Record a deployment. |
| PATCH | `/deployments/:id` | `updateDeployment(id, …)` | Update a deployment. |
| POST | `/runs/:runId/heartbeat` | `heartbeat(runId, claimToken)` | Extend the Run lease. Returns `{ leaseExpiresAt }`. |
| POST | `/runs/:runId/finish` | `finishRun(runId, payload)` | Close a Run with `{ claimToken, outcome, note, branch }`. |

The bootstrap ships the client for these; the control flow that calls them in
order is the Worker Core / Orchestration ticket.

## Run handoff normalization

`claim()`, `resume()` and `recover()` all return **one shape** via the SAME
`normalizeRunHandoff(data)` (not re-implemented per endpoint):

```jsonc
{
  "run":       { "id": "…", "claimToken": "…", "leaseExpiresAt": "…" },
  "recovered": { "fromRunId": "…" | null, "cycleState": "…" | null },
  "raw":       { /* original Rail response, untouched */ }
}
```

Rail returns the freshly-created Run under different keys per endpoint
(`run` for claim; `activeRun` + `recoveryOfRunId` + `cycle.state` for
resume / recover; sometimes top-level). Callers only ever read
`handoff.run.{id,claimToken,leaseExpiresAt}` and
`handoff.recovered.{fromRunId,cycleState}`. For `/resume`, `recovered.cycleState`
is the **preserved** cycle state (e.g. `REVIEWING`), not `IN_PROGRESS`.

A `2xx` response whose normalized `run.id` / `run.claimToken` is still
missing is a **contract error**, not an absent endpoint — the caller must not
retry the mutation and must not continue without a `claimToken`.

For `resume()` / `recover()` (RAIL-D-00006, `docs/RECOVERY.md`): on that
contract error the Harness does a **read-only `GET /tickets/:ref`** and reports
whether Rail nonetheless created an `activeRun` (the `claimToken` is never
printed). The Harness also fails closed when `recovered.fromRunId` is present
and ≠ the requested `lastRunId`, or when the new `run.id` equals `lastRunId`
(a continuation must produce a **new** Run). **None of these ever trigger a
fallback** — `resume` never falls back to `recover` or `claim`; `recover`
never falls back to `resume` or `claim`.

## Error shape

A non-2xx response throws an `Error` carrying `status`, `code`, `missing[]`
and `data`. `resume()` / `recover()` answering `404 / 405 / 501` (or a
`NOT_FOUND` / `NOT_IMPLEMENTED` / `UNKNOWN_ROUTE` / `METHOD_NOT_ALLOWED` code)
means that governed endpoint is not deployed; the Harness aborts the
continuation with **no alternative mutation** (no fallback to the other
endpoint, no `claim`).

## Heartbeat / lease

A claimed Run holds a lease. The owner must `heartbeat` before
`leaseExpiresAt` or Rail's sweeper marks the Run `ABANDONED`. The lease-live
rule the Harness mirrors is in `docs/STATE_MACHINE.md`.
