/**
 * Rail Harness Developer Console — terminal UI primitives (HC-01).
 *
 * Zero npm dependencies on purpose: raw `readline` keypress events for
 * arrow-key navigation over a real TTY, with a line-based numeric fallback
 * when there is no TTY (piped output, some restricted SSH sessions) so the
 * console still works everywhere. Pure rendering + IO — no Rail, no Worker.
 */

import readline from "node:readline";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function colorize(text, code, isTTY) {
  return isTTY ? `${code}${text}${RESET}` : text;
}

/** `✓ label` / `✗ label`, colored only when writing to a real TTY. */
export function formatCheckLine({ label, ok, detail }, { isTTY = false } = {}) {
  const mark = ok ? colorize("✓", GREEN, isTTY) : colorize("✗", RED, isTTY);
  const suffix = !ok && detail ? ` — ${detail}` : "";
  return `${mark} ${label}${suffix}`;
}

/** The boxed "Rail Harness" banner shown at the top of every screen. */
export function renderBanner(title = "Rail Harness") {
  const width = title.length + 2;
  const top = `╭${"─".repeat(width + 2)}╮`;
  const mid = `│ ${title} │`;
  const bot = `╰${"─".repeat(width + 2)}╯`;
  return [top, mid, bot].join("\n");
}

/**
 * Interactive select menu. Resolves with the `value` of the chosen item.
 *
 * @param {object} opts
 * @param {string} opts.question   prompt line, e.g. "¿Qué querés hacer?"
 * @param {{label:string,value:*}[]} opts.items
 * @param {NodeJS.ReadStream}  [opts.input=process.stdin]
 * @param {NodeJS.WriteStream} [opts.output=process.stdout]
 */
export function selectMenu({ question, items, input = process.stdin, output = process.stdout }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("selectMenu: se necesita al menos un item.");
  }

  if (input.isTTY && output.isTTY) {
    return selectMenuInteractive({ question, items, input, output });
  }
  return selectMenuFallback({ question, items, input, output });
}

function renderItems(items, cursor, output) {
  for (let i = 0; i < items.length; i += 1) {
    const pointer = i === cursor ? colorize("❯", CYAN, true) : " ";
    output.write(`${pointer} ${items[i].label}\n`);
  }
}

function selectMenuInteractive({ question, items, input, output }) {
  return new Promise((resolve, reject) => {
    let cursor = 0;
    let settled = false;

    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();

    output.write(`${question}\n\n`);
    renderItems(items, cursor, output);

    const linesWritten = items.length;

    const redraw = () => {
      output.write(`\x1b[${linesWritten}A`);
      renderItems(items, cursor, output);
    };

    const cleanup = () => {
      input.removeListener("keypress", onKeypress);
      try {
        input.setRawMode(wasRaw ?? false);
      } catch {
        // stream may already be closing
      }
      input.pause();
    };

    const finish = value => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write("\n");
      resolve(value);
    };

    const onKeypress = (_str, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + items.length) % items.length;
        redraw();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % items.length;
        redraw();
      } else if (key.name === "return" || key.name === "enter") {
        finish(items[cursor].value);
      } else if ((key.ctrl && key.name === "c") || key.name === "escape") {
        settled = true;
        cleanup();
        output.write("\n");
        reject(Object.assign(new Error("Cancelado por el usuario."), { code: "CANCELLED" }));
      }
    };

    input.on("keypress", onKeypress);
  });
}

function selectMenuFallback({ question, items, input, output }) {
  return new Promise((resolve, reject) => {
    output.write(`${question}\n\n`);
    items.forEach((item, i) => output.write(`  ${i + 1}) ${item.label}\n`));
    output.write("\n");

    const rl = readline.createInterface({ input, output, terminal: false });
    const ask = () => rl.question(`Elegí una opción (1-${items.length}): `, answer => {
      const n = Number(String(answer).trim());
      if (Number.isInteger(n) && n >= 1 && n <= items.length) {
        rl.close();
        resolve(items[n - 1].value);
        return;
      }
      if (answer === null) {
        rl.close();
        reject(Object.assign(new Error("Cancelado por el usuario."), { code: "CANCELLED" }));
        return;
      }
      output.write("Opción inválida.\n");
      ask();
    });
    ask();
  });
}

export const COLORS = Object.freeze({ RESET, DIM, GREEN, RED, CYAN });
