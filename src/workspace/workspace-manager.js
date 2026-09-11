/**
 * Workspace Manager — RAIL-D-00003.
 *
 * Prepares one ISOLATED git workspace per claimed ticket, under a configured
 * workspace root, on the ticket's own branch, taken from the authorized target
 * repository. It runs ONLY after a valid `claim` / `resume` (the Worker Core
 * owns the Run lease). Rail stays the authority (docs/HARNESS.md).
 *
 * Hard rules this module enforces (see the ticket AC + docs):
 *   - It never knows or receives a `claimToken`; its context is asserted
 *     secret-free (`assertNoSecretKeys`).
 *   - It never writes RAIL_TOKEN / claimToken / any credential into a
 *     workspace. Git subprocesses run with `safeEnvironment()` (every `RAIL_*`
 *     var stripped) so git itself never sees the control plane.
 *   - No mutation happens before this module is explicitly invoked, and — on a
 *     wrong repo or an inconsistent/foreign workspace — no mutation happens at
 *     all: the read-only checks run first and throw before any `worktree add`
 *     / `checkout`.
 *   - Every ticket gets its own directory keyed by ticket code; one ticket can
 *     never share or contaminate another's workspace.
 *   - It operates ONLY inside the configured workspace root and never deletes
 *     or rewrites work it does not own.
 *
 * Git strategy: `git worktree` from the primary clone (`RAIL_REPO_PATH`) into
 * `<workspaceRoot>/<ticket-code>`. Separate working tree + index + HEAD per
 * ticket, shared object store, deterministic plumbing commands only.
 *
 * Human-facing text (logs / Error messages) is Spanish; machine-readable
 * identifiers — the `WORKSPACE_ERROR_CODES`, branch names, Rail field names —
 * are never translated.
 */

import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

import { SECRET_KEY_RE, safeEnvironment } from "../security/sanitize.js";

