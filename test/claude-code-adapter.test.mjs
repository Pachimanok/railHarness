/**
 * Claude Code adapter — RAIL-D-00004 acceptance tests.
 *
 * Fully offline: `spawn`, the git branch check, the CLI preflight runner and
 * `fs.existsSync` are all injected fakes. The real `claude` binary is NEVER
 * invoked during `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  preflight,
  run,
  createClaudeCodeExecution,
  claudeCodeAdapter,
  buildPrompt,
  buildImplementPrompt,
  buildRecoveryPrompt,
  buildClaudeArgs,
  isResumingSession,
  assertClaudeJsonSchemaCompatible,
  CLAUDE_TOOLS,
  CLAUDE_ALLOWED_TOOLS,
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_PROVIDER
} from "../src/adapters/claude-code.js";
import { buildExecutionEnvelope } from "../src/contracts/execution-envelope.js";
import {
  validateExecutionResult,
  EXECUTION_RESULT_JSON_SCHEMA
} from "../src/contracts/execution-result.js";
import { REQUIRED_CLAUDE_FLAGS } from "../src/adapters/claude-preflight.js";

// ── fixtures ────────────────────────────────────────────────────────────

const BRANCH = "rail/rail-d-00004";
const WS_PATH = "/tmp/rail-workspaces/rail-d-00004";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const FAKE_CLAIM_TOKEN = "CT-fake-claimtoken-abc123";

/** `claude --help` excerpt carrying every REQUIRED flag (no --permission-prompts). */
const HELP_ALL = `
Options:
  --allowedTools, --allowed-tools <tools...>   allow list
  --disallowedTools <tools...>                 deny list
  --json-schema <schema>                       JSON Schema for structured output
  --output-format <format>                     Output format (only with --print)
  --permission-mode <mode>                     Permission mode
  -p, --print                                  Print response and exit
  -r, --resume [value]                         Resume a conversation by session ID
  --session-id <uuid>                          Use a specific session ID
  --tools <tools...>                           Available tools from the built-in set
  -n, --name <name>                            Set a display name for this session
`;

function okResult(overrides = {}) {
  return {
    outcome: "IMPLEMENTED",
    summary: "Se implementó el AdapterRouter y el adapter de Claude Code.",
    question: null,
    context: null,
    impact: null,
    tests: ["npm test : pass"],
    filesChanged: ["src/adapters/adapter-router.js"],
    ...overrides
  };
}
const OK_STDOUT = JSON.stringify({ result: okResult() });

function makeEnvelope(overrides = {}) {
  const base = {
    kind: "IMPLEMENT",
    run: { id: "run-1", branch: BRANCH },
    ticket: { item: { code: "RAIL-D-00004", title: "AdapterRouter" } },
    workspace: { path: WS_PATH },
    session: { id: SESSION_ID }
  };
  return buildExecutionEnvelope({ ...base, ...overrides });
}

/** A fake child process: EventEmitter + fake stdout/stderr + kill spy. */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.exitCode = null;
    this.signals = [];
  }
  kill(signal = "SIGTERM") {
    this.signals.push(signal);
    this.killed = true;
    return true;
  }
  /** Emit output then close, like the real child would. */
  finish({ stdout = "", stderr = "", code = 0 } = {}) {
    if (stdout) this.stdout.emit("data", Buffer.from(stdout));
    if (stderr) this.stderr.emit("data", Buffer.from(stderr));
    this.exitCode = code;
    this.emit("close", code);
  }
}

/** Injectable spawn that records every call and returns `child`. */
function spawnFake(child, calls) {
  return (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return child;
  };
}

const runGitOn = branch => () => branch;

// ── 1. preflight ───────────────────────────────────────────────────────

test("preflight: version ok + flags completos => { version, flags }", () => {
  const out = preflight({
    runCli: args => (args[0] === "--version" ? "2.1.266 (Claude Code)" : HELP_ALL)
  });
  assert.equal(out.version, "2.1.266 (Claude Code)");
  assert.deepEqual(out.flags, [...REQUIRED_CLAUDE_FLAGS]);
});

