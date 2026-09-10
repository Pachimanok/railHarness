/**
 * Claude Code adapter — RAIL-D-00004.
 *
 * The executable half of the claude-code adapter: the `preflight()` that shells
 * out to the real CLI and the `run(envelope)` that executes Claude Code
 * non-interactively inside an isolated workspace and returns a structured
 * `ExecutionResult`. The pure flag-detection helpers stay in
 * `src/adapters/claude-preflight.js`.
 *
 * Roles (docs/ADAPTER_CONTRACT.md): Rail governs the workflow; the Harness owns
 * the Run and the workspace; this adapter ONLY transforms code inside a given
 * worktree and returns a result. It never calls Rail, never commits / pushes /
 * merges / switches branch, never touches the network.
 *
 * Security invariants enforced here:
 *   - The child process runs with `safeEnvironment()` — every `RAIL_*` var and
 *     `CLAIM_TOKEN` stripped — so Claude Code never sees the control plane.
 *   - `cwd` is exclusively `envelope.workspace.path`; the branch is verified to
 *     equal `envelope.run.branch` BEFORE the CLI is spawned.
 *   - `spawn` with a structured argv — never a shell string, no interpolation.
 *   - stdout / stderr are captured in a bounded buffer.
 *   - The full prompt and the ticket detail are never logged.
 *   - `--permission-prompts` is never passed (docs/ADAPTER_CONTRACT.md); the
 *     permission posture is `--permission-mode auto` plus an allow/deny tool
 *     list. In `--print` mode with no SDK host, anything that would prompt is
 *     denied (never hangs). NOTE (RAIL-D-00004 Tester): the deny-list is a hard
 *     block, but `--allowedTools` is NOT a closed set under `auto` — the
 *     classifier auto-approves other non-deny-listed commands, and `Write` /
 *     `Edit` are not confined to `workspace.path`. This is not an OS sandbox;
 *     strong FS/network isolation is a `SANDBOX`/`STAGING` concern
 *     (docs/ADAPTER_ROUTER.md "Follow-ups for hardening").
 *
 * DELIBERATE DEVIATION FROM THE REFERENCE (`~/rail-runner/harness/adapters/
 * claude-code.mjs`): the reference keeps `--permission-prompts none` and
 * `--no-chrome`; this adapter drops `--permission-prompts` entirely per the
 * ticket, and drops `--no-chrome` because the Chrome integration is not enabled
 * for a `--tools`-restricted run.
 */

import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";

import {
  REQUIRED_CLAUDE_FLAGS,
  missingClaudeFlags,
  flagPresent
} from "./claude-preflight.js";
import {
  EXECUTION_RESULT_JSON_SCHEMA,
  parseExecutionResult
} from "../contracts/execution-result.js";
import {
  validateExecutionEnvelope,
  assertNoSecrets
} from "../contracts/execution-envelope.js";
import { safeEnvironment } from "../security/sanitize.js";

/** The CLI binary and the provider key the AdapterRouter registers this under. */
export const CLAUDE_BIN = "claude";
export const CLAUDE_PROVIDER = "claude-code";

/** Built-in tools Claude Code may use inside the workspace (nothing else). */
export const CLAUDE_TOOLS = "Read,Edit,Write,Glob,Grep,Bash";

/**
 * Explicitly auto-approved invocations: read / search / edit, plus read-only
 * `git` and the common test / lint / build / typecheck runners. This list is
 * NOT the whole approval surface: under `--permission-mode auto` the CLI
 * classifier may also auto-approve other commands that are not in
 * `CLAUDE_DISALLOWED_TOOLS` (RAIL-D-00004 Tester). The deny-list below is the
 * hard boundary; this list just spells out the expected happy path.
 */
export const CLAUDE_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",

  "Bash(git status *)",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git branch --show-current)",
  "Bash(git rev-parse *)",
  "Bash(git ls-files *)",

  "Bash(npm test *)",
  "Bash(npm run test *)",
  "Bash(npm run lint *)",
  "Bash(npm run typecheck *)",
  "Bash(npm run build *)",

  "Bash(pnpm test *)",
  "Bash(pnpm lint *)",
  "Bash(pnpm build *)",
  "Bash(pnpm typecheck *)",

  "Bash(yarn test *)",
  "Bash(yarn lint *)",
  "Bash(yarn build *)",
  "Bash(yarn typecheck *)",

  "Bash(pytest *)",
  "Bash(python -m pytest *)",
  "Bash(go test *)",
  "Bash(cargo test *)"
].join(",");

