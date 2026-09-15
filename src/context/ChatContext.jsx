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
import faqCatalog from "../config/NewFaqConfig.json";
import { getBackendHosts } from "../config/environment.js";
import { configureUrlPolicy } from "../domain/security/urlPolicy.js";
import { configureCorrelation } from "../domain/observability/correlation.js";
import { resolveIntent, mentionsService } from "../domain/intents/intentResolver.js";
import { evaluateTopic, resolveTopicGuardSettings } from "../domain/moderation/topicGuard.js";
import { createFlowRegistry, runFlow, getFlowLabel } from "../application/flows/flowRegistry.js";
import { sessionMetrics, METRIC_EVENTS } from "../domain/observability/sessionMetrics.js";

import { useMessageStore, buildGreetingMessages } from "../hooks/useMessageStore.js";
import { useFollowUp } from "../hooks/useFollowUp.js";
import { usePreferences } from "../hooks/usePreferences.js";
import { useSitemapLinks } from "../hooks/useSitemapLinks.js";
import { useAiConversation } from "../hooks/useAiConversation.js";
import { usePredialFlow } from "../hooks/usePredialFlow.js";
import { usePqrsdFlow } from "../hooks/usePqrsdFlow.js";
import { useSisbenFlow } from "../hooks/useSisbenFlow.js";
import { useCitizenIdentity } from "../hooks/useCitizenIdentity.js";
import { useConversationRecorder } from "../hooks/useConversationRecorder.js";

/** Tope de longitud del mensaje del ciudadano. */
const MAX_INPUT_LENGTH = 1000;

// Configurar la política de URLs una sola vez, al cargar el módulo.
configureUrlPolicy({
  allowedLinkHosts: config.security?.allowedLinkHosts ?? [],
  knownBackendHosts: getBackendHosts()
});

// GOB-GCP-STD-01: emisión de cabeceras de correlación hacia los microservicios.
configureCorrelation({ enabled: config.observability?.sendCorrelationId !== false });

