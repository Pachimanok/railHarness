#!/usr/bin/env node
/**
 * `rail-harness` executable — Developer Console entry point (HC-01).
 *
 * Thin wrapper: parses nothing itself, just hands `process.argv` off to
 * `runCli` and exits with the code it returns. No Worker Core, no Rail.
 */

import { runCli } from "../src/console/cli.js";

runCli()
  .then(code => process.exit(code ?? 0))
  .catch(err => {
    console.error("Rail Harness — error fatal:");
    console.error(err?.message || err);
    process.exit(1);
  });