/** Machine-readable failure codes. Identifiers — never translated. */
export const WORKSPACE_ERROR_CODES = Object.freeze({
  BAD_CONFIG: "WORKSPACE_BAD_CONFIG",
  REPO_MISMATCH: "WORKSPACE_REPO_MISMATCH",
  INCONSISTENT: "WORKSPACE_INCONSISTENT",
  OUTSIDE_ROOT: "WORKSPACE_OUTSIDE_ROOT",
  NO_BASE_BRANCH: "WORKSPACE_NO_BASE_BRANCH"
});

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Throw if `node` carries a secret-looking KEY anywhere. The Workspace Manager
 * must never see a `claimToken` or any credential (defense in depth; mirrors
 * the Worker Core's own guard).
 */
export function assertNoSecretKeys(node, pathLabel = "workspaceContext") {
  if (node == null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (SECRET_KEY_RE.test(key)) {
      throw fail(
        WORKSPACE_ERROR_CODES.BAD_CONFIG,
        `El contexto del Workspace Manager no puede contener secretos: ${pathLabel}.${key}`
      );
    }
    assertNoSecretKeys(value, `${pathLabel}.${key}`);
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Normalize any git remote URL (or a bare `owner/repo`) to a lowercase
 * `owner/repo` slug. Returns `null` when it cannot be parsed. Pure.
 *
 *   git@github.com:Owner/Repo.git        -> owner/repo
 *   ssh://git@github.com/Owner/Repo.git  -> owner/repo
 *   https://github.com/Owner/Repo.git    -> owner/repo
 *   https://x@github.com/Owner/Repo      -> owner/repo
 *   Owner/Repo                           -> owner/repo
 */
export function normalizeRepoSlug(url) {
  let s = String(url ?? "").trim();
  if (!s) return null;
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");

  // scp-like syntax: git@host:owner/repo
  const scp = s.match(/^[^/@]+@[^/:]+:(.+)$/);
  if (scp) s = scp[1];
  // explicit scheme: strip "<scheme>://<userinfo@>host/"
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "");
  }

  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  if (!owner || !repo) return null;
  return `${owner}/${repo}`.toLowerCase();
}

/** ticket code / ref / branch -> filesystem-safe directory slug. Pure. */
export function workspaceSlug(codeOrRef) {
  return String(codeOrRef ?? "")
    .trim()
    .replace(/^rail\//i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * Resolve the absolute, isolated workspace directory for a ticket. Throws
 * (`BAD_CONFIG` / `OUTSIDE_ROOT`) rather than ever returning a path outside the
 * root or a traversal. Pure.
 */
export function workspacePathFor(workspaceRoot, codeOrRef) {
  const root = requireAbsolute(workspaceRoot, "workspaceRoot");
  const slug = workspaceSlug(codeOrRef);
  if (!slug) {
    throw fail(
      WORKSPACE_ERROR_CODES.BAD_CONFIG,
      `No se pudo derivar un nombre de workspace válido de "${codeOrRef}".`
    );
  }
  const resolved = path.resolve(root, slug);
  assertInsideRoot(root, resolved);
  if (path.dirname(resolved) !== path.resolve(root)) {
    throw fail(
      WORKSPACE_ERROR_CODES.OUTSIDE_ROOT,
      `El workspace calculado (${resolved}) no es hijo directo del root autorizado (${root}).`
    );
  }
  return resolved;
}

function requireAbsolute(value, label) {
  const v = String(value ?? "").trim();
  if (!v || !path.isAbsolute(v)) {
    throw fail(
      WORKSPACE_ERROR_CODES.BAD_CONFIG,
      `${label} debe ser una ruta absoluta (recibí ${JSON.stringify(value)}).`
    );
  }
  return v;
}

/** Throw `OUTSIDE_ROOT` unless `candidate` is strictly inside `root`. Pure. */
export function assertInsideRoot(root, candidate) {
  const rr = path.resolve(String(root ?? ""));
  const pp = path.resolve(String(candidate ?? ""));
  if (pp === rr || !pp.startsWith(rr + path.sep)) {
    throw fail(
      WORKSPACE_ERROR_CODES.OUTSIDE_ROOT,
      `La ruta ${pp} está fuera del workspace root autorizado (${rr}). Operación rechazada.`
    );
  }
  return pp;
}

/**
 * Read the ticket's authorized target repository slug (`owner/repo`).
 * Accepts a Rail ticket detail (`{ targetRepository: { repoFullName } }`) or a
 * bare string. Throws `BAD_CONFIG` when absent/unparseable. Pure.
 */
export function resolveTargetRepo(ticketOrName) {
  const raw =
    typeof ticketOrName === "string"
      ? ticketOrName
      : ticketOrName?.targetRepository?.repoFullName ??
        ticketOrName?.targetRepository?.fullName ??
        ticketOrName?.item?.targetRepository?.repoFullName ??
        null;
  const slug = normalizeRepoSlug(raw);
  if (!slug) {
    throw fail(
      WORKSPACE_ERROR_CODES.BAD_CONFIG,
      "El ticket no declara un targetRepository.repoFullName utilizable; " +
        "el Workspace Manager no puede validar el repositorio."
    );
  }
  return slug;
}

// ── Git runner (deterministic, injectable) ───────────────────────────────

/**
 * Default git runner: synchronous, deterministic plumbing calls. Git runs with
 * `safeEnvironment()` — every `RAIL_*` var and `CLAIM_TOKEN` removed — so the
 * subprocess never sees the control plane, and prompts are disabled.
 *
 * Returns trimmed stdout. On a non-zero exit throws an Error carrying
 * `status` / `stderr` (callers that expect a possible failure wrap it).
 */
export function defaultRunGit(args, { cwd } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...safeEnvironment(process.env), GIT_TERMINAL_PROMPT: "0" }
    }).trim();
  } catch (err) {
    const e = new Error(
      `git ${args.join(" ")} falló` +
        (err.stderr ? `: ${String(err.stderr).trim()}` : ` (${err.message})`)
    );
    e.status = typeof err.status === "number" ? err.status : null;
    e.stderr = err.stderr ? String(err.stderr) : null;
    e.gitArgs = args;
    throw e;
  }
}

function gitOk(runGit, args, opts) {
  try {
    runGit(args, opts);
    return true;
  } catch {
    return false;
  }
}

function isGitWorktree(runGit, dir) {
  try {
    return runGit(["rev-parse", "--is-inside-work-tree"], { cwd: dir }) === "true";
  } catch {
    return false;
  }
}

function currentBranch(runGit, dir) {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
}

function isDirty(runGit, dir) {
  return runGit(["status", "--porcelain"], { cwd: dir }).trim().length > 0;
}

function localBranchExists(runGit, repoPath, branch) {
  return gitOk(
    runGit,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoPath }
  );
}

function anyRefExists(runGit, repoPath, ref) {
  return gitOk(runGit, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repoPath
  });
}

