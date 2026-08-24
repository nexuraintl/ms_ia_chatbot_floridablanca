/**
 * Traducción de errores técnicos de los RPA a lenguaje ciudadano. Capa de dominio.
 *
 * ANTES: las mismas cuatro cadenas `humanMsg.includes(...)` estaban duplicadas en
 * `handlePredialStreamEvent` y en `handlePredialFormSubmit` dentro de
 * `ChatContext.jsx`, con textos ligeramente distintos entre las dos copias.
 *
 * Además de deduplicar, esto cierra una fuga de información: el `catch` genérico
 * mostraba `error.message` crudo al ciudadano, lo que exponía detalles internos del
 * backend (rutas, nombres de host, trazas del RPA). Ahora todo mensaje que no coincida
 * con una regla conocida se sustituye por un texto genérico y el detalle técnico solo
 * va a `console` para depuración.
 */

/**
 * Reglas de traducción, evaluadas en orden. La primera que coincide gana.
 * @type {{ match: RegExp, message: string }[]}
 */
const TRANSLATIONS = [
  {
    match: /pasarela de pago/i,
    message:
      "Ya hay un pago en proceso para este predio. Si acabas de generar la factura, usa ese enlace; " +
      "si no, intenta nuevamente en una hora."
  },
  {
    match: /Generar Factura'? no se habilit/i,
    message:
      "¡Buenas noticias! Este predio se encuentra al día (Paz y Salvo), no registra deuda pendiente."
  },
  {
    match: /No se encontró el valor|No se encontró el predio/i,
    message:
      "No encontré ese predio en Floridablanca. Por favor verifica el número ingresado o intenta con otro dato."
  },
  {
    match: /sesión.*expirad|expirad.*sesión/i,
    message:
      "La sesión de selección expiró por inactividad. Por favor realiza la búsqueda de nuevo."
  },
  {
    match: /timeout|ETIMEDOUT|AbortError/i,
    message:
      "El trámite está tardando más de lo normal. Por favor intenta de nuevo en unos minutos."
  },
  {
    match: /Failed to fetch|NetworkError|ECONNREFUSED/i,
    message:
      "No pude conectarme con el servicio de la Alcaldía. Por favor intenta más tarde."
  }
];

/** Mensaje por defecto cuando ninguna regla coincide. */
export const GENERIC_ERROR =
  "No pude completar el trámite en este momento. Por favor intenta de nuevo en unos minutos.";

/**
 * Traduce un error técnico a un mensaje apto para mostrar al ciudadano.
 *
 * @param {unknown} error Error, mensaje de error, o texto del evento del stream.
 * @param {Object} [opts]
 * @param {string} [opts.fallback] Mensaje a usar si no hay coincidencia.
 * @returns {string}
 */
export const translateRpaError = (error, { fallback = GENERIC_ERROR } = {}) => {
  const raw =
    typeof error === "string" ? error : error?.message ? String(error.message) : "";

  if (!raw) return fallback;

  for (const rule of TRANSLATIONS) {
    if (rule.match.test(raw)) return rule.message;
  }

  // Sin coincidencia: no exponer el mensaje interno al ciudadano.
  return fallback;
};

/**
 * Fallos que el servicio marca como reintentables, con la espera medida para cada uno.
 * Todo lo que no esté aquí NO se reintenta: cada intento abre un navegador, gasta un captcha
 * pagado y degrada el portal (está medido que facturas repetidas sobre el mismo predio hacen
 * que la generación pase de 2.6s a 32s).
 *
 * @type {{ match: RegExp, delayMs: number }[]}
 */
const RETRYABLE = [
  { match: /abandon(ó|o) la p(á|a)gina de factura/i, delayMs: 30_000 },
  { match: /No apareci(ó|o) el popup de (é|e)xito/i, delayMs: 30_000 },
  { match: /CAPSOLVER/i, delayMs: 0 },
  { match: /Error esperando respuesta del portal/i, delayMs: 15_000 }
];

/**
 * ¿Este fallo admite UN reintento?
 *
 * Nunca en bucle: quien llama debe consumir el único reintento disponible y no volver a
 * preguntar. Un 502 en la radicación de una PQRSD no entra nunca aquí, porque el trámite
 * pudo haber quedado creado y un reenvío lo duplicaría.
 *
 * @param {unknown} error
 * @returns {{ retryable: boolean, delayMs: number }}
 */
export const classifyRetry = (error) => {
  const raw = typeof error === "string" ? error : error?.message ? String(error.message) : "";
  if (!raw) return { retryable: false, delayMs: 0 };

  for (const rule of RETRYABLE) {
    if (rule.match.test(raw)) return { retryable: true, delayMs: rule.delayMs };
  }
  return { retryable: false, delayMs: 0 };
};

/**
 * Traduce un error de búsqueda de predio incluyendo el criterio usado.
 * El valor buscado puede ser una cédula, así que se recorta y no se registra en logs.
 *
 * @param {unknown} error
 * @param {{ searchType?: string }} [ctx]
 * @returns {string}
 */
export const translatePredialSearchError = (error, { searchType } = {}) => {
  const raw = typeof error === "string" ? error : error?.message ? String(error.message) : "";
  if (/No se encontró el valor de búsqueda|No se encontró el predio/i.test(raw) && searchType) {
    return `No encontré ningún predio en Floridablanca para el ${searchType} ingresado. Verifica el dato e intenta de nuevo.`;
  }
  return translateRpaError(error);
};
