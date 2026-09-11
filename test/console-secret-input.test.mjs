/**
 * HC-03-AC-05 — hidden-echo secret input (`src/console/secret-input.js`).
 *
 * Never touches real stdin: the interactive-TTY path is driven through a
 * fake `EventEmitter`-based input/output pair that mimics just enough of
 * `net.Socket`'s TTY surface (`isTTY`, `setRawMode`, `resume`/`pause`,
 * keypress events) for `readline.emitKeypressEvents` to work with it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { promptSecret } from "../src/console/secret-input.js";

class FakeTTYInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
  }
  setRawMode(v) {
    this.isRaw = v;
  }
  resume() {}
  pause() {}
}

class FakeTTYOutput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.chunks = [];
  }
  write(s) {
    this.chunks.push(s);
    return true;
  }
}

function typeAndEnter(input, text) {
  setImmediate(() => {
    for (const ch of text) input.emit("keypress", ch, { name: ch, sequence: ch });
    input.emit("keypress", null, { name: "return" });
  });
}

// ─── HC-03-AC-05: never echoes the real value ──────────────────────────────

test("HC-03-AC-05 (TTY): el valor real nunca se escribe a output, sólo asteriscos", async () => {
  const input = new FakeTTYInput();
  const output = new FakeTTYOutput();

  const promise = promptSecret({ prompt: "Token: ", input, output });
  typeAndEnter(input, "rag_supersecret_token");
  const value = await promise;

  assert.equal(value, "rag_supersecret_token");
  const written = output.chunks.join("");
  assert.ok(!written.includes("rag_supersecret_token"));
  assert.ok(!written.includes("supersecret"));
  assert.match(written, /^Token: \*+\n$/);
});

test("HC-03-AC-05 (TTY): backspace borra un carácter, nunca revela el valor", async () => {
  const input = new FakeTTYInput();
  const output = new FakeTTYOutput();

  const promise = promptSecret({ prompt: "Token: ", input, output });
  setImmediate(() => {
    for (const ch of "abcx") input.emit("keypress", ch, { name: ch, sequence: ch });
    input.emit("keypress", null, { name: "backspace" });
    input.emit("keypress", null, { name: "return" });
  });
  const value = await promise;

  assert.equal(value, "abc");
  assert.ok(!output.chunks.join("").includes("x"));
});

test("HC-03-AC-05 (TTY): Ctrl+C cancela con code CANCELLED, sin resolver el valor tipeado", async () => {
  const input = new FakeTTYInput();
  const output = new FakeTTYOutput();

  const promise = promptSecret({ prompt: "Token: ", input, output });
  setImmediate(() => {
    for (const ch of "partial") input.emit("keypress", ch, { name: ch, sequence: ch });
    input.emit("keypress", null, { name: "c", ctrl: true });
  });

  await assert.rejects(promise, err => err.code === "CANCELLED");
});

test("promptSecret restaura el modo raw del input al terminar", async () => {
  const input = new FakeTTYInput();
  const output = new FakeTTYOutput();
  input.isRaw = false;

  const promise = promptSecret({ prompt: "Token: ", input, output });
  typeAndEnter(input, "x");
  await promise;

  assert.equal(input.isRaw, false);
});

// ─── fallback: no TTY (piped / restricted SSH session) ─────────────────────

test("promptSecret (sin TTY): fallback de línea resuelve la respuesta", async () => {
  const { Readable, Writable } = await import("node:stream");
  const input = new Readable({ read() {} });
  input.isTTY = false;
  const chunks = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  output.isTTY = false;

  const promise = promptSecret({ prompt: "Token: ", input, output });
  input.push("rag_piped_token\n");
  const value = await promise;

  assert.equal(value, "rag_piped_token");
});
