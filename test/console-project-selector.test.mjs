/**
 * HC-02-AC-01, HC-02-AC-08 — project selector (`src/console/project-selector.js`).
 *
 * Only ever calls `rail.listProjects()`; shows exactly what Rail returns
 * (never invents a project); handles the empty case without crashing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeProjects, sortProjects, selectProject, NO_PROJECTS_MESSAGE } from "../src/console/project-selector.js";

function collectLogger() {
  const lines = [];
  return { logger: line => lines.push(line), lines };
}

// ─── normalizeProjects ──────────────────────────────────────────────────

test("normalizeProjects: soporta {items:[...]}", () => {
  const out = normalizeProjects({ items: [{ id: "p1", name: "TotalView" }, { id: "p2", name: "Khai" }] });
  assert.deepEqual(out.map(p => [p.id, p.label]), [["p1", "TotalView"], ["p2", "Khai"]]);
});

test("normalizeProjects: soporta un array directo y {projects:[...]}", () => {
  assert.equal(normalizeProjects([{ id: "p1", name: "A" }]).length, 1);
  assert.equal(normalizeProjects({ projects: [{ id: "p1", name: "A" }] }).length, 1);
});

test("normalizeProjects: usa label/title/slug como fallback del nombre, e id si no hay nada más", () => {
  const out = normalizeProjects({
    items: [{ id: "p1", label: "Etiqueta" }, { id: "p2", title: "Título" }, { id: "p3" }]
  });
  assert.deepEqual(out.map(p => p.label), ["Etiqueta", "Título", "p3"]);
});

test("normalizeProjects: nunca inventa un proyecto — entradas sin id se descartan", () => {
  const out = normalizeProjects({ items: [{ name: "sin id" }, null, { id: "p1", name: "válido" }] });
  assert.deepEqual(out.map(p => p.id), ["p1"]);
});

test("normalizeProjects: lista vacía / respuesta vacía => []", () => {
  assert.deepEqual(normalizeProjects({ items: [] }), []);
  assert.deepEqual(normalizeProjects({}), []);
});

test("sortProjects: orden estable y legible por label", () => {
  const out = sortProjects([
    { id: "p3", label: "Plataforma Deportiva" },
    { id: "p1", label: "TotalView" },
    { id: "p2", label: "Khai" }
  ]);
  assert.deepEqual(out.map(p => p.label), ["Khai", "Plataforma Deportiva", "TotalView"]);
});

// ─── selectProject ──────────────────────────────────────────────────────

test("HC-02-AC-01: muestra EXACTAMENTE los proyectos devueltos por listProjects, ordenados, nada inventado", async () => {
  const { logger, lines } = collectLogger();
  let calls = 0;
  const rail = {
    async listProjects() {
      calls += 1;
      return { items: [{ id: "p1", name: "TotalView" }, { id: "p2", name: "Khai" }, { id: "p3", name: "Plataforma Deportiva" }] };
    }
  };

  let seenItems;
  const menu = async ({ items }) => {
    seenItems = items;
    return items[0].value; // pick the first project
  };

  const project = await selectProject({ rail, menu, logger });

  assert.equal(calls, 1, "selectProject sólo debe llamar listProjects() una vez");
  assert.deepEqual(seenItems.map(i => i.label), ["Khai", "Plataforma Deportiva", "TotalView", "Volver"]);
  assert.equal(project.label, "Khai");
  assert.match(lines.join("\n"), /¿Con qué proyecto querés trabajar\?/);
});

test("HC-02-AC-08: cero proyectos => mensaje humano, sin crash, selectProject devuelve null", async () => {
  const { logger, lines } = collectLogger();
  const rail = { async listProjects() { return { items: [] }; } };
  const menu = async () => {
    throw new Error("no debería mostrarse ningún menú sin proyectos");
  };

  const project = await selectProject({ rail, menu, logger });

  assert.equal(project, null);
  assert.ok(lines.includes(NO_PROJECTS_MESSAGE));
});

test("'Volver' desde el selector de proyectos devuelve null sin lanzar", async () => {
  const { logger } = collectLogger();
  const rail = { async listProjects() { return { items: [{ id: "p1", name: "TotalView" }] }; } };
  const menu = async ({ items }) => items[items.length - 1].value; // "Volver" siempre es el último

  const project = await selectProject({ rail, menu, logger });
  assert.equal(project, null);
});

test("selectProject: llama onConnected una vez que listProjects() resuelve, antes de renderizar", async () => {
  const { logger } = collectLogger();
  const order = [];
  const rail = {
    async listProjects() {
      order.push("listProjects");
      return { items: [{ id: "p1", name: "TotalView" }] };
    }
  };
  const menu = async ({ items }) => {
    order.push("menu");
    return items[0].value;
  };

  await selectProject({ rail, menu, logger, onConnected: () => order.push("onConnected") });
  assert.deepEqual(order, ["listProjects", "onConnected", "menu"]);
});
