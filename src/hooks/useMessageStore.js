/**
 * Estado de los mensajes del chat.
 *
 * Extraído de `ChatContext.jsx`, donde `addMessage`, `updateMessage`, el arranque con
 * los mensajes de bienvenida y la limpieza de `quickReplies` estaban entremezclados
 * con la orquestación de cuatro trámites y con el cliente de IA.
 *
 * Un detalle que aquí queda explícito: `addMessage` borra los `quickReplies` de todos
 * los mensajes anteriores, para que solo el último ofrezca botones. Antes esa regla
 * estaba implícita en un `.map()` dentro del `setMessages` y era fácil de romper.
 */

import { useCallback, useRef, useState } from "react";
import { createMessage, createTimestamp } from "../domain/messages/messageFactory.js";
import { toConversationTurns } from "../domain/messages/conversationTurns.js";

/**
 * Inserta el nombre del ciudadano en el saludo.
 *
 * `"¡Hola! Te doy la bienvenida…"` -> `"¡Hola, Ana! Te doy la bienvenida…"`.
 * Si el texto configurado no empieza por un saludo reconocible se antepone uno, en lugar
 * de intentar reescribirlo: el texto del tenant no se toca más de lo necesario.
 *
 * @param {string} message
 * @param {string} [firstName]
 * @returns {string}
 */
const personalizeGreeting = (message, firstName) => {
  if (!firstName) return message;
  if (/^\s*¡?\s*hola\s*!?/i.test(message)) {
    return message.replace(/^\s*¡?\s*hola\s*!?,?/i, `¡Hola, ${firstName}!`);
  }
  return `¡Hola, ${firstName}! ${message}`;
};

/**
 * Construye el saludo del asistente: presentación y opciones sugeridas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ÚNICA FUENTE DEL TEXTO DE BIENVENIDA
 *
 * Estos dos mensajes se emiten en tres momentos distintos: al abrir el chat sin puerta de
 * identidad, al entregar los datos y al omitirlos. Cuando cada momento armaba su propia
 * copia del texto —con sus propios valores por defecto— bastaba cambiar
 * `chatbotConfig.json` para que los tres saludos dejaran de coincidir. Aquí se
 * construyen una sola vez.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Devuelve descriptores PARCIALES (sin `id` ni `timestamp`) para que los complete quien
 * los emita: `addMessages` genera identificadores nuevos y `buildWelcomeMessages` usa
 * identificadores fijos.
 *
 * @param {Object} params
 * @param {Object} params.config             `chatbotConfig.json`
 * @param {boolean} params.isServicesEnabled
 * @param {string} [params.firstName]        Nombre del ciudadano, si ya se identificó.
 * @returns {Partial<import("../domain/messages/messageFactory.js").ChatMessage>[]}
 */
export const buildGreetingMessages = ({ config, isServicesEnabled, firstName }) => {
  const replies = isServicesEnabled
    ? (config.quickReplies || []).map((r) => r.label)
    : [];

  const presentation = personalizeGreeting(
    config.welcome?.message1 || "¡Hola! Te doy la bienvenida a la Alcaldía de Floridablanca.",
    firstName
  );

  const invitation = isServicesEnabled
    ? config.welcome?.message2_services ||
      "Soy tu asistente virtual. Puedes escribirme tu duda directamente o seleccionar una de estas opciones sugeridas:"
    : config.welcome?.message2_no_services ||
      "Soy tu asistente virtual. Escribe tu duda o pregunta y te responderé con gusto.";

  // `interfaceOnly`: el saludo se le muestra al ciudadano pero no se le envía al modelo.
  // Si viajara como turno del asistente, el modelo copiaría el patrón y abriría cada
  // respuesta con "¡Hola, <nombre>!".
  return [
    { sender: "bot", text: presentation, interfaceOnly: true },
    {
      sender: "bot",
      text: invitation,
      quickReplies: replies.length > 0 ? replies : null,
      interfaceOnly: true
    }
  ];
};

