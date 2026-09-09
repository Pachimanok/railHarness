/**
 * Placeholder execution for the Worker Core.
 *
 * The Worker Core supervises exactly one "execution" between `claim` and
 * `finish`. The real execution — isolated git workspace + Claude Code adapter
 * + Implementer/Reviewer/Tester orchestration — is delivered by later tickets
 * (TMP-003 / TMP-004 / TMP-005).
 *
 * Until then, `npm run worker` wires THIS placeholder: it touches nothing (no
 * git, no filesystem, no Rail), and it simply holds — keeping the Run alive
 * via the Core's heartbeat — until the Core cancels it (SIGINT / SIGTERM, or
 * loss of ownership / fencing).
 *
 * Contract (see `createWorkerCore`): a factory `(ctx) => { done, cancel }`.
 *   - `ctx` is `{ ref, ticket, branch, run: { id } }` — NEVER a claimToken.
 *   - `done` is a Promise that settles only when `cancel()` is called.
 *   - `cancel(reason)` makes `done` resolve promptly.
 */
export function createPlaceholderExecution(ctx, { logger = line => console.log(line) } = {}) {
  const log = msg => {
    try {
      logger(String(msg));
    } catch {
      /* ignore */
    }
  };

  log(
    `Ejecución PLACEHOLDER para ${ctx?.ref} (Run ${ctx?.run?.id}). ` +
      "No hay Workspace Manager ni adapter reales todavía (TMP-003/004/005): " +
      "no se toca el repositorio."
  );
  log(
    "El Worker Core mantiene el Run vivo con heartbeat hasta recibir SIGINT/SIGTERM " +
      "o hasta perder el ownership."
  );

  let resolveDone;
  const done = new Promise(resolve => {
    resolveDone = resolve;
  });

  return {
    done,
    cancel(reason = "cancelación solicitada") {
      log(`Ejecución PLACEHOLDER cancelada: ${reason}. No había nada que revertir.`);
      resolveDone({
        outcome: "RELEASED",
        note: `Ejecución placeholder finalizada sin trabajo: ${reason}.`
      });
    }
  };
}