test("preflight: falta un flag requerido => error humano en español, sin claim", () => {
  const helpNoSchema = HELP_ALL.split("\n")
    .filter(l => !l.includes("--json-schema"))
    .join("\n");
  assert.throws(
    () =>
      preflight({
        runCli: args => (args[0] === "--version" ? "2.1.266" : helpNoSchema)
      }),
    err => {
      assert.match(err.message, /--json-schema/);
      assert.match(err.message, /no soporta los flags requeridos/);
      assert.match(err.message, /No claim was created\.$/);
      return true;
    }
  );
});

test("preflight: --permission-prompts NUNCA es requerido", () => {
  // Help text without --permission-prompts still passes.
  assert.ok(!HELP_ALL.includes("--permission-prompts"));
  const out = preflight({
    runCli: args => (args[0] === "--version" ? "2.1.266" : HELP_ALL)
  });
  assert.ok(!out.flags.includes("--permission-prompts"));
  assert.ok(!REQUIRED_CLAUDE_FLAGS.includes("--permission-prompts"));
});

test("preflight: 'claude --version' no ejecutable => error explícito, sin claim", () => {
  assert.throws(
    () =>
      preflight({
        runCli: () => {
          throw new Error("spawn claude ENOENT");
        }
      }),
    err => {
      assert.match(err.message, /No pude ejecutar 'claude --version'/);
      assert.match(err.message, /No claim was created\.$/);
      return true;
    }
  );
});

// ── 2. args de IMPLEMENT ──────────────────────────────────────────────

test("run IMPLEMENT: argv no interactivo, JSON estructurado, sesión nueva", async () => {
  const child = new FakeChild();
  const calls = [];
  const env = makeEnvelope();

  const p = run(env, { spawn: spawnFake(child, calls), runGit: runGitOn(BRANCH), existsSync: () => true });
  child.finish({ stdout: OK_STDOUT });
  const { sessionId, result } = await p;

  const args = calls[0].args;
  const pair = (flag, val) => {
    const i = args.indexOf(flag);
    assert.ok(i !== -1, `falta ${flag}`);
    assert.equal(args[i + 1], val, `${flag} debe ser ${val}`);
  };
  assert.ok(args.includes("--print"));
  pair("--output-format", "json");
  pair("--json-schema", JSON.stringify(EXECUTION_RESULT_JSON_SCHEMA));
  pair("--permission-mode", "auto");
  pair("--tools", CLAUDE_TOOLS);
  pair("--allowedTools", CLAUDE_ALLOWED_TOOLS);
  pair("--disallowedTools", CLAUDE_DISALLOWED_TOOLS);
  pair("--session-id", SESSION_ID);
  pair("--name", `rail-${SESSION_ID.slice(0, 8)}`);
  assert.ok(!args.includes("--resume"));
  assert.ok(!args.includes("--permission-prompts"));

  assert.equal(sessionId, SESSION_ID);
  assert.equal(result.outcome, "IMPLEMENTED");
});

test("argv NUNCA contiene --permission-prompts (IMPLEMENT y RECOVERY)", () => {
  for (const env of [
    makeEnvelope(),
    makeEnvelope({
      kind: "RECOVERY",
      continuation: { pendingFeedback: ["revisar x"], changedFiles: ["src/a.js"] }
    })
  ]) {
    assert.ok(!buildClaudeArgs(env).includes("--permission-prompts"));
  }
});

// ── 3. args de RECOVERY / --resume ────────────────────────────────────

test("RECOVERY usa --resume con la sesión existente, sin --session-id/--name", () => {
  const env = makeEnvelope({
    kind: "RECOVERY",
    continuation: {
      priorImplementationNote: "hecho el router",
      failedReviewNote: "faltan tests",
      pendingFeedback: ["agregar test de cancel"],
      changedFiles: ["src/adapters/adapter-router.js"]
    }
  });
  assert.ok(isResumingSession(env));
  const args = buildClaudeArgs(env);
  const i = args.indexOf("--resume");
  assert.ok(i !== -1);
  assert.equal(args[i + 1], SESSION_ID);
  assert.ok(!args.includes("--session-id"));
  assert.ok(!args.includes("--name"));
});

