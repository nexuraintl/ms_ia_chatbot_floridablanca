/**
 * Estadísticas derivadas de la conversación. Capa de dominio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DERIVAR EN LUGAR DE CONTAR
 *
 * Estas cifras NO se llevan en contadores. Se calculan cada vez a partir de la lista de
 * mensajes, que es la única fuente de verdad de lo que ocurrió en la atención.
 *
 * La razón es concreta: las defensas que interesan medir —la redacción de PII y el
 * bloqueo de enlaces no autorizados— se aplican DURANTE EL RENDER (`RichText` valida
 * cada enlace del texto del modelo cada vez que pinta la burbuja). Un contador
 * incrementado ahí subiría con cada repintado y acabaría informando "47 enlaces
 * bloqueados" cuando hubo uno. Derivar del estado da el número correcto por
 * construcción y además es idempotente.
 *
 * Todo es JavaScript puro y sin efectos, así que se puede ejercitar desde la suite de
 * pruebas sin navegador.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { redactPII } from "../security/piiRedactor.js";
import { forModelOutput } from "../security/urlPolicy.js";

/**
 * URLs presentes en un texto, tanto en forma Markdown `[etiqueta](url)` como sueltas.
 * Es el mismo universo de enlaces que `RichText` convierte en `<a>`, así que lo que
 * cuente este módulo coincide con lo que el ciudadano ve.
 */
const URL_REGEX = /https?:\/\/[^\s)\]]+/g;

/**
 * @typedef {Object} ConversationStats
 * @property {number} total            Mensajes en la conversación.
 * @property {number} fromCitizen
 * @property {number} fromBot
 * @property {number} notices          Mensajes de sistema (avisos, privacidad).
 * @property {number} withMaskedPii    Mensajes cuyo texto contenía datos personales.
 * @property {number} interactiveCards Formularios y tarjetas de trámite mostrados.
 * @property {number} attachments      Adjuntos entregados (facturas, QR).
 * @property {string[]} blockedLinkHosts  Hosts de enlaces que la política NO autorizó.
 */

/**
 * Resume la conversación.
 *
 * @param {import("../messages/messageFactory.js").ChatMessage[]} messages
 * @param {Object} [opts]
 * @param {string} [opts.baseOrigin]  Origen de la página, para resolver enlaces relativos
 *        igual que lo hace `RichText`.
 * @returns {ConversationStats}
 */
export const summarizeConversation = (messages, { baseOrigin } = {}) => {
  const list = Array.isArray(messages) ? messages : [];

  let fromCitizen = 0;
  let fromBot = 0;
  let notices = 0;
  let withMaskedPii = 0;
  let interactiveCards = 0;
  let attachments = 0;

  /** Se deduplica por host: diez intentos al mismo dominio son un destino, no diez. */
  const blockedHosts = new Set();

  for (const message of list) {
    if (message?.sender === "user") fromCitizen += 1;
    else if (message?.sender === "bot") fromBot += 1;
    else notices += 1;

    if (message?.customComponent) interactiveCards += 1;
    if (message?.attachment) attachments += 1;

    const text = typeof message?.text === "string" ? message.text : "";
    if (text === "") continue;

    // Si redactar cambia el texto, es que contenía algo que no debe salir en un log.
    if (redactPII(text) !== text) withMaskedPii += 1;

    // Los enlaces solo se validan en la salida del modelo: los del ciudadano no se
    // renderizan como enlaces pulsables.
    if (message.sender !== "bot") continue;

    URL_REGEX.lastIndex = 0;
    const found = text.match(URL_REGEX);
    if (!found) continue;

    for (const rawUrl of found) {
      const { safe } = forModelOutput(rawUrl, { baseOrigin });
      if (safe) continue;
      try {
        blockedHosts.add(new URL(rawUrl, baseOrigin).host);
      } catch {
        blockedHosts.add(rawUrl.slice(0, 40));
      }
    }
  }

  return {
    total: list.length,
    fromCitizen,
    fromBot,
    notices,
    withMaskedPii,
    interactiveCards,
    attachments,
    blockedLinkHosts: Array.from(blockedHosts)
  };
};

/**
 * Formatea una duración en milisegundos como texto corto en español.
 * `95_000` -> `"1 min"`, `3_600_000` -> `"1 h 0 min"`.
 *
 * @param {number} ms
 * @returns {string}
 */
export const formatDuration = (ms) => {
  const total = Number(ms);
  if (!Number.isFinite(total) || total < 0) return "—";

  const minutes = Math.floor(total / 60000);
  if (minutes < 1) return "menos de 1 min";
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
};
