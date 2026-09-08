/**
 * Política global de idioma del Rail Harness.
 *
 * Toda comunicación HUMANA del Harness es en español: los prompts que se
 * envían a un runtime/adapter, los logs human-facing del Worker, las
 * preguntas / motivos de bloqueo / resúmenes / explicaciones que produce un
 * adapter, y el contenido de las Agent Queries.
 *
 * Lo machine-readable NO se traduce nunca: enums, estados del WorkCycle/Run,
 * outcomes, tipos de check y nombres de campos del protocolo Rail viajan tal
 * cual. Ver docs/HARNESS.md ("Política global de idioma").
 *
 * Este módulo es la única fuente de verdad de esa instrucción. No hace I/O.
 */

/** Idioma de toda comunicación humana. */
export const HUMAN_LANGUAGE = "es";

export const LANGUAGE_POLICY_VERSION = "0.1";

/**
 * Valores machine-readable que NUNCA se traducen. Incluye los estados y
 * outcomes del protocolo Rail y los tipos de check citados por el ticket de
 * idioma. La lista es de refuerzo/documentación: cualquier otro identificador
 * del protocolo también queda sin traducir.
 */
export const PROTOCOL_TERMS = Object.freeze([
  "READY",
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
  "SUCCESS",
  "FAILED",
  "CODE_REVIEW",
  "AUTOMATED_TESTS",
  "ACCEPTANCE_CRITERIA"
]);

/**
 * Instrucción canónica de idioma. Todo runtime/adapter DEBE incorporarla al
 * prompt que ejecuta (ver docs/ADAPTER_CONTRACT.md). Texto plano en español.
 */
export const LANGUAGE_INSTRUCTION = [
  "IDIOMA: toda comunicación humana debe ser en español.",
  "Respondé en español. Las preguntas (question), el contexto y el impacto de",
  "un bloqueo (context, impact), los resúmenes (summary) y cualquier",
  "explicación deben estar en español.",
  "NO traduzcas valores machine-readable: los enums, los estados del",
  "WorkCycle y del Run, los outcomes, los tipos de check y los nombres de",
  "campos del protocolo Rail se dejan exactamente como están",
  `(por ejemplo: ${PROTOCOL_TERMS.join(", ")}).`
].join(" ");

/**
 * Objeto estructurado, congelado, que viaja dentro de cada ExecutionEnvelope
 * y que un adapter renderiza en su prompt. No contiene claves sensibles.
 */
export function buildLanguagePolicy() {
  return Object.freeze({
    version: LANGUAGE_POLICY_VERSION,
    humanLanguage: HUMAN_LANGUAGE,
    instruction: LANGUAGE_INSTRUCTION,
    doNotTranslate: PROTOCOL_TERMS
  });
}

/**
 * ¿`policy` es una política de idioma válida para este Harness? Pura.
 * Devuelve `{ valid, errors }`.
 */
export function validateLanguagePolicy(policy) {
  const errors = [];

  if (!policy || typeof policy !== "object") {
    return { valid: false, errors: ["languagePolicy must be an object"] };
  }
  if (policy.humanLanguage !== HUMAN_LANGUAGE) {
    errors.push(`languagePolicy.humanLanguage must be "${HUMAN_LANGUAGE}"`);
  }
  if (typeof policy.instruction !== "string" || !/español/i.test(policy.instruction)) {
    errors.push("languagePolicy.instruction must be a Spanish instruction string");
  }
  if (!Array.isArray(policy.doNotTranslate)) {
    errors.push("languagePolicy.doNotTranslate must be an array");
  } else {
    const missing = PROTOCOL_TERMS.filter(t => !policy.doNotTranslate.includes(t));
    if (missing.length) {
      errors.push(`languagePolicy.doNotTranslate is missing: ${missing.join(", ")}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
