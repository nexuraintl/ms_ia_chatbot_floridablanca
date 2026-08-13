/**
 * Puerto del repositorio de conversaciones.
 *
 * Contrato que la aplicación consume para persistir el registro de atención. Igual que
 * `AiProviderPort`, existe para que el destino real del almacenamiento sea una decisión
 * intercambiable: hoy no está definido —solo se sabe que estará alojado en Cloud Run—
 * y la aplicación no debe tener que cambiar cuando se defina.
 *
 * Implementaciones previstas:
 *   · `HttpConversationRepository`  — envía a un endpoint HTTP (Cloud Run). Listo,
 *                                     pendiente únicamente de la URL y del contrato
 *                                     que exponga el backend.
 *   · `OutboxConversationRepository` — decorador que añade cola durable y reintentos
 *                                     sobre cualquier otro repositorio.
 *   · `NullConversationRepository`   — no persiste nada; es el que se usa mientras la
 *                                     persistencia está desactivada por configuración.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENTREGA GARANTIZADA "AL MENOS UNA VEZ"
 *
 * Al ser un registro legal, perder un mensaje es peor que duplicarlo. Por eso el
 * contrato es de entrega "al menos una vez": el cliente reintenta hasta confirmar, y
 * el backend debe DEDUPLICAR por `messageId`.
 *
 * Requisito para quien implemente el backend: `messageId` debe ser clave única (o
 * usarse en un `INSERT ... ON CONFLICT DO NOTHING` / `set()` con id explícito en
 * Firestore). Sin esa deduplicación, un reintento tras un timeout de red creará
 * mensajes repetidos en el historial.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * @typedef {Object} ConversationRepository
 * @property {string} name
 * @property {(envelope: import("../domain/conversation/conversationRecord.js").ConversationEnvelope) => Promise<void>} openConversation
 *           Registra o actualiza la cabecera (identidad, autorización, contexto).
 *           Debe ser idempotente por `conversationId`.
 * @property {(records: import("../domain/conversation/conversationRecord.js").ConversationMessageRecord[]) => Promise<void>} appendMessages
 *           Añade mensajes. Debe ser idempotente por `messageId`.
 * @property {() => Promise<{pending: number}>} flush
 *           Fuerza el envío de lo pendiente. Devuelve cuántos quedan sin confirmar.
 */

const REQUIRED_METHODS = ["openConversation", "appendMessages", "flush"];

/**
 * Valida que un objeto cumple el puerto. Se invoca al construir, para que un
 * repositorio mal implementado falle al arrancar y no al intentar guardar evidencia.
 *
 * @param {unknown} candidate
 * @returns {ConversationRepository}
 * @throws {TypeError}
 */
export const assertImplementsConversationRepository = (candidate) => {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("ConversationRepository: se esperaba un objeto.");
  }
  if (typeof candidate.name !== "string" || !candidate.name) {
    throw new TypeError('ConversationRepository: falta la propiedad "name".');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof candidate[method] !== "function") {
      throw new TypeError(`ConversationRepository: "${method}" debe ser una función.`);
    }
  }
  return /** @type {ConversationRepository} */ (candidate);
};

/**
 * Repositorio inerte (patrón objeto nulo).
 *
 * Se usa cuando la persistencia está desactivada. Evita que la aplicación tenga que
 * comprobar `if (repository)` en cada punto de guardado, que es justo donde un olvido
 * significaría perder un registro en silencio.
 *
 * @type {ConversationRepository}
 */
export const nullConversationRepository = {
  name: "null",
  async openConversation() {},
  async appendMessages() {},
  async flush() {
    return { pending: 0 };
  }
};
