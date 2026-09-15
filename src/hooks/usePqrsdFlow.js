/**
 * Flujo de PQRSD: orientacion previa, menu, radicacion y consulta de trazabilidad.
 *
 * Privacidad: el par (radicado, codigo de autenticacion) abre el expediente completo del
 * ciudadano, asi que el codigo nunca se escribe en un mensaje del chat; los mensajes se
 * replican en la consola y en la telemetria.
 */

import { useCallback, useMemo, useRef } from "react";
import { consultarPqrsd } from "../services/pqrsdService.js";
import { translateRpaError } from "../domain/errors/rpaErrorTranslator.js";
import { sessionMetrics, METRIC_EVENTS } from "../domain/observability/sessionMetrics.js";
import {
  PRE_GUIDANCE_STAGES,
  PRE_GUIDANCE_DECISIONS,
  classifyDecision,
  resolvePreGuidanceSettings
} from "../domain/pqrsd/preGuidance.js";

/** Identificadores de los tramites en el panel. Coinciden con el registro de flujos. */
const FLOW_CONSULT = { flowId: "pqrsd_consultar", label: "Consulta de PQRSD" };
const FLOW_CREATE = { flowId: "pqrsd_crear", label: "Radicación de PQRSD" };

/**
 * @param {Object} deps
 * @param {(msg: Object) => string} deps.addMessage
 * @param {(loading: boolean) => void} deps.setIsLoading
 * @param {(delay?: number) => void} deps.scheduleFollowUp
 * @param {(text: string) => Promise<string>} [deps.requestGuidance] Orientacion con la
 *        informacion disponible (FAQ e IA). La inyecta `ChatContext`.
 * @param {Object} [deps.config] `chatbotConfig.json`
 */