/**
 * Explicitly denied — never auto-approved and never eligible for a prompt.
 * Defense in depth on top of `--permission-mode auto`: the mutating `git`
 * verbs, branch switching, and every network fetch the ticket forbids.
 */
export const CLAUDE_DISALLOWED_TOOLS = [
  "Bash(git commit *)",
  "Bash(git push *)",
  "Bash(git merge *)",
  "Bash(git rebase *)",
  "Bash(git reset *)",
  "Bash(git checkout *)",
  "Bash(git switch *)",
  "Bash(git clean *)",
  "Bash(git stash *)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(nc *)",
  "Bash(ssh *)",
  "WebFetch",
  "WebSearch"
].join(",");

/**
 * Flags `buildClaudeArgs` uses on TOP of `REQUIRED_CLAUDE_FLAGS`. Kept small
 * and verified in `preflight()` too, so "the adapter uses only options the
 * installed CLI supports" holds for the whole argv, not just the core list.
 */
export const EXTRA_CLAUDE_FLAGS = Object.freeze(["--disallowedTools"]);

/** CLI flags the Harness must never pass (docs/ADAPTER_CONTRACT.md). */
export const FORBIDDEN_CLAUDE_FLAGS = Object.freeze(["--permission-prompts"]);

const DEFAULT_KILL_GRACE_MS = 2000;
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;

/**
 * Guard the JSON Schema that goes into `claude --json-schema`. Pure, offline,
 * no version detection.
 *
 * Claude Code (verified on 2.1.266) bundles a **draft-07** JSON Schema
 * validator. A schema that declares a `$schema` meta-ref the CLI does not know
 * (draft 2019-09 / 2020-12) is rejected up front with
 * `--json-schema is not a valid JSON Schema: no schema with key or ref "..."`
 * and the whole run exits non-zero — every IMPLEMENT/RECOVERY would fail
 * (RAIL-D-00004 Tester finding). This does not re-implement schema validation;
 * it only refuses to emit a payload we know the CLI throws on.
 *
 * Rule: `$schema` must be **absent** (preferred, reference-aligned) or pin
 * draft-07. The schema must also stay a closed object.
 *
 * @param {object} schema  the object serialized into `--json-schema`
 * @returns {object} the same `schema` on success
 */
export function assertClaudeJsonSchemaCompatible(schema) {
  if (!schema || typeof schema !== "object") {
    throw new Error("El JSON Schema para --json-schema debe ser un objeto.");
  }
  const meta = schema.$schema;
  if (meta != null && !/draft-07/.test(String(meta))) {
    throw new Error(
      `El JSON Schema para --json-schema declara $schema=${JSON.stringify(meta)}, que la CLI ` +
        "de Claude Code (validador draft-07) no reconoce y hace fallar el run entero. " +
        "Quitá la propiedad $schema (preferido) o fijá draft-07."
    );
  }
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    throw new Error(
      "El JSON Schema para --json-schema debe ser un object cerrado (additionalProperties:false)."
    );
  }
  return schema;
}

// ── preflight ───────────────────────────────────────────────────────────

/**
 * Real preflight: run `claude --version` and `claude --help`, then confirm the
 * installed CLI supports every flag in `REQUIRED_CLAUDE_FLAGS`. Throws — with a
 * human, Spanish message ending in `No claim was created.` — before any Run is
 * claimed if the binary is missing or a required flag is absent.
 *
 * `--permission-prompts` is NOT checked and is never required.
 *
 * @param {object} [p]
 * @param {(args:string[]) => string} [p.runCli]  injectable CLI runner (tests).
 * @returns {{ version: string, flags: string[] }}
 */