/** Parsed `git worktree list --porcelain` -> array of absolute worktree paths. */
function listWorktreePaths(runGit, repoPath) {
  let out;
  try {
    out = runGit(["worktree", "list", "--porcelain"], { cwd: repoPath });
  } catch {
    return [];
  }
  const paths = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(path.resolve(line.slice("worktree ".length)));
  }
  return paths;
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function samePath(a, b) {
  return realpath(a) === realpath(b);
}

function resolveBaseBranch({ runGit, repoPath, baseBranch, env }) {
  const explicit =
    (baseBranch && String(baseBranch).trim()) ||
    (env && String(env.RAIL_BASE_BRANCH ?? "").trim());
  if (explicit) {
    if (!anyRefExists(runGit, repoPath, explicit)) {
      throw fail(
        WORKSPACE_ERROR_CODES.NO_BASE_BRANCH,
        `La base branch indicada (${explicit}) no existe en ${repoPath}.`
      );
    }
    return explicit;
  }
  try {
    const head = runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: repoPath
    });
    const short = head.replace(/^origin\//, "").trim();
    if (short && anyRefExists(runGit, repoPath, short)) return short;
  } catch {
    /* no remote HEAD — fall through */
  }
  for (const candidate of ["main", "master"]) {
    if (localBranchExists(runGit, repoPath, candidate)) return candidate;
  }
  throw fail(
    WORKSPACE_ERROR_CODES.NO_BASE_BRANCH,
    "No se pudo determinar la base branch. Configurá RAIL_BASE_BRANCH."
  );
}

// ── prepareWorkspace ────────────────────────────────────────────────────

/**
 * Prepare (create or safely reuse) the isolated git workspace for a claimed
 * ticket and return its path to the caller (the Worker Core).
 *
 * @param {object} p
 * @param {object|string} p.ticket        Rail ticket detail (secret-stripped is fine) or `owner/repo`.
 * @param {string} p.branch               the ticket branch, e.g. `rail/rail-d-00003` (mandatory).
 * @param {string} p.workspaceRoot        absolute configured workspace root (RAIL_WORKSPACE_ROOT).
 * @param {string} p.repoPath             absolute path to the primary clone (RAIL_REPO_PATH).
 * @param {string|null} [p.baseBranch]    base branch for a brand-new ticket branch.
 * @param {string|null} [p.ticketCode]    explicit dir key; default: ticket code / branch.
 * @param {Function} [p.runGit]           injectable git runner (args, {cwd}) -> stdout.
 * @param {(msg:string)=>void} [p.logger] Spanish human sink.
 * @param {object} [p.env]                env for base-branch detection. Default: process.env.
 *
 * @returns {Promise<{path:string, branch:string, baseBranch:string,
 *                     repoFullName:string, created:boolean, reused:boolean}>}
 */
