/**
 * Adaptador del microservicio RPA de Impuesto Predial (Alcaldía de Floridablanca).
 *
 * Habla con el proxy del backend del chatbot, no con el Cloud Run: el servicio exige un
 * identity token de Google y el navegador no puede acuñar uno. Ver docs/INTEGRACION_RPA.md.
 *
 * Las rutas son las del estándar GOB-GCP-STD-01 (`/v1/...`). Las anteriores (`/api/...`)
 * ya no existen.
 */

import { get, post, HttpError } from "../adapters/http/httpClient.js";
import { environment, RPA_MOUNTS } from "../config/environment.js";
import { createCorrelationId } from "../domain/observability/correlation.js";

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
 * Convierte una ruta de seguimiento devuelta por el servicio en una URL del proxy.
 *
 * Las respuestas de `?mode=fast|async` traen `poll` y `stream` ya construidas y con el
 * prefijo correcto del ambiente. Concatenarlas a mano a partir del `job_id` funciona contra
 * el Cloud Run directo y se rompe detrás del gateway, así que se usan tal cual y aquí solo
 * se reasientan sobre el proxy.
 *
 * @param {string} path Valor de `poll` o `stream` de la respuesta.
 * @returns {string}
 * @throws {Error} Si la ruta no tiene la forma esperada.
 */
export const resolveTrackingUrl = (path) => {
  let relative = String(path || "").trim();
  if (relative === "") {
    throw new Error("El servicio no devolvió la ruta de seguimiento del trámite.");
  }
  if (!relative.startsWith("/")) relative = `/${relative}`;

  // Detrás del gateway la ruta ya viene con el prefijo del servicio, que es el mismo con el
  // que el proxy lo publica. Se quita para no duplicarlo.
  const mount = RPA_MOUNTS.factura;
  while (relative === mount || relative.startsWith(`${mount}/`)) {
    relative = relative.slice(mount.length) || "/";
  }

  // El valor viene de una respuesta del backend, pero acaba en un `EventSource`: se exige la
  // forma conocida en lugar de confiar.
  if (!/^\/v1\/jobs\/[A-Za-z0-9_-]+(\/stream)?$/.test(relative)) {
    throw new Error(`La ruta de seguimiento no tiene la forma esperada: ${relative}`);
  }
  return `${BASE_URL}${relative}`;
};

/**
 * Municipios disponibles y tipos de búsqueda válidos.
 * Endpoint: GET /v1/clientes
 *
 * Los `search_types` cambian por municipio: enviar uno de otro municipio da 422.
 *
 * @returns {Promise<Object>}
 */
export const getClientes = async () => {
  try {
    return await get(`${BASE_URL}/v1/clientes`);
  } catch (error) {
    console.warn("[Predial] Servicio no alcanzable, usando configuración por defecto:", error?.message);
    return FALLBACK_CLIENTES;
  }
};

/**
 * Resolución anticipada del reCAPTCHA, para acortar el trámite posterior.
 * Endpoint: POST /v1/prewarm
 *
 * El captcha es el mayor costo del flujo (5-65s medidos) y resolverlo por adelantado baja el
 * trámite de ~45s a ~25s. Es idempotente, así que se llama en cuanto el ciudadano muestra
 * intención, antes de que termine de dar los datos.
 *
 * @param {string} [cliente]
 * @returns {Promise<void>}
 */
export const prewarmCaptcha = async (cliente = "floridablanca") => {
  try {
    await post(`${BASE_URL}/v1/prewarm?cliente=${encodeURIComponent(cliente)}`, undefined, {
      timeoutMs: 25_000
    });
  } catch (error) {
    // Es preventivo y silencioso: no debe cortar el flujo principal.
    console.warn("[Predial] Prewarm del captcha no disponible:", error?.message);
  }
};

/**
 * Error de cola del proxy: el servicio de factura admite dos trámites simultáneos y este
 * ciudadano llegó tercero. No es un fallo del trámite.
 */
