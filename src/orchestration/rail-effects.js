/**
 * Governed Rail effects for the Orchestration layer — RAIL-D-00005.
 *
 * Every write to Rail the orchestrator performs goes through here:
 *   - `publishCheck`      — POST /tickets/:ref/checks  (only WITH valid evidence)
 *   - `requestTransition` — POST /tickets/:ref/transitions
 *   - `raiseBlockingQuery`— POST /tickets/:ref/queries  ({ blocking: true })
 *   - `governedNote`      — POST /tickets/:ref/comments  (factual hand-off note)
 *
 * Rail stays the authority (docs/HARNESS.md, docs/STATE_MACHINE.md):
 *   - a check is NEVER created without real evidence (`assertCheckEvidence`);
 *   - a transition Rail rejects is RESPECTED — never forced, never simulated;
 *   - a `humanOnly` frontier is surfaced, never satisfied with a fake approval.
 *
 * This module needs the `RailApiClient` and the `runId` only. It never sees a
 * `claimToken` (checks / transitions / queries are authorized by the agent
 * bearer token + `runId`; see docs/PROTOCOL.md).
 */

/**
 * WorkCycle transitions the orchestrator may request, in order, and the checks
 * that gate each one. Read-only mirror of docs/STATE_MACHINE.md — Rail
 * re-validates every one server-side.
 */
export const TRANSITION_PLAN = Object.freeze([
  Object.freeze({
    from: "CLAIMED",
    to: "IN_PROGRESS",
    afterRole: null,
    gatingChecks: Object.freeze([])
  }),
  Object.freeze({
    from: "IN_PROGRESS",
    to: "REVIEWING",
    afterRole: "IMPLEMENTER",
    gatingChecks: Object.freeze(["IMPLEMENTATION"])
  }),
  Object.freeze({
    from: "REVIEWING",
    to: "TESTING",
    afterRole: "REVIEWER",
    gatingChecks: Object.freeze(["CODE_REVIEW"])
  }),
  Object.freeze({
    from: "TESTING",
    to: "SANDBOX_READY",
    afterRole: "TESTER",
    gatingChecks: Object.freeze(["AUTOMATED_TESTS", "ACCEPTANCE_CRITERIA"])
  })
]);

/** Check types this layer knows how to back with evidence. */
export const ORCHESTRATION_CHECK_TYPES = Object.freeze([
  "IMPLEMENTATION",
  "CODE_REVIEW",
  "AUTOMATED_TESTS",
  "ACCEPTANCE_CRITERIA"
]);

/**
 * Throw (Spanish, `code = ORCH_INSUFFICIENT_EVIDENCE`) unless `evidence` really
 * backs a PASS `type` check. This is the guard behind "los checks se publican
 * SÓLO con evidencia válida" (DoD).
 */
export function assertCheckEvidence(type, evidence) {
  const e = evidence && typeof evidence === "object" ? evidence : {};
  const fail = msg => {
    const err = new Error(
      `No se publica el check ${type} sin evidencia válida: ${msg}. No se fabrica un PASS.`
    );
    err.code = "ORCH_INSUFFICIENT_EVIDENCE";
    throw err;
  };

  const nonEmptyStr = v => typeof v === "string" && v.trim() !== "";
  const strArr = v => Array.isArray(v) && v.length > 0 && v.every(nonEmptyStr);

  switch (type) {
    case "IMPLEMENTATION":
      if (!nonEmptyStr(e.summary)) fail("falta un 'summary' de lo implementado");
      return;
    case "CODE_REVIEW":
      if (e.reviewerDecision !== "PASS") {
        fail("la decisión del Reviewer no es PASS");
      }
      if (!nonEmptyStr(e.summary)) fail("falta el 'summary' del Reviewer");
      return;
    case "AUTOMATED_TESTS":
      if (!strArr(e.tests)) {
        fail("no hay comandos de test ejecutados con resultado en 'tests'");
      }
      return;
    case "ACCEPTANCE_CRITERIA":
      if (!Array.isArray(e.acceptanceCriteria) || e.acceptanceCriteria.length === 0) {
        fail("no hay Acceptance Criteria evaluados");
      }
      for (const ac of e.acceptanceCriteria) {
        if (!ac || !nonEmptyStr(ac.id)) fail("un Acceptance Criterion no tiene id");
        if (ac.status !== "PASS") {
          fail(`el Acceptance Criterion ${ac.id} no está en PASS`);
        }
      }
      return;
    default:
      fail(`tipo de check no soportado por la orquestación (${type})`);
  }
}

