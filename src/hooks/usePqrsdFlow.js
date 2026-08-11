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
      text: "¿Qué trámite de PQRSD deseas realizar en la Alcaldía de Floridablanca?",
      quickReplies: ["📑 Radicar PQRSD", "🔍 Consultar PQRSD"]
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
        } else {
          addMessage({
            sender: "bot",
            text:
              `⚠️ ${res?.message ||
                "No se encontró ningún radicado con los datos ingresados. Verifica el número de radicado y el código de seguridad."}`
          });
        }
      } catch (error) {
        // `consultarPqrsd` ya devuelve mensajes aptos para el ciudadano; el traductor
        // actúa como red de seguridad para cualquier error inesperado.
        addMessage({
          sender: "bot",
          text: `⚠️ ${error?.message || translateRpaError(error)}`
        });
      } finally {
        setIsLoading(false);
        scheduleFollowUp();
      }
    },
    [addMessage, setIsLoading, scheduleFollowUp]
  );

  return { startPqrsdCreate, startPqrsdConsult, startPqrsdMenu, submitPqrsdConsult };
};
