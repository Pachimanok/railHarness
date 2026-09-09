import { test } from "node:test";
import assert from "node:assert/strict";

import { readIntervalEnv } from "../src/worker/cli.js";

test("readIntervalEnv: usa el default cuando la variable está ausente o vacía", () => {
  assert.equal(readIntervalEnv({}, "RAIL_X", 30_000), 30_000);
  assert.equal(readIntervalEnv({ RAIL_X: "   " }, "RAIL_X", 30_000), 30_000);
});

test("readIntervalEnv: parsea un entero de milisegundos positivo", () => {
  assert.equal(readIntervalEnv({ RAIL_X: "12000" }, "RAIL_X", 30_000), 12_000);
  assert.equal(readIntervalEnv({ RAIL_X: "500.9" }, "RAIL_X", 30_000), 500);
});

test("readIntervalEnv: rechaza valores no numéricos o <= 0", () => {
  assert.throws(() => readIntervalEnv({ RAIL_X: "0" }, "RAIL_X", 1), /entero de milisegundos > 0/);
  assert.throws(() => readIntervalEnv({ RAIL_X: "-5" }, "RAIL_X", 1), /entero de milisegundos > 0/);
  assert.throws(() => readIntervalEnv({ RAIL_X: "abc" }, "RAIL_X", 1), /entero de milisegundos > 0/);
});