export function preflight({ runCli } = {}) {
  const run =
    runCli ||
    (args =>
      execFileSync(CLAUDE_BIN, args, {
        encoding: "utf8",
        env: { ...safeEnvironment(process.env), GIT_TERMINAL_PROMPT: "0" }
      }));

  let version;
  try {
    version = String(run(["--version"])).trim();
  } catch (err) {
    throw new Error(
      `No pude ejecutar '${CLAUDE_BIN} --version'. ¿Está '${CLAUDE_BIN}' instalado y en el PATH? ` +
        `${err.message}\nNo claim was created.`
    );
  }

  let helpText;
  try {
    helpText = String(run(["--help"]));
  } catch (err) {
    throw new Error(
      `No pude ejecutar '${CLAUDE_BIN} --help': ${err.message}\nNo claim was created.`
    );
  }

  const missing = [
    ...missingClaudeFlags(helpText),
    ...EXTRA_CLAUDE_FLAGS.filter(flag => !flagPresent(helpText, flag))
  ];
  if (missing.length) {
    throw new Error(
      [
        `La CLI de Claude Code instalada (${version || "versión desconocida"}) no soporta los ` +
          `flags requeridos para ejecución no interactiva: ${missing.join(", ")}.`,
        "El adapter necesita esos flags para correr con salida JSON estructurada y sesión controlada.",
        "Actualizá la CLI de Claude Code o revisá 'claude --help'. El flag --permission-prompts NO se usa.",
        "No claim was created."
      ].join("\n")
    );
  }

  // Fail before any claim if the structured-output schema is not one this CLI
  // accepts (e.g. a re-introduced draft 2020-12 `$schema`).
  try {
    assertClaudeJsonSchemaCompatible(EXECUTION_RESULT_JSON_SCHEMA);
  } catch (err) {
    throw new Error(`${err.message}\nNo claim was created.`);
  }

  return { version, flags: [...REQUIRED_CLAUDE_FLAGS] };
}

// ── prompt construction (pure) ─────────────────────────────────────────

const OUTPUT_RULES = [
  "DECISIÓN DE SALIDA (respondé ÚNICAMENTE con el schema JSON solicitado):",
  "",
  "IMPLEMENTED: la implementación está hecha y la verificaste razonablemente.",
  "BLOCKED:     necesitás una respuesta humana concreta. 'question' es obligatorio",
  "             y no puede estar vacío; completá también 'context' e 'impact'.",
  "RELEASE:     el ticket, la SPEC, el proyecto o el repositorio no corresponden,",
  "             o continuar sería conceptualmente incorrecto. No implementes.",
  "FAILED:      hubo un problema técnico que impide completar y no es una",
  "             decisión de negocio.",
  "",
  "Toda comunicación humana (summary, question, context, impact y cualquier",
  "explicación) va en español. No traduzcas los valores machine-readable: enums,",
  "estados del WorkCycle y del Run, outcomes ni tipos de check."
].join("\n");

function hardRules(branch) {
  return [
    "REGLAS OBLIGATORIAS:",
    `- Trabajá exclusivamente dentro del worktree actual; la branch debe ser ${branch}.`,
    "- No hagas git commit, git push, git merge, git rebase, git reset, git checkout,",
    "  git switch, git clean ni git stash. No cambies de branch.",
    "- No uses curl, wget ni ningún acceso a la red. No llames a la API de Rail.",
    "- No inventes reglas de negocio ni arquitectura que el repo o la SPEC no justifiquen.",
    "- No amplíes el alcance. Preservá el comportamiento no relacionado.",
    "- Inspeccioná el código relevante antes de editar.",
    "- Ejecutá solamente las verificaciones/tests permitidos que correspondan."
  ].join("\n");
}

/** IMPLEMENT prompt. `envelope.ticket` is already secret-stripped. */
export function buildImplementPrompt(envelope) {
  const { run, ticket, languagePolicy } = envelope;
  return [
    languagePolicy.instruction,
    "",
    "Sos el IMPLEMENTER del Rail Harness. Rail gobierna el workflow; vos sólo",
    "trabajás sobre el código del worktree.",
    "",
    `RUN: ${run.id}`,
    `BRANCH OBLIGATORIA: ${run.branch}`,
    "",
    "TICKET Y SPEC:",
    JSON.stringify(ticket, null, 2),
    "",
    hardRules(run.branch),
    "",
    OUTPUT_RULES
  ].join("\n");
}

