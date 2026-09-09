/**
 * Workspace Manager — RAIL-D-00003 acceptance tests.
 *
 * Fully offline and reproducible: every test builds its own throwaway git
 * repositories under `os.tmpdir()` with the real `git` binary and removes them
 * afterwards. No GitHub, no Rail, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  prepareWorkspace,
  cleanupWorkspace,
  createWorkspaceExecution,
  workspacePathFor,
  workspaceSlug,
  assertInsideRoot,
  normalizeRepoSlug,
  resolveTargetRepo,
  assertWorkspaceCleanOfSecrets,
  WORKSPACE_ERROR_CODES
} from "../src/workspace/workspace-manager.js";

import { createWorkerCore, WORKER_PHASES } from "../src/worker/worker-core.js";

const AUTHORIZED = "Pachimanok/railHarness";
const AUTHORIZED_HTTPS = "https://github.com/Pachimanok/railHarness.git";
const FAKE_TOKEN = "rag_faketoken_supersecret_value";
const FAKE_CLAIM_TOKEN = "CT-claim-fake-abc123";

// ── temp git repo helpers ───────────────────────────────────────────────

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
}

function initPrimaryRepo(dir, { origin = AUTHORIZED_HTTPS } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.test"]);
  git(dir, ["config", "user.name", "Rail Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# temp primary\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  if (origin) git(dir, ["remote", "add", "origin", origin]);
  return dir;
}

/** Fresh sandbox: `{ base, primary, root }`, auto-removed after the test. */
function sandbox(t, primaryOpts) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rail-ws-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const primary = initPrimaryRepo(path.join(base, "primary"), primaryOpts);
  const root = path.join(base, "workspaces");
  return { base, primary, root };
}

