/**
 * Rail Harness Developer Console — local Doctor (HC-01, V1).
 *
 * Read-only environment checks. NO RailSoft, NO Worker Core, NO network.
 * Every external command run (`git --version`, `claude --version`) is
 * read-only and goes through an injectable `runCli` so tests never depend on
 * the real binaries being installed. Never prints an environment dump —
 * only the specific, non-secret facts listed below.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { safeEnvironment } from "../security/sanitize.js";
import { configDirFor, ensureConfigDir } from "./config-store.js";
import { buildReadonlyRailFromEnv } from "./rail-readonly.js";

/** CLI binary name for Claude Code. Kept as a local literal — the Developer
 * Console does not import anything from the adapters layer on purpose. */
export const CLAUDE_BIN = "claude";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = path.join(__dirname, "..", "..", "package.json");

/** Detect the local Linux user / machine without ever prompting for them. */
export function getIdentity({ osModule = os, env = process.env } = {}) {
  let username;
  try {
    username = osModule.userInfo().username;
  } catch {
    username = env.USER || env.LOGNAME || "(desconocido)";
  }
  const hostname = osModule.hostname?.() ?? "(desconocido)";
  const home = env.HOME || osModule.homedir?.() || "(desconocido)";
  return { username, hostname, home };
}

/** Parse a minimal `">=X"` / `">=X.Y"` engines range into `{major, minor}`. */
export function parseMinNodeRange(range) {
  const match = />=\s*(\d+)(?:\.(\d+))?/.exec(String(range || ""));
  if (!match) return null;
  return { major: Number(match[1]), minor: match[2] !== undefined ? Number(match[2]) : 0 };
}

function versionSatisfiesMin(version, min) {
  if (!min) return true;
  const [major, minor] = String(version).split(".").map(n => Number(n) || 0);
  if (major !== min.major) return major > min.major;
  return minor >= min.minor;
}

/** 1. Node.js installed + compatible with `package.json`'s `engines.node`. */
export function checkNode({ nodeVersion = process.versions.node, packageJsonPath = PACKAGE_JSON_PATH } = {}) {
  let minRange = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    minRange = parseMinNodeRange(pkg?.engines?.node);
  } catch {
    // No package.json / unparsable engines range: don't fail the check over it.
  }

  const ok = versionSatisfiesMin(nodeVersion, minRange);
  return {
    id: "node",
    label: `Node: ${nodeVersion}`,
    ok,
    detail: ok ? null : `se requiere Node ${minRange.major}.${minRange.minor} o superior`
  };
}

/**
 * Run `bin --version`, read-only. `runCli`, when given, is `(args) =>
 * stdout` (args already excludes the binary name) — same injectable shape
 * used by the Claude Code adapter's own preflight, so tests never depend on
 * the real binary being installed.
 */
function tryVersion(bin, runCli) {
  const run =
    runCli ||
    (args => execFileSync(bin, args, { encoding: "utf8", stdio: "pipe", env: safeEnvironment(process.env) }));
  try {
    const out = String(run(["--version"])).trim();
    return { ok: true, detail: out.split("\n")[0] };
  } catch (err) {
    return { ok: false, detail: err.code === "ENOENT" ? "no encontrado en PATH" : (err.message || "error") };
  }
}

/** 2. Git installed. `runGit`: `(args) => stdout`, injectable for tests. */
export function checkGit({ runGit } = {}) {
  const { ok, detail } = tryVersion("git", runGit);
  return { id: "git", label: "Git", ok, detail: ok ? detail : `Git ${detail}` };
}

/** 3. Claude Code available in PATH. `runClaude`: `(args) => stdout`. */
export function checkClaudeCode({ runClaude } = {}) {
  const { ok, detail } = tryVersion(CLAUDE_BIN, runClaude);
  return {
    id: "claudeCode",
    label: "Claude Code",
    ok,
    detail: ok ? detail : `'${CLAUDE_BIN}' ${detail}`
  };
}

/** 4. HOME available and pointing at an existing directory. */
export function checkHome({ env = process.env, osModule = os } = {}) {
  const home = env.HOME || osModule.homedir?.();
  const ok = !!home && fs.existsSync(home) && fs.statSync(home).isDirectory();
  return { id: "home", label: `HOME: ${home || "(no definido)"}`, ok, detail: ok ? null : "HOME no disponible" };
}

