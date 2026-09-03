/**
 * Flujo de PQRSD: menú, radicación y consulta de trazabilidad.
 *
 * Extraído de `ChatContext.jsx`.
 *
 * Nota de privacidad: el par (radicado, código de autenticación) es la credencial que
 * abre el expediente completo del ciudadano —nombre, correo, asunto, anexos y
 * respuestas oficiales—. Por eso el código de autenticación nunca se escribe en un
 * mensaje del chat: los mensajes se replican en la terminal de la consola y en la
 * telemetría. Solo se menciona el radicado, que además queda enmascarado por
 * `piiRedactor` en cualquier salida de log.
 */

import { useCallback } from "react";
import { consultarPqrsd } from "../services/pqrsdService.js";
import { translateRpaError } from "../domain/errors/rpaErrorTranslator.js";
import { sessionMetrics, METRIC_EVENTS } from "../domain/observability/sessionMetrics.js";

/** Identificador del trámite en el panel. Coincide con el del registro de flujos. */
const FLOW_CONSULT = { flowId: "pqrsd_consultar", label: "Consulta de PQRSD" };

/**
 * @param {Object} deps
 * @param {(msg: Object) => string} deps.addMessage
 * @param {(loading: boolean) => void} deps.setIsLoading
 * @param {(delay?: number) => void} deps.scheduleFollowUp
 */
export const usePqrsdFlow = ({ addMessage, setIsLoading, scheduleFollowUp }) => {
  /** Muestra el formulario de radicación. */
  const startPqrsdCreate = useCallback(() => {
    addMessage({
      sender: "bot",
      text: "Diligencia el siguiente formulario para radicar tu PQRSD en la Alcaldía de Floridablanca:",
      customComponent: "pqrsd_crear"
    });
  }, [addMessage]);

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
      // La radicación se retiró del menú: por ahora solo se ofrece la consulta.
      text:
        "Puedo consultar el estado de una PQRSD ya radicada en la Alcaldía de Floridablanca. " +
        "Para radicar una nueva, hazlo por el canal oficial de correspondencia virtual del municipio.",
      quickReplies: ["🔍 Consultar PQRSD"]
    });
  }, [addMessage]);

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

  return { startPqrsdCreate, startPqrsdConsult, startPqrsdMenu, submitPqrsdConsult };
};
