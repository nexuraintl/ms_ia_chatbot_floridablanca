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
import { createGeminiProxyProvider } from "./GeminiProxyProvider.js";
import { createLocalMockProvider } from "./LocalMockProvider.js";
import { createQuotaAwareProvider } from "./QuotaAwareProvider.js";

/**
 * Registro de constructores disponibles.
 * @type {Record<string, (deps: Object) => import("../../ports/AiProviderPort.js").AiProvider>}
 */
const PROVIDER_REGISTRY = {
  "ai-proxy": createGeminiProxyProvider,
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
 * Política de selección, en orden de preferencia:
 *
 *   1. `ai-proxy`   — hay un backend configurado. Es la opción de producción: la clave
 *                     vive en el servidor y el gasto se controla ahí.
 *   2. `gemini-api` — no hay backend pero sí una clave en el navegador. Es el modo de
 *                     desarrollo local; la clave queda expuesta a quien use el equipo.
 *   3. `local-mock` — ni backend ni clave: se responde con el catálogo de FAQ.
 *
 * El proxy tiene prioridad sobre la clave local a propósito: si un despliegue tiene
 * backend, una clave olvidada en el `localStorage` del operador no debe hacer que sus
 * consultas se salten el control de gasto.
 *
 * `proxyEnabled` existe porque un proxy en el MISMO origen no tiene URL que mirar: su
 * ruta es `/api/ai/chat`, relativa. Sin este parámetro, el despliegue normal —el widget
 * servido por su propio backend— caía en `gemini-api` y volvía a pedir la clave en el
 * navegador, que es justo lo que el proxy existe para evitar.
 *
 * @param {Object} params
 * @param {string} params.apiKey
 * @param {string} [params.proxyUrl]    Origen del proxy. Vacío = mismo origen.
 * @param {boolean} [params.proxyEnabled] ¿Hay un backend con el proxy montado?
 * @param {string} [params.preferred]  Fuerza un proveedor concreto (diagnóstico/pruebas).
 * @returns {string} id del proveedor
 */
export const selectProviderId = ({ apiKey, proxyUrl, proxyEnabled = false, preferred }) => {
  if (preferred && PROVIDER_REGISTRY[preferred]) return preferred;
  if (proxyEnabled || (proxyUrl && String(proxyUrl).trim() !== "")) return "ai-proxy";
  return apiKey && String(apiKey).trim() !== "" ? "gemini-api" : "local-mock";
};

/**
 * Construye el proveedor que corresponde al estado actual.
 *
 * Cuando el elegido es el proxy se envuelve en `QuotaAwareProvider`, que atiende con el
 * banco de preguntas cuando el backend dice que se agotó la cuota. La composición se hace
 * aquí y no dentro del proveedor para que cada pieza siga teniendo una responsabilidad:
 * el proxy habla con el backend, el decorador decide cuándo degradar, y el mock responde
 * localmente.
 *
 * @param {Object} deps
 * @param {() => string} deps.getApiKey
 * @param {import("../../domain/faq/faqMatcher.js").FaqItem[]} deps.faqCatalog
 * @param {string} [deps.proxyUrl]
 * @param {boolean} [deps.proxyEnabled]
 * @param {string} [deps.preferred]
 * @returns {import("../../ports/AiProviderPort.js").AiProvider}
 */
export const createAiProvider = ({
  getApiKey,
  faqCatalog,
  proxyUrl = "",
  proxyEnabled = false,
  preferred
}) => {
  const apiKey = typeof getApiKey === "function" ? getApiKey() : "";
  const id = selectProviderId({ apiKey, proxyUrl, proxyEnabled, preferred });
  const factory = PROVIDER_REGISTRY[id];

  if (!factory) {
    throw new Error(`createAiProvider: no hay proveedor registrado con id "${id}".`);
  }

  // Validar el contrato al construir: un proveedor mal implementado falla aquí,
  // no en mitad de una conversación con un ciudadano.
  const provider = assertImplementsAiProvider(factory({ getApiKey, faqCatalog, proxyUrl }));

  if (id !== "ai-proxy") return provider;

  return createQuotaAwareProvider({
    primary: provider,
    fallback: createLocalMockProvider({ faqCatalog })
  });
};
