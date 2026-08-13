/**
 * Puerto del proveedor de IA. Define el contrato que la aplicación consume.
 *
 * La aplicación depende de este contrato, no de un proveedor concreto: la selección
 * ocurre una sola vez en `createAiProvider`, así que añadir uno nuevo no obliga a tocar
 * ni la aplicación ni los existentes. Se expresa con JSDoc y se valida al arrancar con
 * `assertImplementsAiProvider`.
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
 * @property {boolean} [billable]  true si la llamada consumió cuota de un proveedor
 *           remoto. Solo el proveedor sabe esto, así que es él quien lo declara: el
 *           consumidor no debe deducirlo del nombre del adaptador. Sin este campo, la
 *           consola contaba como "tokens consumidos" las respuestas del catálogo local,
 *           que no gastan nada.
 * @property {{reason: string, retryAfterSeconds: number}} [fallback]
 *           Presente cuando el proveedor declina atender y pide que otro lo haga: cuota
 *           agotada, límite de tasa, servicio caído. `retryAfterSeconds` lo dicta el
 *           servidor, no el cliente. Lo consume `QuotaAwareProvider`, que atiende la
 *           consulta con el banco de preguntas; ningún consumidor debería convertir este
 *           campo en texto para el ciudadano.
 * @property {boolean} [servedByFallback]  true si respondió el catálogo local en lugar del
 *           proveedor de IA. Es información para el panel del operador.
 * @property {string} [fallbackReason]     Motivo de esa degradación, para el panel.
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
 * Respuesta de degradación estándar. Centralizarla evita que cada proveedor invente su
 * propio texto y que se filtre un error interno al ciudadano.
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
  isError: true,
  // Una degradación ocurre porque la petición falló o no se llegó a hacer: no hay
  // consumo que atribuir.
  billable: false
});
