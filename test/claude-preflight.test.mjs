import { test } from "node:test";
import assert from "node:assert/strict";

import {
  flagPresent,
  missingClaudeFlags,
  REQUIRED_CLAUDE_FLAGS
} from "../src/adapters/claude-preflight.js";

// Trimmed real `claude --help` excerpt, enough to exercise detection without
// the binary being installed where tests run.
const HELP = `
Options:
  --allowedTools, --allowed-tools <tools...>   Comma or space-separated list of tool names to allow
  --json-schema <schema>                       JSON Schema for structured output validation.
  --output-format <format>                     Output format (only works with --print)
  --permission-mode <mode>                     Permission mode to use for the session
  -p, --print                                  Print response and exit (useful for pipes).
  -r, --resume [value]                         Resume a conversation by session ID
  --session-id <uuid>                          Use a specific session ID for the conversation
  --tools <tools...>                           Specify the list of available tools from the built-in set.
  -n, --name <name>                            Set a display name for this session
`;

test("REQUIRED_CLAUDE_FLAGS does NOT include --permission-prompts", () => {
  assert.ok(!REQUIRED_CLAUDE_FLAGS.includes("--permission-prompts"));
});

test("REQUIRED_CLAUDE_FLAGS is frozen", () => {
  assert.ok(Object.isFrozen(REQUIRED_CLAUDE_FLAGS));
});

test("flagPresent finds every required flag in the help excerpt", () => {
  for (const flag of REQUIRED_CLAUDE_FLAGS) {
    assert.equal(flagPresent(HELP, flag), true, `expected to find ${flag}`);
  }
  assert.deepEqual(missingClaudeFlags(HELP), []);
});

test("flagPresent distinguishes --tools from --allowedTools", () => {
  const onlyAllowed = "  --allowedTools, --allowed-tools <tools...>   ...";
  assert.equal(flagPresent(onlyAllowed, "--tools"), false);
  assert.equal(flagPresent(onlyAllowed, "--allowedTools"), true);
});

test("missingClaudeFlags reports a dropped flag", () => {
  const helpNoResume = HELP.split("\n").filter(l => !l.includes("--resume")).join("\n");
  assert.deepEqual(missingClaudeFlags(helpNoResume), ["--resume"]);
});

test("empty / null help never yields a false positive", () => {
  assert.equal(flagPresent("", "--print"), false);
  assert.equal(flagPresent(null, "--print"), false);
});
