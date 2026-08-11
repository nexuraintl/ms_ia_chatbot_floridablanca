/**
 * Repositorio que imprime en consola lo que se enviaría al backend.
 * Implementa `ConversationRepositoryPort`.
 *
 * Existe porque el destino real de la persistencia aún no está definido. Permite
 * revisar el contrato y el contenido exacto de los registros —qué campos, qué datos
 * personales, qué volumen— antes de decidir dónde se guardan, y sirve para que quien
 * implemente el backend vea la forma real de los payloads sin adivinarla.
 *
 * No persiste nada: al recargar la página no queda rastro. No usar en producción.
 */

/**
 * Acumulador COMPARTIDO entre instancias, a nivel de módulo.
 *
 * Deliberadamente no es por instancia: en desarrollo, `StrictMode` monta los efectos
 * dos veces, así que se crean dos repositorios. Con un acumulador por instancia, la
 * segunda sobrescribía `window.__aviChatbotRecords` con su propio objeto vacío mientras
 * la que realmente grababa era la primera — y la inspección mostraba cero registros
 * aunque la consola sí los estuviera imprimiendo.
 *
 * Un diagnóstico que informa mal es peor que no tenerlo, así que el estado se comparte.
 */
const captured = { envelopes: [], messages: [] };

/**
 * @returns {import("../../ports/ConversationRepositoryPort.js").ConversationRepository}
 */
export const createConsoleConversationRepository = () => {
  // Se expone en `window` para poder inspeccionarlo desde las herramientas de
  // desarrollo: `__aviChatbotRecords.messages`
  if (globalThis.window) {
    globalThis.window.__aviChatbotRecords = captured;
  }

  return {
    name: "console",

    async openConversation(envelope) {
      captured.envelopes.push(envelope);
      console.info(
        `💾 [Registro] Conversación abierta — tenant=${envelope.tenantId} ` +
        `id=${envelope.conversationId} ` +
        `identidad=${envelope.identity ? "sí" : "anónima"} ` +
        `autorización=${envelope.consent ? envelope.consent.noticeVersion : "no"}`,
        envelope
      );
    },

    async appendMessages(records) {
      captured.messages.push(...records);
      for (const r of records) {
        console.info(
          `💾 [Registro] #${r.sequence} [${r.sender}] ${String(r.text).slice(0, 90)}` +
          `${String(r.text).length > 90 ? "…" : ""}`
        );
      }
      console.info(
        `💾 [Registro] Total acumulado en esta sesión: ${captured.messages.length} mensaje(s). ` +
        "Inspecciona con window.__aviChatbotRecords"
      );
    },

    async flush() {
      return { pending: 0 };
    }
  };
};
