/**
 * Flujo de Impuesto Predial: formulario, stream de eventos y selección de predio.
 *
 * El trámite se lanza en modo asíncrono y el progreso se sigue por la ruta `stream` que
 * devuelve el servicio. No se sostiene la petición del ciudadano esperando el trámite: tarda
 * 25-45s y Cloud Run corta a los 300s.
 *
 * Tres desenlaces, no dos: factura lista, no se encontró nada, o varios predios —que exige
 * mostrar la lista y llamar a `seleccionar_predio`. `multiple_predios` no es un error.
 *
 * El monto no se menciona antes del evento `pdf_ready`: antes de eso el portal muestra `$0`
 * transitorio, y leerlo antes significa decirle al ciudadano que no debe nada cuando debe
 * millones.
 */

import { useCallback, useEffect, useRef } from "react";
import {
  generarFacturaAsync,
  getJobStatus,
  listenJobStream,
  seleccionarPredio,
  formatPesos,
  getFacturaPdfUrl,
  RpaBusyError
} from "../services/rpaPredialService.js";
import {
  classifyRetry,
  translateRpaError,
  translatePredialSearchError
} from "../domain/errors/rpaErrorTranslator.js";
import { sessionMetrics, METRIC_EVENTS } from "../domain/observability/sessionMetrics.js";

/** Identificador del trámite en el panel de monitoreo. Coincide con el del registro de flujos. */
const FLOW = { flowId: "predial", label: "Impuesto Predial" };

/**
 * Mensajes de progreso por evento del stream.
 *
 * `started` no está: ese mensaje ya se muestra al enviar el formulario, antes de que el
 * servicio responda, para que el ciudadano no espere sin señal. Ponerlo aquí también lo
 * repetía.
 */
const PROGRESS_MESSAGES = Object.freeze({
  portal_ready: "📑 Verificando registros...",
  invoice_ready: "📊 Calculando impuestos y vigencias..."
});

/** Primer mensaje, en cuanto se envía el formulario. */
const SEARCH_STARTED_MESSAGE = "🔍 Consultando la información de tu predio...";

/** Cadencia y tope del seguimiento por consulta, cuando el stream se corta antes de terminar. */
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 20;

/**
 * @param {Object} deps
 * @param {(msg: Object) => string} deps.addMessage
 * @param {(loading: boolean) => void} deps.setIsLoading
 * @param {(delay?: number) => void} deps.scheduleFollowUp
 */
