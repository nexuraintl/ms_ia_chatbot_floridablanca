/**
 * Fábrica de proveedores de IA. Único punto donde se decide QUÉ proveedor se usa.
 *
 * ANTES la decisión estaba dentro de `queryGemini`:
 *
 *     if (!apiKey || apiKey.trim() === "") return queryMockGemini(...)
 *
 * Es decir, el proveedor real conocía y construía a su alternativa. Añadir un tercer
 * proveedor obligaba a editar ese `if`, y con él el módulo de todos los demás.
 *
 * Ahora los proveedores se registran en un mapa y la selección es una política
 * aislada. Registrar uno nuevo —un proxy de backend, otro modelo— es añadir una
 * entrada, sin modificar código existente (principio abierto/cerrado).
 */

import { assertImplementsAiProvider } from "../../ports/AiProviderPort.js";
import { createGeminiApiProvider } from "./GeminiApiProvider.js";
import { createLocalMockProvider } from "./LocalMockProvider.js";

/**
 * Registro de constructores disponibles.
 * @type {Record<string, (deps: Object) => import("../../ports/AiProviderPort.js").AiProvider>}
 */
const PROVIDER_REGISTRY = {
  "gemini-api": createGeminiApiProvider,
  "local-mock": createLocalMockProvider
};

/**
 * Registra un proveedor adicional en tiempo de ejecución.
 * Pensado para incorporar un adaptador de backend sin tocar este archivo.
 *
 * @param {string} id
 * @param {(deps: Object) => import("../../ports/AiProviderPort.js").AiProvider} factory
 */
export const registerAiProvider = (id, factory) => {
  if (typeof id !== "string" || !id) throw new TypeError("registerAiProvider: id inválido.");
  if (typeof factory !== "function") throw new TypeError("registerAiProvider: factory inválida.");
  PROVIDER_REGISTRY[id] = factory;
};

/**
 * Política de selección: con clave disponible se usa la API; sin ella, el mock local.
 *
 * @param {Object} params
 * @param {string} params.apiKey
 * @param {string} [params.preferred]  Fuerza un proveedor concreto (diagnóstico/pruebas).
 * @returns {string} id del proveedor
 */
export const selectProviderId = ({ apiKey, preferred }) => {
  if (preferred && PROVIDER_REGISTRY[preferred]) return preferred;
  return apiKey && String(apiKey).trim() !== "" ? "gemini-api" : "local-mock";
};

/**
 * Construye el proveedor que corresponde al estado actual.
 *
 * @param {Object} deps
 * @param {() => string} deps.getApiKey
 * @param {import("../../domain/faq/faqMatcher.js").FaqItem[]} deps.faqCatalog
 * @param {string} [deps.preferred]
 * @returns {import("../../ports/AiProviderPort.js").AiProvider}
 */
export const createAiProvider = ({ getApiKey, faqCatalog, preferred }) => {
  const apiKey = typeof getApiKey === "function" ? getApiKey() : "";
  const id = selectProviderId({ apiKey, preferred });
  const factory = PROVIDER_REGISTRY[id];

  if (!factory) {
    throw new Error(`createAiProvider: no hay proveedor registrado con id "${id}".`);
  }

  // Validar el contrato al construir: un proveedor mal implementado falla aquí,
  // no en mitad de una conversación con un ciudadano.
  return assertImplementsAiProvider(factory({ getApiKey, faqCatalog }));
};