test("resumeAnswer (IMPLEMENT) también fuerza --resume y preserva la sesión", async () => {
  const child = new FakeChild();
  const calls = [];
  const env = makeEnvelope({ resumeAnswer: "Sí, el ticket corresponde; continuá." });

  const p = run(env, { spawn: spawnFake(child, calls), runGit: runGitOn(BRANCH), existsSync: () => true });
  child.finish({ stdout: OK_STDOUT });
  const { sessionId } = await p;

  const args = calls[0].args;
  const i = args.indexOf("--resume");
  assert.ok(i !== -1);
  assert.equal(args[i + 1], SESSION_ID);
  assert.ok(!args.includes("--session-id"));
  assert.equal(sessionId, SESSION_ID);
  assert.match(args.at(-1), /RESPUESTA HUMANA:/);
});

// ── 4. cwd == workspace.path ─────────────────────────────────────────

test("Claude se ejecuta con cwd = workspace.path", async () => {
  const child = new FakeChild();
  const calls = [];
  const p = run(makeEnvelope(), {
    spawn: spawnFake(child, calls),
    runGit: runGitOn(BRANCH),
    existsSync: () => true
  });
  child.finish({ stdout: OK_STDOUT });
  await p;
  assert.equal(calls[0].opts.cwd, WS_PATH);
});

test("workspace inexistente => rechazo antes de ejecutar Claude", async () => {
  const calls = [];
  await assert.rejects(
    run(makeEnvelope(), {
      spawn: spawnFake(new FakeChild(), calls),
      runGit: runGitOn(BRANCH),
      existsSync: () => false
    }),
    /no existe en disco/
  );
  assert.equal(calls.length, 0, "no se debe spawnear Claude");
});

// ── 5. branch mismatch => rechazo antes de ejecutar Claude ───────────

test("branch del worktree != run.branch => rechazo, sin spawn", async () => {
  const calls = [];
  await assert.rejects(
    run(makeEnvelope(), {
      spawn: spawnFake(new FakeChild(), calls),
      runGit: runGitOn("otra-branch"),
      existsSync: () => true
    }),
    err => {
      assert.match(err.message, /está en la branch "otra-branch"/);
      assert.match(err.message, /no cambia de branch/);
      return true;
    }
  );
  assert.equal(calls.length, 0, "no se debe spawnear Claude en la branch equivocada");
});

// ── 6. safeEnvironment => sin RAIL_*/CLAIM_TOKEN ─────────────────────

test("el proceso hijo recibe safeEnvironment(): sin RAIL_*/CLAIM_TOKEN", async () => {
  const child = new FakeChild();
  const calls = [];
  const saved = { ...process.env };
  process.env.RAIL_TOKEN = "rag_supersecret";
  process.env.RAIL_API_URL = "https://rail.example/api";
  process.env.CLAIM_TOKEN = FAKE_CLAIM_TOKEN;
  process.env.RAIL_HUMAN_TOKEN = "human-secret";
  try {
    const p = run(makeEnvelope(), {
      spawn: spawnFake(child, calls),
      runGit: runGitOn(BRANCH),
      existsSync: () => true
    });
    child.finish({ stdout: OK_STDOUT });
    await p;
  } finally {
    for (const k of ["RAIL_TOKEN", "RAIL_API_URL", "CLAIM_TOKEN", "RAIL_HUMAN_TOKEN"]) {
      if (!(k in saved)) delete process.env[k];
    }
  }
  const childEnv = calls[0].opts.env;
  for (const k of Object.keys(childEnv)) {
    assert.ok(!/^RAIL_/.test(k), `no debe pasar ${k}`);
  }
  assert.ok(!("CLAIM_TOKEN" in childEnv));
  assert.ok(!("RAIL_HUMAN_TOKEN" in childEnv));
  assert.equal(childEnv.GIT_TERMINAL_PROMPT, "0");
  assert.ok("PATH" in childEnv, "un env normal como PATH sí se conserva");
});