export const usePredialFlow = ({ addMessage, setIsLoading, scheduleFollowUp }) => {
  /** Función de cierre del stream SSE activo. */
  const closeStreamRef = useRef(null);

  /** Temporizadores del seguimiento por consulta y del reintento, para poder cancelarlos. */
  const timersRef = useRef([]);

  /**
   * ¿Se consumió ya el único reintento de este trámite? Se reinicia al empezar uno nuevo.
   * Cada intento abre un navegador y gasta un captcha pagado, así que nunca hay un segundo.
   */
  const retryUsedRef = useRef(false);

  /**
   * Eventos ya presentados, por `ts` + tipo.
   *
   * El servicio reenvía todo el historial: al reconectar el stream y también al consultar el
   * trámite, que devuelve la lista completa de eventos. Sin esto, un stream que se corta a
   * mitad repite en el chat todos los mensajes de progreso ya mostrados.
   */
  const seenEventsRef = useRef(new Set());

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
  }, []);

  const closeActiveStream = useCallback(() => {
    if (closeStreamRef.current) {
      closeStreamRef.current();
      closeStreamRef.current = null;
    }
    clearTimers();
  }, [clearTimers]);

  // Cerrar el stream y los temporizadores al desmontar el widget.
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
   * Cierra el trámite con un fallo: mensaje al ciudadano y métrica.
   * @param {string} reason
   */
  const failFlow = useCallback(
    (reason) => {
      closeActiveStream();
      setIsLoading(false);
      addMessage({ sender: "bot", text: `⚠️ ${reason}` });
      sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, { ...FLOW, reason });
      scheduleFollowUp();
    },
    [addMessage, setIsLoading, scheduleFollowUp, closeActiveStream]
  );

  /**
   * Traduce un evento del stream a mensajes del chat.
   *
   * @param {Object} evt
   * @param {{phone?: string, email?: string}} contextData
   * @param {{onRetryableError?: (message: string) => boolean, pollPath?: string}} [handlers]
   */
  const handleStreamEvent = useCallback(
    (evt, contextData = {}, handlers = {}) => {
      const { event, outcome, amount, filename, payment_url, payment_qr, message, session_id, predios } = evt;

      const eventKey = `${evt.ts || 0}_${event}`;
      if (seenEventsRef.current.has(eventKey)) return;
      seenEventsRef.current.add(eventKey);

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
        // La factura entregada es el resultado del trámite: aquí sí terminó, y solo aquí el
        // monto es de fiar.
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
        // `payment_url` y `payment_qr` son independientes: puede llegar uno sin el otro.
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

      if (event === "stream_timeout") {
        // El stream se cierra a los 300s, pero el trámite sigue vivo: se pasa a consultar.
        if (handlers.pollPath) {
          addMessage({
            sender: "bot",
            text: "⏳ El trámite está tardando más de lo habitual. Sigo pendiente, no cierres el chat."
          });
          handlers.onStreamTimeout?.();
        } else {
          failFlow(
            "El trámite está tardando más de lo normal y perdí el seguimiento. " +
              "Consulta de nuevo en unos minutos."
          );
        }
        return;
      }

      if (event === "done") {
        // `done` es el ciclo de vida del JOB, no el desenlace del TRÁMITE: un fallo también
        // cierra en `done`. El desenlace está en `result.status`.
        const outcomeStatus = String(evt.result?.status || "").toLowerCase();
        if (outcomeStatus === "error") {
          const reason = translateRpaError(evt.result?.message || message);
          if (handlers.onRetryableError?.(evt.result?.message || message)) return;
          failFlow(reason);
          return;
        }
        closeActiveStream();
        setIsLoading(false);
        scheduleFollowUp();
        return;
      }

      if (event === "error") {
        if (handlers.onRetryableError?.(message)) return;
        failFlow(translateRpaError(message));
      }
    },
    [addMessage, setIsLoading, scheduleFollowUp, closeActiveStream, failFlow]
  );

  /**
   * Sigue un trámite por consulta cuando el stream ya no está disponible.
   *
   * @param {string} pollPath
   * @param {{phone?: string, email?: string}} contextData
   */
  const followByPolling = useCallback(
    (pollPath, contextData) => {
      let attempts = 0;

      const tick = async () => {
        attempts += 1;
        try {
          const job = await getJobStatus(pollPath);
          const status = String(job?.status || "").toLowerCase();

          if (status === "done" || status === "error") {
            // Se reproducen los eventos del job para no duplicar la lógica de presentación.
            for (const evt of job?.events || []) {
              handleStreamEvent(evt, contextData);
            }
            const outcomeStatus = String(job?.result?.status || "").toLowerCase();
            if (outcomeStatus === "error") {
              failFlow(translateRpaError(job?.result?.message));
              return;
            }
            closeActiveStream();
            setIsLoading(false);
            scheduleFollowUp();
            return;
          }

          if (attempts >= POLL_MAX_ATTEMPTS) {
            failFlow(
              "El trámite sigue en curso pero dejé de esperar. Vuelve a consultar en unos minutos: " +
                "si la factura se generó, el portal ya la tiene."
            );
            return;
          }
          timersRef.current.push(setTimeout(tick, POLL_INTERVAL_MS));
        } catch (error) {
          failFlow(translateRpaError(error));
        }
      };

      timersRef.current.push(setTimeout(tick, POLL_INTERVAL_MS));
    },
    [handleStreamEvent, failFlow, closeActiveStream, setIsLoading, scheduleFollowUp]
  );

  /**
   * Engancha el seguimiento de un trámite ya aceptado.
   *
   * @param {{job_id?: string, poll?: string, stream?: string}} resp
   * @param {{phone?: string, email?: string}} contextData
   * @param {() => void} [onRetry] Relanza el trámite; solo se invoca una vez.
   * @returns {boolean} `false` si la respuesta no permitía seguir el trámite.
   */
  const trackTramite = useCallback(
    (resp, contextData, onRetry) => {
      if (!resp?.stream || !resp?.poll) {
        setIsLoading(false);
        addMessage({
          sender: "bot",
          text: "⚠️ El servicio no devolvió la ruta de seguimiento del trámite. Intenta de nuevo en unos minutos."
        });
        sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, {
          ...FLOW,
          reason: "El RPA no devolvió las rutas de seguimiento"
        });
        return false;
      }

      /**
       * Consume el único reintento disponible, si el fallo lo admite.
       * @param {string} message
       * @returns {boolean} `true` si se va a reintentar y no hay que informar del fallo.
       */
      const onRetryableError = (message) => {
        const { retryable, delayMs } = classifyRetry(message);
        if (!retryable || retryUsedRef.current || !onRetry) return false;

        retryUsedRef.current = true;
        closeActiveStream();
        addMessage({
          sender: "bot",
          text: "🔄 El portal de la Alcaldía falló a mitad del proceso. Lo intento una vez más..."
        });
        timersRef.current.push(setTimeout(onRetry, delayMs));
        return true;
      };

      closeStreamRef.current = listenJobStream(
        resp.stream,
        (evt) =>
          handleStreamEvent(evt, contextData, {
            onRetryableError,
            pollPath: resp.poll,
            onStreamTimeout: () => followByPolling(resp.poll, contextData)
          }),
        () => {
          // Se perdió el canal, pero el trámite sigue vivo del lado del servicio.
          closeStreamRef.current = null;
          addMessage({
            sender: "bot",
            text: "⚠️ Se interrumpió la conexión en vivo. Sigo consultando el estado del trámite..."
          });
          followByPolling(resp.poll, contextData);
        }
      );
      return true;
    },
    [addMessage, setIsLoading, handleStreamEvent, followByPolling, closeActiveStream]
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
      retryUsedRef.current = false;
      seenEventsRef.current = new Set();

      addMessage({ sender: "bot", text: SEARCH_STARTED_MESSAGE });

      const launch = async () => {
        try {
          const resp = await generarFacturaAsync({ searchType, searchValue, phone, email, cliente });
          trackTramite(resp, { phone, email }, launch);
        } catch (error) {
          if (error instanceof RpaBusyError) {
            setIsLoading(false);
            addMessage({
              sender: "bot",
              text:
                "⏳ En este momento el servicio está atendiendo otros trámites. " +
                `Vuelve a intentarlo en aproximadamente ${Math.ceil(error.retryAfterSeconds / 60)} minuto(s).`
            });
            sessionMetrics.record(METRIC_EVENTS.FLOW_FAILED, {
              ...FLOW,
              reason: "El servicio de factura estaba en su tope de trámites simultáneos"
            });
            scheduleFollowUp();
            return;
          }
          failFlow(translatePredialSearchError(error, { searchType }));
        }
      };

      await launch();
    },
    [addMessage, setIsLoading, scheduleFollowUp, closeActiveStream, trackTramite, failFlow]
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

      // Enviar contacto falso a un sistema de notificación oficial es peor que fallar: la
      // factura se notifica a ese correo y ese celular.
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
      retryUsedRef.current = false;
      seenEventsRef.current = new Set();

      addMessage({
        sender: "bot",
        text: `📊 Calculando impuestos y vigencias para el predio #${index + 1}...`
      });

      // La sesión es de un solo uso: se consume al llamar con un índice válido, así que este
      // paso no admite reintento aunque el fallo esté marcado como reintentable.
      try {
        const resp = await seleccionarPredio({ sessionId, index, phone, email, mode: "async" });
        trackTramite(resp, contextData);
      } catch (error) {
        if (error instanceof RpaBusyError) {
          setIsLoading(false);
          addMessage({
            sender: "bot",
            text:
              "⏳ En este momento el servicio está atendiendo otros trámites. " +
              "Vuelve a seleccionar tu predio en un par de minutos."
          });
          scheduleFollowUp();
          return;
        }
        failFlow(translateRpaError(error));
      }
    },
    [addMessage, setIsLoading, scheduleFollowUp, closeActiveStream, trackTramite, failFlow]
  );

  return { startPredial, submitPredialForm, selectPredio };
};
