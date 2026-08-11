/**
 * Política de URLs. Capa de dominio.
 *
 * Distingue dos fuentes de URL con niveles de confianza distintos, porque el riesgo
 * no está en la URL sino en QUIÉN la propuso:
 *
 *   1. `forModelOutput()`  — enlaces que aparecen dentro del texto generado por la IA.
 *      Superficie de inyección de prompt: si el DOM anfitrión o una FAQ envenenada
 *      logran que el modelo escriba una URL, esta se renderizaría como enlace de
 *      confianza dentro de un chat institucional. Aquí SÍ aplica lista blanca de host.
 *
 *   2. `forBackendResource()` — enlaces que devuelve un backend propio (factura PDF,
 *      pasarela PSE). El servidor ya es una dependencia de confianza; bloquear por host
 *      rompería pagos reales. Aquí se valida esquema y se exige HTTPS, y se avisa por
 *      consola si el host no está en la lista conocida.
 */

/** Esquemas que nunca deben llegar a un atributo href. */
const SAFE_SCHEMES = ["http:", "https:", "mailto:", "tel:"];

const RESULT_BLOCKED = "#";

/**
 * @typedef {Object} UrlPolicyConfig
 * @property {string[]} allowedLinkHosts  Hosts (o sufijos `.dominio`) permitidos en salida del modelo.
 * @property {string[]} knownBackendHosts Hosts esperados para recursos de backend.
 */

/** @type {UrlPolicyConfig} */
const DEFAULT_CONFIG = {
  allowedLinkHosts: [],
  knownBackendHosts: []
};

let config = { ...DEFAULT_CONFIG };

/**
 * Inyecta la configuración de la política. Se llama una vez al arrancar la app.
 * @param {Partial<UrlPolicyConfig>} next
 */
export const configureUrlPolicy = (next = {}) => {
  config = {
    allowedLinkHosts: next.allowedLinkHosts ?? DEFAULT_CONFIG.allowedLinkHosts,
    knownBackendHosts: next.knownBackendHosts ?? DEFAULT_CONFIG.knownBackendHosts
  };
};

/**
 * Parsea una URL devolviendo el objeto URL normalizado, o null si no es segura.
 * @param {unknown} url
 * @param {string} [baseOrigin]
 * @returns {URL|null}
 */
const parseSafe = (url, baseOrigin) => {
  if (typeof url !== "string" || url.trim() === "") return null;
  const trimmed = url.trim();
  try {
    const parsed = baseOrigin ? new URL(trimmed, baseOrigin) : new URL(trimmed);
    return SAFE_SCHEMES.includes(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * ¿El host coincide con una entrada de la lista blanca?
 * Una entrada que empieza por `.` se trata como comodín de sufijo: `.gov.co` acepta
 * `floridablanca.gov.co` pero NO `floridablanca.gov.co.evil.example`, porque la
 * comparación es sobre el final exacto del hostname.
 *
 * @param {string} hostname
 * @param {string[]} allowList
 * @returns {boolean}
 */
const matchesHost = (hostname, allowList) => {
  const host = hostname.toLowerCase();
  return allowList.some((entry) => {
    const allowed = String(entry).toLowerCase().trim();
    if (!allowed) return false;
    if (allowed.startsWith(".")) return host === allowed.slice(1) || host.endsWith(allowed);
    return host === allowed;
  });
};

/**
 * Valida y normaliza una URL contenida en la salida del modelo.
 *
 * @param {unknown} url
 * @param {Object} [opts]
 * @param {string} [opts.baseOrigin] Origen para resolver rutas relativas.
 * @returns {{ safe: boolean, href: string, reason: string|null }}
 */
export const forModelOutput = (url, { baseOrigin } = {}) => {
  const trimmed = typeof url === "string" ? url.trim() : "";

  // Anclas internas: inofensivas y útiles.
  if (trimmed.startsWith("#")) {
    return { safe: true, href: trimmed, reason: null };
  }

  const parsed = parseSafe(url, baseOrigin);
  if (!parsed) {
    return { safe: false, href: RESULT_BLOCKED, reason: "esquema-no-permitido" };
  }

  // mailto: y tel: no tienen host que validar.
  if (parsed.protocol === "mailto:" || parsed.protocol === "tel:") {
    return { safe: true, href: parsed.href, reason: null };
  }

  const allowList = [...config.allowedLinkHosts];
  if (baseOrigin) {
    try {
      allowList.push(new URL(baseOrigin).hostname);
    } catch {
      /* baseOrigin inválido: se ignora */
    }
  }

  if (!matchesHost(parsed.hostname, allowList)) {
    return { safe: false, href: RESULT_BLOCKED, reason: "host-no-autorizado" };
  }

  // Devolver href normalizado, no la entrada cruda.
  return { safe: true, href: parsed.href, reason: null };
};

/**
 * Valida una URL entregada por un backend propio (PDF de factura, pasarela de pago).
 * No aplica lista blanca de host — bloquearla rompería pagos legítimos — pero exige
 * un esquema seguro y avisa si el host es inesperado.
 *
 * @param {unknown} url
 * @returns {{ safe: boolean, href: string, trusted: boolean }}
 */
export const forBackendResource = (url) => {
  const parsed = parseSafe(url);
  if (!parsed) {
    return { safe: false, href: RESULT_BLOCKED, trusted: false };
  }

  const trusted = matchesHost(parsed.hostname, config.knownBackendHosts);
  if (!trusted && config.knownBackendHosts.length > 0) {
    console.warn(
      `⚠️ [urlPolicy] El backend devolvió un recurso en un host no listado: ${parsed.hostname}. ` +
      `Se permite para no romper el trámite, pero conviene añadirlo a security.knownBackendHosts.`
    );
  }

  return { safe: true, href: parsed.href, trusted };
};

/**
 * Compatibilidad: valida únicamente el esquema y devuelve la URL normalizada.
 * Útil para `<img src>`, donde `javascript:` no ejecuta y la lista blanca de host
 * sería demasiado restrictiva (los QR llegan como `data:` o desde el backend).
 *
 * @param {unknown} url
 * @returns {string} URL normalizada o "#"
 */
export const sanitizeUrlScheme = (url) => {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (trimmed.startsWith("#")) return trimmed;
  // Las imágenes en data: son legítimas para códigos QR embebidos.
  if (/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(trimmed)) {
    return trimmed;
  }
  const parsed = parseSafe(url);
  return parsed ? parsed.href : RESULT_BLOCKED;
};
