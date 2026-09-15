/**
 * Orientacion previa a la radicacion de una PQRSD. Capa de dominio, funciones puras.
 *
 * Antes de abrir el formulario se le pregunta al ciudadano cual es su inquietud y se
 * intenta resolver con la informacion disponible. Solo si persiste se continua con la
 * radicacion. Ver docs/MANUAL.md.
 */

import { normalizeForMatching } from "../security/textSanitizer.js";
import { containsFuzzyKeyword } from "../matching/fuzzyMatcher.js";

/** Etapas de la conversacion previa. */
export const PRE_GUIDANCE_STAGES = Object.freeze({
  IDLE: "idle",
  AWAITING_QUERY: "awaiting_query",
  AWAITING_DECISION: "awaiting_decision"
});

/** Resultado de interpretar la respuesta del ciudadano a la pregunta de cierre. */
export const PRE_GUIDANCE_DECISIONS = Object.freeze({
  RESOLVED: "resolved",
  UNRESOLVED: "unresolved",
  UNCLEAR: "unclear"
});

/** Textos por defecto. `chatbotConfig.pqrsd.preGuidance` los sobrescribe. */
export const DEFAULT_PRE_GUIDANCE = Object.freeze({
  enabled: true,
  /** Rondas de orientacion antes de ofrecer el formulario sin volver a preguntar. */
  maxGuidanceRounds: 2,
  question:
    "Antes de radicar, cuéntanos: ¿cuál es tu duda, inquietud o novedad? " +
    "Con esa información intento resolverte de inmediato y, si hace falta, continuamos con la radicación.",
  decisionQuestion: "¿Con esta información quedó resuelta tu solicitud?",
  resolvedLabel: "✅ Sí, quedó resuelta",
  unresolvedLabel: "📑 No, quiero radicar la PQRSD",
  resolvedReply:
    "Me alegra haberte podido ayudar. Si más adelante necesitas una gestión formal, " +
    'escríbeme "radicar PQRSD" y te abro el formulario.',
  bridgeReply:
    "Si tu solicitud aún no ha sido resuelta, podemos continuar con la radicación de una " +
    "PQRSD para que sea atendida por el área correspondiente.",
  exhaustedReply:
    "Para que tu caso lo revise el área correspondiente, lo mejor es dejarlo radicado como PQRSD.",
  errorReply:
    "No pude consultar la información en este momento, así que continuemos con la radicación de tu PQRSD."
});

/** Cierres corteses que empiezan por "no" pero significan que ya quedo resuelto. */
const CLOSING_PHRASES = Object.freeze([
  "no gracias",
  "no muchas gracias",
  "ninguna mas",
  "nada mas",
  "eso es todo",
  "asi esta bien",
  "ya esta bien",
  "todo bien"
]);

/** El ciudadano quiere continuar con la radicacion. */
const UNRESOLVED_KEYWORDS = Object.freeze([
  "no",
  "negativo",
  "seguir",
  "sigamos",
  "formulario",
  "pqrsd",
  "sigue igual"
]);

/** Raices verbales de continuar, para cubrir la conjugacion sin listarla entera. */
const UNRESOLVED_STEMS = Object.freeze(["radic", "continu", "persist", "insist"]);

/** El ciudadano da por resuelta la consulta. */
const RESOLVED_KEYWORDS = Object.freeze([
  "si",
  "claro",
  "afirmativo",
  "gracias",
  "listo",
  "perfecto",
  "quedo claro",
  "eso era"
]);

/** Raices verbales de dar por resuelto. */
const RESOLVED_STEMS = Object.freeze(["resuel", "solucion", "entend", "aclara"]);

/**
 * Resuelve los textos efectivos de la orientacion previa.
 *
 * @param {Object} [config] `chatbotConfig.json`
 * @returns {typeof DEFAULT_PRE_GUIDANCE}
 */
export const resolvePreGuidanceSettings = (config) => ({
  ...DEFAULT_PRE_GUIDANCE,
  ...(config?.pqrsd?.preGuidance || {})
});

/**
 * Interpreta la respuesta del ciudadano a "¿quedó resuelta tu solicitud?".
 *
 * Las etiquetas de los botones se comparan primero: son texto exacto y no deben
 * depender de que el diccionario acierte.
 *
 * @param {string} text
 * @param {{resolvedLabel?: string, unresolvedLabel?: string}} [labels]
 * @returns {string} Uno de `PRE_GUIDANCE_DECISIONS`.
 */
export const classifyDecision = (text, { resolvedLabel, unresolvedLabel } = {}) => {
  const normalized = normalizeForMatching(text);
  if (!normalized) return PRE_GUIDANCE_DECISIONS.UNCLEAR;

  if (unresolvedLabel && normalized === normalizeForMatching(unresolvedLabel)) {
    return PRE_GUIDANCE_DECISIONS.UNRESOLVED;
  }
  if (resolvedLabel && normalized === normalizeForMatching(resolvedLabel)) {
    return PRE_GUIDANCE_DECISIONS.RESOLVED;
  }

  if (CLOSING_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return PRE_GUIDANCE_DECISIONS.RESOLVED;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  const startsWithStem = (stems) =>
    words.some((word) => stems.some((stem) => word.startsWith(stem)));

  if (containsFuzzyKeyword(normalized, UNRESOLVED_KEYWORDS) || startsWithStem(UNRESOLVED_STEMS)) {
    return PRE_GUIDANCE_DECISIONS.UNRESOLVED;
  }
  if (containsFuzzyKeyword(normalized, RESOLVED_KEYWORDS) || startsWithStem(RESOLVED_STEMS)) {
    return PRE_GUIDANCE_DECISIONS.RESOLVED;
  }

  return PRE_GUIDANCE_DECISIONS.UNCLEAR;
};