function ticketDetail(code, repoFullName = AUTHORIZED) {
  return {
    item: { code, id: `tkt_${code}`, title: code },
    projectId: "proj_ws",
    state: "READY",
    targetRepository: { id: "repo_1", label: "Harness", repoFullName }
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────

test("normalizeRepoSlug acepta las formas usuales de remote y normaliza a owner/repo", () => {
  for (const url of [
    "git@github.com:Pachimanok/railHarness.git",
    "ssh://git@github.com/Pachimanok/railHarness.git",
    "https://github.com/Pachimanok/railHarness.git",
    "https://token@github.com/Pachimanok/railHarness",
    "Pachimanok/railHarness"
  ]) {
    assert.equal(normalizeRepoSlug(url), "pachimanok/railharness", url);
  }
  assert.equal(normalizeRepoSlug(""), null);
  assert.equal(normalizeRepoSlug("no-slash"), null);
});

test("workspaceSlug y workspacePathFor nunca escapan del root autorizado", () => {
  assert.equal(workspaceSlug("RAIL-D-00003"), "rail-d-00003");
  assert.equal(workspaceSlug("rail/rail-d-00003"), "rail-d-00003");

  const root = path.join(os.tmpdir(), "rail-root-x");
  const p = workspacePathFor(root, "../../evil");
  assert.equal(path.dirname(p), path.resolve(root), "queda como hijo directo del root");
  assert.ok(p.startsWith(path.resolve(root) + path.sep));

  assert.throws(() => workspacePathFor("relative/root", "x"), {
    code: WORKSPACE_ERROR_CODES.BAD_CONFIG
  });
  assert.throws(() => assertInsideRoot("/a/root", "/a/root/../evil"), {
    code: WORKSPACE_ERROR_CODES.OUTSIDE_ROOT
  });
  assert.throws(() => assertInsideRoot("/a/root", "/a/root"), {
    code: WORKSPACE_ERROR_CODES.OUTSIDE_ROOT
  });
});

test("resolveTargetRepo lee targetRepository.repoFullName del ticket o rechaza", () => {
  assert.equal(resolveTargetRepo(ticketDetail("RAIL-D-00003")), "pachimanok/railharness");
  assert.equal(resolveTargetRepo("Pachimanok/railHarness"), "pachimanok/railharness");
  assert.throws(() => resolveTargetRepo({ item: { code: "X" } }), {
    code: WORKSPACE_ERROR_CODES.BAD_CONFIG
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T3-AC-01 — crea/selecciona un workspace/branch aislado bajo el root y
// devuelve su ruta.
// ─────────────────────────────────────────────────────────────────────────

test("T3-AC-01: crea un worktree aislado bajo el root, en la branch del ticket desde la base", async t => {
  const { primary, root } = sandbox(t);
  const logs = [];

  const ws = await prepareWorkspace({
    ticket: ticketDetail("RAIL-D-00003"),
    branch: "rail/rail-d-00003",
    workspaceRoot: root,
    repoPath: primary,
    logger: l => logs.push(l)
  });

  assert.equal(ws.created, true);
  assert.equal(ws.reused, false);
  assert.equal(ws.branch, "rail/rail-d-00003");
  assert.equal(ws.baseBranch, "main");
  assert.equal(ws.repoFullName, "pachimanok/railharness");
  assert.ok(ws.path.startsWith(path.resolve(root) + path.sep), "queda dentro del root");
  assert.equal(path.basename(ws.path), "rail-d-00003");
  assert.ok(fs.existsSync(ws.path), "el worktree existe en disco");
  assert.equal(git(ws.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "rail/rail-d-00003");
  assert.equal(
    git(ws.path, ["rev-parse", "HEAD"]),
    git(primary, ["rev-parse", "main"]),
    "parte de la base branch"
  );
  assert.ok(logs.some(l => /[Ww]orkspace creado/.test(l)));
});

test("T3-AC-01: si la branch del ticket ya existe, hace checkout de ESA branch (no crea otra)", async t => {
  const { primary, root } = sandbox(t);
  git(primary, ["branch", "rail/rail-d-00003", "main"]);
  const branchSha = git(primary, ["rev-parse", "rail/rail-d-00003"]);

  const ws = await prepareWorkspace({
    ticket: ticketDetail("RAIL-D-00003"),
    branch: "rail/rail-d-00003",
    workspaceRoot: root,
    repoPath: primary
  });

  assert.equal(git(ws.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "rail/rail-d-00003");
  assert.equal(git(ws.path, ["rev-parse", "HEAD"]), branchSha);
});

test("T3-AC-01: respeta la base branch indicada (RAIL_BASE_BRANCH / arg)", async t => {
  const { primary, root } = sandbox(t);
  git(primary, ["checkout", "-q", "-b", "develop"]);
  git(primary, ["commit", "-q", "--allow-empty", "-m", "solo en develop"]);
  git(primary, ["checkout", "-q", "main"]);
  const developSha = git(primary, ["rev-parse", "develop"]);
  assert.notEqual(developSha, git(primary, ["rev-parse", "main"]));

  const viaArg = await prepareWorkspace({
    ticket: ticketDetail("RAIL-D-00050"),
    branch: "rail/rail-d-00050",
    baseBranch: "develop",
    workspaceRoot: root,
    repoPath: primary
  });
  assert.equal(viaArg.baseBranch, "develop");
  assert.equal(git(viaArg.path, ["rev-parse", "HEAD"]), developSha);

  const viaEnv = await prepareWorkspace({
    ticket: ticketDetail("RAIL-D-00051"),
    branch: "rail/rail-d-00051",
    workspaceRoot: root,
    repoPath: primary,
    env: { RAIL_BASE_BRANCH: "develop" }
  });
  assert.equal(viaEnv.baseBranch, "develop");
  assert.equal(git(viaEnv.path, ["rev-parse", "HEAD"]), developSha);
});

test("T3-AC-01: valida targetRepository contra el origin real (acepta la forma SSH)", async t => {
  const { primary, root } = sandbox(t, { origin: "git@github.com:Pachimanok/railHarness.git" });

  const ws = await prepareWorkspace({
    ticket: ticketDetail("RAIL-D-00003"),
    branch: "rail/rail-d-00003",
    workspaceRoot: root,
    repoPath: primary
  });
  assert.ok(fs.existsSync(ws.path));
  assert.equal(ws.repoFullName, "pachimanok/railharness");
});

// ─────────────────────────────────────────────────────────────────────────
// Aislamiento entre tickets.
// ─────────────────────────────────────────────────────────────────────────

test("dos tickets obtienen workspaces distintos y no se contaminan entre sí", async t => {
  const { primary, root } = sandbox(t);

  const a = await prepareWorkspace({
    ticket: ticketDetail("RAIL-D-00003"),
    branch: "rail/rail-d-00003",
    workspaceRoot: root,
    repoPath: primary
  });
  const b = await prepareWorkspace({
    ticket: ticketDetail("RAIL-D-00010"),
    branch: "rail/rail-d-00010",
    workspaceRoot: root,
    repoPath: primary
  });

  assert.notEqual(a.path, b.path);
  assert.ok(a.path.startsWith(path.resolve(root) + path.sep));
  assert.ok(b.path.startsWith(path.resolve(root) + path.sep));
  assert.notEqual(
    git(a.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(b.path, ["rev-parse", "--abbrev-ref", "HEAD"])
  );

  // A commit in A's workspace is invisible in B's.
  fs.writeFileSync(path.join(a.path, "solo-en-a.txt"), "trabajo de A\n");
  git(a.path, ["add", "-A"]);
  git(a.path, ["commit", "-q", "-m", "cambio de A"]);

  assert.ok(!fs.existsSync(path.join(b.path, "solo-en-a.txt")));
  assert.equal(git(b.path, ["log", "--oneline"]).includes("cambio de A"), false);
});

// ─────────────────────────────────────────────────────────────────────────
// Rechazo seguro ante repo equivocado — sin mutación.
// ─────────────────────────────────────────────────────────────────────────

test("rechazo seguro: origin != targetRepository => REPO_MISMATCH y NADA se crea", async t => {
  const { primary, root } = sandbox(t, { origin: "https://github.com/Pachimanok/otroRepo.git" });

  await assert.rejects(
    prepareWorkspace({
      ticket: ticketDetail("RAIL-D-00003"),
      branch: "rail/rail-d-00003",
      workspaceRoot: root,
      repoPath: primary
    }),
    err => {
      assert.equal(err.code, WORKSPACE_ERROR_CODES.REPO_MISMATCH);
      assert.match(err.message, /no corresponde/);
      return true;
    }
  );

  assert.ok(!fs.existsSync(path.join(root, "rail-d-00003")), "no se creó el workspace");
  const worktrees = git(primary, ["worktree", "list", "--porcelain"]);
  assert.equal(worktrees.split("\n").filter(l => l.startsWith("worktree ")).length, 1);
});

test("ante repo equivocado sólo se ejecutan comandos git de lectura (ninguna mutación)", async t => {
  const { primary, root } = sandbox(t, { origin: "https://github.com/Pachimanok/otroRepo.git" });
  const calls = [];
  const spyGit = (args, opts) => {
    calls.push(args);
    return execFileSync("git", args, {
      cwd: opts?.cwd,
      stdio: "pipe",
      encoding: "utf8"
    }).trim();
  };
  const MUTATING = new Set(["add", "commit", "checkout", "switch", "branch", "reset", "clean"]);

  await assert.rejects(
    prepareWorkspace({
      ticket: ticketDetail("RAIL-D-00003"),
      branch: "rail/rail-d-00003",
      workspaceRoot: root,
      repoPath: primary,
      runGit: spyGit
    }),
    { code: WORKSPACE_ERROR_CODES.REPO_MISMATCH }
  );

  assert.ok(calls.length > 0, "corrió al menos una verificación");
  for (const args of calls) {
    assert.ok(!MUTATING.has(args[0]), `comando mutante ejecutado: git ${args.join(" ")}`);
    if (args[0] === "worktree") {
      assert.equal(args[1], "list", `git worktree ${args[1]} no debería ejecutarse`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// T3-AC-02 — workspace previo inconsistente o fuera del root => rechazo sin
// borrar ni modificar trabajo ajeno.
// ─────────────────────────────────────────────────────────────────────────

test("T3-AC-02: un directorio no-git en la ruta del workspace => INCONSISTENT, no se borra", async t => {
  const { primary, root } = sandbox(t);
  const wsPath = path.join(root, "rail-d-00003");
  fs.mkdirSync(wsPath, { recursive: true });
  fs.writeFileSync(path.join(wsPath, "trabajo-ajeno.txt"), "no me borres\n");

  await assert.rejects(
    prepareWorkspace({
      ticket: ticketDetail("RAIL-D-00003"),
      branch: "rail/rail-d-00003",
      workspaceRoot: root,
      repoPath: primary
    }),
    { code: WORKSPACE_ERROR_CODES.INCONSISTENT }
  );

  assert.ok(fs.existsSync(path.join(wsPath, "trabajo-ajeno.txt")), "el trabajo ajeno sigue ahí");
  assert.equal(fs.readFileSync(path.join(wsPath, "trabajo-ajeno.txt"), "utf8"), "no me borres\n");
});

test("T3-AC-02: un repo git ajeno en la ruta del workspace => rechazo, no se toca", async t => {
  const { base, primary, root } = sandbox(t);
  const wsPath = path.join(root, "rail-d-00003");
  initPrimaryRepo(wsPath, { origin: "https://github.com/otra/cosa.git" });
  fs.writeFileSync(path.join(wsPath, "ajeno.txt"), "mío\n");

  await assert.rejects(
    prepareWorkspace({
      ticket: ticketDetail("RAIL-D-00003"),
      branch: "rail/rail-d-00003",
      workspaceRoot: root,
      repoPath: primary
    }),
    err => {
      assert.ok(
        [WORKSPACE_ERROR_CODES.REPO_MISMATCH, WORKSPACE_ERROR_CODES.INCONSISTENT].includes(err.code),
        `código inesperado: ${err.code}`
      );
      return true;
    }
  );

  assert.ok(fs.existsSync(path.join(wsPath, "ajeno.txt")), "no se borró el repo ajeno");
  assert.ok(base);
});

test("T3-AC-02: un worktree del repo correcto pero NO registrado en el primary => rechazo", async t => {
  const { primary, root } = sandbox(t);
  // A second, independent primary clone-alike with the SAME origin, whose
  // worktree lands on our target path but is not registered against `primary`.
  const other = initPrimaryRepo(path.join(path.dirname(root), "other-primary"), {
    origin: AUTHORIZED_HTTPS
  });
  const wsPath = path.join(root, "rail-d-00003");
  fs.mkdirSync(root, { recursive: true });
  git(other, ["worktree", "add", "-b", "rail/rail-d-00003", wsPath, "main"]);
  fs.writeFileSync(path.join(wsPath, "en-progreso.txt"), "trabajo\n");

  await assert.rejects(
    prepareWorkspace({
      ticket: ticketDetail("RAIL-D-00003"),
      branch: "rail/rail-d-00003",
      workspaceRoot: root,
      repoPath: primary
    }),
    { code: WORKSPACE_ERROR_CODES.INCONSISTENT }
  );
  assert.ok(fs.existsSync(path.join(wsPath, "en-progreso.txt")), "no se tocó el worktree ajeno");
});

test("T3-AC-02: workspace en otra branch con cambios sin commitear => no se reposiciona", async t => {
  const { primary, root } = sandbox(t);
  const first = await prepareWorkspace({
    ticket: ticketDetail("RAIL-D-00003"),
    branch: "rail/otra-branch",
    workspaceRoot: root,
    repoPath: primary,
    ticketCode: "RAIL-D-00003"
  });
  fs.writeFileSync(path.join(first.path, "wip.txt"), "a medias\n");

  await assert.rejects(
    prepareWorkspace({
      ticket: ticketDetail("RAIL-D-00003"),
      branch: "rail/rail-d-00003",
      workspaceRoot: root,
      repoPath: primary,
      ticketCode: "RAIL-D-00003"
    }),
    { code: WORKSPACE_ERROR_CODES.INCONSISTENT }
  );
  assert.equal(fs.readFileSync(path.join(first.path, "wip.txt"), "utf8"), "a medias\n");
  assert.equal(git(first.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "rail/otra-branch");
});

// ─────────────────────────────────────────────────────────────────────────
// Idempotencia.
// ─────────────────────────────────────────────────────────────────────────

test("idempotencia: preparar dos veces devuelve el mismo path y reutiliza sin tocar el trabajo", async t => {
  const { primary, root } = sandbox(t);
  const args = {
    ticket: ticketDetail("RAIL-D-00003"),
    branch: "rail/rail-d-00003",
    workspaceRoot: root,
    repoPath: primary
  };

  const first = await prepareWorkspace(args);
  assert.equal(first.created, true);

  fs.writeFileSync(path.join(first.path, "avance.txt"), "trabajo en curso\n");

  const second = await prepareWorkspace(args);
  assert.equal(second.path, first.path);
  assert.equal(second.created, false);
  assert.equal(second.reused, true);
  assert.equal(
    fs.readFileSync(path.join(first.path, "avance.txt"), "utf8"),
    "trabajo en curso\n",
    "el trabajo sin commitear se preserva"
  );
  assert.equal(
    git(primary, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter(l => l.startsWith("worktree ")).length,
    2,
    "no se agregó un worktree duplicado"
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Higiene de secretos: nada se copia/serializa al workspace.
// ─────────────────────────────────────────────────────────────────────────

test("ninguna credencial se copia o serializa dentro del workspace", async t => {
  const { primary, root } = sandbox(t);

  const ws = await prepareWorkspace({
    // el ticket llega con claves secretas: no deben aparecer en el workspace
    ticket: { ...ticketDetail("RAIL-D-00003"), token: FAKE_TOKEN, claimToken: FAKE_CLAIM_TOKEN },
    branch: "rail/rail-d-00003",
    workspaceRoot: root,
    repoPath: primary,
    env: { ...process.env, RAIL_TOKEN: FAKE_TOKEN, CLAIM_TOKEN: FAKE_CLAIM_TOKEN }
  });

  assert.doesNotThrow(() =>
    assertWorkspaceCleanOfSecrets(ws.path, [FAKE_TOKEN, FAKE_CLAIM_TOKEN])
  );
  assert.ok(!fs.existsSync(path.join(ws.path, ".env")), "no se escribió ningún .env");
  assert.ok(!JSON.stringify(ws).includes(FAKE_TOKEN));
  assert.ok(!JSON.stringify(ws).includes(FAKE_CLAIM_TOKEN));
});

test("assertWorkspaceCleanOfSecrets detecta un secreto realmente presente en el árbol", async t => {
  const { primary, root } = sandbox(t);
  const ws = await prepareWorkspace({
    ticket: ticketDetail("RAIL-D-00003"),
    branch: "rail/rail-d-00003",
    workspaceRoot: root,
    repoPath: primary
  });
  fs.writeFileSync(path.join(ws.path, "leak.txt"), `dejaste ${FAKE_TOKEN} acá\n`);
  assert.throws(() => assertWorkspaceCleanOfSecrets(ws.path, [FAKE_TOKEN]), {
    code: WORKSPACE_ERROR_CODES.INCONSISTENT
  });
});

// ─────────────────────────────────────────────────────────────────────────
// cleanupWorkspace — limpieza segura e idempotente.
// ─────────────────────────────────────────────────────────────────────────

test("cleanupWorkspace elimina sólo el worktree del ticket y es idempotente", async t => {
  const { primary, root } = sandbox(t);
  const a = await prepareWorkspace({
    ticket: ticketDetail("RAIL-D-00003"),
    branch: "rail/rail-d-00003",
    workspaceRoot: root,
    repoPath: primary
  });
  const b = await prepareWorkspace({
    ticket: ticketDetail("RAIL-D-00010"),
    branch: "rail/rail-d-00010",
    workspaceRoot: root,
    repoPath: primary
  });

  const r1 = await cleanupWorkspace({
    workspaceRoot: root,
    repoPath: primary,
    ticketCode: "RAIL-D-00003"
  });
  assert.equal(r1.removed, true);
  assert.ok(!fs.existsSync(a.path));
  assert.ok(fs.existsSync(b.path), "el otro ticket no se toca");
  assert.ok(
    git(primary, ["worktree", "list", "--porcelain"]).includes(b.path.replace(/\\/g, "/")) ||
      git(primary, ["worktree", "list"]).includes(path.basename(b.path))
  );

  const r2 = await cleanupWorkspace({
    workspaceRoot: root,
    repoPath: primary,
    ticketCode: "RAIL-D-00003"
  });
  assert.equal(r2.removed, false, "segunda llamada: no-op");
});

test("cleanupWorkspace no borra un directorio que no es un worktree registrado", async t => {
  const { primary, root } = sandbox(t);
  const stray = path.join(root, "rail-d-00099");
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, "algo.txt"), "contenido\n");

  await assert.rejects(
    cleanupWorkspace({ workspaceRoot: root, repoPath: primary, path: stray }),
    { code: WORKSPACE_ERROR_CODES.INCONSISTENT }
  );
  assert.ok(fs.existsSync(path.join(stray, "algo.txt")));
});

test("cleanupWorkspace no elimina un worktree sucio salvo force", async t => {
  const { primary, root } = sandbox(t);
  const ws = await prepareWorkspace({
    ticket: ticketDetail("RAIL-D-00003"),
    branch: "rail/rail-d-00003",
    workspaceRoot: root,
    repoPath: primary
  });
  fs.writeFileSync(path.join(ws.path, "sin-commitear.txt"), "cambios\n");

  await assert.rejects(
    cleanupWorkspace({ workspaceRoot: root, repoPath: primary, ticketCode: "RAIL-D-00003" }),
    { code: WORKSPACE_ERROR_CODES.INCONSISTENT }
  );
  assert.ok(fs.existsSync(ws.path), "sigue en disco");

  const forced = await cleanupWorkspace({
    workspaceRoot: root,
    repoPath: primary,
    ticketCode: "RAIL-D-00003",
    force: true
  });
  assert.equal(forced.removed, true);
  assert.ok(!fs.existsSync(ws.path));
});

test("cleanupWorkspace rechaza una ruta fuera del root sin ejecutar git", async t => {
  const { primary, root } = sandbox(t);
  let gitCalls = 0;
  await assert.rejects(
    cleanupWorkspace({
      workspaceRoot: root,
      repoPath: primary,
      path: path.join(os.tmpdir(), "definitivamente-fuera-del-root"),
      runGit: (...a) => {
        gitCalls += 1;
        return "";
      }
    }),
    { code: WORKSPACE_ERROR_CODES.OUTSIDE_ROOT }
  );
  assert.equal(gitCalls, 0, "no se ejecutó ningún comando git");
});

// ─────────────────────────────────────────────────────────────────────────
// Integración con la superficie del Worker Core (createExecution inyectable).
// ─────────────────────────────────────────────────────────────────────────

test("createWorkspaceExecution: prepara el workspace, expone la ruta y libera al cancelar", async t => {
  const { primary, root } = sandbox(t);
  const logs = [];
  const ctx = {
    ref: "RAIL-D-00003",
    ticket: ticketDetail("RAIL-D-00003"),
    branch: "rail/rail-d-00003",
    run: { id: "run-1" }
  };

  const ex = createWorkspaceExecution(ctx, {
    workspaceRoot: root,
    repoPath: primary,
    logger: l => logs.push(l)
  });

  const ws = await ex.ready;
  assert.ok(ws.path.startsWith(path.resolve(root) + path.sep));
  assert.ok(fs.existsSync(ws.path));
  assert.equal(ex.workspace.path, ws.path);

  let settled = false;
  ex.done.then(() => {
    settled = true;
  });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(settled, false, "se mantiene vivo hasta la cancelación (sin runtime real)");

  await ex.cancel("Señal SIGTERM recibida");
  const result = await ex.done;
  assert.equal(result.outcome, "RELEASED");
  assert.equal(result.workspacePath, ws.path);
  assert.ok(fs.existsSync(ws.path), "por defecto NO se borra el workspace al cancelar");
  for (const l of logs) assert.ok(!String(l).includes(FAKE_TOKEN));
  assert.ok(logs.some(l => /[Ww]orkspace listo/.test(l)));
});

test("createWorkspaceExecution: un ctx con claimToken es un error duro", () => {
  assert.throws(
    () =>
      createWorkspaceExecution(
        {
          ref: "RAIL-D-00003",
          ticket: ticketDetail("RAIL-D-00003"),
          branch: "rail/rail-d-00003",
          run: { id: "run-1" },
          claimToken: FAKE_CLAIM_TOKEN
        },
        { workspaceRoot: "/tmp/x", repoPath: "/tmp/y" }
      ),
    { code: WORKSPACE_ERROR_CODES.BAD_CONFIG }
  );
});

test("createWorkspaceExecution: si la preparación falla, `done` se rechaza (=> FAILED en el Core)", async t => {
  const { primary, root } = sandbox(t, { origin: "https://github.com/Pachimanok/otroRepo.git" });
  const ex = createWorkspaceExecution(
    {
      ref: "RAIL-D-00003",
      ticket: ticketDetail("RAIL-D-00003"),
      branch: "rail/rail-d-00003",
      run: { id: "run-1" }
    },
    { workspaceRoot: root, repoPath: primary }
  );
  await assert.rejects(ex.ready, { code: WORKSPACE_ERROR_CODES.REPO_MISMATCH });
  await assert.rejects(ex.done, { code: WORKSPACE_ERROR_CODES.REPO_MISMATCH });
});

test("Worker Core + createWorkspaceExecution: ninguna mutación antes del claim; workspace aislado después", async t => {
  const { primary, root } = sandbox(t);
  const PID = "proj_ws";
  const isoIn = ms => new Date(Date.now() + ms).toISOString();

  function fakeRail(ticketState) {
    const calls = { claim: [], finishRun: [], heartbeat: [] };
    const st = { claimed: false };
    return {
      calls,
      async listProjects() {
        return { items: [{ id: PID }] };
      },
      async listReady() {
        const offer = !st.claimed && ticketState === "READY";
        return { items: offer ? [{ item: { code: "RAIL-D-00003", id: "t1" } }] : [] };
      },
      async getTicket() {
        return { ...ticketDetail("RAIL-D-00003"), projectId: PID, state: ticketState };
      },
      async claim(ref, branch) {
        calls.claim.push({ ref, branch });
        st.claimed = true;
        return { run: { id: "run-1", claimToken: "CT-x-secret-1", leaseExpiresAt: isoIn(1_800_000) } };
      },
      async heartbeat(runId, claimToken) {
        calls.heartbeat.push({ runId, claimToken });
        return { leaseExpiresAt: isoIn(1_800_000) };
      },
      async finishRun(runId, payload) {
        calls.finishRun.push({ runId, payload });
        return { ok: true };
      }
    };
  }

  // 1) BACKLOG: el worker nunca reclama => nunca se crea un workspace.
  {
    const api = fakeRail("BACKLOG");
    let worker;
    worker = createWorkerCore({
      api,
      projectId: PID,
      createExecution: ctx =>
        createWorkspaceExecution(ctx, { workspaceRoot: root, repoPath: primary }),
      sleep: async () => worker.requestStop("fin"),
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
      logger: () => {}
    });
    await worker.start();
    assert.equal(api.calls.claim.length, 0);
    assert.ok(!fs.existsSync(path.join(root, "rail-d-00003")), "sin claim no hay workspace");
  }

  // 2) READY: reclama, prepara el workspace aislado bajo el root, y al parar
  //    cierra el Run como RELEASED.
  {
    const api = fakeRail("READY");
    let worker;
    const logs = [];
    worker = createWorkerCore({
      api,
      projectId: PID,
      createExecution: ctx =>
        createWorkspaceExecution(ctx, {
          workspaceRoot: root,
          repoPath: primary,
          logger: l => logs.push(l)
        }),
      sleep: async () => {},
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
      logger: l => logs.push(l)
    });
    const startP = worker.start();
    const wsPath = path.join(root, "rail-d-00003");
    const t0 = Date.now();
    while (Date.now() - t0 < 2000 && !fs.existsSync(wsPath)) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(api.calls.claim.length, 1, "reclamó exactamente una vez");
    assert.ok(fs.existsSync(wsPath), "el workspace se creó tras el claim");
    assert.equal(git(wsPath, ["rev-parse", "--abbrev-ref", "HEAD"]), "rail/rail-d-00003");
    assert.ok(wsPath.startsWith(path.resolve(root) + path.sep));

    worker.requestStop("Señal SIGINT recibida");
    await startP;
    assert.equal(worker.getState().phase, WORKER_PHASES.STOPPED);
    assert.equal(api.calls.finishRun.length, 1);
    assert.equal(api.calls.finishRun[0].payload.outcome, "RELEASED");
    for (const l of logs) assert.ok(!String(l).includes("CT-x-secret-1"), "el claimToken no se loguea");
  }
});
