/**
 * Redacción de datos personales (PII). Capa de dominio.
 *
 * Antes existían `maskEmail`/`maskPhone`/`maskIdentification` pero solo se aplicaban
 * al render visual de la consola. El pipeline de telemetría escribía el mensaje del
 * ciudadano en claro. Este módulo centraliza la redacción para que se aplique en el
 * BORDE de salida (telemetría, logs, analítica), que es donde importa de cara a la
 * Ley 1581 de 2012 (Habeas Data).
 */

/**
 * Enmascara un correo: `juan.perez@gmail.com` -> `j*****z@gmail.com`
 * @param {unknown} email
 * @returns {string}
 */
export const maskEmail = (email) => {
  if (typeof email !== "string" || email.trim() === "") return "";
  const parts = email.trim().split("@");
  if (parts.length !== 2) return "*****";
  const [name, domain] = parts;
  if (name.length <= 2) return `${name[0]}*@${domain}`;
  return `${name[0]}*****${name[name.length - 1]}@${domain}`;
};

/**
 * Enmascara un celular: `3101234567` -> `310****567`
 * @param {unknown} phone
 * @returns {string}
 */
export const maskPhone = (phone) => {
  if (typeof phone !== "string" || phone.trim() === "") return "";
  const clean = phone.trim();
  if (clean.length < 7) return "***";
  return `${clean.substring(0, 3)}****${clean.substring(clean.length - 3)}`;
};

/**
 * Enmascara un documento de identidad: `1098765432` -> `109****432`
 * @param {unknown} idNum
 * @returns {string}
 */
export const maskIdentification = (idNum) => {
  if (typeof idNum !== "string" || idNum.trim() === "") return "";
  const clean = idNum.trim();
  if (clean.length <= 4) return "****";
  return `${clean.substring(0, 3)}****${clean.substring(clean.length - 3)}`;
};

/**
 * Enmascara el código de autenticación de una PQRSD.
 *
 * Este código, junto al radicado, es la credencial que da acceso al expediente
 * completo del ciudadano (nombre, correo, asunto, anexos y respuestas). Ninguna de
 * las máscaras anteriores lo cubría porque es alfanumérico, así que aparecía en
 * texto claro en la terminal de la consola.
 *
 * `202UhXbRIu2026488450` -> `202…8450`
 *
 * @param {unknown} code
 * @returns {string}
 */
export const maskAuthCode = (code) => {
  if (typeof code !== "string" || code.trim() === "") return "";
  const clean = code.trim();
  if (clean.length <= 8) return "********";
  return `${clean.substring(0, 3)}…${clean.substring(clean.length - 4)}`;
};

/**
 * Patrones de PII detectables en texto libre, en orden de aplicación.
 * El orden importa: el correo se procesa primero para que la parte numérica de una
 * dirección como `usuario1098765432@x.com` no se enmascare por separado.
 */
const REDACTION_RULES = [
  {
    name: "email",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replace: maskEmail
  },
  {
    name: "authCode",
    // Códigos tipo PQRSD: mezcla de dígitos y letras, 12+ caracteres.
    pattern: /\b(?=[A-Za-z0-9]{12,24}\b)(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]+\b/g,
    replace: maskAuthCode
  },
  {
    name: "phone",
    pattern: /\b3\d{9}\b/g,
    replace: maskPhone
  },
  {
    name: "identification",
    pattern: /\b\d{6,12}\b/g,
    replace: maskIdentification
  }
];

/**
 * Redacta toda la PII detectable en un texto libre.
 *
 * Es deliberadamente agresivo: enmascara cualquier número de 6 a 12 dígitos, lo que
 * también afecta a radicados y códigos prediales. En un log de operación eso es
 * preferible a filtrar una cédula.
 *
 * @param {unknown} text
 * @returns {string}
 */
export const redactPII = (text) => {
  if (typeof text !== "string" || text.length === 0) return "";
  return REDACTION_RULES.reduce(
    (acc, rule) => acc.replace(rule.pattern, (match) => rule.replace(match)),
    text
  );
};

/**
 * Redacta los valores de PII de un objeto plano por nombre de campo.
 * Se usa antes de enviar cualquier payload a telemetría o a `console`.
 *
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 */
export const redactFields = (obj) => {
  if (!obj || typeof obj !== "object") return {};
  const FIELD_MASKS = {
    email: maskEmail,
    correo: maskEmail,
    phone: maskPhone,
    telefono: maskPhone,
    telefonoCelular: maskPhone,
    telefono_celular: maskPhone,
    documento: maskIdentification,
    numeroIdentificacion: maskIdentification,
    numero_identificacion: maskIdentification,
    searchValue: maskIdentification,
    search_value: maskIdentification,
    codigoAutenticacion: maskAuthCode,
    codigo_autenticacion: maskAuthCode
  };

  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const mask = FIELD_MASKS[key];
    out[key] = mask && typeof value === "string" ? mask(value) : value;
  }
  return out;
};