/** RECOVERY (continuation) prompt: a cycle already started; do NOT restart. */
export function buildRecoveryPrompt(envelope) {
  const { run, ticket, continuation, languagePolicy } = envelope;
  const c = continuation || {};
  const feedback = (c.pendingFeedback || []).length
    ? c.pendingFeedback.map((f, i) => `${i + 1}. ${f}`).join("\n")
    : "(Rail no devolvió feedback estructurado; revisá el Code Review fallido y la SPEC.)";
  const changed = (c.changedFiles || []).length
    ? c.changedFiles.map(f => `  - ${f}`).join("\n")
    : "  (git no reporta cambios; verificá igualmente el estado del worktree)";
  return [
    languagePolicy.instruction,
    "",
    "Sos el IMPLEMENTER del Rail Harness y estás RETOMANDO un ciclo ya empezado.",
    "NO es un arranque en frío: ya hay implementación sin commitear en el worktree.",
    "",
    `RUN (nuevo, del recovery): ${run.id}`,
    `BRANCH OBLIGATORIA (la misma de antes): ${run.branch}`,
    "",
    "PRIMER PASO OBLIGATORIO — antes de modificar nada: ejecutá 'git status' y",
    "'git diff', leé el diff completo y entendé qué ya está hecho y qué falta.",
    "",
    "ARCHIVOS YA MODIFICADOS EN EL WORKTREE:",
    changed,
    "",
    `IMPLEMENTATION PASS PREVIO: ${
      c.priorImplementationNote || "(no disponible; inferí del diff actual)"
    }`,
    `CODE REVIEW FALLIDO: ${
      c.failedReviewNote || "(nota no disponible; usá el feedback de abajo)"
    }`,
    "",
    "FEEDBACK PENDIENTE A RESOLVER:",
    feedback,
    "",
    "TICKET Y SPEC:",
    JSON.stringify(ticket, null, 2),
    "",
    hardRules(run.branch),
    "- Además: NO descartes el trabajo sin commitear (nada de reset/checkout/clean/stash); es válido.",
    "",
    OUTPUT_RULES
  ].join("\n");
}

/** Resume prompt: a human answered the blocking Agent Query. */
export function buildResumePrompt(envelope) {
  const { run, languagePolicy, resumeAnswer, kind } = envelope;
  return [
    languagePolicy.instruction,
    "",
    "La Agent Query que bloqueaba este Rail Run fue respondida por un humano.",
    "",
    "RESPUESTA HUMANA:",
    String(resumeAnswer),
    "",
    `Retomá exactamente el ticket y el contexto anterior en la branch ${run.branch}.`,
    kind === "RECOVERY"
      ? "Seguís en una continuación: no empieces de cero y no descartes el trabajo sin commitear."
      : "Continuá desde donde quedó la implementación.",
    "Si la respuesta confirma que el ticket/repositorio/proyecto no corresponde,",
    "devolvé RELEASE y no implementes. Si resuelve la duda, continuá.",
    "Mantené todas las reglas originales (sin commit/push/merge, sin cambiar de branch,",
    "sin red, sin llamar a Rail).",
    "",
    OUTPUT_RULES
  ].join("\n");
}

/** Pick the prompt for this envelope. */
export function buildPrompt(envelope) {
  if (envelope.resumeAnswer != null) return buildResumePrompt(envelope);
  if (envelope.kind === "RECOVERY") return buildRecoveryPrompt(envelope);
  return buildImplementPrompt(envelope);
}

// ── argv construction (pure) ──────────────────────────────────────────

/**
 * Whether this execution reuses an existing Claude Code conversation
 * (`--resume`) rather than opening a new one (`--session-id` + `--name`).
 *
 * A RECOVERY continues the session that corresponds to the recovered cycle; a
 * resume after a human-answered Agent Query continues the blocked session. Both
 * "recuperan una conversación existente" and must NOT mint a new one.
 */
export function isResumingSession(envelope) {
  return envelope.kind === "RECOVERY" || envelope.resumeAnswer != null;
}

/**
 * Build the structured argv for a non-interactive Claude Code run. Pure — no
 * shell, no interpolation; the prompt is a single final argument.
 */
