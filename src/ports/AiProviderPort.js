/**
 * Puerto del proveedor de IA. Define el contrato que la aplicación consume.
 *
 * Esta es la pieza de INVERSIÓN DE DEPENDENCIAS del refactor.
 *
 * ANTES: `ChatContext` importaba `queryGemini` directamente, y dentro de
 * `queryGemini` había un `if (!apiKey) return queryMockGemini(...)`. Es decir, la
 * política de "qué proveedor usar" estaba enterrada en el detalle de implementación
 * de uno de los proveedores, y el código de alto nivel dependía de un módulo
 * concreto. Cambiar de proveedor —o añadir un proxy de backend— obligaba a editar
 * tanto el consumidor como el proveedor.
 *
 * AHORA: la aplicación depende de este contrato. Los proveedores lo implementan
 * (`GeminiApiProvider`, `LocalMockProvider`) y la selección ocurre una sola vez, en
 * `createAiProvider`. Añadir un proveedor nuevo —por ejemplo uno que hable con un
 * backend propio en lugar de exponer la clave en el navegador— no requiere tocar ni
 * la aplicación ni los proveedores existentes.
 *
 * El proyecto es JavaScript, así que el contrato se expresa con JSDoc y se valida en
 * tiempo de construcción con `assertImplementsAiProvider`.
 */

/**
 * Turno de conversación en el formato interno de la app.
 * @typedef {Object} ConversationTurn
 * @property {"user"|"bot"|"system"} sender
 * @property {string} text
 */

/**
 * Petición al proveedor de IA.
 * @typedef {Object} AiRequest
 * @property {ConversationTurn[]} history  Conversación completa; el último turno es el actual.
 * @property {import("../domain/pageContext/pageContext.js").PageContext|null} pageContext
 *           Metadatos de la página anfitriona. NO CONFIABLE: el proveedor debe
 *           encapsularlo según `domain/pageContext/promptSerializer.js`.
 * @property {string|null} activeContext  Intención de FAQ activa, para expansión de consulta.
 */

/**
 * Respuesta normalizada. Todos los proveedores devuelven esta forma, de modo que el
 * consumidor no necesita saber cuál respondió (principio de sustitución de Liskov).
 *
 * @typedef {Object} AiReply
 * @property {string} text
 * @property {string|null} contextIntent  Intención detectada, para memoria conversacional.
 * @property {number} tokensUsed
 * @property {number} savedTokens
 * @property {boolean} isEstimate  true si las cifras de tokens son aproximadas.
 * @property {boolean} [isError]   true si la respuesta es un mensaje de degradación.
 */

/**
 * @typedef {Object} AiProvider
 * @property {string} name  Identificador para logs y diagnóstico.
 * @property {(request: AiRequest) => Promise<AiReply>} generateReply
 */

/** Métodos y propiedades obligatorios de un proveedor. */
const REQUIRED_MEMBERS = ["name", "generateReply"];

/**
 * Valida en tiempo de ejecución que un objeto cumple el puerto.
 * Se invoca en la fábrica, de modo que un proveedor mal implementado falla al
 * arrancar y no en mitad de una conversación con un ciudadano.
 *
 * @param {unknown} candidate
 * @returns {AiProvider}
 * @throws {TypeError}
 */
export const assertImplementsAiProvider = (candidate) => {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("AiProvider: se esperaba un objeto.");
  }
  for (const member of REQUIRED_MEMBERS) {
    if (candidate[member] === undefined || candidate[member] === null) {
      throw new TypeError(`AiProvider: falta el miembro obligatorio "${member}".`);
    }
  }
  if (typeof candidate.generateReply !== "function") {
    throw new TypeError('AiProvider: "generateReply" debe ser una función.');
  }
  return /** @type {AiProvider} */ (candidate);
};

/**
 * Respuesta de degradación estándar, usada cuando un proveedor falla.
 * Centralizarla evita que cada proveedor invente su propio texto y garantiza que
 * nunca se filtre el mensaje de error interno al ciudadano.
 *
 * @param {string} [text]
 * @returns {AiReply}
 */
export const degradedReply = (
  text = "⚠️ En este momento presento congestión para responder tu consulta. " +
    "Por favor intenta de nuevo en unos instantes o selecciona una opción de la lista."
) => ({
  text,
  contextIntent: null,
  tokensUsed: 0,
  savedTokens: 0,
  isEstimate: true,
  isError: true
});
