/**
 * Fábrica de mensajes del chat. Capa de dominio.
 *
 * Centraliza la creación de identificadores y marcas de tiempo, que antes estaban
 * repetidas en cinco puntos de `ChatContext.jsx` con
 * `Math.random().toString(36).substr(2, 9)`.
 *
 * Dos problemas con ese patrón: `substr` está deprecado, y 9 caracteres base-36 de
 * `Math.random()` colisionan con probabilidad apreciable en una conversación larga
 * (los ids se usan como `key` de React y para `updateMessage`, así que una colisión
 * corrompe el render).
 */

/** @typedef {"user" | "bot" | "system"} MessageSender */

/**
 * @typedef {Object} ChatMessage
 * @property {string} id
 * @property {MessageSender} sender
 * @property {string} [text]
 * @property {string} timestamp
 * @property {string[]|null} [quickReplies]
 * @property {Object} [form]
 * @property {Object} [attachment]
 * @property {string} [customComponent]
 */

/**
 * Genera un identificador único para un mensaje.
 * Usa `crypto.randomUUID` cuando está disponible (todos los navegadores objetivo y
 * Node 19+); si no, cae a un contador monótono combinado con entropía.
 *
 * @returns {string}
 */
let fallbackCounter = 0;
export const createMessageId = () => {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint8Array(8);
    cryptoObj.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  fallbackCounter += 1;
  return `msg-${Date.now().toString(36)}-${fallbackCounter}`;
};

/**
 * Marca de tiempo en formato HH:MM local, tal como la muestra la UI.
 * @param {Date} [date]
 * @returns {string}
 */
export const createTimestamp = (date = new Date()) =>
  date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Construye un mensaje completo a partir de un descriptor parcial.
 * Rellena `id` y `timestamp` si no vienen dados, sin sobrescribirlos si sí.
 *
 * @param {Partial<ChatMessage>} partial
 * @returns {ChatMessage}
 */
export const createMessage = (partial = {}) => {
  const { id, timestamp, ...rest } = partial;
  return {
    ...rest,
    id: id || createMessageId(),
    timestamp: timestamp || createTimestamp()
  };
};

/** Atajos de construcción para los tres remitentes. */
export const botMessage = (text, extra = {}) => createMessage({ sender: "bot", text, ...extra });
export const userMessage = (text, extra = {}) => createMessage({ sender: "user", text, ...extra });
export const systemMessage = (text, extra = {}) => createMessage({ sender: "system", text, ...extra });
