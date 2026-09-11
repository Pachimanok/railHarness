/**
 * HC-04 — local trace store (`src/console/trace/store.js`).
 *
 * Every test points `homeDir` at a throwaway `os.tmpdir()` directory and
 * removes it afterwards. The real HOME is never touched (HC-04-AC-15).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  stateDirFor,
  sessionsDirFor,
  eventsDirFor,
  sessionFilePathFor,
  eventsFilePathFor,
  ensureStateDirsSecure,
  writeSessionAtomic,
  appendEventSafe,
  readSessionSafe,
  listSessions,
  countSessions,
  countEvents,
  getLastSession
} from "../src/console/trace/store.js";
import { createSession } from "../src/console/trace/session.js";
import { createEvent } from "../src/console/trace/event.js";

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rail-harness-trace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

test("HC-04: stateDirFor vive bajo ~/.local/state/rail-harness, separado de ~/.config", t => {
  const home = tempHome(t);
  const dir = stateDirFor(home);
  assert.equal(dir, path.join(home, ".local", "state", "rail-harness"));
  assert.ok(!dir.includes(".config"));
});

// ─── HC-04-AC-11 / AC-12: permissions ──────────────────────────────────────

test("HC-04-AC-11: ensureStateDirsSecure crea sessions/ y events/ con mode 0700", t => {
  const home = tempHome(t);
  ensureStateDirsSecure(home);
  assert.equal(modeOf(stateDirFor(home)), 0o700);
  assert.equal(modeOf(sessionsDirFor(home)), 0o700);
  assert.equal(modeOf(eventsDirFor(home)), 0o700);
});

test("HC-04-AC-11: corrige el mode si el directorio ya existía más permisivo", t => {
  const home = tempHome(t);
  fs.mkdirSync(sessionsDirFor(home), { recursive: true, mode: 0o755 });
  fs.chmodSync(sessionsDirFor(home), 0o755);
  ensureStateDirsSecure(home);
  assert.equal(modeOf(sessionsDirFor(home)), 0o700);
});

test("HC-04-AC-12: writeSessionAtomic escribe el archivo con mode 0600", t => {
  const home = tempHome(t);
  const session = createSession({ linuxUser: "fran", machine: "m1" });
  const file = writeSessionAtomic(home, session);
  assert.equal(modeOf(file), 0o600);
  assert.equal(file, sessionFilePathFor(home, session.id));
});

test("HC-04-AC-12: appendEventSafe escribe el archivo del día con mode 0600", t => {
  const home = tempHome(t);
  const session = createSession({ linuxUser: "fran", machine: "m1" });
  const event = createEvent({ sessionId: session.id, type: "SESSION_STARTED" });
  const file = appendEventSafe(home, event);
  assert.equal(modeOf(file), 0o600);
  assert.equal(file, eventsFilePathFor(home));
});

// ─── HC-04-AC-13: no sigue symlinks inseguros ──────────────────────────────

test("HC-04-AC-13: writeSessionAtomic rechaza un symlink en la posición del archivo de sesión", t => {
  const home = tempHome(t);
  const session = createSession({ linuxUser: "fran", machine: "m1" });
  ensureStateDirsSecure(home);
  const target = path.join(home, "elsewhere-session.json");
  fs.writeFileSync(target, "{}");
  fs.symlinkSync(target, sessionFilePathFor(home, session.id));

  assert.throws(() => writeSessionAtomic(home, session), /symlink inseguro/);
});

test("HC-04-AC-13: appendEventSafe rechaza un symlink en la posición del archivo de eventos del día", t => {
  const home = tempHome(t);
  ensureStateDirsSecure(home);
  const target = path.join(home, "elsewhere-events.jsonl");
  fs.writeFileSync(target, "");
  fs.symlinkSync(target, eventsFilePathFor(home));

  const session = createSession({ linuxUser: "fran", machine: "m1" });
  const event = createEvent({ sessionId: session.id, type: "SESSION_STARTED" });
  assert.throws(() => appendEventSafe(home, event), /symlink inseguro/);
});

// ─── round-trip + corruption tolerance ─────────────────────────────────────

test("HC-04: writeSessionAtomic + readSessionSafe hacen un round-trip exacto", t => {
  const home = tempHome(t);
  const session = createSession({ linuxUser: "fran", machine: "m1" });
  writeSessionAtomic(home, session);
  const result = readSessionSafe(home, session.id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.session, session);
});

test("readSessionSafe nunca lanza: missing / corrupt", t => {
  const home = tempHome(t);
  assert.deepEqual(readSessionSafe(home, "rhs_missing"), { ok: false, reason: "missing" });

  ensureStateDirsSecure(home);
  fs.writeFileSync(sessionFilePathFor(home, "rhs_bad"), "{not json", { mode: 0o600 });
  assert.deepEqual(readSessionSafe(home, "rhs_bad"), { ok: false, reason: "corrupt" });
});

test("HC-04: la corrupción de una sesión anterior no impide leer/crear otras (listSessions la ignora)", t => {
  const home = tempHome(t);
  const s1 = createSession({ linuxUser: "fran", machine: "m1" });
  writeSessionAtomic(home, s1);

  ensureStateDirsSecure(home);
  fs.writeFileSync(sessionFilePathFor(home, "rhs_corrupt"), "{not json", { mode: 0o600 });

  const s2 = createSession({ linuxUser: "fran", machine: "m1" });
  writeSessionAtomic(home, s2);

  const listed = listSessions(home);
  assert.equal(listed.length, 2);
  assert.ok(listed.some(s => s.id === s1.id));
  assert.ok(listed.some(s => s.id === s2.id));
});

test("HC-04: la corrupción de una línea de evento no impide leer las demás (countEvents la ignora)", t => {
  const home = tempHome(t);
  const session = createSession({ linuxUser: "fran", machine: "m1" });
  appendEventSafe(home, createEvent({ sessionId: session.id, type: "SESSION_STARTED" }));
  fs.appendFileSync(eventsFilePathFor(home), "{this is not json}\n");
  appendEventSafe(home, createEvent({ sessionId: session.id, type: "DOCTOR_RUN" }));

  assert.equal(countEvents(home), 2);
});

test("listSessions/countSessions/countEvents/getLastSession nunca lanzan sin store previo", t => {
  const home = tempHome(t);
  assert.deepEqual(listSessions(home), []);
  assert.equal(countSessions(home), 0);
  assert.equal(countEvents(home), 0);
  assert.equal(getLastSession(home), null);
});

test("listSessions ordena por startedAt descendente y limit funciona", t => {
  const home = tempHome(t);
  const older = { ...createSession({ linuxUser: "fran", machine: "m1" }), startedAt: "2026-01-01T00:00:00.000Z" };
  const newer = { ...createSession({ linuxUser: "fran", machine: "m1" }), startedAt: "2026-06-01T00:00:00.000Z" };
  writeSessionAtomic(home, older);
  writeSessionAtomic(home, newer);

  const listed = listSessions(home);
  assert.equal(listed[0].id, newer.id);
  assert.equal(listed[1].id, older.id);
  assert.equal(getLastSession(home).id, newer.id);
  assert.equal(listSessions(home, { limit: 1 }).length, 1);
});
