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
  { routingMap, pendingService = null, activationKeywords = ACTIVATION_KEYWORDS }
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
