/**
 * `npm run worker` — the persistent Worker Core process.
 *
 * Reads the runtime config, builds a RailApiClient, and drives
 * `createWorkerCore` with the placeholder execution (no real workspace /
 * adapter / orchestration yet — see docs/WORKER_CORE.md). Human-facing output
 * is Spanish; the Rail token and any per-Run claimToken are never printed.
 *
 * SIGINT / SIGTERM request a controlled stop: the Core stops claiming new
 * work, cancels the active execution if any, releases the Run it owns, and
 * exits. A second signal forces an immediate exit.
 */

import os from "node:os";

import { loadRuntimeConfig, describeConfig } from "../config/runtime-config.js";
import { RailApiClient } from "../rail/rail-api-client.js";
import { createWorkerCore } from "./worker-core.js";
import { createPlaceholderExecution } from "./placeholder-execution.js";

/** Parse an optional positive-integer ms env var, falling back to `fallback`. */
export function readIntervalEnv(env, name, fallback) {
  const raw = (env[name] ?? "").toString().trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} debe ser un entero de milisegundos > 0 (recibí "${raw}").`);
  }
  return Math.floor(n);
}

export async function runWorkerCli({ env = process.env, logger = line => console.log(line) } = {}) {
  const config = loadRuntimeConfig(env, { machineFallback: os.hostname() });

  logger("Rail Harness — Worker Core");
  logger(describeConfig(config));
  logger("");

  const heartbeatIntervalMs = readIntervalEnv(
    env,
    "RAIL_HEARTBEAT_INTERVAL_MS",
    5 * 60 * 1000
  );
  const discoveryPollMs = readIntervalEnv(env, "RAIL_DISCOVERY_POLL_MS", 30 * 1000);

  if (heartbeatIntervalMs >= 15 * 60 * 1000) {
    logger(
      "Aviso: el intervalo de heartbeat es alto; asegurate de que sea menor que la " +
        "duración del lease que otorga Rail."
    );
  }

  const api = RailApiClient.fromRuntimeConfig(config);

  const worker = createWorkerCore({
    api,
    projectId: config.rail.projectId,
    createExecution: ctx => createPlaceholderExecution(ctx, { logger }),
    heartbeatIntervalMs,
    discoveryPollMs,
    logger
  });

  let signalsSeen = 0;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      signalsSeen += 1;
      if (signalsSeen === 1) {
        worker.requestStop(`Señal ${signal} recibida`);
      } else {
        logger("Segunda señal recibida: salida inmediata.");
        process.exit(130);
      }
    });
  }

  await worker.start();
  return worker.getState();
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  runWorkerCli()
    .then(() => process.exit(0))
    .catch(err => {
      console.error("WORKER CORE FATAL:");
      console.error(err);
      process.exit(1);
    });
}