export function buildClaudeArgs(envelope) {
  assertClaudeJsonSchemaCompatible(EXECUTION_RESULT_JSON_SCHEMA);
  const args = [
    "--print",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(EXECUTION_RESULT_JSON_SCHEMA),
    "--permission-mode",
    "auto",
    "--tools",
    CLAUDE_TOOLS,
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS,
    "--disallowedTools",
    CLAUDE_DISALLOWED_TOOLS
  ];

  const sid = String(envelope.session.id);
  if (isResumingSession(envelope)) {
    args.push("--resume", sid);
  } else {
    args.push("--session-id", sid, "--name", `rail-${sid.slice(0, 8)}`);
  }

  args.push(buildPrompt(envelope));
  return args;
}

// ── pre-run guards ────────────────────────────────────────────────────

function defaultRunGit(args, { cwd } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...safeEnvironment(process.env), GIT_TERMINAL_PROMPT: "0" }
  })
    .toString()
    .trim();
}

/**
 * Read-only checks that must pass BEFORE Claude Code is spawned. Throws (in
 * Spanish) on any failure; nothing is executed. Returns the validated `cwd`.
 */
function assertRunnable(envelope, { existsSync, runGit }) {
  const v = validateExecutionEnvelope(envelope);
  if (!v.valid) {
    throw new Error(
      `ExecutionEnvelope inválido; no se ejecuta Claude Code: ${v.errors.join("; ")}`
    );
  }
  // Defense in depth: no claimToken / credential may reach the adapter.
  assertNoSecrets(envelope);

  const cwd = envelope.workspace.path;
  if (!existsSync(cwd)) {
    throw new Error(`El workspace ${cwd} no existe en disco; no se ejecuta Claude Code.`);
  }

  let branch;
  try {
    branch = String(runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).trim();
  } catch (err) {
    throw new Error(`No pude verificar la branch del workspace ${cwd}: ${err.message}`);
  }
  if (branch !== envelope.run.branch) {
    throw new Error(
      `El workspace ${cwd} está en la branch "${branch}" pero el Run exige "${envelope.run.branch}". ` +
        "El adapter no cambia de branch; se aborta antes de ejecutar Claude Code."
    );
  }
  return cwd;
}

// ── execution ─────────────────────────────────────────────────────────

/**
 * Start one Claude Code execution. Returns a handle compatible with the Worker
 * Core's cancel/fencing path:
 *
 *   { sessionId, done, cancel(reason?) }
 *
 * `done` resolves with `{ sessionId, result }` (a validated `ExecutionResult`)
 * or REJECTS on a technical failure / invalid output / cancellation. It never
 * fabricates an `IMPLEMENTED`. `cancel()` terminates the child process
 * (SIGTERM, then SIGKILL after a grace window) so no orphan is left behind.
 *
 * @param {object} envelope   validated ExecutionEnvelope
 * @param {object} [opts]
 * @param {Function} [opts.spawn]        injectable child spawner (tests)
 * @param {string}   [opts.bin]          CLI binary (default "claude")
 * @param {Function} [opts.existsSync]   injectable fs.existsSync (tests)
 * @param {Function} [opts.runGit]       injectable git runner for the branch check
 * @param {number}   [opts.killGraceMs]  SIGTERM→SIGKILL grace window
 * @param {(msg:string)=>void} [opts.logger]  Spanish sink; NEVER receives the prompt/ticket
 */