const HUMAN_ONLY_RE = /(HUMAN[_-]?ONLY|HUMAN[_-]?APPROVAL|MANUAL[_-]?GATE|APPROVAL[_-]?REQUIRED|NEEDS[_-]?HUMAN)/i;

/** Does a thrown Rail error mean "this transition needs a human, not the agent"? */
export function isHumanOnlyRejection(err) {
  if (!err) return false;
  if (err.data?.gateResults?.humanOnly === true) return true;
  if (err.code && HUMAN_ONLY_RE.test(String(err.code))) return true;
  if (err.message && HUMAN_ONLY_RE.test(String(err.message))) return true;
  return false;
}

/** Read a `gateResults`-like node off a transition response, whatever the key. */
function gateResultsOf(res) {
  if (!res || typeof res !== "object") return null;
  return res.gateResults ?? res.gate ?? res.transition?.gateResults ?? null;
}

/**
 * Interpret a 2xx transition response. Rail may answer 2xx with the transition
 * NOT applied (a gate failed). We only treat it as applied when nothing says
 * otherwise.
 */
export function classifyTransition(res, to) {
  const gate = gateResultsOf(res);
  if (res && res.applied === false) {
    return { applied: false, humanOnly: Boolean(gate?.humanOnly), missing: gate?.missing ?? [] };
  }
  if (gate && gate.passed === false) {
    return { applied: false, humanOnly: Boolean(gate.humanOnly), missing: gate.missing ?? [] };
  }
  const landed = res?.toState ?? res?.to ?? res?.transition?.toState ?? null;
  if (landed && to && landed !== to) {
    return { applied: false, humanOnly: Boolean(gate?.humanOnly), missing: gate?.missing ?? [] };
  }
  return { applied: true, humanOnly: false, missing: [] };
}

/**
 * A compact, human-readable digest of the evidence behind a check, folded into
 * the check `note` so Rail actually RECEIVES the evidence (the checks endpoint
 * only carries free-text `note` + `detailsUrl`). Spanish; no secrets.
 */
export function digestEvidence(type, evidence) {
  const e = evidence && typeof evidence === "object" ? evidence : {};
  switch (type) {
    case "IMPLEMENTATION": {
      const files = (e.filesChanged ?? []).slice(0, 12).join(", ");
      return `implementado: ${e.summary}${files ? ` | archivos: ${files}` : ""}`;
    }
    case "CODE_REVIEW":
      return `revisión independiente: PASS | ${e.summary}`;
    case "AUTOMATED_TESTS":
      return `tests ejecutados: ${(e.tests ?? []).join("; ")}`;
    case "ACCEPTANCE_CRITERIA":
      return `AC: ${(e.acceptanceCriteria ?? [])
        .map(ac => `${ac.id}=${ac.status}`)
        .join("; ")}`;
    default:
      return "";
  }
}

/** Normalize whatever `listQueries` returns into a plain array of queries. */
export function extractQueries(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.queries)) return data.queries;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