/**
 * Construye los mensajes con los que arranca la conversación.
 *
 * En los modos de puerta (`gate`, `gate_skippable`) solo se emite el aviso de privacidad:
 * el saludo llega después, cuando el ciudadano entrega u omite sus datos, para que no
 * quede por encima del formulario de identidad.
 *
 * @param {Object} params
 * @param {Object} params.config             `chatbotConfig.json`
 * @param {boolean} params.isServicesEnabled
 * @param {boolean} [params.isGateVisible]
 * @returns {import("../domain/messages/messageFactory.js").ChatMessage[]}
 */
export const buildWelcomeMessages = ({ config, isServicesEnabled, isGateVisible = false }) => {
  const timestamp = createTimestamp();

  const privacyNotice = {
    id: "welcome-privacy",
    sender: "system",
    text:
      config.welcome?.privacyNotice ||
      "🔒 Aviso de Privacidad: Al enviar tu primer mensaje o seleccionar una opción, " +
        "autorizas el Tratamiento de Datos Personales (Ley 1581 de 2012) y aceptas los " +
        "Términos y Condiciones.",
    timestamp
  };

  if (isGateVisible) {
    return [privacyNotice];
  }

  return [
    privacyNotice,
    // Identificadores fijos: estos mensajes se reconstruyen en cada reinicio y unas claves
    // de React estables evitan repintar toda la lista.
    ...buildGreetingMessages({ config, isServicesEnabled }).map((message, index) => ({
      ...message,
      id: `welcome-${index + 1}`,
      timestamp
    }))
  ];
};

/**
 * Hook de estado de mensajes.
 *
 * @param {Object} params
 * @param {Object} params.config
 * @param {boolean} params.isServicesEnabled
 * @param {boolean} [params.isGateVisible=false]
 * @returns {Object}
 */
export const useMessageStore = ({ config, isServicesEnabled, isGateVisible = false }) => {
  const [messages, setMessages] = useState(() =>
    buildWelcomeMessages({ config, isServicesEnabled: true, isGateVisible })
  );

  /**
   * Referencia al último id añadido, para que quien llama pueda actualizar el mensaje
   * después sin depender del valor devuelto en un `setState` asíncrono.
   */
  const lastIdRef = useRef(null);

  /**
   * Añade un mensaje y retira los botones rápidos de los anteriores.
   * @param {Partial<import("../domain/messages/messageFactory.js").ChatMessage>} partial
   * @returns {string} id del mensaje creado
   */
  const addMessage = useCallback((partial) => {
    const message = createMessage(partial);
    lastIdRef.current = message.id;
    setMessages((prev) => [
      ...prev.map((m) => (m.quickReplies ? { ...m, quickReplies: null } : m)),
      message
    ]);
    return message.id;
  }, []);

  /** Añade varios mensajes en una sola actualización de estado. */
  const addMessages = useCallback((partials) => {
    const created = partials.map(createMessage);
    if (created.length > 0) lastIdRef.current = created[created.length - 1].id;
    setMessages((prev) => [
      ...prev.map((m) => (m.quickReplies ? { ...m, quickReplies: null } : m)),
      ...created
    ]);
    return created.map((m) => m.id);
  }, []);

  /**
   * Actualiza un mensaje existente.
   * @param {string} id
   * @param {Object} updates
   */
  const updateMessage = useCallback((id, updates) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...updates } : m)));
  }, []);

  /** Reemplaza la conversación por los mensajes de bienvenida. */
  const reset = useCallback(
    (servicesEnabled = isServicesEnabled) => {
      setMessages(buildWelcomeMessages({ config, isServicesEnabled: servicesEnabled, isGateVisible }));
    },
    [config, isServicesEnabled, isGateVisible]
  );

  /** Conversación en el formato que consume el proveedor de IA. */
  const toConversationHistory = useCallback(
    (extraUserText) => toConversationTurns(messages, extraUserText),
    [messages]
  );

  return {
    messages,
    setMessages,
    addMessage,
    addMessages,
    updateMessage,
    reset,
    toConversationHistory,
    lastMessageId: lastIdRef
  };
};