export class RpaBusyError extends Error {
  /** @param {number} retryAfterSeconds */
  constructor(retryAfterSeconds) {
    super("El servicio está atendiendo otros trámites en este momento.");
    this.name = "RpaBusyError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Traduce un fallo del proxy a un error de dominio.
 * @param {unknown} error
 * @returns {Error}
 */
const asDomainError = (error) => {
  if (error instanceof HttpError && error.status === 429 && error.body?.reason === "rpa_queue_full") {
    return new RpaBusyError(Number(error.body?.retryAfterSeconds) || 45);
  }
  // Se propaga el mensaje del backend para que el traductor de dominio pueda reconocerlo
  // (paz y salvo, pasarela ocupada, predio inexistente).
  return new Error(
    (error instanceof HttpError && (error.body?.message || error.body?.detail)) ||
      error?.message ||
      "Error del servicio Predial",
    { cause: error }
  );
};

/**
 * Inicia la generación de la factura en modo asíncrono.
 * Endpoint: POST /v1/generar_factura?mode=async
 *
 * Modo asíncrono a propósito: un trámite tarda 25-45s y Cloud Run corta la petición a los
 * 300s, así que la petición del ciudadano no se sostiene esperando. El progreso se sigue por
 * la ruta `stream` que devuelve esta llamada.
 *
 * @param {Object} payload
 * @param {string} payload.searchType
 * @param {string} payload.searchValue
 * @param {string} payload.phone
 * @param {string} payload.email
 * @param {string} [payload.cliente]
 * @returns {Promise<{status: string, job_id: string, poll: string, stream: string}>}
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
      `${BASE_URL}/v1/generar_factura?mode=async`,
      {
        // Teléfono y correo van en el cuerpo, nunca en la query: las URLs se registran.
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
    console.error(`[Predial] Fallo al iniciar la factura (status=${error?.status ?? "n/d"})`);
    throw asDomainError(error);
  }
};

/**
 * Estado de un trámite. Se usa cuando el stream se corta antes de terminar.
 * Endpoint: GET /v1/jobs/{job_id}
 *
 * `status` es el ciclo de vida del JOB (`running` | `done` | `error`); el desenlace del
 * TRÁMITE está en `result.status`. Un `done` no significa que salió bien.
 *
 * @param {string} pollPath Valor de `poll` de la respuesta del trámite.
 * @returns {Promise<Object>}
 */
export const getJobStatus = async (pollPath) => {
  try {
    return await get(resolveTrackingUrl(pollPath), { timeoutMs: 20_000 });
  } catch (error) {
    if (error?.status === 404) {
      throw new Error("El trámite ya expiró. Los trámites se conservan 15 minutos.", { cause: error });
    }
    throw asDomainError(error);
  }
};

/**
 * Escucha el stream SSE de eventos de un trámite.
 * Endpoint: GET /v1/jobs/{job_id}/stream
 *
 * @param {string} streamPath Valor de `stream` de la respuesta del trámite.
 * @param {(evt: Object) => void} onEvent
 * @param {(err: unknown) => void} [onError]
 * @returns {() => void} Función de limpieza que cierra el stream.
 */
export const listenJobStream = (streamPath, onEvent, onError) => {
  let streamUrl;
  try {
    streamUrl = resolveTrackingUrl(streamPath);
  } catch (error) {
    if (onError) onError(error);
    return () => {};
  }

  // `EventSource` no admite cabeceras propias, así que la correlación viaja por query. Es un
  // identificador, no un dato personal, y el proxy solo la acepta con forma de UUID.
  const separator = streamUrl.includes("?") ? "&" : "?";
  const eventSource = new EventSource(`${streamUrl}${separator}cid=${createCorrelationId()}`);
  const processedEvents = new Set();

  eventSource.onmessage = (e) => {
    if (!e.data) return;
    try {
      const evt = JSON.parse(e.data);
      const eventKey = `${evt.ts || 0}_${evt.event}`;

      // Deduplicar: una reconexión SSE reenvía los eventos ya vistos (el cursor arranca en 0).
      if (processedEvents.has(eventKey)) return;
      processedEvents.add(eventKey);

      onEvent(evt);

      if (evt.event === "done" || evt.event === "error" || evt.event === "stream_timeout") {
        eventSource.close();
      }
    } catch (err) {
      console.error("[Predial] Evento SSE ilegible:", err?.message);
    }
  };

  eventSource.onerror = (err) => {
    console.error("[Predial] Error de conexión SSE");
    if (onError) onError(err);
    eventSource.close();
  };

  return () => eventSource.close();
};

/**
 * Selecciona un predio cuando la búsqueda devolvió varios.
 * Endpoint: POST /v1/seleccionar_predio?mode=async
 *
 * La sesión es de un solo uso y muere a los 5 minutos. Un 422 por índice inválido NO la
 * consume, así que se puede corregir y reintentar.
 *
 * @param {Object} payload
 * @param {string} payload.sessionId
 * @param {number} payload.index
 * @param {string} payload.phone
 * @param {string} payload.email
 * @param {string} [payload.mode]
 * @returns {Promise<{job_id: string, poll: string, stream: string}>}
 */
export const seleccionarPredio = async ({ sessionId, index, phone, email, mode = "async" }) => {
  try {
    return await post(
      `${BASE_URL}/v1/seleccionar_predio?mode=${encodeURIComponent(mode)}`,
      { session_id: sessionId, index: Number(index), phone, email, mode },
      { timeoutMs: RPA_TIMEOUT_MS }
    );
  } catch (error) {
    console.error(`[Predial] Fallo al seleccionar predio (status=${error?.status ?? "n/d"})`);

    if (error?.status === 404) {
      throw new Error(
        "La sesión de selección ha expirado por inactividad. Realiza la búsqueda de nuevo.",
        { cause: error }
      );
    }
    if (error?.status === 422) {
      throw new Error("El predio seleccionado no es válido. Intenta nuevamente.", { cause: error });
    }
    throw asDomainError(error);
  }
};

/**
 * Formatea un monto a pesos colombianos.
 * `amount` llega como string de pesos sin separadores ni decimales: "66122546".
 *
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
 * Endpoint: GET /v1/facturas/{filename}
 *
 * Apunta al proxy, nunca al Cloud Run: el endpoint está detrás de IAM y el navegador del
 * ciudadano no lleva token. El backend lo descarga y lo reenvía.
 *
 * El nombre lo pone el portal y viene en la respuesta del trámite. No se construye.
 *
 * @param {string} filename
 * @returns {string}
 */
export const getFacturaPdfUrl = (filename) => {
  if (!filename) return "#";
  // La lista blanca del proxy solo admite este juego de caracteres; validarlo aquí evita
  // construir un enlace que el propio backend va a rechazar con un 404.
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(filename)) {
    console.warn("[Predial] Nombre de factura inesperado, no se ofrece descarga:", filename);
    return "#";
  }
  return `${BASE_URL}/v1/facturas/${encodeURIComponent(filename)}`;
};
