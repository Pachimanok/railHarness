/**
 * Ticket preflight for the Worker Core.
 *
 * Pure, read-only checks the Worker Core runs on a Rail ticket detail BEFORE
 * asking Rail to `claim` it. Mirrors "Claim preconditions" in
 * docs/STATE_MACHINE.md (1-4; precondition 5, `targetRepository` vs the local
 * git origin, needs the Workspace Manager and is intentionally NOT here yet —
 * see docs/WORKER_CORE.md).
 *
 * Derived from the approved reference
 * (`~/rail-runner/harness/scripts/harness.mjs` `assertTicketClaimable`). No
 * I/O, no logging: the caller decides what to print. Failure => throw, and the
 * Worker Core must not mutate anything.
 *
 * Every thrown message ends with `No claim was created.` so a human log makes
 * the "nothing was mutated" guarantee explicit.
 */

const NO_CLAIM = "No claim was created.";

/**
 * Throw an explicit Error unless `detail` is a Rail ticket that can be claimed
 * right now for `projectId`. Pure. Preconditions, in order:
 *
 *   1. `detail` exists and is an object.
 *   2. `detail.projectId === projectId`.
 *   3. `detail.blocked` is falsy (no open blocking Agent Query).
 *   4. `detail.state === "READY"`.
 *   5. `detail.activeRun` is absent (a `WorkCycle` has at most one).
 *
 * `READY`, `BLOCKED`, `IN_PROGRESS`, … are Rail protocol values — never
 * translated, even though this Harness logs in Spanish.
 */
export function assertTicketClaimable(detail, projectId, ref) {
  if (!detail || typeof detail !== "object") {
    throw new Error(
      `El ticket "${ref}" no existe o Rail no devolvió detalle. ${NO_CLAIM}`
    );
  }
  if (detail.projectId !== projectId) {
    throw new Error(
      `Project mismatch: el ticket "${ref}" pertenece a projectId=${detail.projectId}, ` +
        `configurado=${projectId}. ${NO_CLAIM}`
    );
  }
  if (detail.blocked) {
    throw new Error(
      `El ticket "${ref}" está BLOCKED (stateBeforeBlock=${detail.stateBeforeBlock ?? "?"}). ` +
        `Hay una Agent Query bloqueante abierta. ${NO_CLAIM}`
    );
  }
  if (detail.state !== "READY") {
    throw new Error(
      `El ticket "${ref}" no está READY (state=${detail.state}). ` +
        `Sólo se reclama desde READY. ${NO_CLAIM}`
    );
  }
  if (detail.activeRun) {
    throw new Error(
      `El ticket "${ref}" ya tiene un activeRun (${detail.activeRun.id}, ` +
        `agent=${detail.activeRun.agent ?? "?"}). ${NO_CLAIM}`
    );
  }
  return detail;
}

/**
 * Non-throwing form of {@link assertTicketClaimable}. Returns
 * `{ claimable: boolean, reason: string|null }` — `reason` is a Spanish,
 * secret-free explanation when `claimable` is false. Use this in the discovery
 * loop to decide, without an exception, whether to move to the next candidate.
 */
export function isTicketClaimable(detail, projectId, ref) {
  try {
    assertTicketClaimable(detail, projectId, ref);
    return { claimable: true, reason: null };
  } catch (err) {
    return { claimable: false, reason: err.message };
  }
}

/**
 * Pull the first candidate ticket ref out of a `GET /tickets?state=READY`
 * response (`RailApiClient.listReady`). Rail returns `{ items: [ { item: {
 * code, id, title } } ] }`; a couple of shape variants are tolerated. Returns
 * the ref string (`item.code` preferred, `item.id` fallback), or `null` when
 * there is nothing READY. Pure.
 */
export function pickDiscoveryRef(readyResponse) {
  const items = Array.isArray(readyResponse)
    ? readyResponse
    : readyResponse?.items || readyResponse?.tickets || [];

  for (const candidate of items) {
    const item = candidate?.item || candidate;
    const ref = item?.code || item?.id;
    if (ref) return String(ref);
  }
  return null;
}
