/**
 * Rail Harness Developer Console — ticket selector (HC-02, Paso 2).
 *
 * READ-ONLY. Lists `state=READY` tickets for a project and, on selection,
 * re-reads the ticket (`getTicket`) and re-validates it before showing a
 * read-only detail screen. NEVER claims, NEVER starts the Worker — only the
 * facade's `listReady` / `getTicket` are used here.
 */

import { isUserCancelled } from "./cancellation.js";

const BACK = "__back__";

export const TICKET_SELECTOR_BACK = "back";
export const TICKET_SELECTOR_CONTINUE = "continue";

export const NO_READY_TICKETS_MESSAGE = "No hay tickets READY para este proyecto.";
export const NEXT_STEP_MESSAGE = "El lanzamiento del Worker se habilitará en un próximo paso.";

function clean(value) {
  const v = (value ?? "").toString().trim();
  return v.length ? v : null;
}

/**
 * Normalize a `GET /tickets?state=READY&...` response into `[{ref,title}]`.
 * Rail returns `{items:[{item:{code,id,title}}]}` — the same shape the
 * Worker Core's own discovery code expects; a couple of variants are
 * tolerated. Never invents a ticket that isn't in the payload.
 */
export function normalizeReadyTickets(raw) {
  const list = Array.isArray(raw) ? raw : raw?.items || raw?.tickets || [];
  const out = [];
  for (const entry of list) {
    const item = entry?.item || entry;
    if (!item) continue;
    const ref = clean(item.code) || clean(item.id);
    if (!ref) continue;
    out.push({ ref, title: clean(item.title) || "(sin título)" });
  }
  return out;
}

/**
 * Re-validate a `getTicket(ref)` detail before showing it. Pure, no I/O.
 * Mirrors the Worker Core's own claim preconditions minus the `blocked`
 * check, which is not meaningful for a read-only preview — everything here
 * is about whether the console may safely SHOW the ticket, never about
 * claiming it.
 */
export function validateTicketForDisplay(detail, project) {
  if (!detail || typeof detail !== "object") {
    return { ok: false, reason: "Rail no devolvió el detalle del ticket." };
  }
  if (detail.projectId !== project.id) {
    return { ok: false, reason: "pertenece a otro proyecto." };
  }
  if (detail.state !== "READY") {
    return { ok: false, reason: `no está READY (estado actual: ${detail.state}).` };
  }
  if (detail.activeRun) {
    return { ok: false, reason: "ya tiene un activeRun." };
  }
  if (!clean(detail.targetRepository?.repoFullName)) {
    return { ok: false, reason: "no tiene un targetRepository válido." };
  }
  return { ok: true, reason: null };
}

/** Read-only detail lines for a validated ticket. No sensitive fields. */
export function formatTicketDetail(detail, project) {
  const item = detail.item || {};
  const ref = clean(item.code) || clean(item.id) || "(sin código)";
  const branch = clean(detail.branch) || clean(detail.activeRun?.branch);

  const lines = [
    `Ticket: ${ref}`,
    `Título: ${clean(item.title) || "(sin título)"}`,
    `Estado: ${detail.state}`,
    `Proyecto: ${project.label}`,
    `Repositorio: ${detail.targetRepository.repoFullName}`
  ];
  if (branch) lines.push(`Branch: ${branch}`);
  return lines;
}

/**
 * One pass of the ticket screen for `project`: list READY tickets, let the
 * user pick one or "Volver", and on a pick show its read-only detail.
 * Returns `TICKET_SELECTOR_BACK` (go back to the project selector) or
 * `TICKET_SELECTOR_CONTINUE` (redraw the ticket list — the caller loops).
 * Never calls anything but `rail.listReady` / `rail.getTicket`.
 */
export async function selectTicket({ rail, project, menu, logger, trace }) {
  const raw = await rail.listReady(project.id);
  trace?.recordEvent("READY_LIST_VIEWED", { projectId: project.id });
  const tickets = normalizeReadyTickets(raw);

  logger("");
  logger(project.label);
  logger("");
  logger("Tickets READY:");
  logger("");

  if (tickets.length === 0) {
    logger(NO_READY_TICKETS_MESSAGE);
    logger("");
    return TICKET_SELECTOR_BACK;
  }

  const items = [
    ...tickets.map(t => ({ label: `${t.ref}  ${t.title}`, value: t.ref })),
    { label: "Volver", value: BACK }
  ];

  let choice;
  try {
    choice = await menu({ question: "Tickets READY:", items });
  } catch (err) {
    if (isUserCancelled(err)) return TICKET_SELECTOR_BACK;
    throw err;
  }
  if (choice === BACK) return TICKET_SELECTOR_BACK;

  trace?.recordEvent("TICKET_SELECTED", { projectId: project.id, ticketRef: choice });

  let detail;
  try {
    detail = await rail.getTicket(choice);
  } catch (err) {
    logger("");
    logger(`No se pudo leer el ticket ${choice} (${err.message}).`);
    logger("");
    return TICKET_SELECTOR_CONTINUE;
  }

  const validation = validateTicketForDisplay(detail, project);
  logger("");
  if (!validation.ok) {
    logger(`El ticket ${choice} no está disponible: ${validation.reason}`);
    logger("");
    return TICKET_SELECTOR_CONTINUE;
  }

  for (const line of formatTicketDetail(detail, project)) logger(line);
  logger("");
  logger(NEXT_STEP_MESSAGE);
  logger("");
  trace?.recordEvent("TICKET_DETAIL_VIEWED", { projectId: project.id, ticketRef: choice });
  return TICKET_SELECTOR_CONTINUE;
}
