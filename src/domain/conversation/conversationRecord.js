/**
 * Registro de conversación. Capa de dominio.
 *
 * Al ser evidencia legal prioriza idempotencia (`messageId` estable, para que un
 * reintento no duplique), orden verificable (`sequence` monótono, porque el reloj del
 * cliente lo controla el usuario) y aislamiento multi-tenant (`tenantId` en cada
 * registro, no solo en la conversación).
 *
 * `occurredAt` es hora del cliente y no es confiable: el backend debe estampar su propio
 * `receivedAt`, que es el que tiene valor probatorio. Ver REGISTRO_Y_IDENTIDAD.md.
 */

import { createMessageId } from "../messages/messageFactory.js";
import { truncate } from "../security/textSanitizer.js";

/**
 * Versión del esquema de los registros.
 * Incrementar ante cualquier cambio incompatible, para que el backend pueda migrar.
 */
export const RECORD_SCHEMA_VERSION = 1;

/** Tope de longitud del texto persistido por mensaje. */
const MAX_TEXT_LENGTH = 8000;

/**
 * @typedef {Object} ConversationMessageRecord
 * @property {number} schemaVersion
 * @property {string} tenantId
 * @property {string} conversationId
 * @property {string} messageId      Clave de idempotencia.
 * @property {number} sequence       Monótono dentro de la conversación, empieza en 0.
 * @property {string} occurredAt     ISO, reloj del cliente (no confiable).
 * @property {"user"|"bot"|"system"} sender
 * @property {string} text
 * @property {Object|null} metadata  Datos del mensaje que no son texto (adjuntos, formularios).
 */

/**
 * @typedef {Object} ConversationEnvelope
 * @property {number} schemaVersion
 * @property {string} tenantId
 * @property {string} conversationId
 * @property {string} startedAt
 * @property {import("../identity/citizenIdentity.js").CitizenIdentity|null} identity
 * @property {import("../consent/consentRecord.js").ConsentRecord|null} consent
 * @property {{pageUrl: string, locale: string}} context
 */

/**
 * Crea el identificador de una conversación.
 * @returns {string}
 */
export const createConversationId = () => createMessageId();

/**
 * Cabecera de la conversación: lo que no cambia mensaje a mensaje. Se reenvía cuando la
 * identidad o la autorización cambian.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.conversationId
 * @param {import("../identity/citizenIdentity.js").CitizenIdentity|null} [params.identity]
 * @param {import("../consent/consentRecord.js").ConsentRecord|null} [params.consent]
 * @param {string} [params.pageUrl]
 * @param {string} [params.startedAt]
 * @returns {ConversationEnvelope}
 */
export const createEnvelope = ({
  tenantId,
  conversationId,
  identity = null,
  consent = null,
  pageUrl = "",
  startedAt = new Date().toISOString()
}) => ({
  schemaVersion: RECORD_SCHEMA_VERSION,
  tenantId,
  conversationId,
  startedAt,
  identity,
  consent,
  context: {
    // Sin user-agent ni huella del dispositivo: no aportan y aumentan la exposición.
    pageUrl: truncate(String(pageUrl || ""), 500),
    locale: "es-CO"
  }
});

/**
 * Construye el registro de un mensaje.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.conversationId
 * @param {number} params.sequence
 * @param {import("../messages/messageFactory.js").ChatMessage} params.message
 * @returns {ConversationMessageRecord}
 */
export const createMessageRecord = ({ tenantId, conversationId, sequence, message }) => ({
  schemaVersion: RECORD_SCHEMA_VERSION,
  tenantId,
  conversationId,
  // Reutiliza el id de la interfaz: el registro y lo que el ciudadano vio son trazables.
  messageId: message.id,
  sequence,
  occurredAt: new Date().toISOString(),
  sender: message.sender,
  text: truncate(String(message.text ?? ""), MAX_TEXT_LENGTH),
  metadata: extractMetadata(message)
});

/**
 * Extrae los datos no textuales de un mensaje. No se persiste el mensaje entero: lleva
 * props de React y datos crudos de los RPA que ya viven en los sistemas de origen.
 *
 * @param {import("../messages/messageFactory.js").ChatMessage} message
 * @returns {Object|null}
 */
const extractMetadata = (message) => {
  const meta = {};

  if (message.customComponent) meta.component = message.customComponent;
  if (message.form?.type) meta.formType = message.form.type;
  if (message.attachment) {
    meta.attachment = {
      type: message.attachment.type,
      label: message.attachment.fileLabel || message.attachment.label || null
    };
  }
  if (message.buttonUrl) meta.hasActionButton = true;
  if (Array.isArray(message.quickReplies) && message.quickReplies.length > 0) {
    meta.quickRepliesOffered = message.quickReplies.length;
  }

  return Object.keys(meta).length > 0 ? meta : null;
};

/**
 * ¿Debe este mensaje formar parte del registro? Se excluye la bienvenida: es texto fijo.
 *
 * @param {import("../messages/messageFactory.js").ChatMessage} message
 * @returns {boolean}
 */
export const isRecordable = (message) => {
  if (!message?.sender) return false;
  if (typeof message.id === "string" && message.id.startsWith("welcome-")) return false;
  // Un mensaje sin texto ni componente no aporta nada al registro.
  return Boolean(message.text || message.customComponent || message.attachment);
};