// ── 7. prompt contiene languagePolicy.instruction ───────────────────

test("todo prompt inyecta envelope.languagePolicy.instruction al inicio", () => {
  const impl = makeEnvelope();
  const rec = makeEnvelope({
    kind: "RECOVERY",
    continuation: { pendingFeedback: ["x"], changedFiles: ["a"] }
  });
  const res = makeEnvelope({ resumeAnswer: "continuá" });

  for (const env of [impl, rec, res]) {
    const prompt = buildPrompt(env);
    assert.ok(
      prompt.includes(env.languagePolicy.instruction),
      "el prompt debe contener la instrucción de idioma"
    );
    assert.ok(prompt.startsWith(env.languagePolicy.instruction));
    assert.match(prompt, /español/);
  }
  assert.ok(buildImplementPrompt(impl).includes(impl.languagePolicy.instruction));
  assert.ok(buildRecoveryPrompt(rec).includes(rec.languagePolicy.instruction));
});

test("el prompt viaja como último argumento de la CLI", async () => {
  const child = new FakeChild();
  const calls = [];
  const env = makeEnvelope();
  const p = run(env, { spawn: spawnFake(child, calls), runGit: runGitOn(BRANCH), existsSync: () => true });
  child.finish({ stdout: OK_STDOUT });
  await p;
  assert.equal(calls[0].args.at(-1), buildImplementPrompt(env));
});

// ── 8. JSON válido => ExecutionResult válido ─────────────────────────

test("salida JSON válida (wrapper .result) => ExecutionResult válido", async () => {
  const child = new FakeChild();
  const p = run(makeEnvelope(), { spawn: spawnFake(child, []), runGit: runGitOn(BRANCH), existsSync: () => true });
  child.finish({ stdout: OK_STDOUT });
  const { result } = await p;
  assert.ok(validateExecutionResult(result).valid);
  assert.equal(result.outcome, "IMPLEMENTED");
});

test("salida JSON válida (objeto desnudo) => ExecutionResult válido", async () => {
  const child = new FakeChild();
  const p = run(makeEnvelope(), { spawn: spawnFake(child, []), runGit: runGitOn(BRANCH), existsSync: () => true });
  child.finish({ stdout: JSON.stringify(okResult({ outcome: "BLOCKED", question: "¿Cuál repo?" })) });
  const { result } = await p;
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(result.question, "¿Cuál repo?");
  assert.ok(validateExecutionResult(result).valid);
});

// ── 9. JSON inválido / vacío / wrapper inesperado => no false PASS ──

test("JSON inválido / vacío / schema inválido => rechazo, nunca IMPLEMENTED", async () => {
  const cases = [
    { label: "no-json", stdout: "esto no es json" },
    { label: "vacío", stdout: "   " },
    { label: "schema inválido", stdout: "{}" },
    { label: "outcome inválido", stdout: JSON.stringify(okResult({ outcome: "SUCCESS" })) },
    { label: "BLOCKED sin question", stdout: JSON.stringify(okResult({ outcome: "BLOCKED", question: "" })) }
  ];
  for (const c of cases) {
    const child = new FakeChild();
    const p = run(makeEnvelope(), {
      spawn: spawnFake(child, []),
      runGit: runGitOn(BRANCH),
      existsSync: () => true
    });
    child.finish({ stdout: c.stdout, code: 0 });
    // `assert.rejects` passing IS the guarantee: no resolved { result } — so no
    // fabricated IMPLEMENTED ever reaches the caller.
    await assert.rejects(p, err => err instanceof Error, `caso ${c.label} debe rechazar`);
  }
});

// ── 10. exit != 0 => no false IMPLEMENTED ────────────────────────────

