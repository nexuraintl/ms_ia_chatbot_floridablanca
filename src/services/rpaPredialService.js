/**
 * Adaptador del microservicio RPA de Impuesto Predial (Alcaldía de Floridablanca).
 *
 * Refactor: la lógica repetida de `fetch` + comprobación de `response.ok` + parseo se
 * delega en `adapters/http/httpClient.js`, que además añade timeout —antes una
 * petición colgada dejaba el chat en "escribiendo…" para siempre.
 *
 * La traducción de errores técnicos a lenguaje ciudadano ya no se hace aquí ni se
 * duplica en el contexto: vive en `domain/errors/rpaErrorTranslator.js`.
 */

import { get, post, HttpError } from "../adapters/http/httpClient.js";
import { environment } from "../config/environment.js";
import { forBackendResource } from "../domain/security/urlPolicy.js";

const BASE_URL = environment.predialApiUrl;

/** Timeout amplio: el RPA navega un portal externo y resuelve un captcha. */
const RPA_TIMEOUT_MS = 60_000;

/**
 * Configuración de respaldo cuando el microservicio no responde.
 * Permite que el formulario se renderice y el usuario entienda qué puede consultar.
 */
const FALLBACK_CLIENTES = Object.freeze({
  status: "success",
  clientes: [
    {
      id: "floridablanca",
      name: "Floridablanca (Santander)",
      search_types: [
        "Código Predial",
        "Número Cuenta",
        "Código NPN",
        "Código NUPRE",
        "Matrícula Inmobiliaria"
      ]
    }
  ]
});

/**
 * Municipios disponibles y tipos de búsqueda válidos.
 * Endpoint: GET /api/clientes
 *
 * @returns {Promise<Object>}
 */
export const getClientes = async () => {
  try {
    return await get(`${BASE_URL}/api/clientes`);
  } catch (error) {
    console.warn(
      "⚠️ [Predial] Servicio no alcanzable, usando configuración por defecto:",
      error?.message
    );
    return FALLBACK_CLIENTES;
  }
};

/**
 * Resolución anticipada del reCAPTCHA, para acortar el trámite posterior.
 * Endpoint: POST /api/prewarm
 *
 * @param {string} [cliente]
 * @returns {Promise<void>}
 */
export const prewarmCaptcha = async (cliente = "floridablanca") => {
  try {
    await post(`${BASE_URL}/api/prewarm?cliente=${encodeURIComponent(cliente)}`, undefined, {
      timeoutMs: 15_000
    });
  } catch (error) {
    // Es preventivo y silencioso: no debe cortar el flujo principal.
    console.warn("⚠️ [Predial] Prewarm del captcha no disponible:", error?.message);
  }
};

/**
 * Inicia la generación de la factura en modo asíncrono.
 * Endpoint: POST /api/generar_factura?mode=async
 *
 * @param {Object} payload
 * @param {string} payload.searchType
 * @param {string} payload.searchValue
 * @param {string} payload.phone
 * @param {string} payload.email
 * @param {string} [payload.cliente]
 * @returns {Promise<{status: string, job_id: string}>}
 */
export const generarFacturaAsync = async ({
  searchType,
  searchValue,
  phone,
  email,
  cliente = "floridablanca"
}) => {
  try {
    return await post(
      `${BASE_URL}/api/generar_factura?mode=async`,
      {
        search_type: searchType,
        search_value: searchValue,
        phone,
        email,
        cliente,
        mode: "async"
      },
      { timeoutMs: RPA_TIMEOUT_MS }
    );
  } catch (error) {
    // No registrar el cuerpo de la petición: contiene documento, teléfono y correo.
    console.error(
      `❌ [Predial] Fallo al iniciar la factura (status=${error?.status ?? "n/d"})`
    );
    // Se propaga el mensaje del backend para que el traductor de dominio pueda
    // reconocerlo (paz y salvo, pasarela ocupada, predio inexistente).
    throw new Error(
      (error instanceof HttpError && error.body?.message) || error?.message || "Error del servicio Predial",
      { cause: error }
    );
  }
};

/**
 * Escucha el stream SSE de eventos de un job.
 * Endpoint: GET /api/jobs/{jobId}/stream
 *
 * @param {string} jobId
 * @param {(evt: Object) => void} onEvent
 * @param {(err: unknown) => void} [onError]
 * @returns {() => void} Función de limpieza que cierra el stream.
 */
export const listenJobStream = (jobId, onEvent, onError) => {
  const streamUrl = `${BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/stream`;
  const eventSource = new EventSource(streamUrl);
  const processedEvents = new Set();

  eventSource.onmessage = (e) => {
    if (!e.data) return;
    try {
      const evt = JSON.parse(e.data);
      const eventKey = `${evt.ts || 0}_${evt.event}`;

      // Deduplicar: una reconexión SSE reenvía los eventos ya vistos.
      if (processedEvents.has(eventKey)) return;
      processedEvents.add(eventKey);

      onEvent(evt);

      if (evt.event === "done" || evt.event === "error" || evt.event === "stream_timeout") {
        eventSource.close();
      }
    } catch (err) {
      console.error("❌ [Predial] Evento SSE ilegible:", err?.message);
    }
  };

  eventSource.onerror = (err) => {
    console.error("❌ [Predial] Error de conexión SSE");
    if (onError) onError(err);
    eventSource.close();
  };

  return () => eventSource.close();
};

/**
 * Selecciona un predio cuando la búsqueda devolvió varios.
 * Endpoint: POST /api/seleccionar_predio?mode=async
 *
 * @param {Object} payload
 * @param {string} payload.sessionId
 * @param {number} payload.index
 * @param {string} payload.phone
 * @param {string} payload.email
 * @param {string} [payload.mode]
 * @returns {Promise<{job_id: string}>}
 */
export const seleccionarPredio = async ({ sessionId, index, phone, email, mode = "async" }) => {
  try {
    return await post(
      `${BASE_URL}/api/seleccionar_predio?mode=${encodeURIComponent(mode)}`,
      { session_id: sessionId, index: Number(index), phone, email, mode },
      { timeoutMs: RPA_TIMEOUT_MS }
    );
  } catch (error) {
    console.error(`❌ [Predial] Fallo al seleccionar predio (status=${error?.status ?? "n/d"})`);

    if (error?.status === 404) {
      throw new Error(
        "La sesión de selección ha expirado por inactividad. Realiza la búsqueda de nuevo.",
        { cause: error }
      );
    }
    if (error?.status === 422) {
      throw new Error("El predio seleccionado no es válido. Intenta nuevamente.", { cause: error });
    }
    throw new Error(error?.message || "Error al seleccionar el predio", { cause: error });
  }
};

/**
 * Formatea un monto a pesos colombianos.
 * @param {string|number} amountStr
 * @returns {string}
 */
export const formatPesos = (amountStr) => {
  if (!amountStr && amountStr !== 0) return "$0";
  const num = parseInt(String(amountStr).replace(/\D/g, ""), 10);
  if (Number.isNaN(num)) return "$0";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0
  }).format(num);
};

/**
 * URL de descarga de una factura en PDF.
 * Pasa por la política de recursos de backend para garantizar un esquema seguro.
 *
 * @param {string} filename
 * @returns {string}
 */
export const getFacturaPdfUrl = (filename) => {
  if (!filename) return "#";
  const { href } = forBackendResource(`${BASE_URL}/facturas/${encodeURIComponent(filename)}`);
  return href;
};