/**
 * RailSoft's authoritative `RailQueryStatus` enum. There is no `ANSWERED` and no
 * `CLOSED` — anything outside this set is a contract violation, handled
 * fail-closed (see `createResolvedQueryWaiter`).
 *
 *   PENDING   — the query is open; the advance keeps waiting.
 *   RESOLVED  — a human answered; `answerQuery` guarantees non-empty `answer`
 *               text (empty text is rejected server-side as `invalid_input`).
 *   DISMISSED — "descartar sin responder": explicitly discarded WITHOUT a human
 *               answer. RailSoft's `recomputeBlocked` restores the WorkCycle to
 *               `stateBeforeBlock`, but that is NOT an answer for the agent.
 */
export const RAIL_QUERY_STATUSES = Object.freeze(["PENDING", "RESOLVED", "DISMISSED"]);

/** Error a waiter throws when RailSoft's Agent Query contract is violated. */
function queryContractError(msg) {
  const e = new Error(
    `Resolución de Agent Query inválida contra el contrato de RailSoft: ${msg}. ` +
      "Fail-closed: no se reanuda el rol, no se espera eternamente y no se inventa una " +
      "instrucción humana."
  );
  e.code = "ORCH_QUERY_CONTRACT_VIOLATION";
  return e;
}

/**
 * Build a CANCELABLE poller that waits for a governed human resolution of the
 * blocking Agent Query identified EXCLUSIVELY by `queryId`.
 *
 *   - It polls `api.listQueries(ref)` every `pollMs` (no busy-loop).
 *   - It matches ONLY `query.id === queryId`. An old query, a query from another
 *     Run, a query for another block, or one previously resolved NEVER unblocks
 *     this wait — there is NO `list.find(x => x.blocking)` fallback.
 *   - `PENDING`  → keep waiting (the caller's Promise stays pending, so the
 *     Worker Core keeps heartbeating and the Run stays ACTIVE; `finishRun` is
 *     never called).
 *   - `RESOLVED` → resolve `{ kind: "ANSWERED", answer }` with the trimmed human
 *     text. `RESOLVED` without non-empty `answer` contradicts `answerQuery` and
 *     is thrown as a contract violation (never a synthetic answer).
 *   - `DISMISSED` → resolve `{ kind: "DISMISSED" }`. This is NOT a human answer:
 *     the caller must NOT resume, NOT synthesize an instruction.
 *   - Any other status (`ANSWERED`, `CLOSED`, …) → contract violation, thrown.
 *   - A missing / empty `queryId` → contract violation, thrown (RailSoft's
 *     `createQuery` ALWAYS returns a `queryId`).
 *   - It rejects promptly with `ORCH_QUERY_WAIT_CANCELLED` when `signal` aborts.
 *   - A transient `listQueries` read error is retried on the next interval — it
 *     never invents a resolution.
 *
 * All I/O is injected (`api`, `sleep`) so tests never touch a real Rail.
 *
 * @param {object} p
 * @param {object} p.api      RailApiClient (or fake) with `listQueries(ref)`.
 * @param {string} p.ref
 * @param {number} [p.pollMs] poll interval (default 15000).
 * @param {AbortSignal} [p.signal]
 * @param {(ms:number)=>Promise} [p.sleep]
 * @param {(msg:string)=>void} [p.logger]
 * @returns {(q:{queryId:string}) => Promise<{kind:"ANSWERED",answer:string}|{kind:"DISMISSED"}>}
 */
