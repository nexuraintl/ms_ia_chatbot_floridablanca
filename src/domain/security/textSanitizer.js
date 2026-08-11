/**
 * Saneamiento de texto. Capa de dominio: sin dependencias de navegador ni de red.
 *
 * Responsabilidad única: normalizar cadenas que provienen de fuentes no confiables
 * (usuario, DOM anfitrión, respuestas de backends) a una forma segura de transportar.
 *
 * NO escapa HTML a propósito: React escapa por defecto al interpolar texto, y añadir
 * un escape manual produciría doble escape visible (`&amp;lt;`). El único lugar donde
 * haría falta escapar es `dangerouslySetInnerHTML`, que este proyecto no usa.
 */

/** Caracteres de control ASCII, excluyendo \t \n \r que se tratan aparte. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

// eslint-disable-next-line no-control-regex
const ALL_CONTROL_CHARS = /[\u0000-\u001f]/g;

/**
 * Caracteres invisibles usados para ocultar payloads de inyección de prompt:
 * zero-width space/joiner, marcas de dirección bidireccional y BOM. Se escriben con
 * escapes explícitos a propósito — como literales serían invisibles en el editor.
 */
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/**
 * Elimina caracteres de control e invisibles preservando saltos de línea legítimos.
 *
 * @param {unknown} text
 * @returns {string}
 */
export const sanitizeText = (text) => {
  if (typeof text !== "string") return "";
  return text.replace(CONTROL_CHARS, "").replace(INVISIBLE_CHARS, "").trim();
};

/**
 * Aplana una cadena a una sola línea apta para escribirse en un log.
 * Previene inyección CRLF / falsificación de entradas de log.
 *
 * @param {unknown} str
 * @param {number} maxLen
 * @returns {string}
 */
export const sanitizeLogString = (str, maxLen = 500) => {
  if (typeof str !== "string" || str.length === 0) return "";
  const cleaned = str
    .replace(/[\r\n\t]/g, " ")
    .replace(ALL_CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned.length > maxLen ? cleaned.substring(0, maxLen) + "…" : cleaned;
};

/**
 * Prepara texto que proviene de una fuente NO CONFIABLE para incrustarse en un prompt.
 *
 * Además de limpiar caracteres de control, neutraliza los marcadores estructurales que
 * permitirían a la fuente hacerse pasar por instrucciones del sistema: corchetes de
 * sección (`[SECCIÓN]:`), vallas de bloque (```), y etiquetas de rol tipo `system:`.
 *
 * No intenta detectar frases maliciosas por lista negra: eso es inevitablemente
 * evadible. La defensa real es estructural — ver `pageContext/promptSerializer.js`,
 * que encierra estos datos en un bloque explícitamente marcado como no confiable y
 * los envía fuera de `systemInstruction`.
 *
 * @param {unknown} text
 * @param {number} maxLen
 * @returns {string}
 */
export const sanitizeForPrompt = (text, maxLen = 300) => {
  if (typeof text !== "string" || text.length === 0) return "";
  const cleaned = sanitizeLogString(text, maxLen)
    // Neutralizar delimitadores de sección y de bloque
    .replace(/[[\]]/g, "")
    .replace(/`{3,}/g, "")
    // Neutralizar etiquetas de rol que confundirían el turno de conversación.
    // El flag `m` es necesario: sin él el ancla `^` solo evalúa el inicio de todo
    // el string y una etiqueta en la segunda línea sobreviviría.
    .replace(/^\s*(system|assistant|user|model|developer)\s*:/gim, "$1-")
    .replace(/\b(system|assistant|developer)\s*:/gi, "$1-")
    .trim();

  // Recorte final estricto. `sanitizeLogString` añade puntos suspensivos DESPUÉS de
  // cortar, así que su salida puede exceder `maxLen` en un carácter; y los reemplazos
  // posteriores tampoco garantizan la longitud. Quien fija un tope espera que se
  // respete de forma exacta.
  return truncate(cleaned, maxLen);
};

/**
 * Trunca de forma segura, sin cortar a mitad de un par surrogate (emoji).
 *
 * @param {unknown} text
 * @param {number} maxLen
 * @returns {string}
 */
export const truncate = (text, maxLen) => {
  if (typeof text !== "string") return "";
  if (text.length <= maxLen) return text;
  const cut = text.substring(0, maxLen);
  // Si cortamos justo en el high surrogate de un par, retroceder un carácter
  const lastCode = cut.charCodeAt(cut.length - 1);
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? cut.slice(0, -1) : cut;
};

/**
 * Escapa metacaracteres para construir una expresión regular a partir de texto libre.
 *
 * @param {unknown} str
 * @returns {string}
 */
export const escapeRegex = (str) => {
  if (typeof str !== "string") return "";
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

/**
 * Normaliza texto para comparación semántica: minúsculas, sin acentos, sin puntuación.
 * Centraliza la cadena `.toLowerCase().normalize("NFD")...` que estaba duplicada en
 * cinco lugares distintos del proyecto.
 *
 * @param {unknown} text
 * @returns {string}
 */
export const normalizeForMatching = (text) => {
  if (typeof text !== "string") return "";
  return text
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // marcas diacriticas tras NFD
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?¿¡]/g, "");
};
