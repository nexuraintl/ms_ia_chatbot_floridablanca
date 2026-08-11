/* eslint-disable react-refresh/only-export-components */
/**
 * Contexto del chat: COMPOSICIÓN Y CABLEADO.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ANTES: 930 líneas haciendo, en un solo archivo:
 *   · estado de React (mensajes, carga, tema, clave, interruptores)
 *   · acceso a localStorage sin protección
 *   · scraping del DOM de la página anfitriona
 *   · descarga y parseo del mapa del sitio del portal
 *   · puntuación de relevancia de enlaces
 *   · construcción del prompt
 *   · cliente de la API de Gemini (indirectamente)
 *   · orquestación de cuatro trámites, con sus streams SSE
 *   · traducción de errores técnicos, duplicada
 *   · telemetría de tokens
 *   · reglas de enrutamiento semántico
 *
 * AHORA: solo compone piezas y expone el contexto. Cada responsabilidad de arriba
 * vive en su propio módulo, se puede probar por separado y se puede sustituir sin
 * abrir este archivo.
 *
 * La forma del objeto de contexto se mantiene idéntica a propósito, para que
 * `ChatWindow`, `ChatbotConsole` y las tarjetas de trámite no cambien.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import config from "../config/chatbotConfig.json";
import { getBackendHosts } from "../config/environment.js";
import { configureUrlPolicy } from "../domain/security/urlPolicy.js";
import { resolveIntent, mentionsService } from "../domain/intents/intentResolver.js";
import { createFlowRegistry, runFlow, getFlowLabel } from "../application/flows/flowRegistry.js";

import { useMessageStore } from "../hooks/useMessageStore.js";
import { useFollowUp } from "../hooks/useFollowUp.js";
import { usePreferences } from "../hooks/usePreferences.js";
import { useSitemapLinks } from "../hooks/useSitemapLinks.js";
import { useAiConversation } from "../hooks/useAiConversation.js";
import { usePredialFlow } from "../hooks/usePredialFlow.js";
import { usePqrsdFlow } from "../hooks/usePqrsdFlow.js";
import { useSisbenFlow } from "../hooks/useSisbenFlow.js";

/** Tope de longitud del mensaje del ciudadano. */
const MAX_INPUT_LENGTH = 1000;

// Configurar la política de URLs una sola vez, al cargar el módulo.
configureUrlPolicy({
  allowedLinkHosts: config.security?.allowedLinkHosts ?? [],
  knownBackendHosts: getBackendHosts()
});

const ChatContext = createContext(null);

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChat debe usarse dentro de un ChatProvider");
  }
  return context;
};

