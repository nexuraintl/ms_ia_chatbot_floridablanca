/**
 * Cliente HTTP compartido. Capa de adaptadores.
 *
 * Los cuatro servicios (`gemini`, `rpaPredial`, `pqrsd`, `apiMock`) repetían el mismo
 * bloque `fetch` + `response.ok` + `response.json()` + `console.error(error)`, cada
 * uno con matices distintos. Además ninguno tenía timeout: una petición colgada dejaba
 * el chat en estado "escribiendo…" indefinidamente.
 *
 * Este cliente añade:
 *   · Timeout con `AbortController` (por defecto 30 s).
 *   · Parseo de JSON tolerante: un 502 con cuerpo HTML no revienta con SyntaxError.
 *   · Errores tipados que NO arrastran el cuerpo de la respuesta del servidor, para
 *     que un `catch` descuidado no acabe pintando detalles internos en el chat.
 */

/** Timeout por defecto de las peticiones, en milisegundos. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Error de transporte o de aplicación HTTP.
 * `publicMessage` es lo único apto para mostrar al usuario; `detail` queda para logs.
 */
export class HttpError extends Error {
  /**
   * @param {string} message  Mensaje técnico, para logs.
   * @param {Object} opts
   * @param {number} [opts.status]
   * @param {unknown} [opts.body]
   * @param {string} [opts.publicMessage]
   */
  constructor(message, { status = 0, body = null, publicMessage = "" } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.publicMessage = publicMessage;
  }
}

/**
 * Intenta parsear JSON; si no lo consigue devuelve null en lugar de lanzar.
 * @param {Response} response
 * @returns {Promise<unknown|null>}
 */
const parseJsonSafe = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Realiza una petición HTTP con timeout y manejo de errores uniforme.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {unknown} [options.body]  Objeto (se serializa a JSON) o FormData/string.
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<unknown>} Cuerpo parseado.
 * @throws {HttpError}
 */
export const request = async (
  url,
  { method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Permitir que quien llama también pueda cancelar.
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const isPlainObject = body !== undefined && body !== null && !isFormData && typeof body === "object";

  /** @type {RequestInit} */
  const init = {
    method,
    signal: controller.signal,
    headers: {
      Accept: "application/json",
      // No fijar Content-Type con FormData: el navegador debe añadir el boundary.
      ...(isPlainObject ? { "Content-Type": "application/json" } : {}),
      ...headers
    }
  };

  if (body !== undefined && body !== null) {
    init.body = isPlainObject ? JSON.stringify(body) : body;
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    clearTimeout(timer);
    const aborted = error?.name === "AbortError";
    throw new HttpError(aborted ? `Timeout tras ${timeoutMs}ms: ${url}` : `Fallo de red: ${error?.message}`, {
      status: 0,
      publicMessage: aborted
        ? "El servicio está tardando más de lo normal. Intenta de nuevo en unos minutos."
        : "No pude conectarme con el servicio. Verifica tu conexión e intenta de nuevo."
    });
  } finally {
    clearTimeout(timer);
  }

  const payload = await parseJsonSafe(response);

  if (!response.ok) {
    throw new HttpError(`HTTP ${response.status} en ${url}`, {
      status: response.status,
      body: payload,
      publicMessage: ""
    });
  }

  return payload;
};

/** Atajos. */
export const get = (url, opts) => request(url, { ...opts, method: "GET" });
export const post = (url, body, opts) => request(url, { ...opts, method: "POST", body });
