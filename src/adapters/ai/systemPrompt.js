/**
 * Construcción del prompt de sistema. Capa de adaptadores.
 *
 * Solo entra aquí contenido de confianza: estas reglas y las FAQ del propio repositorio.
 * El contexto de la página anfitriona viaja aparte, como turno de datos delimitado
 * (`domain/pageContext/promptSerializer.js`). Ver SECURITY.md.
 */

/** Instrucciones base de comportamiento. */
import { BASE_RULES } from "../../../shared/assistantRules.js";

/**
 * Ensambla el prompt de sistema con el contexto de confianza disponible.
 *
 * @param {Object} [opts]
 * @param {string} [opts.faqContext]  Bloque de FAQ oficial (confiable: viene del repo).
 * @returns {string}
 */
export const buildSystemPrompt = ({ faqContext = "" } = {}) => {
  let prompt = BASE_RULES;

  if (faqContext) {
    prompt += `\n\n[INFORMACIÓN MUNICIPAL OFICIAL PARA RESPONDER CON PRECISIÓN]:\n${faqContext}`;
  }

  return prompt;
};

export const SYSTEM_PROMPT_BASE = BASE_RULES;