export const ChatProvider = ({ children }) => {
  // ── Estado de presentación ────────────────────────────────────────────────
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isTextInputEnabled, setIsTextInputEnabled] = useState(true);

  // ── Memoria conversacional ────────────────────────────────────────────────
  const [activeContext, setActiveContext] = useState(null);
  const [lastServiceMentioned, setLastServiceMentioned] = useState(null);

  // ── Contadores de consumo ─────────────────────────────────────────────────
  const [tokensUsedTotal, setTokensUsedTotal] = useState(0);
  const [tokensSavedTotal, setTokensSavedTotal] = useState(0);

  // ── Preferencias persistentes ─────────────────────────────────────────────
  const preferences = usePreferences();
  const {
    apiKey,
    updateApiKey,
    theme,
    setTheme,
    toggleTheme,
    isGeminiEnabled,
    setIsGeminiEnabled,
    isServicesEnabled,
    setIsServicesEnabled
  } = preferences;

  // ── Mensajes ──────────────────────────────────────────────────────────────
  const { messages, setMessages, addMessage, updateMessage, reset, toConversationHistory } =
    useMessageStore({ config, isServicesEnabled });

  // ── Seguimiento tras inactividad ──────────────────────────────────────────
  const { schedule: scheduleFollowUp, clear: clearFollowUpTimer } = useFollowUp({
    setMessages,
    config,
    isServicesEnabled
  });

  // ── Contexto del portal anfitrión ─────────────────────────────────────────
  const { sitemapLinks } = useSitemapLinks();

  // ── Conversación con IA ───────────────────────────────────────────────────
  const onUsage = useCallback(({ used, saved }) => {
    setTokensUsedTotal((prev) => prev + used);
    setTokensSavedTotal((prev) => prev + saved);
  }, []);

  const { ask } = useAiConversation({ apiKey, sitemapLinks, onUsage });

  // ── Flujos de trámite ─────────────────────────────────────────────────────
  const flowDeps = useMemo(
    () => ({ addMessage, setIsLoading, scheduleFollowUp }),
    [addMessage, scheduleFollowUp]
  );

  const { startPredial, submitPredialForm, selectPredio } = usePredialFlow(flowDeps);
  const { startPqrsdCreate, startPqrsdConsult, startPqrsdMenu, submitPqrsdConsult } =
    usePqrsdFlow(flowDeps);
  const { startSisben, submitForm: submitSisbenForm } = useSisbenFlow(flowDeps);

  /**
   * Registro de flujos. Añadir un trámite es añadir una entrada aquí y su hook;
   * ni el enrutador ni este componente necesitan una rama nueva.
   */
  const flowRegistry = useMemo(
    () =>
      createFlowRegistry({
        startSisben,
        startPredial,
        startPqrsdCreate,
        startPqrsdConsult,
        startPqrsdMenu
      }),
    [startSisben, startPredial, startPqrsdCreate, startPqrsdConsult, startPqrsdMenu]
  );

  // ── Reinicio al cambiar los módulos activos ───────────────────────────────
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setIsTextInputEnabled(true);
    reset(isServicesEnabled);
  }, [isServicesEnabled, isGeminiEnabled, reset]);

  /**
   * Intenta resolver el mensaje como un trámite local.
   * @param {string} text
   * @returns {boolean} true si se lanzó un flujo
   */
  const tryRouteToFlow = useCallback(
    (text) => {
      const { flow } = resolveIntent(text, {
        routingMap: config.routing,
        pendingService: lastServiceMentioned
      });

      const { executed } = runFlow(flowRegistry, flow);
      if (executed) {
        setLastServiceMentioned(null);
        setIsLoading(false);
      }
      return executed;
    },
    [flowRegistry, lastServiceMentioned]
  );

  /**
   * Envía un mensaje de texto libre.
   *
   * @param {string} text
   * @param {boolean} [skipAddUserMessage] true si el mensaje ya se añadió (respuesta rápida).
   */
  const sendMessage = useCallback(
    async (text, skipAddUserMessage = false) => {
      const trimmed = String(text ?? "").trim();
      if (trimmed === "") return;

      const userText = trimmed.substring(0, MAX_INPUT_LENGTH);

      clearFollowUpTimer();
      if (!skipAddUserMessage) {
        addMessage({ sender: "user", text: userText });
      }
      setIsLoading(true);

      try {
        // 1. ¿Es un trámite?
        if (isServicesEnabled) {
          if (tryRouteToFlow(userText)) return;
        } else if (mentionsService(userText)) {
          addMessage({
            sender: "bot",
            text: "⚠️ Los servicios y trámites interactivos están inhabilitados temporalmente por el administrador."
          });
          setIsLoading(false);
          return;
        }

        // 2. Conversación libre con IA.
        if (!isGeminiEnabled) {
          addMessage({
            sender: "bot",
            text:
              "⚠️ La sección de preguntas frecuentes y respuesta libre con IA está inhabilitada " +
              "en este momento. Por favor utiliza los trámites habilitados."
          });
          return;
        }

        const history = toConversationHistory(skipAddUserMessage ? null : userText);
        const reply = await ask({ history, userText, activeContext });

        if (reply.contextIntent) {
          setActiveContext(reply.contextIntent);
        }

        let replyText = reply.text;

        // Si quedó un trámite mencionado sin lanzar, ofrecer activarlo.
        if (lastServiceMentioned) {
          const label = getFlowLabel(flowRegistry, lastServiceMentioned);
          replyText += `\n\n*(Escribe "iniciar" para realizar el trámite interactivo de ${label} aquí mismo)*`;
        }

        addMessage({ sender: "bot", text: replyText });
      } catch (error) {
        // El detalle técnico no se muestra al ciudadano.
        console.error("❌ [Chat] Error procesando el mensaje:", error?.message);
        addMessage({
          sender: "bot",
          text: "⚠️ Hubo un inconveniente al procesar tu solicitud. Por favor intenta de nuevo."
        });
      } finally {
        setIsLoading(false);
        scheduleFollowUp();
      }
    },
    [
      addMessage,
      clearFollowUpTimer,
      isServicesEnabled,
      isGeminiEnabled,
      tryRouteToFlow,
      toConversationHistory,
      ask,
      activeContext,
      lastServiceMentioned,
      flowRegistry,
      scheduleFollowUp
    ]
  );

  /**
   * Maneja el clic en una respuesta rápida.
   * @param {string} option
   */
  const selectQuickReply = useCallback(
    async (option) => {
      addMessage({ sender: "user", text: option });
      setIsLoading(true);

      if (!isServicesEnabled) {
        addMessage({
          sender: "bot",
          text: "⚠️ Los servicios y trámites interactivos están inhabilitados en este momento."
        });
        setIsLoading(false);
        return;
      }

      if (tryRouteToFlow(option)) return;

      // Sin trámite directo: derivar al flujo normal sin duplicar el mensaje.
      await sendMessage(option, true);
    },
    [addMessage, isServicesEnabled, tryRouteToFlow, sendMessage]
  );

  // ── Control de apertura ───────────────────────────────────────────────────
  const openChat = useCallback(() => setIsOpen(true), []);
  const closeChat = useCallback(() => setIsOpen(false), []);
  const toggleChat = useCallback(() => setIsOpen((prev) => !prev), []);

  const resetChat = useCallback(() => {
    setIsTextInputEnabled(true);
    setActiveContext(null);
    setLastServiceMentioned(null);
    clearFollowUpTimer();
    reset(isServicesEnabled);
  }, [clearFollowUpTimer, reset, isServicesEnabled]);

  /**
   * Valor del contexto. Se memoiza para no re-renderizar a todos los consumidores en
   * cada render del proveedor.
   */
  const value = useMemo(
    () => ({
      // Estado
      isOpen,
      messages,
      isTextInputEnabled,
      isLoading,
      apiKey,
      tokensSavedTotal,
      tokensUsedTotal,
      theme,

      // Apertura
      openChat,
      closeChat,
      toggleChat,

      // Conversación
      sendMessage,
      selectQuickReply,
      resetChat,
      scheduleFollowUp,
      clearFollowUpTimer,
      updateMessage,

      // Trámites
      submitChatForm: submitSisbenForm,
      handlePredialFormSubmit: submitPredialForm,
      handlePqrsdConsultSubmit: submitPqrsdConsult,
      handleSelectPredio: selectPredio,

      // Configuración
      updateApiKey,
      isGeminiEnabled,
      setIsGeminiEnabled,
      isServicesEnabled,
      setIsServicesEnabled,
      setTheme,
      toggleTheme
    }),
    [
      isOpen,
      messages,
      isTextInputEnabled,
      isLoading,
      apiKey,
      tokensSavedTotal,
      tokensUsedTotal,
      theme,
      openChat,
      closeChat,
      toggleChat,
      sendMessage,
      selectQuickReply,
      resetChat,
      scheduleFollowUp,
      clearFollowUpTimer,
      updateMessage,
      submitSisbenForm,
      submitPredialForm,
      submitPqrsdConsult,
      selectPredio,
      updateApiKey,
      isGeminiEnabled,
      setIsGeminiEnabled,
      isServicesEnabled,
      setIsServicesEnabled,
      setTheme,
      toggleTheme
    ]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};
