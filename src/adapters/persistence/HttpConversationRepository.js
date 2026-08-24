/**
 * Repositorio de conversaciones sobre HTTP. Implementa `ConversationRepositoryPort`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESTADO: LISTO, PENDIENTE DE APUNTAR
 *
 * El destino real del almacenamiento aún no está definido; solo se sabe que estará
 * alojado en Cloud Run. Este adaptador está completo y funcional: para activarlo basta
 * definir `VITE_CONVERSATION_API_URL` en el build.
 *
 * CONTRATO QUE DEBE EXPONER EL BACKEND
 *
 *   POST {base}/api/v1/conversations
 *     cuerpo: ConversationEnvelope
 *     debe ser idempotente por `conversationId` (upsert, no insert)
 *     respuesta: 200 / 201
 *
 *   POST {base}/api/v1/conversations/{conversationId}/messages
 *     cuerpo: { messages: ConversationMessageRecord[] }
 *     debe DEDUPLICAR por `messageId`
 *     respuesta: 200 / 202
 *
 * Requisitos del lado servidor que este adaptador no puede garantizar:
 *
 *   · Deduplicación por `messageId`. El cliente reintenta hasta recibir confirmación,
 *     así que sin deduplicación habrá mensajes repetidos en el historial. En Firestore:
 *     `doc(messageId).set(...)`. En Postgres: clave única y `ON CONFLICT DO NOTHING`.
 *   · Estampar `receivedAt` con el reloj del servidor. El `occurredAt` que envía el
 *     cliente lo controla el usuario y no tiene valor probatorio.
 *   · Cifrado en reposo y política de retención. Los registros contienen nombre,
 *     correo y, con frecuencia, la cédula que el ciudadano escribió en el chat.
 *   · Límite de tasa por IP. Es un endpoint público: el widget corre en el navegador
 *     de cualquiera, así que cualquiera puede llamarlo.
 *   · CORS que permita los dominios de los portales anfitriones.
 *
 * SOBRE LA AUTENTICACIÓN: este endpoint no puede autenticarse desde el navegador sin
 * exponer la credencial —es el mismo problema que la clave de Gemini (ver SECURITY.md,
 * H-01)—. Lo viable es que sea público con límite de tasa y validación estricta del
 * cuerpo, y que el backend nunca confíe en el `tenantId` que envía el cliente sin
 * cruzarlo con el origen de la petición.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { post, HttpError } from "../http/httpClient.js";

/** Timeout de las peticiones de persistencia. */
const PERSIST_TIMEOUT_MS = 15_000;

/**
 * Crea el adaptador HTTP.
 *
 * @param {Object} deps
 * @param {string} deps.baseUrl
 * @returns {import("../../ports/ConversationRepositoryPort.js").ConversationRepository}
 */
export const createHttpConversationRepository = ({ baseUrl }) => {
  if (!baseUrl) {
    throw new Error("HttpConversationRepository: se requiere baseUrl.");
  }

  const base = String(baseUrl).replace(/\/+$/, "");

  return {
    name: "http",

    async openConversation(envelope) {
      try {
        await post(`${base}/api/v1/conversations`, envelope, { timeoutMs: PERSIST_TIMEOUT_MS });
      } catch (error) {
        // Se propaga para que el decorador de cola pueda reintentar. No se registra el
        // cuerpo en consola: contiene el nombre y el correo del ciudadano.
        const status = error instanceof HttpError ? error.status : 0;
        throw new Error(`No se pudo abrir la conversación (status=${status})`, { cause: error });
      }
    },

    async appendMessages(records) {
      if (!Array.isArray(records) || records.length === 0) return;

      // Todos los registros de una tanda pertenecen a la misma conversación: quien
      // llama agrupa por `conversationId` antes de invocar.
      const { conversationId } = records[0];

      try {
        await post(
          `${base}/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
          { messages: records },
          { timeoutMs: PERSIST_TIMEOUT_MS }
        );
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 0;
        throw new Error(
          `No se pudieron guardar ${records.length} mensaje(s) (status=${status})`,
          { cause: error }
        );
      }
    },

    async flush() {
      // Este adaptador envía de forma sincrónica; no mantiene estado pendiente.
      // La cola y los reintentos los aporta `OutboxConversationRepository`.
      return { pending: 0 };
    }
  };
};