function startClaudeExecution(
  envelope,
  {
    spawn = nodeSpawn,
    bin = CLAUDE_BIN,
    existsSync = fs.existsSync,
    runGit = defaultRunGit,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    logger = () => {}
  } = {}
) {
  const log = msg => {
    try {
      logger(String(msg));
    } catch {
      /* a broken logger must never break execution */
    }
  };

  const cwd = assertRunnable(envelope, { existsSync, runGit });
  const args = buildClaudeArgs(envelope);
  const sessionId = String(envelope.session.id);

  // `closed` flips only when the child actually emitted `close`/`error` — it is
  // the ONLY reliable "the process really ended" signal. `child.killed` is NOT:
  // Node sets it as soon as a signal is *sent*, even if the process ignores it.
  const controller = {
    cancelled: false,
    cancelReason: null,
    child: null,
    closed: false,
    sigkillTimer: null
  };

  log(
    `Claude Code: ${envelope.kind} sesión rail-${sessionId.slice(0, 8)} ` +
      `en branch ${envelope.run.branch} (cwd=${cwd}). ` +
      "El prompt completo y el ticket no se registran."
  );

  const collected = new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: { ...safeEnvironment(process.env), GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      reject(new Error(`No pude iniciar '${bin}': ${err.message}`));
      return;
    }
    controller.child = child;

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString();
    });
    child.stderr?.on("data", chunk => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString();
    });
    child.on("error", err => {
      controller.closed = true;
      if (controller.sigkillTimer) clearTimeout(controller.sigkillTimer);
      reject(new Error(`Falló el proceso de Claude Code: ${err.message}`));
    });
    child.on("close", code => {
      controller.closed = true;
      if (controller.sigkillTimer) clearTimeout(controller.sigkillTimer);
      resolve({ stdout, stderr, code });
    });
  });

  const done = collected.then(({ stdout, stderr, code }) => {
    if (controller.cancelled) {
      throw new Error(
        `La ejecución de Claude Code fue cancelada: ${
          controller.cancelReason || "cancelación solicitada"
        }.`
      );
    }
    if (code !== 0) {
      const tail = stderr ? `\n${stderr.slice(-2000)}` : "";
      throw new Error(
        `Claude Code terminó con código ${code} y sin un ExecutionResult válido. ` +
          `Se reporta como fallo técnico; no se fabrica IMPLEMENTED.${tail}`
      );
    }
    // parseExecutionResult throws on: salida vacía, JSON inválido, wrapper
    // inesperado, schema inválido. Ninguno se promociona a IMPLEMENTED.
    const result = parseExecutionResult(stdout);
    return { sessionId, result };
  });

  function cancel(reason = "cancelación solicitada") {
    // Idempotent: only the first call sends a signal or schedules the escalation.
    if (controller.cancelled) return;
    controller.cancelled = true;
    controller.cancelReason = reason;
    log(`Claude Code: cancelación solicitada (${reason}); se termina el proceso hijo.`);

    const child = controller.child;
    if (!child || controller.closed || child.exitCode != null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    // Escalate to SIGKILL only if the child has NOT really ended by then.
    // Gate on `controller.closed` / `exitCode` — never on `child.killed`
    // (true the moment SIGTERM was sent, regardless of the child).
    const t = setTimeout(() => {
      try {
        if (!controller.closed && controller.child && controller.child.exitCode == null) {
          controller.child.kill("SIGKILL");
        }
      } catch {
        /* ignore */
      }
    }, killGraceMs);
    controller.sigkillTimer = t;
    if (t && typeof t.unref === "function") t.unref();
  }

  return {
    sessionId,
    done,
    cancel,
    get child() {
      return controller.child;
    }
  };
}

/**
 * `run(envelope)` per docs/ADAPTER_CONTRACT.md.
 *
 * @param {object} envelope  validated ExecutionEnvelope
 * @param {object} [opts]    same injectables as `startClaudeExecution`, plus an
 *                           optional `signal` (AbortSignal) that cancels the run.
 * @returns {Promise<{ sessionId: string, result: object }>}
 */
export async function run(envelope, opts = {}) {
  const exec = startClaudeExecution(envelope, opts);

  const signal = opts.signal;
  if (signal) {
    if (signal.aborted) {
      exec.cancel("AbortSignal ya abortado");
    } else {
      signal.addEventListener("abort", () => exec.cancel("AbortSignal abortado"), {
        once: true
      });
    }
  }

  return exec.done;
}

/**
 * Worker-Core-compatible execution handle: `{ sessionId, done, cancel }`.
 * `done` resolves with `{ sessionId, result }` or rejects. Mapping
 * `ExecutionResult.outcome` onto Rail transitions/checks is the Orchestration
 * ticket's job — NOT this adapter's.
 */
export function createClaudeCodeExecution(envelope, opts = {}) {
  return startClaudeExecution(envelope, opts);
}

/** The adapter module the AdapterRouter registers for `provider: "claude-code"`. */
export const claudeCodeAdapter = Object.freeze({
  provider: CLAUDE_PROVIDER,
  preflight,
  run,
  createExecution: createClaudeCodeExecution
});