export async function prepareWorkspace({
  ticket,
  branch,
  workspaceRoot,
  repoPath,
  baseBranch = null,
  ticketCode = null,
  runGit = defaultRunGit,
  logger = () => {},
  env = process.env
} = {}) {
  const log = msg => {
    try {
      logger(String(msg));
    } catch {
      /* a broken logger must never break workspace prep */
    }
  };

  if (typeof branch !== "string" || !branch.trim()) {
    throw fail(WORKSPACE_ERROR_CODES.BAD_CONFIG, "branch es obligatorio (rail/<código>).");
  }
  const root = requireAbsolute(workspaceRoot, "workspaceRoot");
  const primary = requireAbsolute(repoPath, "repoPath");

  if (!isGitWorktree(runGit, primary)) {
    throw fail(
      WORKSPACE_ERROR_CODES.BAD_CONFIG,
      `repoPath (${primary}) no es un repositorio Git.`
    );
  }

  // 1. Authorized-repo validation — READ-ONLY, before any mutation.
  const repoFullName = resolveTargetRepo(ticket);
  let originUrl = null;
  try {
    originUrl = runGit(["remote", "get-url", "origin"], { cwd: primary });
  } catch {
    originUrl = null;
  }
  const originSlug = normalizeRepoSlug(originUrl);
  if (!originSlug || originSlug !== repoFullName) {
    throw fail(
      WORKSPACE_ERROR_CODES.REPO_MISMATCH,
      `El repositorio local (${primary}, origin=${originSlug ?? "desconocido"}) no corresponde ` +
        `al targetRepository del ticket (${repoFullName}). No se preparó ningún workspace.`
    );
  }

  const dirKey = ticketCode || ticket?.item?.code || ticket?.code || branch;
  const wsPath = workspacePathFor(root, dirKey);
  const resolvedBase = resolveBaseBranch({ runGit, repoPath: primary, baseBranch, env });

  // 2. Existing directory: reuse only if it is a consistent worktree of THIS
  //    repo, registered against the primary clone, inside the root. Otherwise
  //    reject WITHOUT deleting or modifying anything.
  if (fs.existsSync(wsPath)) {
    const stat = fs.statSync(wsPath);
    if (!stat.isDirectory()) {
      throw fail(
        WORKSPACE_ERROR_CODES.INCONSISTENT,
        `El path del workspace (${wsPath}) existe y no es un directorio. No se toca.`
      );
    }
    if (!isGitWorktree(runGit, wsPath)) {
      throw fail(
        WORKSPACE_ERROR_CODES.INCONSISTENT,
        `Ya existe ${wsPath} y no es un worktree Git. Podría contener trabajo ajeno; ` +
          "no se borra ni se modifica."
      );
    }
    let top = null;
    try {
      top = runGit(["rev-parse", "--show-toplevel"], { cwd: wsPath });
    } catch {
      top = null;
    }
    if (!top || !samePath(top, wsPath)) {
      throw fail(
        WORKSPACE_ERROR_CODES.INCONSISTENT,
        `${wsPath} no es la raíz de su propio worktree (toplevel=${top ?? "desconocido"}). No se toca.`
      );
    }
    let wsOrigin = null;
    try {
      wsOrigin = normalizeRepoSlug(runGit(["remote", "get-url", "origin"], { cwd: wsPath }));
    } catch {
      wsOrigin = null;
    }
    if (wsOrigin !== repoFullName) {
      throw fail(
        WORKSPACE_ERROR_CODES.REPO_MISMATCH,
        `El workspace existente ${wsPath} apunta a ${wsOrigin ?? "un repo desconocido"}, ` +
          `no a ${repoFullName}. No se borra ni se modifica.`
      );
    }
    const registered = listWorktreePaths(runGit, primary).some(p => samePath(p, wsPath));
    if (!registered) {
      throw fail(
        WORKSPACE_ERROR_CODES.INCONSISTENT,
        `${wsPath} no está registrado como worktree de ${primary}. Es un checkout ajeno; no se toca.`
      );
    }

    const onBranch = currentBranch(runGit, wsPath);
    if (onBranch === branch) {
      log(`Workspace reutilizado para ${dirKey}: ${wsPath} (branch ${branch}).`);
      return {
        path: wsPath,
        branch,
        baseBranch: resolvedBase,
        repoFullName,
        created: false,
        reused: true
      };
    }
    if (isDirty(runGit, wsPath)) {
      throw fail(
        WORKSPACE_ERROR_CODES.INCONSISTENT,
        `El workspace ${wsPath} está en la branch ${onBranch} con cambios sin commitear. ` +
          `No se cambia a ${branch} para no pisar trabajo en curso.`
      );
    }
    if (localBranchExists(runGit, primary, branch)) {
      runGit(["checkout", branch], { cwd: wsPath });
    } else {
      runGit(["checkout", "-b", branch, resolvedBase], { cwd: wsPath });
    }
    log(`Workspace ${wsPath} reposicionado de ${onBranch} a ${branch} (estaba limpio).`);
    return {
      path: wsPath,
      branch,
      baseBranch: resolvedBase,
      repoFullName,
      created: false,
      reused: true
    };
  }

  // 3. Fresh worktree. Parent root is created if missing; the leaf is created
  //    by `git worktree add`.
  fs.mkdirSync(root, { recursive: true });
  if (localBranchExists(runGit, primary, branch)) {
    runGit(["worktree", "add", wsPath, branch], { cwd: primary });
    log(`Workspace creado para ${dirKey}: ${wsPath} sobre la branch existente ${branch}.`);
  } else {
    runGit(["worktree", "add", "-b", branch, wsPath, resolvedBase], { cwd: primary });
    log(
      `Workspace creado para ${dirKey}: ${wsPath} en nueva branch ${branch} desde ${resolvedBase}.`
    );
  }
  return {
    path: wsPath,
    branch,
    baseBranch: resolvedBase,
    repoFullName,
    created: true,
    reused: false
  };
}

// ── cleanupWorkspace ────────────────────────────────────────────────────

/**
 * Remove ONLY this ticket's worktree, and only when it is a registered
 * worktree of the primary clone, inside the authorized root. Never `rm -rf`s a
 * path, never touches anything outside the root, never removes a worktree with
 * uncommitted changes unless `force`. Idempotent: a no-op when nothing is
 * there.
 *
 * @returns {Promise<{removed:boolean, path:string}>}
 */
