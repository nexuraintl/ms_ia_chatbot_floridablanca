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

/**
 * Construye los mensajes de bienvenida.
 *
 * @param {Object} params
 * @param {Object} params.config             `chatbotConfig.json`
 * @param {boolean} params.isServicesEnabled
 * @returns {import("../domain/messages/messageFactory.js").ChatMessage[]}
 */
export const buildWelcomeMessages = ({ config, isServicesEnabled }) => {
  const timestamp = createTimestamp();
  const replies = isServicesEnabled
    ? (config.quickReplies || []).map((r) => r.label)
    : [];

  return [
    {
      id: "welcome-privacy",
      sender: "system",
      text:
        config.welcome?.privacyNotice ||
        "🔒 Aviso de Privacidad: Al enviar tu primer mensaje o seleccionar una opción, " +
          "autorizas el Tratamiento de Datos Personales (Ley 1581 de 2012) y aceptas los " +
          "Términos y Condiciones.",
      timestamp
    },
    {
      id: "welcome-1",
      sender: "bot",
      text: config.welcome?.message1 || "¡Hola!",
      timestamp
    },
    {
      id: "welcome-2",
      sender: "bot",
      text: isServicesEnabled
        ? config.welcome?.message2_services
        : config.welcome?.message2_no_services,
      timestamp,
      quickReplies: replies.length > 0 ? replies : null
    }
  ];
};

/**
 * Hook de estado de mensajes.
 *
 * @param {Object} params
 * @param {Object} params.config
 * @param {boolean} params.isServicesEnabled
 * @returns {Object}
 */
export const useMessageStore = ({ config, isServicesEnabled }) => {
  const [messages, setMessages] = useState(() =>
    buildWelcomeMessages({ config, isServicesEnabled: true })
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
      setMessages(buildWelcomeMessages({ config, isServicesEnabled: servicesEnabled }));
    },
    [config, isServicesEnabled]
  );

  /** Conversación en el formato que consume el proveedor de IA. */
  const toConversationHistory = useCallback(
    (extraUserText) => {
      const history = messages
        .filter((m) => m.sender === "user" || m.sender === "bot")
        .map((m) => ({ sender: m.sender, text: m.text }));
      if (extraUserText) history.push({ sender: "user", text: extraUserText });
      return history;
    },
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