test("exit code != 0 => fallo técnico, nunca IMPLEMENTED (aunque stdout traiga result)", async () => {
  for (const stdout of ["", "boom", OK_STDOUT]) {
    const child = new FakeChild();
    const p = run(makeEnvelope(), {
      spawn: spawnFake(child, []),
      runGit: runGitOn(BRANCH),
      existsSync: () => true
    });
    child.finish({ stdout, stderr: "error interno", code: 2 });
    await assert.rejects(p, err => {
      assert.match(err.message, /terminó con código 2/);
      assert.match(err.message, /no se fabrica IMPLEMENTED/);
      return true;
    });
  }
});

// ── 11. cancel mata el proceso hijo ─────────────────────────────────

test("cancel() termina el proceso Claude y hace rechazar done (sin huérfano)", async () => {
  const child = new FakeChild();
  const exec = createClaudeCodeExecution(makeEnvelope(), {
    spawn: spawnFake(child, []),
    runGit: runGitOn(BRANCH),
    existsSync: () => true,
    killGraceMs: 10
  });

  exec.cancel("ownership perdido (fencing)");
  assert.ok(child.signals.includes("SIGTERM"), "debe enviar SIGTERM al hijo");
  assert.ok(child.killed);

  child.finish({ code: 143 });
  await assert.rejects(exec.done, /fue cancelada: ownership perdido/);
});

test("run() respeta un AbortSignal y cancela el hijo", async () => {
  const child = new FakeChild();
  const ac = new AbortController();
  const p = run(makeEnvelope(), {
    spawn: spawnFake(child, []),
    runGit: runGitOn(BRANCH),
    existsSync: () => true,
    killGraceMs: 10,
    signal: ac.signal
  });
  ac.abort();
  assert.ok(child.signals.includes("SIGTERM"));
  child.finish({ code: 143 });
  await assert.rejects(p, /fue cancelada/);
});

test("cancel COOPERATIVO: SIGTERM, el hijo cierra => NO se envía SIGKILL", async () => {
  const child = new FakeChild();
  const exec = createClaudeCodeExecution(makeEnvelope(), {
    spawn: spawnFake(child, []),
    runGit: runGitOn(BRANCH),
    existsSync: () => true,
    killGraceMs: 15
  });

  exec.cancel("shutdown");
  assert.deepEqual(child.signals, ["SIGTERM"]);
  child.finish({ code: 143 }); // el hijo obedeció el SIGTERM

  await assert.rejects(exec.done, /fue cancelada: shutdown/);
  await new Promise(r => setTimeout(r, 40)); // deja vencer la ventana de gracia
  assert.ok(!child.signals.includes("SIGKILL"), "un hijo que ya cerró no debe recibir SIGKILL");
});

test("cancel NO COOPERATIVO: el hijo ignora SIGTERM => SIGKILL tras killGraceMs y done rechaza", async () => {
  const child = new FakeChild();
  const exec = createClaudeCodeExecution(makeEnvelope(), {
    spawn: spawnFake(child, []),
    runGit: runGitOn(BRANCH),
    existsSync: () => true,
    killGraceMs: 15
  });

  exec.cancel("fencing");
  assert.deepEqual(child.signals, ["SIGTERM"]);
  // el hijo NO cierra: exitCode sigue null, no hay evento close
  assert.equal(child.exitCode, null);

  await new Promise(r => setTimeout(r, 60)); // supera killGraceMs
  assert.ok(child.signals.includes("SIGKILL"), "debe escalar a SIGKILL si el hijo sigue vivo");

  child.finish({ code: 137 }); // el kernel lo termina
  await assert.rejects(exec.done, /fue cancelada: fencing/);
});