export async function cleanupWorkspace({
  workspaceRoot,
  repoPath,
  ticketCode = null,
  branch = null,
  path: explicitPath = null,
  force = false,
  runGit = defaultRunGit,
  logger = () => {}
} = {}) {
  const log = msg => {
    try {
      logger(String(msg));
    } catch {
      /* ignore */
    }
  };
  const primary = requireAbsolute(repoPath, "repoPath");
  const root = requireAbsolute(workspaceRoot, "workspaceRoot");

  const wsPath = explicitPath
    ? assertInsideRoot(root, path.resolve(explicitPath))
    : workspacePathFor(root, ticketCode || branch);

  if (!fs.existsSync(wsPath)) {
    log(`Nada que limpiar: ${wsPath} no existe.`);
    return { removed: false, path: wsPath };
  }
  const registered = listWorktreePaths(runGit, primary).some(p => samePath(p, wsPath));
  if (!registered) {
    throw fail(
      WORKSPACE_ERROR_CODES.INCONSISTENT,
      `${wsPath} no es un worktree registrado de ${primary}. No se elimina nada.`
    );
  }
  if (!force && isDirty(runGit, wsPath)) {
    throw fail(
      WORKSPACE_ERROR_CODES.INCONSISTENT,
      `El workspace ${wsPath} tiene cambios sin commitear. No se elimina (usá force para forzar).`
    );
  }
  runGit(
    ["worktree", "remove", ...(force ? ["--force"] : []), wsPath],
    { cwd: primary }
  );
  log(`Workspace ${wsPath} eliminado con "git worktree remove".`);
  return { removed: true, path: wsPath };
}

// ── Secret-hygiene assertion for the workspace tree ─────────────────────

/**
 * Walk every non-`.git` file under `wsPath` and throw if any contains one of
 * `secrets`. Used to prove no credential is ever copied/serialized into a
 * workspace. Bounded, deterministic, read-only.
 */
export function assertWorkspaceCleanOfSecrets(wsPath, secrets = [], { maxBytes = 5_000_000 } = {}) {
  const needles = secrets.map(s => String(s ?? "")).filter(s => s.length >= 4);
  if (!needles.length) return;
  const root = path.resolve(wsPath);

  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let text;
      try {
        if (fs.statSync(full).size > maxBytes) continue;
        text = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      for (const needle of needles) {
        if (text.includes(needle)) {
          throw fail(
            WORKSPACE_ERROR_CODES.INCONSISTENT,
            `Se encontró un secreto serializado en el workspace: ${path.relative(root, full)}.`
          );
        }
      }
    }
  };
  walk(root);
}

// ── Read-only worktree inspection (RAIL-D-00006 recovery) ──────────────

/**
 * READ-ONLY inspection of the isolated worktree a recovery would reuse. Runs
 * ONLY non-mutating git plumbing (`rev-parse`, `status --porcelain`,
 * `worktree list`, `remote get-url`) — never `checkout` / `reset` / `clean` /
 * `worktree add`. A dirty worktree is EXPECTED in recovery and is reported,
 * not treated as an error.
 *
 * @param {object} p
 * @param {string} p.workspaceRoot      absolute configured workspace root.
 * @param {string} p.repoPath           absolute path to the primary clone.
 * @param {string} p.dirKey             ticket code / branch → workspace dir slug.
 * @param {Function} [p.runGit]         injectable git runner.
 * @returns {{ path:string, exists:boolean, isWorktree:boolean, toplevel:string|null,
 *             isRoot:boolean, branch:string|null, dirty:boolean|null,
 *             originSlug:string|null, registered:boolean }}
 */
