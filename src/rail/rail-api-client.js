/**
 * Rail API client for the Harness.
 * Node 18+ (global `fetch`).
 *
 * Rail is authoritative for states and gates — this client only speaks the
 * protocol (see docs/PROTOCOL.md). Ported from the approved reference
 * (`~/rail-runner/harness/api/rail-api-client.js`) with no behavioural change;
 * only the module layout differs.
 *
 * This client NEVER logs. It returns tokens inside result objects but writes
 * nothing to stdout/stderr — callers must route anything human-facing through
 * `src/security/sanitize.js`.
 */

/**
 * The ONE Run-handoff shape the caller sees, shared by `claim()` and
 * `recover()`:
 *
 *   {
 *     run: { id, claimToken, leaseExpiresAt },
 *     recovered: { fromRunId, cycleState } | null,   // only recover() fills this
 *     raw: <original Rail response, untouched>
 *   }
 *
 * Rail returns the freshly-created Run under different keys per endpoint:
 *   - POST /claim   -> { run: { id, claimToken, leaseExpiresAt }, ... }
 *   - POST /recover -> { activeRun: { id, state, claimToken?, leaseExpiresAt? },
 *                        recoveryOfRunId, cycle: { state } }
 *   - variants that put it top-level: { id, claimToken, leaseExpiresAt }
 *
 * Normalizing here decouples the caller from each endpoint's exact shape.
 * NEVER logs the claimToken: it is only returned inside the object.
 */
export function normalizeRunHandoff(data) {
  const d = data && typeof data === "object" ? data : {};
  const runNode =
    (d.run && typeof d.run === "object" && d.run) ||
    (d.activeRun && typeof d.activeRun === "object" && d.activeRun) ||
    (d.recoveredRun && typeof d.recoveredRun === "object" && d.recoveredRun) ||
    d;

  const pick = (...keys) => {
    for (const k of keys) {
      if (runNode && runNode[k] != null) return runNode[k];
      if (d[k] != null) return d[k];
    }
    return null;
  };

  return {
    run: {
      id: pick("id", "runId", "run_id"),
      claimToken: pick("claimToken", "claim_token"),
      leaseExpiresAt: pick("leaseExpiresAt", "lease_expires_at", "leaseExpiry")
    },
    recovered: {
      fromRunId:
        d.recovered?.fromRunId ??
        d.recoveryOfRunId ??
        d.fromRunId ??
        (runNode && runNode.recoveryOfRunId) ??
        null,
      cycleState:
        d.recovered?.cycleState ??
        d.cycle?.state ??
        d.cycleState ??
        d.state ??
        null
    },
    raw: data ?? null
  };
}

export class RailApiClient {
  constructor({ baseUrl, token, agent, machine, actor = "agent" }) {
    if (!baseUrl || !token) throw new Error("baseUrl and token are required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.agent = agent;
    this.machine = machine;
    this.actor = actor;
  }

  /**
   * Build the config for a Harness runtime config object
   * (`src/config/runtime-config.js`).
   */
  static fromRuntimeConfig(config) {
    return new RailApiClient({
      baseUrl: config.rail.apiUrl,
      token: config.rail.token,
      agent: config.agent,
      machine: config.machine,
      actor: config.actor ?? "agent"
    });
  }

  async request(path, { method = "GET", body, headers = {} } = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(this.agent ? { "X-Rail-Agent": this.agent } : {}),
        ...(this.machine ? { "X-Rail-Machine": this.machine } : {}),
        ...(this.actor ? { "X-Rail-Actor": this.actor } : {}),
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(data?.error || `Rail API ${res.status}`);
      err.status = res.status;
      err.code = data?.code;
      err.missing = data?.missing || [];
      err.data = data;
      throw err;
    }
    return data;
  }

  // ── Read-only ──────────────────────────────────────────────────────────

  listTickets(params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    return this.request(`/tickets${qs.size ? `?${qs}` : ""}`);
  }

  listReady(projectId, limit = 50) {
    return this.listTickets({ projectId, state: "READY", kind: "ticket", limit });
  }

  getTicket(ref) {
    return this.request(`/tickets/${encodeURIComponent(ref)}`);
  }

  listQueries(ref) {
    return this.request(`/tickets/${encodeURIComponent(ref)}/queries`);
  }

  listChecks(ref, all = false) {
    return this.request(
      `/tickets/${encodeURIComponent(ref)}/checks${all ? "?all=1" : ""}`
    );
  }

  listDeployments(ref) {
    return this.request(`/tickets/${encodeURIComponent(ref)}/deployments`);
  }

  listApprovals(ref) {
    return this.request(`/tickets/${encodeURIComponent(ref)}/approvals`);
  }

  timeline(ref) {
    return this.request(`/tickets/${encodeURIComponent(ref)}/timeline`);
  }

