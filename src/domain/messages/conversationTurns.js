/**
 * Qué parte de la conversación ve el proveedor de IA. Capa de dominio.
 *
 * La lista de mensajes de la pantalla y la conversación que se le envía al modelo no son
 * lo mismo: el saludo, el aviso de privacidad y la oferta de más ayuda son interfaz. Si
 * viajan como turnos del asistente, el modelo aprende el patrón y lo repite —abría cada
 * respuesta con "¡Hola, <nombre>!"— y además se paga por enviarlos.
 *
 * Como efecto colateral deseable, el nombre del ciudadano deja de salir hacia el
 * proveedor: solo aparecía en esos mensajes de interfaz (Ley 1581, minimización).
 */

/**
 * ¿El mensaje es un turno real de la conversación?
 *
 * @param {import("./messageFactory.js").ChatMessage} message
 * @returns {boolean}
 */
export const isConversationTurn = (message) =>
  Boolean(message) &&
  (message.sender === "user" || message.sender === "bot") &&
  message.interfaceOnly !== true &&
  typeof message.text === "string" &&
  message.text.trim() !== "";

/**
 * Convierte los mensajes de la pantalla en los turnos que consume el proveedor de IA.
 *
 * @param {import("./messageFactory.js").ChatMessage[]} messages
 * @param {string} [extraUserText]  Mensaje del ciudadano aún no añadido a la lista.
 * @returns {{sender: string, text: string}[]}
 */
export const toConversationTurns = (messages, extraUserText) => {
  const turns = (Array.isArray(messages) ? messages : [])
    .filter(isConversationTurn)
    .map((message) => ({ sender: message.sender, text: message.text }));

  if (typeof extraUserText === "string" && extraUserText.trim() !== "") {
    turns.push({ sender: "user", text: extraUserText });
  }
  return turns;
};
