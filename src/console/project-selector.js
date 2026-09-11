/**
 * Rail Harness Developer Console — project selector (HC-02, Paso 2).
 *
 * Pure display-shape helpers + one interactive flow. Only ever uses the
 * READ-ONLY Rail facade (`rail-readonly.js`) injected by the caller — never
 * imports `RailApiClient` and never invents a project that Rail did not
 * return.
 */

const BACK = "__back__";

function clean(value) {
  const v = (value ?? "").toString().trim();
  return v.length ? v : null;
}

/**
 * Normalize a `GET /projects` response into `[{ id, label }]`. Tolerates the
 * shapes Rail is known to use elsewhere in this Harness (bare array,
 * `{items:[...]}}`, `{projects:[...]}}`) plus bare-string entries. Never
 * fabricates a project: entries without a usable id are dropped.
 */
export function normalizeProjects(raw) {
  const list = Array.isArray(raw) ? raw : raw?.items || raw?.projects || [];
  const out = [];
  for (const entry of list) {
    if (entry == null) continue;
    const id = clean(typeof entry === "string" ? entry : entry.id ?? entry.projectId);
    if (!id) continue;
    const label =
      typeof entry === "string"
        ? entry
        : clean(entry.name) || clean(entry.label) || clean(entry.title) || clean(entry.slug) || id;
    out.push({ id, label, raw: entry });
  }
  return out;
}

/** Stable, human-readable ordering: by label, then by id as a tiebreaker. */
export function sortProjects(projects) {
  return [...projects].sort((a, b) => {
    const byLabel = a.label.localeCompare(b.label, "es", { sensitivity: "base" });
    return byLabel !== 0 ? byLabel : a.id.localeCompare(b.id);
  });
}

export const NO_PROJECTS_MESSAGE = "No tenés proyectos disponibles en RailSoft.";

/**
 * Interactive project picker. `rail.listProjects()` is the ONLY Rail call
 * made here. `onConnected`, when given, is called once `listProjects()` has
 * resolved successfully (before rendering anything) so the caller can print
 * a "RailSoft conectado" confirmation at the right moment without issuing a
 * second request. Returns the chosen `{id,label,raw}` project, or `null`
 * when the user picks "Volver" (or there is nothing to choose from).
 */
export async function selectProject({ rail, menu, logger, onConnected }) {
  const raw = await rail.listProjects();
  onConnected?.();
  const projects = sortProjects(normalizeProjects(raw));

  if (projects.length === 0) {
    logger("");
    logger(NO_PROJECTS_MESSAGE);
    logger("");
    return null;
  }

  logger("");
  logger("¿Con qué proyecto querés trabajar?");
  logger("");

  const items = [...projects.map(p => ({ label: p.label, value: p })), { label: "Volver", value: BACK }];

  let choice;
  try {
    choice = await menu({ question: "¿Con qué proyecto querés trabajar?", items });
  } catch (err) {
    if (err?.code === "CANCELLED") return null;
    throw err;
  }

  return choice === BACK ? null : choice;
}