/** Filtro de alcance temático, resuelto una vez: la configuración no cambia en caliente. */
const TOPIC_GUARD = resolveTopicGuardSettings(config);

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

  // ── Identidad del ciudadano (configurable por tenant) ─────────────────────
  const identityState = useCitizenIdentity({ config });

  // ── Mensajes ──────────────────────────────────────────────────────────────
  const { messages, setMessages, addMessage, addMessages, updateMessage, reset, toConversationHistory } =
    useMessageStore({ config, isServicesEnabled, isGateVisible: identityState.isGateVisible });

  // ── Registro de la conversación (evidencia de la atención) ────────────────
  const recorder = useConversationRecorder({
    messages,
    config,
    identity: identityState.identity,
    consent: identityState.consent
  });

  // ── Seguimiento tras inactividad ──────────────────────────────────────────
  const { schedule: scheduleFollowUp, clear: clearFollowUpTimer } = useFollowUp({
    setMessages,
    config,
    isServicesEnabled
  });

  // ── Contexto del portal anfitrión ─────────────────────────────────────────
  const { sitemapLinks } = useSitemapLinks();

  // ── Conversación con IA ───────────────────────────────────────────────────
  //
  // La medición del consumo ya no vive aquí. Antes eran dos `useState` que sumaban
  // "tokens usados" y "tokens ahorrados"; el segundo era una constante disfrazada y
  // ambos volvían a cero en cada recarga. Ahora `useAiConversation` reporta latencia,
  // desenlace y tokens al registro de `domain/observability/sessionMetrics.js`, que
  // distingue lo que informa la API de lo que estimamos.
  const { ask, providerName } = useAiConversation({ apiKey, sitemapLinks });

  /**
   * Orientación con la información disponible, para la etapa previa a una PQRSD.
   * Devuelve solo el texto: el flujo decide cómo presentarlo.
   *
   * @param {string} text
   * @returns {Promise<string>}
   */
  const requestGuidance = useCallback(
    async (text) => {
      // El mensaje del ciudadano ya se añadió en este mismo tick, así que `messages`
      // todavía no lo incluye y hay que adjuntarlo al historial a mano.
      const reply = await ask({
        history: toConversationHistory(text),
        userText: text,
        activeContext
      });
      if (reply.contextIntent) setActiveContext(reply.contextIntent);
      return reply.text;
    },
    [ask, toConversationHistory, activeContext]
  );

  // ── Flujos de trámite ─────────────────────────────────────────────────────
  const flowDeps = useMemo(
    () => ({ addMessage, setIsLoading, scheduleFollowUp }),
    [addMessage, scheduleFollowUp]
  );

  const { startPredial, submitPredialForm, selectPredio } = usePredialFlow(flowDeps);
  // Con la respuesta libre desactivada no hay con qué orientar: el botón de radicar
  // vuelve a abrir el formulario directamente.
  const {
    startPqrsdCreate,
    startPqrsdConsult,
    startPqrsdMenu,
    submitPqrsdConsult,
    consumePreGuidance,
    resetPreGuidance
  } = usePqrsdFlow({
    ...flowDeps,
    requestGuidance: isGeminiEnabled ? requestGuidance : null,
    config
  });
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

  /**
   * Vincular el id de conversación a las cabeceras de correlación, para que todas las
   * peticiones de una misma atención se puedan agrupar en Cloud Logging.
   */
  useEffect(() => {
    configureCorrelation({ conversationId: recorder.conversationId });
  }, [recorder.conversationId]);

  // ── Reinicio al cambiar los módulos activos ───────────────────────────────
  const isFirstRender = useRef(true);
  const prevPrefsRef = useRef({ isServicesEnabled, isGeminiEnabled });
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (
      prevPrefsRef.current.isServicesEnabled !== isServicesEnabled ||
      prevPrefsRef.current.isGeminiEnabled !== isGeminiEnabled
    ) {
      prevPrefsRef.current = { isServicesEnabled, isGeminiEnabled };
      setIsTextInputEnabled(true);
      resetPreGuidance();
      reset(isServicesEnabled);
    }
  }, [isServicesEnabled, isGeminiEnabled, resetPreGuidance, reset]);

  /** Muestra el formulario de identidad como una tarjeta dentro del chat. */
  const showIdentityForm = useCallback(
    (introText) => {
      addMessage({
        sender: "bot",
        text: introText,
        customComponent: "identity_form"
      });
    },
    [addMessage]
  );

  /**
   * Intenta resolver el mensaje como un trámite local.
   *
   * En modo `progressive`, un trámite que notifica resultados (Predial, PQRSD) pide
   * antes nombre y correo, y queda en espera para reanudarse en cuanto se entreguen.
   * Así se captura el dato sin poner una barrera a quien solo viene a consultar algo.
   *
   * @param {string} text
   * @returns {boolean} true si se atendió (se lanzó el flujo o se pidió la identidad)
   */
  const tryRouteToFlow = useCallback(
    (text) => {
      const { flow } = resolveIntent(text, {
        routingMap: config.routing,
        pendingService: lastServiceMentioned
      });

      if (!flow) return false;

      if (identityState.flowRequiresIdentity(flow)) {
        identityState.requestIdentityForFlow(flow);
        showIdentityForm(
          `Para continuar con ${getFlowLabel(flowRegistry, flow)} necesito tus datos de contacto, ` +
          "porque el resultado se notifica por correo electrónico:"
        );
        setLastServiceMentioned(null);
        setIsLoading(false);
        return true;
      }

      const { executed } = runFlow(flowRegistry, flow);
      if (executed) {
        setLastServiceMentioned(null);
        setIsLoading(false);
      }
      return executed;
    },
    [flowRegistry, lastServiceMentioned, identityState, showIdentityForm]
  );

  /**
   * ¿El mensaje pertenece al ámbito de la Alcaldía?
   *
   * Se consulta antes de llamar al proveedor de IA: cada llamada arrastra el prompt de
   * sistema, el bloque de FAQ y el contexto de página, de modo que una consulta ajena
   * cuesta lo mismo que una legítima.
   *
   * @param {string} text
   * @returns {boolean} true si se descartó el mensaje (y ya se respondió al ciudadano).
   */
  const rejectIfOffTopic = useCallback(
    (text) => {
      const verdict = evaluateTopic(text, {
        enabled: TOPIC_GUARD.enabled,
        faqCatalog,
        routingMap: config.routing,
        allowKeywords: TOPIC_GUARD.allowKeywords,
        blockKeywords: TOPIC_GUARD.blockKeywords,
        activeContext,
        // `messages` aún no incluye el mensaje recién añadido, así que esto responde a
        // "¿el ciudadano ya había escrito antes?".
        hasPriorExchange: messages.some((m) => m.sender === "user")
      });

      if (verdict.allowed) return false;

      sessionMetrics.record(METRIC_EVENTS.OFF_TOPIC_BLOCKED, { reason: verdict.reason });
      addMessage({
        sender: "bot",
        text: TOPIC_GUARD.message,
        quickReplies: isServicesEnabled ? (config.quickReplies || []).map((r) => r.label) : null
      });
      return true;
    },
    [activeContext, addMessage, isServicesEnabled, messages]
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
        // 1. ¿La orientación previa a una PQRSD está esperando este mensaje?
        if (await consumePreGuidance(userText)) return;

        // 2. ¿Es un trámite?
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

        // 3. Fuera del ámbito municipal: se responde sin gastar una llamada a la IA.
        if (rejectIfOffTopic(userText)) return;

        // 4. Conversación libre con IA.
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
      consumePreGuidance,
      rejectIfOffTopic,
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
      // En modo `gate` la puerta debe bloquear TODO, no solo el teclado. Sin esta
      // comprobación, un botón de respuesta rápida cuyo trámite no exige identidad
      // (por ejemplo Sisbén) permitía saltarse la puerta por completo.
      if (identityState.isInputBlocked) {
        addMessage({ sender: "user", text: option });
        showIdentityForm(
          "Para continuar necesito primero tus datos de contacto:"
        );
        return;
      }

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

      // La orientación previa se consulta antes del enrutamiento: sus botones contienen
      // palabras de trámite ("radicar la PQRSD") que volverían a lanzar el flujo.
      if (await consumePreGuidance(option)) return;

      if (tryRouteToFlow(option)) return;

      // Sin trámite directo: derivar al flujo normal sin duplicar el mensaje.
      await sendMessage(option, true);
    },
    [
      addMessage,
      isServicesEnabled,
      consumePreGuidance,
      tryRouteToFlow,
      sendMessage,
      identityState.isInputBlocked,
      showIdentityForm
    ]
  );

  /**
   * Recibe los datos del formulario de identidad.
   *
   * Devuelve el resultado de la validación en lugar de lanzar, porque quien llama es un
   * formulario que necesita pintar los errores campo por campo.
   *
   * @param {{name: string, email: string}} input
   * @returns {{ ok: boolean, errors?: Object }}
   */
  const submitIdentity = useCallback(
    (input) => {
      const result = identityState.submitIdentity(input);
      if (!result.ok) return result;

      const firstName = result.identity.name.split(/\s+/)[0];

      // Reanudar el trámite que quedó en espera mientras se pedía la identidad.
      if (result.resumedFlow) {
        addMessage({
          sender: "bot",
          text: `¡Gracias, ${firstName}! Ya tengo tus datos.`
        });
        runFlow(flowRegistry, result.resumedFlow);
        return result;
      }

      // Sin trámite en espera: la puerta de identidad era lo primero que vio el
      // ciudadano, así que el saludo llega ahora y ya personalizado.
      addMessages(buildGreetingMessages({ config, isServicesEnabled, firstName }));
      return result;
    },
    [identityState, addMessage, addMessages, flowRegistry, isServicesEnabled]
  );

  /** El ciudadano decide continuar sin identificarse. */
  const skipIdentity = useCallback(() => {
    identityState.skipIdentity();
    addMessages(buildGreetingMessages({ config, isServicesEnabled }));
  }, [identityState, addMessages, isServicesEnabled]);

  // ── Control de apertura ───────────────────────────────────────────────────

  /**
   * Muestra el formulario al abrir el chat en los modos de puerta.
   * Se controla con una referencia para no volver a mostrarlo si el ciudadano cierra
   * y reabre el widget dentro de la misma conversación.
   */
  const gateShownRef = useRef(false);

  const openChat = useCallback(() => {
    setIsOpen(true);
    if (identityState.isGateVisible && !gateShownRef.current) {
      gateShownRef.current = true;
      showIdentityForm(identityState.settings.subtitle || "Antes de empezar, cuéntame quién eres:");
    }
  }, [identityState.isGateVisible, identityState.settings.subtitle, showIdentityForm]);

  const closeChat = useCallback(() => setIsOpen(false), []);
  const toggleChat = useCallback(() => {
    if (!isOpen) {
      openChat();
    } else {
      setIsOpen(false);
    }
  }, [isOpen, openChat]);

  const resetChat = useCallback(() => {
    setIsTextInputEnabled(true);
    setActiveContext(null);
    setLastServiceMentioned(null);
    clearFollowUpTimer();
    resetPreGuidance();
    identityState.reset();
    // Un reinicio abre una conversación nueva en el registro, en lugar de mezclar los
    // mensajes con los de la atención anterior.
    recorder.startNewConversation();
    // Las métricas acompañan a la conversación: si el registro empieza de nuevo, los
    // contadores del panel también, o estarían describiendo una atención que ya cerró.
    sessionMetrics.reset();
    gateShownRef.current = false;
    reset(isServicesEnabled);
  }, [clearFollowUpTimer, resetPreGuidance, reset, isServicesEnabled, identityState, recorder]);

  /**
   * Valor del contexto. Se memoiza para no re-renderizar a todos los consumidores en
   * cada render del proveedor.
   */
  const value = useMemo(
    () => ({
      // Estado
      isOpen,
      messages,
      // En modo `gate` el teclado permanece bloqueado hasta que se entregan los datos.
      isTextInputEnabled: isTextInputEnabled && !identityState.isInputBlocked,
      isLoading,
      apiKey,
      theme,

      /**
       * Proveedor que está atendiendo (`gemini-api` o `local-mock`). El panel lo muestra
       * porque es la diferencia entre "responde la IA" y "responde el catálogo local", y
       * antes no había forma de saberlo desde la interfaz.
       */
      providerName,

      // Identidad del ciudadano
      identity: identityState.identity,
      identityMode: identityState.mode,
      identitySettings: identityState.settings,
      isIdentitySkippable: identityState.isSkippable,
      identityPrefill: identityState.prefill,
      /**
       * Solo si existe la autorización, no el registro completo. El panel necesita saber
       * que se otorgó; el texto y la marca de tiempo del consentimiento no tienen por qué
       * circular por más componentes de los necesarios.
       */
      hasConsent: Boolean(identityState.consent),
      submitIdentity,
      skipIdentity,

      // Registro de la conversación
      conversationId: recorder.conversationId,
      isRecordingEnabled: recorder.isEnabled,
      recorderName: recorder.repositoryName,
      pendingRecords: recorder.pendingRecords,

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
      identityState,
      submitIdentity,
      skipIdentity,
      recorder,
      isLoading,
      apiKey,
      providerName,
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