test("cancel MÚLTIPLE: un solo SIGTERM, a lo sumo una escalada SIGKILL, no rompe", async () => {
  const child = new FakeChild();
  const exec = createClaudeCodeExecution(makeEnvelope(), {
    spawn: spawnFake(child, []),
    runGit: runGitOn(BRANCH),
    existsSync: () => true,
    killGraceMs: 15
  });

  assert.doesNotThrow(() => {
    exec.cancel("uno");
    exec.cancel("dos");
    exec.cancel();
  });
  assert.equal(child.signals.filter(s => s === "SIGTERM").length, 1);

  await new Promise(r => setTimeout(r, 60));
  assert.ok(child.signals.filter(s => s === "SIGKILL").length <= 1, "como máximo una escalada SIGKILL");
  assert.ok(child.signals.includes("SIGKILL"), "el hijo no cooperativo termina recibiendo SIGKILL");

  child.finish({ code: 137 });
  await assert.rejects(exec.done, /fue cancelada: uno/); // gana la razón de la primera llamada
});

test("cancel después de que el hijo ya cerró: idempotente, sin señales nuevas", async () => {
  const child = new FakeChild();
  const exec = createClaudeCodeExecution(makeEnvelope(), {
    spawn: spawnFake(child, []),
    runGit: runGitOn(BRANCH),
    existsSync: () => true,
    killGraceMs: 15
  });
  child.finish({ stdout: OK_STDOUT }); // termina OK antes de cualquier cancel
  await exec.done;

  assert.doesNotThrow(() => exec.cancel("tarde"));
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(child.signals, [], "no se envían señales a un hijo ya cerrado");
});

// ── 11bis. guardia de compatibilidad del JSON Schema de la CLI ──────

test("assertClaudeJsonSchemaCompatible rechaza $schema draft 2020-12 y acepta el contrato actual", () => {
  assert.throws(
    () =>
      assertClaudeJsonSchemaCompatible({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        properties: {},
        required: []
      }),
    /\$schema|draft-07/
  );
  // draft-07 explícito: aceptado
  assert.doesNotThrow(() =>
    assertClaudeJsonSchemaCompatible({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {},
      required: []
    })
  );
  // el schema real del contrato pasa y se devuelve tal cual
  assert.equal(
    assertClaudeJsonSchemaCompatible(EXECUTION_RESULT_JSON_SCHEMA),
    EXECUTION_RESULT_JSON_SCHEMA
  );
});

test("EXECUTION_RESULT_JSON_SCHEMA no lleva $schema y buildClaudeArgs no lanza", () => {
  assert.equal(EXECUTION_RESULT_JSON_SCHEMA.$schema, undefined);
  assert.doesNotThrow(() => buildClaudeArgs(makeEnvelope()));
  const args = buildClaudeArgs(makeEnvelope());
  const payload = args[args.indexOf("--json-schema") + 1];
  assert.ok(!payload.includes("2020-12"), "el payload de --json-schema no debe citar draft 2020-12");
  assert.equal(JSON.parse(payload).type, "object");
});

test("preflight falla ANTES del claim si el schema declarara un $schema incompatible", () => {
  // Simula la regresión sin tocar el módulo: se prueba la guardia directamente
  // con el mismo mensaje que preflight adjunta.
  try {
    assertClaudeJsonSchemaCompatible({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false
    });
    assert.fail("debía lanzar");
  } catch (err) {
    assert.match(err.message, /draft-07|\$schema/);
  }
});

// ── 12. ningún comando Rail / git mutante / red en la config ────────

test("la config de tools no habilita git mutante ni red", () => {
  // Built-in set: sólo lectura/búsqueda/edición + Bash. Sin WebFetch/WebSearch.
  assert.equal(CLAUDE_TOOLS, "Read,Edit,Write,Glob,Grep,Bash");

  // El allowlist no contiene ningún verbo mutante ni red.
  for (const bad of ["commit", "push", "merge", "rebase", "reset", "checkout", "clean", "curl", "wget"]) {
    assert.ok(!CLAUDE_ALLOWED_TOOLS.includes(bad), `allowlist no debe incluir ${bad}`);
  }
  // El denylist sí los prohíbe explícitamente.
  for (const bad of [
    "Bash(git commit *)",
    "Bash(git push *)",
    "Bash(git merge *)",
    "Bash(git reset *)",
    "Bash(git checkout *)",
    "Bash(git clean *)",
    "Bash(curl *)",
    "Bash(wget *)",
    "WebFetch",
    "WebSearch"
  ]) {
    assert.ok(CLAUDE_DISALLOWED_TOOLS.includes(bad), `denylist debe incluir ${bad}`);
  }
  // Sólo git de lectura en el allowlist.
  assert.ok(CLAUDE_ALLOWED_TOOLS.includes("Bash(git status *)"));
  assert.ok(CLAUDE_ALLOWED_TOOLS.includes("Bash(git diff *)"));
});