export function inspectWorktree({
  workspaceRoot,
  repoPath,
  dirKey,
  runGit = defaultRunGit
} = {}) {
  const root = requireAbsolute(workspaceRoot, "workspaceRoot");
  const primary = requireAbsolute(repoPath, "repoPath");
  const wsPath = workspacePathFor(root, dirKey);

  const base = {
    path: wsPath,
    exists: false,
    isWorktree: false,
    toplevel: null,
    isRoot: false,
    branch: null,
    dirty: null,
    originSlug: null,
    registered: false
  };

  if (!fs.existsSync(wsPath)) return Object.freeze(base);
  base.exists = true;

  let stat;
  try {
    stat = fs.statSync(wsPath);
  } catch {
    return Object.freeze(base);
  }
  if (!stat.isDirectory()) return Object.freeze(base);

  base.isWorktree = isGitWorktree(runGit, wsPath);
  if (!base.isWorktree) return Object.freeze(base);

  try {
    base.toplevel = runGit(["rev-parse", "--show-toplevel"], { cwd: wsPath });
  } catch {
    base.toplevel = null;
  }
  base.isRoot = Boolean(base.toplevel && samePath(base.toplevel, wsPath));

  try {
    base.branch = currentBranch(runGit, wsPath);
  } catch {
    base.branch = null;
  }
  try {
    base.dirty = isDirty(runGit, wsPath);
  } catch {
    base.dirty = null;
  }
  try {
    base.originSlug = normalizeRepoSlug(
      runGit(["remote", "get-url", "origin"], { cwd: wsPath })
    );
  } catch {
    base.originSlug = null;
  }
  base.registered = listWorktreePaths(runGit, primary).some(p => samePath(p, wsPath));

  return Object.freeze(base);
}

// ── Worker Core integration (injectable `createExecution`) ──────────────

/**
 * Adapt the Workspace Manager to the Worker Core's `createExecution` contract
 * (`(ctx) => { done, cancel }`). It prepares the isolated workspace for the
 * claimed ticket, exposes the path (`ready` / `workspace`), then HOLDS — no
 * real runtime is connected yet (RAIL-D-00004+). The Core keeps the Run alive
 * by heartbeat until `cancel()` (SIGINT/SIGTERM or fencing).
 *
 * `ctx` is `{ ref, ticket, branch, run: { id } }` — asserted secret-free; a
 * `claimToken` here is a hard error.
 *
 * @param {object} ctx
 * @param {object} opts
 * @param {string} opts.workspaceRoot
 * @param {string} opts.repoPath
 * @param {string|null} [opts.baseBranch]
 * @param {Function} [opts.runGit]
 * @param {(msg:string)=>void} [opts.logger]
 * @param {boolean} [opts.cleanupOnCancel]   default false — a workspace is
 *                                           valuable; cleanup is explicit.
 * @param {Function} [opts.prepare]          injectable (tests).
 */
export function createWorkspaceExecution(
  ctx,
  {
    workspaceRoot,
    repoPath,
    baseBranch = null,
    runGit = defaultRunGit,
    logger = () => {},
    cleanupOnCancel = false,
    prepare = prepareWorkspace,
    cleanup = cleanupWorkspace
  } = {}
) {
  assertNoSecretKeys(ctx);

  const log = msg => {
    try {
      logger(String(msg));
    } catch {
      /* ignore */
    }
  };

  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  let prepared = null;
  let failed = null;
  let cancelled = false;

  const ready = prepare({
    ticket: ctx?.ticket,
    branch: ctx?.branch,
    baseBranch,
    workspaceRoot,
    repoPath,
    runGit,
    logger
  })
    .then(ws => {
      prepared = ws;
      log(
        `Workspace listo para ${ctx?.ref}: ${ws.path} ` +
          `(branch ${ws.branch}, base ${ws.baseBranch}, ${ws.created ? "creado" : "reutilizado"}). ` +
          "Sin runtime conectado todavía: el Run se mantiene vivo hasta la cancelación."
      );
      return ws;
    })
    .catch(err => {
      failed = err;
      log(`No se pudo preparar el workspace para ${ctx?.ref}: ${err.message}`);
      rejectDone(err); // -> Worker Core cierra el Run como FAILED
      throw err;
    });

  return {
    done,
    /** Resolves with the prepared workspace `{ path, branch, ... }`. */
    ready,
    get workspace() {
      return prepared;
    },
    async cancel(reason = "cancelación solicitada") {
      if (cancelled) return;
      cancelled = true;
      await ready.catch(() => {});
      if (failed) return; // `done` already rejected

      if (cleanupOnCancel && prepared) {
        try {
          await cleanup({
            workspaceRoot,
            repoPath,
            path: prepared.path,
            runGit,
            logger
          });
        } catch (err) {
          log(`La limpieza del workspace falló: ${err.message}`);
        }
      }
      resolveDone({
        outcome: "RELEASED",
        note: prepared
          ? `Workspace ${prepared.path} preparado; sin runtime conectado. Cierre: ${reason}.`
          : `El workspace no llegó a prepararse. Cierre: ${reason}.`,
        workspacePath: prepared?.path ?? null
      });
    }
  };
}
