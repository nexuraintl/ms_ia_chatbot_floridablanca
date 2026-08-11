/**
 * Flujo de Impuesto Predial: formulario, stream de eventos y selección de predio.
 *
 * Extraído de `ChatContext.jsx` (~150 líneas repartidas en tres funciones).
 *
 * Arreglos incorporados:
 *
 *   · DATOS DE CONTACTO INVENTADOS. `handleSelectPredio` hacía
 *     `phone: contextData.phone || "3000000000"` y
 *     `email: contextData.email || "correo@ejemplo.com"`. Es decir, si el contexto se
 *     perdía, se enviaban datos falsos a un sistema de notificación oficial: el
 *     ciudadano nunca recibiría su factura y la Alcaldía guardaría un registro con
 *     contacto inválido. Ahora, sin datos reales, el flujo se detiene y se explica.
 *
 *   · STREAMS SSE SIN CERRAR. El valor de retorno de `listenJobStream` —la función de
 *     limpieza— se descartaba. Si el ciudadano cerraba el chat o iniciaba otra
 *     consulta, la conexión anterior seguía abierta. Ahora se guarda y se cierra.
 *
 *   · MENSAJES DE ERROR DUPLICADOS. Las mismas cuatro traducciones estaban copiadas en
 *     dos funciones con textos distintos. Ahora vienen de
 *     `domain/errors/rpaErrorTranslator.js`.
 */

import { useCallback, useEffect, useRef } from "react";
import {
  generarFacturaAsync,
  listenJobStream,
  seleccionarPredio,
  formatPesos,
  getFacturaPdfUrl
} from "../services/rpaPredialService.js";
import { translateRpaError, translatePredialSearchError } from "../domain/errors/rpaErrorTranslator.js";
import { sessionMetrics, METRIC_EVENTS } from "../domain/observability/sessionMetrics.js";

/** Identificador del trámite en el panel de monitoreo. Coincide con el del registro de flujos. */
const FLOW = { flowId: "predial", label: "Impuesto Predial" };

/** Mensajes de progreso por evento del stream. */
const PROGRESS_MESSAGES = Object.freeze({
  started: "🔍 Consultando la información de tu predio...",
  portal_ready: "📑 Verificando registros...",
  invoice_ready: "📊 Calculando impuestos y vigencias..."
});

/**
 * @param {Object} deps
 * @param {(msg: Object) => string} deps.addMessage
 * @param {(loading: boolean) => void} deps.setIsLoading
 * @param {(delay?: number) => void} deps.scheduleFollowUp
 */
