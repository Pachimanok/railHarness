/**
 * Rail Harness Developer Console — hidden-echo secret input (HC-03).
 *
 * Zero npm dependencies, same technique as `ui.js`'s `selectMenu`: raw-mode
 * `readline` keypress events on a real TTY (each keystroke echoes a literal
 * `*` instead of the real character — the real value never touches
 * `output`), with a line-based fallback for when there is no controlling
 * TTY (piped output, some restricted SSH sessions). Fully injectable
 * (`input`/`output`) so tests never read real stdin.
 */

import readline from "node:readline";

/**
 * Prompt for a secret line. Resolves the raw string typed (may be empty —
 * callers decide whether that's acceptable). Rejects with `{code:
 * "CANCELLED"}` on Ctrl+C / Escape, same convention as `selectMenu`.
 *
 * @param {object} opts
 * @param {string} [opts.prompt="Token: "]
 * @param {NodeJS.ReadStream}  [opts.input=process.stdin]
 * @param {NodeJS.WriteStream} [opts.output=process.stdout]
 */
export function promptSecret({ prompt = "Token: ", input = process.stdin, output = process.stdout } = {}) {
  if (input.isTTY && output.isTTY) {
    return promptSecretInteractive({ prompt, input, output });
  }
  return promptSecretFallback({ prompt, input, output });
}

function promptSecretInteractive({ prompt, input, output }) {
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;

    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();

    output.write(prompt);

    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      try {
        input.setRawMode(wasRaw ?? false);
      } catch {
        // stream may already be closing
      }
      input.pause();
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write("\n");
      resolve(value);
    };

    const onKeypress = (str, key) => {
      if (!key) return;
      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        settled = true;
        cleanup();
        output.write("\n");
        reject(Object.assign(new Error("Cancelado por el usuario."), { code: "CANCELLED" }));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish();
        return;
      }
      if (key.name === "backspace") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          output.write("\b \b");
        }
        return;
      }
      if (str && !key.ctrl && !key.meta) {
        value += str;
        output.write("*");
      }
    };

    input.on("keypress", onKeypress);
  });
}

function promptSecretFallback({ prompt, input, output }) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input, output, terminal: false });
    rl.question(prompt, answer => {
      rl.close();
      if (answer === null || answer === undefined) {
        reject(Object.assign(new Error("Cancelado por el usuario."), { code: "CANCELLED" }));
        return;
      }
      resolve(String(answer));
    });
  });
}
