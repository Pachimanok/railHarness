/**
 * AdapterRouter — RAIL-D-00004.
 *
 * The provider-agnostic seam between the Harness (Worker Core / Orchestration)
 * and a concrete coding adapter. It:
 *
 *   - exposes a STABLE interface that does not mention any provider;
 *   - selects the adapter by EXPLICIT configuration (constructor `provider`, or
 *     a per-call `opts.provider` override);
 *   - rejects an unknown provider DETERMINISTICALLY (`ADAPTER_UNKNOWN_PROVIDER`);
 *   - lets Codex / other runtimes be added later by registering another entry
 *     in the `adapters` map — WITHOUT touching the Worker Core;
 *   - forwards a validated `ExecutionEnvelope` to `adapter.run` /
 *     `adapter.preflight` / `adapter.createExecution`.
 *
 * Hard rules (docs/ADAPTER_CONTRACT.md, ticket RAIL-D-00004):
 *   - NO Rail logic here: no Rail client import, no transitions, no checks, no
 *     queries.
 *   - NO `claimToken` / secret crosses this layer: every envelope is re-checked
 *     with `assertNoSecrets` before it reaches an adapter.
 *   - The router receives no token and holds no state about a Run.
 */

import { assertNoSecrets } from "../contracts/execution-envelope.js";
import { claudeCodeAdapter } from "./claude-code.js";

/** Machine-readable failure codes. Identifiers — never translated. */
export const ADAPTER_ROUTER_ERROR_CODES = Object.freeze({
  NO_PROVIDER: "ADAPTER_NO_PROVIDER",
  UNKNOWN_PROVIDER: "ADAPTER_UNKNOWN_PROVIDER",
  BAD_ADAPTER: "ADAPTER_BAD_INTERFACE"
});

/** Adapters wired by default. Codex / others slot in here later. */
export const DEFAULT_ADAPTERS = Object.freeze({
  [claudeCodeAdapter.provider]: claudeCodeAdapter
});

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Build an AdapterRouter.
 *
 * @param {object} [p]
 * @param {string|null} [p.provider]   provider selected by explicit config.
 * @param {Record<string, object>} [p.adapters]  registry `{ name: adapter }`;
 *        every adapter must expose `preflight` and `run` functions.
 */
export function createAdapterRouter({ provider = null, adapters = DEFAULT_ADAPTERS } = {}) {
  const registry = new Map(Object.entries(adapters ?? {}));

  if (registry.size === 0) {
    throw fail(
      ADAPTER_ROUTER_ERROR_CODES.BAD_ADAPTER,
      "createAdapterRouter requiere al menos un adapter registrado."
    );
  }
  for (const [name, adapter] of registry) {
    if (
      !adapter ||
      typeof adapter.preflight !== "function" ||
      typeof adapter.run !== "function"
    ) {
      throw fail(
        ADAPTER_ROUTER_ERROR_CODES.BAD_ADAPTER,
        `El adapter "${name}" no cumple la interfaz estable { preflight, run }.`
      );
    }
  }

  const knownProviders = () => [...registry.keys()];

  function resolve(explicitProvider) {
    const name = explicitProvider ?? provider;
    if (!name) {
      throw fail(
        ADAPTER_ROUTER_ERROR_CODES.NO_PROVIDER,
        "No se indicó ningún provider de adapter. Configurá uno explícitamente " +
          `(disponibles: ${knownProviders().join(", ") || "(ninguno)"}).`
      );
    }
    const adapter = registry.get(name);
    if (!adapter) {
      throw fail(
        ADAPTER_ROUTER_ERROR_CODES.UNKNOWN_PROVIDER,
        `Provider de adapter desconocido: "${name}". ` +
          `Providers disponibles: ${knownProviders().join(", ") || "(ninguno)"}.`
      );
    }
    return adapter;
  }

  function guardEnvelope(envelope) {
    if (!envelope || typeof envelope !== "object") {
      throw fail(
        ADAPTER_ROUTER_ERROR_CODES.BAD_ADAPTER,
        "El AdapterRouter requiere un ExecutionEnvelope."
      );
    }
    // No claimToken / credencial de Rail puede cruzar hacia un adapter.
    assertNoSecrets(envelope);
  }

  return {
    /** The explicitly-configured provider, or null. */
    get provider() {
      return provider;
    },
    knownProviders,

    /** Resolve (and return) the adapter for `explicitProvider ?? configured`. */
    select(explicitProvider) {
      return resolve(explicitProvider);
    },

    /** Delegate `preflight()` to the selected adapter. */
    preflight(opts = {}) {
      const { provider: p, ...rest } = opts;
      return resolve(p).preflight(rest);
    },

    /** Delegate `run(envelope)` to the selected adapter. */
    run(envelope, opts = {}) {
      const { provider: p, ...rest } = opts;
      const adapter = resolve(p);
      guardEnvelope(envelope);
      return adapter.run(envelope, rest);
    },

    /**
     * Delegate to `adapter.createExecution(envelope)` when the adapter provides
     * it (a cancelable `{ done, cancel }` handle for the Worker Core), else fall
     * back to a thin wrapper over `run()`.
     */
    createExecution(envelope, opts = {}) {
      const { provider: p, ...rest } = opts;
      const adapter = resolve(p);
      guardEnvelope(envelope);
      if (typeof adapter.createExecution === "function") {
        return adapter.createExecution(envelope, rest);
      }
      let cancelled = false;
      const done = Promise.resolve(adapter.run(envelope, rest));
      return {
        done,
        cancel() {
          cancelled = true;
        },
        get cancelled() {
          return cancelled;
        }
      };
    }
  };
}