export function createResolvedQueryWaiter({
  api,
  ref,
  pollMs = 15000,
  signal,
  sleep,
  logger = () => {}
} = {}) {
  if (!api || typeof api.listQueries !== "function") {
    throw new Error("createResolvedQueryWaiter requiere api.listQueries(ref)");
  }
  const log = m => {
    try {
      logger(String(m));
    } catch {
      /* ignore */
    }
  };
  const baseSleep =
    typeof sleep === "function"
      ? sleep
      : ms =>
          new Promise(r => {
            const t = setTimeout(r, ms);
            if (t && typeof t.unref === "function") t.unref();
          });

  const abortErr = () => {
    const e = new Error("Espera de la Agent Query cancelada (fencing / shutdown).");
    e.code = "ORCH_QUERY_WAIT_CANCELLED";
    return e;
  };

  // A nap that also settles the instant `signal` aborts (never wait a full
  // poll interval to notice a cancel).
  const nap = ms =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortErr());
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(abortErr());
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      Promise.resolve(baseSleep(ms)).then(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      }, reject);
    });

  return async ({ queryId } = {}) => {
    // B4 — RailSoft's `createQuery` ALWAYS returns a `queryId`. Without one there
    // is no valid query to wait on; do NOT fall back to "some blocking query".
    if (typeof queryId !== "string" || queryId.trim() === "") {
      throw queryContractError("no se recibió un queryId para esperar la resolución");
    }

    for (;;) {
      if (signal?.aborted) throw abortErr();
      await nap(pollMs);

      let data;
      try {
        data = await api.listQueries(ref);
      } catch (err) {
        // Transient read failure — Rail is still the authority; keep waiting.
        log(
          `No pude leer las Agent Queries de ${ref} (${railErrText(err)}); se reintenta ` +
            "en el próximo intervalo."
        );
        continue;
      }

      const list = extractQueries(data);
      // ONLY the query we created. Nothing else may unblock this wait.
      const q = list.find(x => x?.id === queryId || x?.queryId === queryId);
      if (!q) continue; // not visible yet — keep waiting

      const status = String(q.status ?? q.state ?? "").toUpperCase();
      switch (status) {
        case "PENDING":
          continue; // still blocking; keep waiting

        case "RESOLVED": {
          const answer = q.answer ?? q.response ?? q.resolution ?? "";
          if (typeof answer !== "string" || answer.trim() === "") {
            // `answerQuery` never yields RESOLVED without non-empty answer text.
            throw queryContractError(
              `la query ${queryId} figura RESOLVED sin 'answer' textual (answerQuery lo exige)`
            );
          }
          log(`Agent Query ${queryId} resuelta por un humano en ${ref}.`);
          return Object.freeze({ kind: "ANSWERED", answer: answer.trim() });
        }

        case "DISMISSED":
          log(
            `Agent Query ${queryId} descartada (DISMISSED) sin respuesta humana en ${ref}; ` +
              "no se reanuda el rol ni se inventa una instrucción."
          );
          return Object.freeze({ kind: "DISMISSED" });

        default:
          // ANSWERED / CLOSED / unknown — not a RailSoft `RailQueryStatus`.
          throw queryContractError(
            `estado de query desconocido '${status}' para ${queryId} ` +
              "(RailSoft sólo define PENDING / RESOLVED / DISMISSED)"
          );
      }
    }
  };
}

function railErrText(err) {
  const status = err?.status != null ? `status=${err.status}` : "";
  const code = err?.code ? `code=${err.code}` : "";
  const msg = err?.message ? err.message : "";
  return [status, code, msg].filter(Boolean).join(" ");
}

/**
 * Build the governed-effects facade bound to one ticket + Run.
 *
 * @param {object} p
 * @param {object} p.api    RailApiClient (or a compatible fake). Needs
 *                          `createCheck`, `transition`, `createQuery`,
 *                          `addComment`.
 * @param {string} p.ref
 * @param {string} p.runId
 * @param {(msg:string)=>void} [p.logger]  Spanish sink.
 */
