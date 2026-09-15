/**
 * Resolución de intención del ciudadano. Capa de dominio, función pura.
 *
 * Sustituye a `services/intentRouter.js` y absorbe la lógica de "palabra de
 * activación" que estaba embebida en `ChatContext.handleSemanticRouting`.
 *
 * Antes, el enrutamiento vivía repartido en tres sitios: el mapa de rutas en
 * `chatbotConfig.json`, la evaluación en `intentRouter.js`, y la decisión de qué
 * flujo lanzar en una cadena de seis `if` dentro de `ChatContext`. Añadir un trámite
 * exigía tocar los tres. Ahora la decisión es un dato (el mapa de rutas) y el
 * despacho es un registro (`application/flows/flowRegistry.js`).
 */

import { normalizeForMatching } from "../security/textSanitizer.js";
import { containsFuzzyKeyword } from "../matching/fuzzyMatcher.js";

/**
 * Palabras que reactivan un trámite mencionado previamente
 * ("iniciar", "otra vez", "de nuevo"...).
 */
export const ACTIVATION_KEYWORDS = Object.freeze([
  "nuevamente",
  "otra vez",
  "de nuevo",
  "iniciar",
  "ejecutar",
  "formulario",
  "comenzar",
  "procesar",
  "abrir"
]);

/**
 * Palabras con las que el ciudadano confirma que quiere abrir el formulario.
 * Incluyen las de activación más las propias del pago.
 */
export const CONFIRMATION_KEYWORDS = Object.freeze([
  ...ACTIVATION_KEYWORDS,
  "pagar",
  "pago",
  "si",
  "dale",
  "listo",
  "hazlo",
  "adelante",
  "continuar"
]);

/**
 * Marcas de que el mensaje es una pregunta. Una consulta no es una confirmación aunque
 * contenga "pagar": "¿dónde pago el predial?" pide información, no el formulario.
 *
 * Los interrogativos cuentan en cualquier posición ("y el ICA dónde se paga"); los verbos
 * que también aparecen en frases afirmativas solo cuentan al principio.
 */
const QUESTION_MARK_RE = /[?¿]/;
const QUESTION_WORD_RE = /\b(qu[eé]|cu[aá]l(es)?|cu[aá]nto[as]?|c[oó]mo|d[oó]nde|cu[aá]ndo|qui[eé]n)\b/i;
const QUESTION_START_RE = /^\s*(por\s+qu[eé]|hay|puedo|debo|tengo|necesito|sirve|aplica|existe)\b/i;

const looksLikeQuestion = (text) =>
  QUESTION_MARK_RE.test(text) || QUESTION_WORD_RE.test(text) || QUESTION_START_RE.test(text);

/** Una confirmación es corta; un párrafo es otra cosa. */
const MAX_CONFIRMATION_WORDS = 8;

/**
 * ¿El mensaje confirma que se abra el trámite ofrecido?
 *
 * @param {string} text
 * @param {string[]} [keywords]
 * @returns {boolean}
 */
export const isFlowConfirmation = (text, keywords = CONFIRMATION_KEYWORDS) => {
  const raw = String(text || "").trim();
  if (raw === "" || looksLikeQuestion(raw)) return false;

  const normalized = normalizeForMatching(raw);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_CONFIRMATION_WORDS) return false;

  return containsFuzzyKeyword(normalized, keywords);
};

/**
 * @typedef {Object} IntentResolution
 * @property {string|null} flow   Identificador del flujo a ejecutar, o null.
 * @property {boolean} viaActivation  true si se resolvió por palabra de activación
 *                                    sobre un trámite pendiente, no por coincidencia directa.
 */

/**
 * Resuelve el flujo que corresponde a un mensaje.
 *
 * @param {string} text Mensaje del ciudadano.
 * @param {Object} opts
 * @param {Record<string, string[]>} opts.routingMap  Mapa flujo -> palabras clave.
 * @param {string|null} [opts.pendingService]  Trámite mencionado antes, aún sin lanzar.
 * @param {string[]} [opts.activationKeywords]
 * @returns {IntentResolution}
 */
export const resolveIntent = (
  text,
  { routingMap, pendingService = null, activationKeywords = CONFIRMATION_KEYWORDS }
) => {
  if (!text || !routingMap) return { flow: null, viaActivation: false };

  const normalized = normalizeForMatching(text);

  // 1. Coincidencia directa con alguna ruta configurada.
  for (const [flow, keywords] of Object.entries(routingMap)) {
    if (containsFuzzyKeyword(normalized, keywords)) {
      return { flow, viaActivation: false };
    }
  }

  // 2. Palabra de activación sobre un trámite mencionado antes.
  if (pendingService && containsFuzzyKeyword(normalized, activationKeywords)) {
    return { flow: pendingService, viaActivation: true };
  }

  return { flow: null, viaActivation: false };
};

/**
 * ¿El mensaje habla de un trámite, aunque los servicios estén deshabilitados?
 * Se usa para responder "los trámites están inhabilitados" en lugar de derivar a la IA.
 *
 * @param {string} text
 * @param {string[]} [serviceKeywords]
 * @returns {boolean}
 */
export const mentionsService = (
  text,
  serviceKeywords = ["sisben", "predial", "rpa", "impuesto", "pagar", "reporte", "robot", "pqrsd", "radicado"]
) => (text ? containsFuzzyKeyword(normalizeForMatching(text), serviceKeywords) : false);