test("el prompt prohíbe explícitamente commit/push/merge/red/Rail y cambiar de branch", () => {
  const prompt = buildImplementPrompt(makeEnvelope());
  assert.match(prompt, /No hagas git commit/);
  assert.match(prompt, /git push/);
  assert.match(prompt, /git merge/);
  assert.match(prompt, /No cambies de branch/);
  assert.match(prompt, /No uses curl, wget/);
  assert.match(prompt, /No llames a la API de Rail/);
});

// ── 13. sessionId preservado ────────────────────────────────────────

test("sessionId se preserva en el resultado y en el argv", async () => {
  for (const env of [
    makeEnvelope(),
    makeEnvelope({ resumeAnswer: "ok" }),
    makeEnvelope({ kind: "RECOVERY", continuation: { pendingFeedback: ["x"], changedFiles: ["a"] } })
  ]) {
    const child = new FakeChild();
    const calls = [];
    const p = run(env, { spawn: spawnFake(child, calls), runGit: runGitOn(BRANCH), existsSync: () => true });
    child.finish({ stdout: OK_STDOUT });
    const { sessionId } = await p;
    assert.equal(sessionId, env.session.id);
    const args = calls[0].args;
    const flag = args.includes("--resume") ? "--resume" : "--session-id";
    assert.equal(args[args.indexOf(flag) + 1], env.session.id);
  }
});

// ── 14. no claimToken en logs / args / env / prompt ────────────────

test("el claimToken NUNCA aparece en logs, argv, env ni prompt", async () => {
  const child = new FakeChild();
  const calls = [];
  const logs = [];

  // Un ticket con un claimToken debe quedar depurado en el envelope.
  const env = makeEnvelope({
    ticket: { item: { code: "RAIL-D-00004" }, claimToken: FAKE_CLAIM_TOKEN, token: "rag_secret" }
  });
  const serializedEnv = JSON.stringify(env);
  assert.ok(!serializedEnv.includes(FAKE_CLAIM_TOKEN), "buildExecutionEnvelope depura el claimToken");
  assert.ok(!serializedEnv.includes("rag_secret"));

  const p = run(env, {
    spawn: spawnFake(child, calls),
    runGit: runGitOn(BRANCH),
    existsSync: () => true,
    logger: line => logs.push(line)
  });
  child.finish({ stdout: OK_STDOUT });
  await p;

  const argvText = JSON.stringify(calls[0].args);
  const envText = JSON.stringify(calls[0].opts.env);
  const logText = logs.join("\n");
  for (const haystack of [argvText, envText, logText]) {
    assert.ok(!haystack.includes(FAKE_CLAIM_TOKEN));
    assert.ok(!haystack.includes("rag_secret"));
    assert.ok(!/claimToken/i.test(haystack));
  }
  // Los logs no vuelcan el prompt completo ni el ticket.
  assert.ok(!logText.includes(env.languagePolicy.instruction));
  assert.ok(!logText.includes("TICKET Y SPEC"));
});

// ── adapter module shape ───────────────────────────────────────────

test("claudeCodeAdapter expone la interfaz del contrato", () => {
  assert.equal(claudeCodeAdapter.provider, CLAUDE_PROVIDER);
  assert.equal(typeof claudeCodeAdapter.preflight, "function");
  assert.equal(typeof claudeCodeAdapter.run, "function");
  assert.equal(typeof claudeCodeAdapter.createExecution, "function");
});