/** 5. `~/.config/rail-harness` accessible or creatable. */
export function checkConfigDirAccessible({ homeDir = os.homedir() } = {}) {
  try {
    const dir = configDirFor(homeDir);
    fs.mkdirSync(dir, { recursive: true });
    return { id: "configDirAccessible", label: "Directorio de configuración", ok: true, detail: dir };
  } catch (err) {
    return {
      id: "configDirAccessible",
      label: "Directorio de configuración",
      ok: false,
      detail: err.code || err.message
    };
  }
}

/** 6. `~/.config/rail-harness` is writable. */
export function checkConfigDirWritable({ homeDir = os.homedir() } = {}) {
  try {
    ensureConfigDir(homeDir);
    return { id: "configDirWritable", label: "Configuración local escribible", ok: true, detail: null };
  } catch (err) {
    return { id: "configDirWritable", label: "Configuración local escribible", ok: false, detail: err.message };
  }
}

/**
 * Run every Doctor check. Fully injectable (`runCli`, `env`, `osModule`,
 * `homeDir`, `nodeVersion`, `packageJsonPath`) so tests never depend on real
 * binaries or the real HOME.
 */
export function runDoctorChecks({
  runGit,
  runClaude,
  env = process.env,
  osModule = os,
  homeDir = env.HOME || osModule.homedir?.(),
  nodeVersion = process.versions.node,
  packageJsonPath = PACKAGE_JSON_PATH
} = {}) {
  return [
    checkNode({ nodeVersion, packageJsonPath }),
    checkGit({ runGit }),
    checkClaudeCode({ runClaude }),
    checkHome({ env, osModule }),
    checkConfigDirAccessible({ homeDir }),
    checkConfigDirWritable({ homeDir })
  ];
}

export function doctorPassCount(checks) {
  return checks.filter(c => c.ok).length;
}

export function doctorExitCode(checks) {
  return checks.every(c => c.ok) ? 0 : 1;
}

/**
 * Optional RailSoft checks (HC-02): only meaningful "cuando existan
 * credenciales" (`RAIL_API_URL` + `RAIL_TOKEN`). Read-only: the single call
 * made — `rail.listProjects()` — is a GET, never a mutation. Never prints
 * `RAIL_TOKEN`. `rail`, when given, overrides the facade built from `env`
 * (tests inject a fake so this never touches the network).
 */
export async function runRailChecks({ env = process.env, rail } = {}) {
  const { rail: activeRail, error: railError } = rail ? { rail, error: null } : buildReadonlyRailFromEnv(env);

  if (railError) {
    return [{ id: "railConnectivity", label: "RailSoft", ok: false, detail: railError }];
  }

  if (!activeRail) {
    return [
      {
        id: "railConnectivity",
        label: "RailSoft",
        ok: false,
        detail: "no configurado (faltan las credenciales de Rail)"
      }
    ];
  }

  try {
    await activeRail.listProjects();
    return [
      { id: "railConnectivity", label: "RailSoft", ok: true, detail: null },
      { id: "railIdentity", label: "Identidad Rail autorizada", ok: true, detail: null }
    ];
  } catch (err) {
    // `RailApiClient` sets `err.status` only when Rail actually answered with
    // a non-2xx HTTP response — that means the server WAS reachable (so
    // connectivity is fine, it's the token that's rejected). No `err.status`
    // means the request itself failed (DNS/TCP/TLS) — connectivity is down.
    const reachedServer = typeof err.status === "number";
    const authFailed = err.status === 401 || err.status === 403;
    return [
      {
        id: "railConnectivity",
        label: "RailSoft",
        ok: reachedServer,
        detail: reachedServer ? null : "no se pudo contactar RailSoft"
      },
      {
        id: "railIdentity",
        label: "Identidad Rail autorizada",
        ok: false,
        detail: authFailed ? "token rechazado por RailSoft" : "no verificada (sin conectividad)"
      }
    ];
  }
}

/** Condensed 4-line summary for the main-menu "Chequeando entorno..." block. */
export function condensedChecks(checks) {
  const byId = Object.fromEntries(checks.map(c => [c.id, c]));
  const configOk = ["home", "configDirAccessible", "configDirWritable"].every(id => byId[id]?.ok);
  return [
    { label: "Node", ok: !!byId.node?.ok },
    { label: "Git", ok: !!byId.git?.ok },
    { label: "Claude Code", ok: !!byId.claudeCode?.ok },
    { label: "Configuración local", ok: configOk }
  ];
}
