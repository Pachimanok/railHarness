# WORKSPACE_MANAGER.md

The **Workspace Manager** — RAIL-D-00003. Prepares one **isolated git
workspace per claimed ticket**, on the ticket's own branch, taken from the
authorized target repository, under a configured root. Implemented in
`src/workspace/workspace-manager.js`.

> **Language:** this document and the code comments are English by repo
> convention. Every human-facing line the Workspace Manager *emits at runtime*
> (logs, `Error` messages) is Spanish. Machine-readable values —
> `WORKSPACE_ERROR_CODES`, branch names, Rail field names — are never
> translated.

## Where it sits

Rail is the authority (`docs/HARNESS.md`). The Workspace Manager runs **only
after a valid `claim` / `resume`** — the Worker Core already owns the Run
lease. It is the physical boundary that guarantees a claimed ticket mutates
**only** its own repo and branch, inside its own directory.

```
Worker Core: claim OK ─▶ createExecution(ctx)  ─▶  Workspace Manager
                                                     ├─ validate targetRepository vs origin   (read-only)
                                                     ├─ resolve <root>/<ticket-code>          (never outside root)
                                                     ├─ git worktree add [-b rail/<code>] … base
                                                     └─ return { path, branch, baseBranch, … }
```

No real runtime (adapter / orchestration) is connected yet
(RAIL-D-00004+). Once the workspace is ready the execution **holds** — the
Core keeps the Run alive by heartbeat — until `cancel()` (SIGINT/SIGTERM or
fencing).

## Security invariants (enforced in code + tests)

1. **Never sees a `claimToken`.** `createWorkspaceExecution(ctx, …)` runs
   `assertNoSecretKeys(ctx)`; a secret-looking key anywhere in the context is
   a hard error (`WORKSPACE_BAD_CONFIG`). `prepareWorkspace` has no token
   parameter.
2. **Never writes a credential into the tree.** The Manager writes no files.
   Git subprocesses run with `safeEnvironment()` — every `RAIL_*` var and
   `CLAIM_TOKEN` stripped — so `git` itself never sees the control plane.
   `assertWorkspaceCleanOfSecrets(path, secrets)` proves it in tests.
3. **No mutation before a valid post-claim invocation, and none at all on a
   wrong/inconsistent repo.** The `targetRepository` ⇄ `origin` check and the
   existing-directory consistency checks are all read-only git plumbing and
   run **before** any `worktree add` / `checkout`.
4. **Operates only inside `RAIL_WORKSPACE_ROOT`.** `workspacePathFor` sanitizes
   the ticket code to a single path segment and asserts the result is a direct
   child of the resolved root; `assertInsideRoot` rejects anything else.
5. **Never destroys work it does not own.** An inconsistent, foreign, or
   dirty-on-another-branch directory is **rejected, not cleaned**.
   `cleanupWorkspace` removes only a worktree that is registered against the
   primary clone and inside the root, and refuses a dirty worktree unless
   `force`.

## Configuration

| Env | Required | Meaning |
|---|---|---|
| `RAIL_REPO_PATH` | yes | absolute path to the **primary clone** of the target repo; worktrees are added from here. |
| `RAIL_WORKSPACE_ROOT` | yes (for this component) | absolute directory; each ticket gets `‹root›/‹ticket-code›`. No machine-specific default. |
| `RAIL_BASE_BRANCH` | no | base branch for a brand-new ticket branch. Default: the primary clone's `origin/HEAD`, else `main`, else `master`. |

`src/config/runtime-config.js` exposes these as `config.repoPath`,
`config.workspaceRoot`, `config.baseBranch`. `describeConfig()` prints
`workspaceRoot` (or `(sin configurar)`), never a secret.

## Public API (`src/index.js`)