  listProjects() {
    return this.request(`/projects`);
  }

  getEnvironments(projectId) {
    return this.request(`/projects/${encodeURIComponent(projectId)}/environments`);
  }

  // ── Mutating (governed by Rail) ───────────────────────────────────────

  async claim(ref, branch) {
    const data = await this.request(`/tickets/${encodeURIComponent(ref)}/claim`, {
      method: "POST",
      body: branch ? { branch } : {}
    });
    return normalizeRunHandoff(data);
  }

  /**
   * Governed GENERAL continuation of ownership on a NON-terminal cycle
   * (`POST /tickets/:ref/resume`). RailSoft's `/resume`:
   *   - preserves `WorkCycle.state` EXACTLY (`REVIEWING → REVIEWING`, …);
   *   - applies to any non-terminal state except `BLOCKED`;
   *   - stale takeover: `activeRun` `ACTIVE` with `leaseExpiresAt <= now`,
   *     `lastRunId == activeRun.id`;
   *   - ownerless resume: `activeRun == null`, `lastRunId ==` the last Run of the
   *     SAME cycle whose `state != ACTIVE` (`COMPLETED` / `RELEASED` / `FAILED` /
   *     `ABANDONED` are ALL valid — the old Run stays terminal and untouched).
   * Creates a NEW `ACTIVE` Run with `recoveryOfRunId = <old Run>`; the cycle
   * state does NOT change. If the endpoint is absent the server answers
   * 404/405/501 and the caller must abort with NO improvised mutation. The
   * response is normalized exactly like `claim()` / `recover()`.
   */
  async resume(ref, { branch, worktreePath, lastRunId, reason } = {}) {
    const data = await this.request(`/tickets/${encodeURIComponent(ref)}/resume`, {
      method: "POST",
      body: { branch, worktreePath, lastRunId, reason }
    });
    return normalizeRunHandoff(data);
  }

  /**
   * Governed recover/reclaim of an orphaned IN_PROGRESS cycle
   * (`POST /tickets/:ref/recover`) — COMPATIBILITY path only: `state ==
   * IN_PROGRESS`, `activeRun == null`, last Run `FAILED` / `ABANDONED` (RailSoft
   * also allows an `IN_PROGRESS` stale takeover here). It does NOT replace the
   * general `/resume` semantics (`resume()` above) that RAIL-D-00006's AC
   * require. See docs/STATE_MACHINE.md / docs/RECOVERY.md. If Rail has not
   * deployed the endpoint the server answers 404/405/501 and the caller must
   * abort without any improvised mutation. The response is normalized like
   * `claim()`.
   */
  async recover(ref, { branch, worktreePath, lastRunId, reason } = {}) {
    const data = await this.request(`/tickets/${encodeURIComponent(ref)}/recover`, {
      method: "POST",
      body: { branch, worktreePath, lastRunId, reason }
    });
    return normalizeRunHandoff(data);
  }

  transition(ref, { to, reason, runId }) {
    return this.request(`/tickets/${encodeURIComponent(ref)}/transitions`, {
      method: "POST",
      body: { to, reason, runId }
    });
  }

  addComment(ref, content) {
    return this.request(`/tickets/${encodeURIComponent(ref)}/comments`, {
      method: "POST",
      body: { content }
    });
  }

  createQuery(
    ref,
    { question, context, impact, audienceRole, blocking = true, runId, answerWebhookUrl }
  ) {
    return this.request(`/tickets/${encodeURIComponent(ref)}/queries`, {
      method: "POST",
      body: {
        question,
        context,
        impact,
        audienceRole,
        blocking,
        runId,
        ...(answerWebhookUrl ? { answerWebhookUrl } : {})
      }
    });
  }

  createCheck(ref, { type, status, headSha, detailsUrl, note, runId }) {
    return this.request(`/tickets/${encodeURIComponent(ref)}/checks`, {
      method: "POST",
      body: { type, status, headSha, detailsUrl, note, runId }
    });
  }

  createDeployment(
    ref,
    { environmentKind, status, commitSha, prNumber, releaseRef, logUri, runId }
  ) {
    return this.request(`/tickets/${encodeURIComponent(ref)}/deployments`, {
      method: "POST",
      body: { environmentKind, status, commitSha, prNumber, releaseRef, logUri, runId }
    });
  }

  updateDeployment(id, { status, verification, note, logUri }) {
    return this.request(`/deployments/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { status, verification, note, logUri }
    });
  }

  heartbeat(runId, claimToken) {
    return this.request(`/runs/${encodeURIComponent(runId)}/heartbeat`, {
      method: "POST",
      body: { claimToken }
    });
  }

  finishRun(runId, payload) {
    return this.request(`/runs/${encodeURIComponent(runId)}/finish`, {
      method: "POST",
      body: payload
    });
  }
}