export const usePredialFlow = ({ addMessage, setIsLoading, scheduleFollowUp }) => {
  /** Función de cierre del stream SSE activo. */
  const closeStreamRef = useRef(null);

  const closeActiveStream = useCallback(() => {
    if (closeStreamRef.current) {
      closeStreamRef.current();
      closeStreamRef.current = null;
    }
  }, []);

  // Cerrar el stream al desmontar el widget.
  useEffect(() => closeActiveStream, [closeActiveStream]);

  /** Muestra el formulario de consulta. */
  const startPredial = useCallback(() => {
    addMessage({
      sender: "bot",
      text: "Diligencia los siguientes datos para consultar y generar la factura del Impuesto Predial en Floridablanca:",
      customComponent: "predial_form"
    });
  }, [addMessage]);

  /**
   * Traduce un evento del stream a mensajes del chat.
   *
   * @param {Object} evt
   * @param {{phone?: string, email?: string}} contextData
   */
  const handleStreamEvent = useCallback(
    (evt, contextData = {}) => {
      const { event, outcome, amount, filename, payment_url, payment_qr, message, session_id, predios } = evt;

      if (PROGRESS_MESSAGES[event]) {
        addMessage({ sender: "bot", text: PROGRESS_MESSAGES[event] });
        return;
      }

      if (event === "search_done") {
        if (outcome === "predio_unico") {
          addMessage({ sender: "bot", text: "✅ Predio ubicado. Solicitando estado de cuenta..." });
        } else if (outcome === "multiples_predios") {
          addMessage({
            sender: "bot",
            text:
              `🏢 Se encontraron ${(predios || evt.result?.predios || []).length} predios registrados ` +
              "para esta consulta. Selecciona tu inmueble a continuación:",
            customComponent: "predial_multiples",
            sessionId: session_id || evt.result?.session_id,
            predios: predios || evt.result?.predios || [],
            // El contexto se propaga para no tener que inventar datos de contacto
            // en el paso de selección.
            predialContext: contextData
          });
        } else if (outcome === "no_encontrado") {
          addMessage({
            sender: "bot",
            text: "⚠️ No encontré ese predio en Floridablanca. Verifica el dato ingresado e intenta de nuevo."
          });
          setIsLoading(false);
          sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, {
            ...FLOW,
            reason: "El RPA no encontró el predio consultado"
          });
        }
        return;
      }

      if (event === "pdf_ready") {
        // La factura entregada es el resultado del trámite: aquí sí terminó.
        sessionMetrics.record(METRIC_EVENTS.FLOW_COMPLETED, FLOW);
        addMessage({
          sender: "bot",
          text:
            `📄 ¡Listo! Tu factura fue generada exitosamente por un total de ` +
            `${amount ? formatPesos(amount) : "monto liquidado"}. Te la adjunto a continuación:`,
          attachment: {
            type: "file",
            fileUrl: getFacturaPdfUrl(filename),
            fileLabel: `📥 Descargar Factura PDF (${filename || "Factura.pdf"})`
          }
        });
        return;
      }

      if (event === "payment_ready") {
        if (payment_url) {
          addMessage({
            sender: "bot",
            text: "Y acá tienes el enlace oficial para pagar en línea mediante PSE:",
            buttonUrl: payment_url,
            buttonText: "💳 Ir a Pagar en Línea (PSE)"
          });
        }
        if (payment_qr) {
          addMessage({
            sender: "bot",
            text: "También puedes escanear este código QR directamente para realizar tu pago:",
            attachment: { type: "image", src: payment_qr, label: "Código QR para Pago PSE" }
          });
        }
        return;
      }

      if (event === "done") {
        closeActiveStream();
        setIsLoading(false);
        scheduleFollowUp();
        return;
      }

      if (event === "error") {
        closeActiveStream();
        setIsLoading(false);
        const reason = translateRpaError(message);
        addMessage({ sender: "bot", text: `⚠️ ${reason}` });
        sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, { ...FLOW, reason });
        scheduleFollowUp();
      }
    },
    [addMessage, setIsLoading, scheduleFollowUp, closeActiveStream]
  );

  /**
   * Envía el formulario y engancha el stream de progreso.
   *
   * @param {Object} formData
   */
  const submitPredialForm = useCallback(
    async ({ searchType, searchValue, phone, email, cliente = "floridablanca" }) => {
      // No se registra `searchValue` en el mensaje del usuario porque suele ser una
      // cédula, y ese texto acaba en la terminal de logs de la consola.
      addMessage({ sender: "user", text: `Consulta de Impuesto Predial (${searchType})` });
      setIsLoading(true);
      closeActiveStream();

      addMessage({ sender: "bot", text: PROGRESS_MESSAGES.started });

      try {
        const resp = await generarFacturaAsync({ searchType, searchValue, phone, email, cliente });

        if (!resp?.job_id) {
          setIsLoading(false);
          addMessage({
            sender: "bot",
            text: "⚠️ El servicio no devolvió un identificador de trámite. Intenta de nuevo en unos minutos."
          });
          sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, {
            ...FLOW,
            reason: "El RPA no devolvió job_id"
          });
          return;
        }

        closeStreamRef.current = listenJobStream(
          resp.job_id,
          (evt) => handleStreamEvent(evt, { phone, email }),
          () => {
            setIsLoading(false);
            addMessage({
              sender: "bot",
              text: "⚠️ Se perdió la conexión con el trámite. Por favor intenta de nuevo."
            });
            sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, {
              ...FLOW,
              reason: "Se perdió la conexión con el stream del RPA"
            });
          }
        );
      } catch (error) {
        setIsLoading(false);
        const reason = translatePredialSearchError(error, { searchType });
        addMessage({ sender: "bot", text: `⚠️ ${reason}` });
        sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, { ...FLOW, reason });
        scheduleFollowUp();
      }
    },
    [addMessage, setIsLoading, scheduleFollowUp, handleStreamEvent, closeActiveStream]
  );

  /**
   * Selecciona un predio de la lista de resultados múltiples.
   *
   * @param {number} index
   * @param {string} sessionId
   * @param {{phone?: string, email?: string}} contextData
   */
  const selectPredio = useCallback(
    async (index, sessionId, contextData = {}) => {
      const { phone, email } = contextData;

      // Antes se enviaba "3000000000" / "correo@ejemplo.com" cuando faltaban.
      // Enviar contacto falso a un sistema de notificación oficial es peor que fallar.
      if (!phone || !email) {
        addMessage({
          sender: "bot",
          text:
            "⚠️ Perdí tus datos de contacto durante el trámite. Por seguridad no puedo continuar " +
            "con datos incompletos, porque la factura se notifica a ese correo y celular. " +
            "Por favor inicia la consulta de nuevo."
        });
        setIsLoading(false);
        sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, {
          ...FLOW,
          reason: "Se perdieron los datos de contacto antes de seleccionar el predio"
        });
        return;
      }

      setIsLoading(true);
      closeActiveStream();

      addMessage({
        sender: "bot",
        text: `📊 Calculando impuestos y vigencias para el predio #${index + 1}...`
      });

      try {
        const resp = await seleccionarPredio({ sessionId, index, phone, email, mode: "async" });

        if (!resp?.job_id) {
          setIsLoading(false);
          addMessage({
            sender: "bot",
            text: "⚠️ El servicio no devolvió un identificador de trámite. Intenta de nuevo."
          });
          sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, {
            ...FLOW,
            reason: "El RPA no devolvió job_id al seleccionar el predio"
          });
          return;
        }

        closeStreamRef.current = listenJobStream(
          resp.job_id,
          (evt) => handleStreamEvent(evt, contextData),
          () => {
            setIsLoading(false);
            addMessage({
              sender: "bot",
              text: "⚠️ Se perdió la conexión con el trámite. Por favor intenta de nuevo."
            });
            sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, {
              ...FLOW,
              reason: "Se perdió la conexión con el stream del RPA"
            });
          }
        );
      } catch (error) {
        setIsLoading(false);
        const reason = translateRpaError(error);
        addMessage({ sender: "bot", text: `⚠️ ${reason}` });
        sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, { ...FLOW, reason });
        scheduleFollowUp();
      }
    },
    [addMessage, setIsLoading, scheduleFollowUp, handleStreamEvent, closeActiveStream]
  );

  return { startPredial, submitPredialForm, selectPredio };
};
