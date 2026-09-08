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
| POST | `/tickets/:ref/recover` | `recover(ref, {branch, worktreePath, lastRunId, reason})` | Governed reclaim of an orphaned `IN_PROGRESS` cycle. Returns a Run handoff. May be absent (404/405/501). See `docs/STATE_MACHINE.md`. |
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

`claim()` and `recover()` both return **one shape** via
`normalizeRunHandoff(data)`:

```jsonc
{
  "run":       { "id": "…", "claimToken": "…", "leaseExpiresAt": "…" },
  "recovered": { "fromRunId": "…" | null, "cycleState": "…" | null },
  "raw":       { /* original Rail response, untouched */ }
}
```

Rail returns the freshly-created Run under different keys per endpoint
(`run` for claim; `activeRun` + `recoveryOfRunId` + `cycle.state` for
recover; sometimes top-level). Callers only ever read
`handoff.run.{id,claimToken,leaseExpiresAt}` and
`handoff.recovered.{fromRunId,cycleState}`.

A `2xx` response whose normalized `run.id` / `run.claimToken` is still
missing is a **contract error**, not an absent endpoint — the caller must not
retry the mutation and must not continue without a `claimToken`.

## Error shape

A non-2xx response throws an `Error` carrying `status`, `code`, `missing[]`
and `data`. `recover()` answering `404 / 405 / 501` (or a `NOT_FOUND` /
`NOT_IMPLEMENTED` / `UNKNOWN_ROUTE` code) means the governed recover endpoint
is not deployed; the Harness aborts recovery with no alternative mutation.

## Heartbeat / lease

A claimed Run holds a lease. The owner must `heartbeat` before
`leaseExpiresAt` or Rail's sweeper marks the Run `ABANDONED`. The lease-live
rule the Harness mirrors is in `docs/STATE_MACHINE.md`.