export const usePqrsdFlow = ({
  addMessage,
  setIsLoading,
  scheduleFollowUp,
  requestGuidance,
  config
}) => {
  const settings = useMemo(() => resolvePreGuidanceSettings(config), [config]);

  // Etapa y rondas viven en referencias: `sendMessage` las consulta en el mismo tick en
  // que llega el mensaje, donde un valor de estado todavia seria el anterior.
  const stageRef = useRef(PRE_GUIDANCE_STAGES.IDLE);
  const roundsRef = useRef(0);

  /** Abre el formulario de radicacion, sin volver a pasar por la orientacion. */
  const showPqrsdForm = useCallback(() => {
    stageRef.current = PRE_GUIDANCE_STAGES.IDLE;
    roundsRef.current = 0;
    addMessage({
      sender: "bot",
      text: "Diligencia el siguiente formulario para radicar tu PQRSD en la Alcaldía de Floridablanca:",
      customComponent: "pqrsd_crear"
    });
  }, [addMessage]);

  /**
   * Entrada del tramite de radicacion. Con la orientacion previa activa, primero pregunta.
   */
  const startPqrsdCreate = useCallback(() => {
    const canGuide = settings.enabled && typeof requestGuidance === "function";
    if (canGuide && stageRef.current === PRE_GUIDANCE_STAGES.IDLE) {
      stageRef.current = PRE_GUIDANCE_STAGES.AWAITING_QUERY;
      roundsRef.current = 0;
      addMessage({ sender: "bot", text: settings.question });
      return;
    }
    showPqrsdForm();
  }, [addMessage, requestGuidance, settings, showPqrsdForm]);

  /** Muestra el formulario de consulta. */
  const startPqrsdConsult = useCallback(() => {
    addMessage({
      sender: "bot",
      text: "Digita tu número de radicado y tu código de seguridad suministrado al radicar la PQRSD.",
      customComponent: "pqrsd_consult"
    });
  }, [addMessage]);

  /** Menú de opciones cuando la intención es genérica ("pqrsd"). */
  const startPqrsdMenu = useCallback(() => {
    addMessage({
      sender: "bot",
      text: "¿Qué trámite de PQRSD deseas realizar en la Alcaldía de Floridablanca?",
      quickReplies: ["📑 Radicar PQRSD", "🔍 Consultar PQRSD"]
    });
  }, [addMessage]);

  /** Responde la inquietud y pregunta si con eso basta. */
  const deliverGuidance = useCallback(
    async (text) => {
      setIsLoading(true);
      try {
        const guidance = await requestGuidance(text);
        roundsRef.current += 1;
        stageRef.current = PRE_GUIDANCE_STAGES.AWAITING_DECISION;

        if (guidance) addMessage({ sender: "bot", text: guidance });
        addMessage({
          sender: "bot",
          text: settings.decisionQuestion,
          quickReplies: [settings.resolvedLabel, settings.unresolvedLabel]
        });
      } catch (error) {
        // Sin orientación no se deja al ciudadano sin salida: se abre la radicación.
        console.error("❌ [PQRSD] No se pudo orientar antes de radicar:", error?.message);
        addMessage({ sender: "bot", text: settings.errorReply });
        showPqrsdForm();
      } finally {
        setIsLoading(false);
        scheduleFollowUp();
      }
    },
    [addMessage, requestGuidance, scheduleFollowUp, setIsLoading, settings, showPqrsdForm]
  );

  /**
   * Atiende el mensaje si la orientación previa lo está esperando.
   *
   * @param {string} text Mensaje del ciudadano, ya añadido a la conversación.
   * @returns {Promise<boolean>} true si el mensaje se consumió aquí.
   */
  const consumePreGuidance = useCallback(
    async (text) => {
      const stage = stageRef.current;
      if (stage === PRE_GUIDANCE_STAGES.IDLE) return false;

      if (stage === PRE_GUIDANCE_STAGES.AWAITING_QUERY) {
        await deliverGuidance(text);
        return true;
      }

      const decision = classifyDecision(text, settings);

      if (decision === PRE_GUIDANCE_DECISIONS.RESOLVED) {
        stageRef.current = PRE_GUIDANCE_STAGES.IDLE;
        roundsRef.current = 0;
        addMessage({ sender: "bot", text: settings.resolvedReply });
        sessionMetrics.record(METRIC_EVENTS.FLOW_AVOIDED, FLOW_CREATE);
        setIsLoading(false);
        scheduleFollowUp();
        return true;
      }

      if (decision === PRE_GUIDANCE_DECISIONS.UNRESOLVED) {
        addMessage({ sender: "bot", text: settings.bridgeReply });
        showPqrsdForm();
        setIsLoading(false);
        return true;
      }

      // Respuesta ambigua: otra ronda de orientación, con tope para no encadenar llamadas.
      if (roundsRef.current >= settings.maxGuidanceRounds) {
        addMessage({ sender: "bot", text: settings.exhaustedReply });
        showPqrsdForm();
        setIsLoading(false);
        return true;
      }

      await deliverGuidance(text);
      return true;
    },
    [addMessage, deliverGuidance, scheduleFollowUp, setIsLoading, settings, showPqrsdForm]
  );

  /** Devuelve la orientación previa a su estado inicial. */
  const resetPreGuidance = useCallback(() => {
    stageRef.current = PRE_GUIDANCE_STAGES.IDLE;
    roundsRef.current = 0;
  }, []);

  /**
   * Consulta un radicado y muestra su trazabilidad.
   *
   * @param {{radicado: string, codigoAutenticacion: string}} params
   */
  const submitPqrsdConsult = useCallback(
    async ({ radicado, codigoAutenticacion }) => {
      // Se menciona el radicado, nunca el código de autenticación.
      addMessage({ sender: "user", text: `🔍 Consulta PQRSD (Radicado: ${radicado})` });
      setIsLoading(true);
      addMessage({ sender: "bot", text: `🔍 Buscando la información del radicado #${radicado}...` });

      try {
        const res = await consultarPqrsd(radicado, codigoAutenticacion);

        if (res?.found) {
          addMessage({
            sender: "bot",
            text: `📑 Aquí tienes los detalles y la trazabilidad de tu PQRSD (Radicado #${radicado}):`,
            customComponent: "pqrsd_result",
            pqrsdData: res
          });
          sessionMetrics.record(METRIC_EVENTS.FLOW_COMPLETED, FLOW_CONSULT);
        } else {
          addMessage({
            sender: "bot",
            text:
              `⚠️ ${res?.message ||
                "No se encontró ningún radicado con los datos ingresados. Verifica el número de radicado y el código de seguridad."}`
          });
          // El motivo NO incluye el radicado ni el código: el panel muestra este texto y
          // ese par es la credencial que abre el expediente completo del ciudadano.
          sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, {
            ...FLOW_CONSULT,
            reason: "El radicado consultado no existe o el código no corresponde"
          });
        }
      } catch (error) {
        // `consultarPqrsd` ya devuelve mensajes aptos para el ciudadano; el traductor
        // actúa como red de seguridad para cualquier error inesperado.
        const reason = error?.message || translateRpaError(error);
        addMessage({ sender: "bot", text: `⚠️ ${reason}` });
        sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, { ...FLOW_CONSULT, reason });
      } finally {
        setIsLoading(false);
        scheduleFollowUp();
      }
    },
    [addMessage, setIsLoading, scheduleFollowUp]
  );

  return {
    startPqrsdCreate,
    startPqrsdConsult,
    startPqrsdMenu,
    submitPqrsdConsult,
    consumePreGuidance,
    resetPreGuidance
  };
};