| Export | Purpose |
|---|---|
| `prepareWorkspace({ ticket, branch, workspaceRoot, repoPath, baseBranch?, ticketCode?, runGit?, logger?, env? })` | Create or safely reuse the isolated worktree. Returns `{ path, branch, baseBranch, repoFullName, created, reused }`. |
| `cleanupWorkspace({ workspaceRoot, repoPath, ticketCode? \| path?, branch?, force?, runGit?, logger? })` | Remove **only** this ticket's registered worktree. Idempotent. Returns `{ removed, path }`. |
| `createWorkspaceExecution(ctx, { workspaceRoot, repoPath, baseBranch?, runGit?, logger?, cleanupOnCancel?, prepare?, cleanup? })` | Adapter to the Worker Core's `createExecution` contract: prepares the workspace, exposes `ready` / `workspace`, holds until `cancel()`. `cleanupOnCancel` defaults to **false** — a workspace is valuable; cleanup is explicit. |
| `workspacePathFor(root, codeOrRef)` / `assertInsideRoot(root, p)` | Pure path-safety helpers. |
| `normalizeRepoSlug(url)` / `resolveTargetRepo(ticket)` | Normalize any git remote (or `owner/repo`) to a lowercase `owner/repo` slug; read the ticket's authorized slug. |
| `assertWorkspaceCleanOfSecrets(path, secrets, opts?)` | Walk the tree (skip `.git`) and throw if any file contains a given secret. |
| `WORKSPACE_ERROR_CODES` | `WORKSPACE_BAD_CONFIG`, `WORKSPACE_REPO_MISMATCH`, `WORKSPACE_INCONSISTENT`, `WORKSPACE_OUTSIDE_ROOT`, `WORKSPACE_NO_BASE_BRANCH`. |

## Branch / base-branch rules

- `branch` (mandatory) is the ticket branch the Worker Core computes,
  `rail/<ticket-code>`. The adapter must never switch branch later
  (`docs/ADAPTER_CONTRACT.md`).
- If `branch` already exists in the primary clone →
  `git worktree add ‹path› ‹branch›` (checks that branch out; no new ref).
- Otherwise → `git worktree add -b ‹branch› ‹path› ‹baseBranch›`.
- Reuse: an existing consistent worktree already on `branch` is returned
  as-is (`reused: true`). On a *different* branch it is repositioned **only**
  when clean; dirty ⇒ `WORKSPACE_INCONSISTENT` (no stomping).

## Rejection matrix

| Situation | Code | Effect |
|---|---|---|
| `workspaceRoot` / `repoPath` not absolute, `repoPath` not a git repo, unusable `targetRepository` | `WORKSPACE_BAD_CONFIG` | throw, nothing done |
| primary clone `origin` ≠ ticket `targetRepository` | `WORKSPACE_REPO_MISMATCH` | throw **before any mutation** |
| target path exists but is not a git worktree / not its own toplevel / not registered against the primary | `WORKSPACE_INCONSISTENT` | throw, **directory untouched** |
| existing worktree points at a different repo | `WORKSPACE_REPO_MISMATCH` | throw, directory untouched |
| existing worktree dirty on another branch | `WORKSPACE_INCONSISTENT` | throw, working changes preserved |
| computed path escapes the root / traversal | `WORKSPACE_OUTSIDE_ROOT` | throw |
| no base branch resolvable for a new branch | `WORKSPACE_NO_BASE_BRANCH` | throw |

## Tests

`test/workspace-manager.test.mjs` — offline and reproducible: every test
builds throwaway git repositories under `os.tmpdir()` with the real `git`
binary and removes them afterwards. No GitHub, no Rail. Coverage: isolated
workspace creation; branch creation vs selection of an existing branch;
base-branch honoured (arg + `RAIL_BASE_BRANCH`); `targetRepository` ⇄ `origin`
validation incl. SSH form; two tickets never share a workspace; safe
rejection on the wrong repo (with a "read-only git only" assertion);
inconsistent / foreign / unregistered / dirty-other-branch directories
rejected without deletion; idempotent reuse preserving uncommitted work; no
credential copied or serialized into the tree; `cleanupWorkspace` isolation /
idempotence / dirty-guard / outside-root guard; Worker Core wiring proving no
workspace exists before the claim and an isolated one after.
