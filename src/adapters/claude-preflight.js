/**
 * Pure CLI-flag preflight helpers for the claude-code adapter.
 *
 * Only the framework-free, testable pieces from the approved reference
 * (`~/rail-runner/harness/adapters/claude-code.mjs`) are bootstrapped here:
 * `REQUIRED_CLAUDE_FLAGS` and `flagPresent`. The executable preflight (which
 * shells out to `claude --version` / `--help`) and the non-interactive
 * runner land with the AdapterRouter ticket, alongside docs/ADAPTER_CONTRACT.md.
 *
 * DELIBERATE DEVIATION FROM THE REFERENCE: `--permission-prompts` is NOT in
 * this list. This bootstrap must not depend on that flag. Permission handling
 * for adapter execution is expressed through `--permission-mode` only (see
 * docs/ADAPTER_CONTRACT.md).
 */

/**
 * Flags a non-interactive claude-code run relies on. The real preflight
 * (later ticket) re-checks these against `claude --help` at runtime rather
 * than trusting a hardcoded "known good" list.
 */
export const REQUIRED_CLAUDE_FLAGS = Object.freeze([
  "--print",
  "--output-format",
  "--json-schema",
  "--permission-mode",
  "--tools",
  "--allowedTools",
  "--resume",
  "--session-id",
  "--name"
]);

/**
 * Does `flag` appear in `helpText` as a real option token — not as a
 * substring of a longer flag (e.g. `--tools` inside `--allowedTools`)? Pure;
 * receives already-captured `--help` text.
 */
export function flagPresent(helpText, flag) {
  if (!helpText) return false;

  let idx = helpText.indexOf(flag);
  while (idx !== -1) {
    const before = idx === 0 ? "" : helpText[idx - 1];
    const after = helpText[idx + flag.length] ?? "";
    const boundaryBefore = before === "" || /[\s,]/.test(before);
    const boundaryAfter = after === "" || /[\s,<[]/.test(after);

    if (boundaryBefore && boundaryAfter) return true;

    idx = helpText.indexOf(flag, idx + 1);
  }

  return false;
}

/**
 * Given captured `claude --help` text, return the subset of
 * `REQUIRED_CLAUDE_FLAGS` that is missing. Pure — the caller decides whether
 * an empty list is required before proceeding.
 */
export function missingClaudeFlags(helpText) {
  return REQUIRED_CLAUDE_FLAGS.filter(flag => !flagPresent(helpText, flag));
}