export function createRailEffects({ api, ref, runId, logger = () => {} } = {}) {
  if (!api) throw new Error("createRailEffects requiere un cliente Rail (api)");
  if (!ref) throw new Error("createRailEffects requiere ref");
  if (!runId) throw new Error("createRailEffects requiere runId");

  const log = msg => {
    try {
      logger(String(msg));
    } catch {
      /* a broken logger must never break orchestration */
    }
  };

  return {
    /**
     * Create a PASS check — only if `evidence` really backs it. Rail's own
     * rejection is respected: it becomes an `ORCH_CHECK_REJECTED` error the
     * orchestrator turns into a FAILED outcome (never a forced success).
     */
    async publishCheck({ type, evidence, note, detailsUrl }) {
      assertCheckEvidence(type, evidence);
      const digest = digestEvidence(type, evidence);
      const fullNote = [note, digest ? `evidencia: ${digest}` : ""]
        .filter(Boolean)
        .join(" — ");
      try {
        const raw = await api.createCheck(ref, {
          type,
          status: "PASS",
          note: fullNote || null,
          detailsUrl: detailsUrl ?? null,
          runId
        });
        log(`Check ${type}/PASS registrado en Rail para ${ref} (Run ${runId}).`);
        return { created: true, type, raw };
      } catch (err) {
        const e = new Error(
          `Rail rechazó el check ${type} (${railErrText(err)}). Se respeta el rechazo; ` +
            "no se fuerza ni se simula un PASS."
        );
        e.code = "ORCH_CHECK_REJECTED";
        e.cause = err;
        throw e;
      }
    },

    /**
     * Ask Rail for a WorkCycle transition. Returns a plain verdict; NEVER
     * throws for a gate failure (the orchestrator decides HANDOFF vs FAILED).
     */
    async requestTransition({ from, to, reason }) {
      try {
        const raw = await api.transition(ref, { to, reason, runId });
        const verdict = classifyTransition(raw, to);
        if (verdict.applied) {
          log(`Transición ${from} → ${to} aplicada por Rail para ${ref}.`);
          return { applied: true, humanOnly: false, missing: [], raw };
        }
        log(
          `Rail NO aplicó la transición ${from} → ${to}` +
            (verdict.humanOnly ? " (humanOnly)" : "") +
            (verdict.missing.length ? `; falta: ${verdict.missing.join(", ")}` : "") +
            ". Se respeta la decisión de Rail."
        );
        return { applied: false, humanOnly: verdict.humanOnly, missing: verdict.missing, raw };
      } catch (err) {
        const humanOnly = isHumanOnlyRejection(err);
        log(
          `Rail rechazó la transición ${from} → ${to} (${railErrText(err)})` +
            (humanOnly ? " — requiere acción humanOnly" : "") +
            ". No se fuerza ni se reintenta."
        );
        return {
          applied: false,
          humanOnly,
          rejected: true,
          missing: Array.isArray(err?.missing) ? err.missing : [],
          reason: err?.message ?? "rechazo de Rail",
          raw: err?.data ?? null
        };
      }
    },

    /**
     * Raise a blocking Agent Query. On Rail rejection returns
     * `{ created: false, rejected: true }` — the orchestrator then stops the
     * advance and never invents an answer.
     */
    async raiseBlockingQuery({ question, context, impact, audienceRole }) {
      try {
        const raw = await api.createQuery(ref, {
          question,
          context: context ?? null,
          impact: impact ?? null,
          ...(audienceRole ? { audienceRole } : {}),
          blocking: true,
          runId
        });
        const id = raw?.id ?? raw?.query?.id ?? raw?.queryId ?? null;
        log(
          `Agent Query bloqueante creada en Rail para ${ref}${id ? ` (${id})` : ""}. ` +
            "El avance se detiene hasta una respuesta humana gobernada."
        );
        return { created: true, id, raw };
      } catch (err) {
        log(
          `Rail rechazó la creación de la Agent Query (${railErrText(err)}). ` +
            "No se fuerza; el avance se detiene igual."
        );
        return { created: false, rejected: true, reason: err?.message ?? "rechazo de Rail" };
      }
    },

    /** A factual, human-facing note (Spanish). Best-effort; never fabricates state. */
    async governedNote(content) {
      try {
        await api.addComment(ref, content);
        log(`Nota gobernada agregada a ${ref}.`);
      } catch (err) {
        log(`No se pudo agregar la nota gobernada a ${ref} (${railErrText(err)}).`);
      }
    }
  };
}
