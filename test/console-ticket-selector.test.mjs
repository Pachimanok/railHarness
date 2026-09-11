/**
 * HC-02-AC-02, HC-02-AC-03, HC-02-AC-04, HC-02-AC-08 — ticket selector
 * (`src/console/ticket-selector.js`).
 *
 * Selecting a project consults ONLY `listReady(projectId)`. Selecting a
 * ticket calls `getTicket(ref)` and re-validates project/state/activeRun/
 * targetRepository before showing anything — and NEVER claims, NEVER starts
 * a Worker (the fakes below don't even expose a `claim` method, so any
 * accidental call would throw).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeReadyTickets,
  validateTicketForDisplay,
  formatTicketDetail,
  selectTicket,
  TICKET_SELECTOR_BACK,
  TICKET_SELECTOR_CONTINUE,
  NO_READY_TICKETS_MESSAGE,
  NEXT_STEP_MESSAGE
} from "../src/console/ticket-selector.js";

function collectLogger() {
  const lines = [];
  return { logger: line => lines.push(line), lines };
}

const PROJECT = { id: "proj_totalview", label: "TotalView" };

function readyTicketDetail(overrides = {}) {
  return {
    projectId: PROJECT.id,
    state: "READY",
    activeRun: null,
    item: { code: "TV-D-00125", title: "Corregir rentabilidad" },
    targetRepository: { repoFullName: "Pachimanok/totalview" },
    ...overrides
  };
}

// ─── normalizeReadyTickets ──────────────────────────────────────────────

test("normalizeReadyTickets: lee {items:[{item:{code,title}}]}", () => {
  const out = normalizeReadyTickets({
    items: [{ item: { code: "TV-D-00125", title: "Corregir rentabilidad" } }, { item: { code: "TV-D-00127", title: "Filtro proveedores" } }]
  });
  assert.deepEqual(out, [
    { ref: "TV-D-00125", title: "Corregir rentabilidad" },
    { ref: "TV-D-00127", title: "Filtro proveedores" }
  ]);
});

test("normalizeReadyTickets: nunca inventa un ticket — entradas sin code/id se descartan", () => {
  const out = normalizeReadyTickets({ items: [{ item: { title: "sin código" } }, { item: { code: "OK-1" } }] });
  assert.deepEqual(out.map(t => t.ref), ["OK-1"]);
});

test("normalizeReadyTickets: [] con respuesta vacía", () => {
  assert.deepEqual(normalizeReadyTickets({ items: [] }), []);
});

// ─── validateTicketForDisplay ───────────────────────────────────────────

test("validateTicketForDisplay: acepta un ticket READY del proyecto correcto, sin activeRun, con targetRepository", () => {
  assert.deepEqual(validateTicketForDisplay(readyTicketDetail(), PROJECT), { ok: true, reason: null });
});

test("HC-02-AC-03: rechaza si pertenece a otro proyecto", () => {
  const res = validateTicketForDisplay(readyTicketDetail({ projectId: "otro" }), PROJECT);
  assert.equal(res.ok, false);
});

test("HC-02-AC-03: rechaza si no está READY", () => {
  const res = validateTicketForDisplay(readyTicketDetail({ state: "IN_PROGRESS" }), PROJECT);
  assert.equal(res.ok, false);
  assert.match(res.reason, /READY/);
});

test("HC-02-AC-03: rechaza si ya tiene activeRun", () => {
  const res = validateTicketForDisplay(readyTicketDetail({ activeRun: { id: "run-1" } }), PROJECT);
  assert.equal(res.ok, false);
  assert.match(res.reason, /activeRun/);
});

test("HC-02-AC-03: rechaza si no tiene targetRepository válido", () => {
  const res = validateTicketForDisplay(readyTicketDetail({ targetRepository: null }), PROJECT);
  assert.equal(res.ok, false);
  assert.match(res.reason, /targetRepository/);
});

test("validateTicketForDisplay: rechaza detalle ausente sin lanzar", () => {
  assert.equal(validateTicketForDisplay(null, PROJECT).ok, false);
});

// ─── formatTicketDetail ─────────────────────────────────────────────────

test("formatTicketDetail: muestra ticket/título/estado/proyecto/repo, sin datos sensibles", () => {
  const lines = formatTicketDetail(readyTicketDetail(), PROJECT).join("\n");
  assert.match(lines, /Ticket: TV-D-00125/);
  assert.match(lines, /Título: Corregir rentabilidad/);
  assert.match(lines, /Estado: READY/);
  assert.match(lines, /Proyecto: TotalView/);
  assert.match(lines, /Repositorio: Pachimanok\/totalview/);
  assert.ok(!lines.includes("claimToken"));
  assert.ok(!lines.includes("Authorization"));
});

test("formatTicketDetail: incluye branch sólo si está disponible", () => {
  const withoutBranch = formatTicketDetail(readyTicketDetail(), PROJECT).join("\n");
  assert.ok(!withoutBranch.includes("Branch:"));

  const withBranch = formatTicketDetail(readyTicketDetail({ branch: "rail/tv-d-00125" }), PROJECT).join("\n");
  assert.match(withBranch, /Branch: rail\/tv-d-00125/);
});

// ─── selectTicket ───────────────────────────────────────────────────────

test("HC-02-AC-02: al elegir un proyecto se consulta ÚNICAMENTE listReady(projectId)", async () => {
  const { logger } = collectLogger();
  const calls = { listReady: [], getTicket: [] };
  const rail = {
    async listReady(projectId) {
      calls.listReady.push(projectId);
      return { items: [] };
    },
    async getTicket(ref) {
      calls.getTicket.push(ref);
      return readyTicketDetail();
    }
  };
  const menu = async () => {
    throw new Error("no debería abrirse el menú sin tickets READY");
  };

  const outcome = await selectTicket({ rail, project: PROJECT, menu, logger });

  assert.deepEqual(calls.listReady, [PROJECT.id]);
  assert.deepEqual(calls.getTicket, []);
  assert.equal(outcome, TICKET_SELECTOR_BACK);
});

test("HC-02-AC-08: cero tickets READY => mensaje humano, sin crash, vuelve al selector de proyectos", async () => {
  const { logger, lines } = collectLogger();
  const rail = { async listReady() { return { items: [] }; } };
  const outcome = await selectTicket({ rail, project: PROJECT, menu: async () => { throw new Error("no menu"); }, logger });

  assert.equal(outcome, TICKET_SELECTOR_BACK);
  assert.ok(lines.includes(NO_READY_TICKETS_MESSAGE));
});

test("HC-02-AC-03/AC-04: elegir un ticket válido hace getTicket(ref), valida, muestra el detalle y NUNCA reclama", async () => {
  const { logger, lines } = collectLogger();
  const calls = { listReady: 0, getTicket: [] };
  const rail = {
    async listReady() {
      calls.listReady += 1;
      return { items: [{ item: { code: "TV-D-00125", title: "Corregir rentabilidad" } }] };
    },
    async getTicket(ref) {
      calls.getTicket.push(ref);
      return readyTicketDetail();
    }
    // sin claim(): si el código intentara reclamar, esto explota con un TypeError.
  };
  const menu = async ({ items }) => items[0].value; // el ticket, no "Volver"

  const outcome = await selectTicket({ rail, project: PROJECT, menu, logger });

  assert.deepEqual(calls.getTicket, ["TV-D-00125"]);
  assert.equal(outcome, TICKET_SELECTOR_CONTINUE);
  assert.equal(rail.claim, undefined);

  const text = lines.join("\n");
  assert.match(text, /Ticket: TV-D-00125/);
  assert.match(text, new RegExp(NEXT_STEP_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("HC-02-AC-03: un ticket inválido (ya con activeRun) muestra 'no disponible' y NO continúa mostrando su detalle", async () => {
  const { logger, lines } = collectLogger();
  const rail = {
    async listReady() {
      return { items: [{ item: { code: "TV-D-00125", title: "Corregir rentabilidad" } }] };
    },
    async getTicket() {
      return readyTicketDetail({ activeRun: { id: "run-1" } });
    }
  };
  const menu = async ({ items }) => items[0].value;

  const outcome = await selectTicket({ rail, project: PROJECT, menu, logger });

  assert.equal(outcome, TICKET_SELECTOR_CONTINUE);
  const text = lines.join("\n");
  assert.match(text, /no está disponible/);
  assert.ok(!text.includes("Repositorio: Pachimanok/totalview"), "no debe mostrarse el detalle de un ticket inválido");
});

test("'Volver' desde el selector de tickets no llama getTicket y devuelve TICKET_SELECTOR_BACK", async () => {
  const { logger } = collectLogger();
  const calls = { getTicket: 0 };
  const rail = {
    async listReady() {
      return { items: [{ item: { code: "TV-D-00125", title: "x" } }] };
    },
    async getTicket() {
      calls.getTicket += 1;
      return readyTicketDetail();
    }
  };
  const menu = async ({ items }) => items[items.length - 1].value; // "Volver"

  const outcome = await selectTicket({ rail, project: PROJECT, menu, logger });
  assert.equal(outcome, TICKET_SELECTOR_BACK);
  assert.equal(calls.getTicket, 0);
});
