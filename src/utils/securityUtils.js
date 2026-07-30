/**
 * Módulo de Utilidades de Ciberseguridad y Sanitización
 * Previene XSS, Fuga de Datos (PII), Inyección de Control/CRLF y Malformed URLs.
 */

/**
 * Sanitiza y valida URLs para prevenir vectores de ataque DOM-based XSS
 * permitiendo únicamente esquemas seguros (http, https, mailto, tel, #).
 * 
 * @param {string} url - URL ingresada o dinámica
 * @returns {string} - URL segura o "#" si se detecta un protocolo malicioso (ej. javascript:, data:)
 */
export const sanitizeUrl = (url) => {
  if (!url || typeof url !== "string") return "#";
  const trimmedUrl = url.trim();

  // Permitir enlaces internos de ancla
  if (trimmedUrl.startsWith("#")) return trimmedUrl;

  try {
    const parsed = new URL(trimmedUrl, window.location.origin);
    const allowedProtocols = ["http:", "https:", "mailto:", "tel:"];
    if (allowedProtocols.includes(parsed.protocol)) {
      return trimmedUrl;
    }
  } catch {
    // Si no se puede parsear como URL relativa/absoluta válida, rechazar
  }

  // Prevenir javascript:, data:, vbscript:, etc.
  return "#";
};

/**
 * Sanitiza textos para prevenir inyecciones HTML y caracteres de control no imprimibles.
 * 
 * @param {string} text 
 * @returns {string}
 */
export const sanitizeText = (text) => {
  if (typeof text !== "string") return "";
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "") // Eliminar caracteres de control ASCII
    .trim();
};

/**
 * Limpia y reemplaza saltos de línea (\r, \n) y caracteres de control para prevenir
 * Inyección en Logs (CRLF Injection / Log Poisoning).
 * 
 * @param {string} str 
 * @param {number} maxLen 
 * @returns {string}
 */
export const sanitizeLogString = (str, maxLen = 500) => {
  if (!str || typeof str !== "string") return "";
  const cleaned = str
    .replace(/[\r\n\t]/g, " ") // Reemplazar saltos de línea y tabs por espacios
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F]/g, ""); // Eliminar control chars
  return cleaned.length > maxLen ? cleaned.substring(0, maxLen) + "..." : cleaned;
};

/**
 * Enmascara números de teléfono para proteger PII (Habeas Data).
 * Ejemplo: "3001234567" -> "300****567"
 * 
 * @param {string} phone 
 * @returns {string}
 */
export const maskPhone = (phone) => {
  if (!phone || typeof phone !== "string") return "";
  const clean = phone.trim();
  if (clean.length < 7) return "***";
  return clean.substring(0, 3) + "****" + clean.substring(clean.length - 3);
};

/**
 * Enmascara direcciones de correo electrónico para proteger PII.
 * Ejemplo: "usuario@ejemplo.com" -> "u*****o@ejemplo.com"
 * 
 * @param {string} email 
 * @returns {string}
 */
export const maskEmail = (email) => {
  if (!email || typeof email !== "string") return "";
  const parts = email.trim().split("@");
  if (parts.length !== 2) return "*****";
  const name = parts[0];
  const domain = parts[1];
  if (name.length <= 2) {
    return name[0] + "*@" + domain;
  }
  return name[0] + "*****" + name[name.length - 1] + "@" + domain;
};

/**
 * Enmascara números de documento de identificación.
 * Ejemplo: "1098765432" -> "109****432"
 * 
 * @param {string} idNum 
 * @returns {string}
 */
export const maskIdentification = (idNum) => {
  if (!idNum || typeof idNum !== "string") return "";
  const clean = idNum.trim();
  if (clean.length <= 4) return "****";
  return clean.substring(0, 3) + "****" + clean.substring(clean.length - 3);
};

/**
 * Escapa caracteres especiales en un string para ser usado en una Expresión Regular segura.
 * 
 * @param {string} str 
 * @returns {string}
 */
export const escapeRegex = (str) => {
  if (typeof str !== "string") return "";
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

/**
 * Valida la sintaxis aproximada de una API Key de Google Gemini.
 * 
 * @param {string} key 
 * @returns {boolean}
 */
export const isValidGeminiApiKey = (key) => {
  if (!key || typeof key !== "string") return false;
  const trimmed = key.trim();
  // Las llaves de Gemini de Google AI Studio suelen iniciar con 'AIzaSy' y tener ~39 caracteres
  return /^AIzaSy[A-Za-z0-9_-]{30,50}$/.test(trimmed);
};
