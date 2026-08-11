/**
 * Identidad del ciudadano. Capa de dominio.
 *
 * Modela el nombre y correo que se solicitan al iniciar la conversación o al entrar a
 * un trámite. Es una entidad de dominio y no un simple objeto de formulario porque
 * define qué se considera válido, cómo se normaliza y cómo se muestra.
 *
 * Nota de privacidad: estos datos NO se redactan al persistirse. El registro de
 * conversaciones se guarda como evidencia legal, y una evidencia con los datos
 * enmascarados no sirve para acreditar a quién se atendió. La redacción sigue
 * aplicándose donde su finalidad es distinta: telemetría de consumo y logs de
 * operación (ver `domain/security/piiRedactor.js`).
 */

import { sanitizeText, truncate } from "../security/textSanitizer.js";

/** Topes de longitud, alineados con lo que suele aceptar un backend municipal. */
export const IDENTITY_LIMITS = Object.freeze({
  name: 120,
  email: 254 // longitud máxima de una dirección de correo según RFC 5321
});

/**
 * @typedef {Object} CitizenIdentity
 * @property {string} name
 * @property {string} email
 * @property {string} providedAt  Marca de tiempo ISO de cuándo se entregaron los datos.
 */

/**
 * Validación de correo deliberadamente permisiva.
 *
 * No se usa una expresión regular "completa" de RFC 5322 a propósito: son enormes,
 * ilegibles y rechazan direcciones válidas. La comprobación real de que un correo
 * existe es enviarle un mensaje. Aquí solo se descartan errores evidentes de tecleo.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Un nombre debe tener al menos dos caracteres de letra. */
const NAME_SHAPE = /\p{L}{2,}/u;

/**
 * Normaliza un nombre: colapsa espacios y recorta.
 * No se fuerza capitalización: hay nombres con partículas en minúscula ("de la Rosa")
 * y apellidos con mayúsculas internas ("McAllister") que un `capitalize` estropearía.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const normalizeName = (value) =>
  truncate(sanitizeText(value).replace(/\s{2,}/g, " "), IDENTITY_LIMITS.name);

/**
 * Normaliza un correo: minúsculas y sin espacios.
 * @param {unknown} value
 * @returns {string}
 */
export const normalizeEmail = (value) =>
  truncate(sanitizeText(value).toLowerCase().replace(/\s/g, ""), IDENTITY_LIMITS.email);

/**
 * Valida los datos de identidad y devuelve los errores por campo.
 *
 * @param {{name?: unknown, email?: unknown}} input
 * @returns {{ valid: boolean, errors: {name?: string, email?: string} }}
 */
export const validateIdentity = ({ name, email } = {}) => {
  const errors = {};

  const cleanName = normalizeName(name);
  if (!cleanName) {
    errors.name = "Escribe tu nombre.";
  } else if (!NAME_SHAPE.test(cleanName)) {
    errors.name = "El nombre debe contener al menos dos letras.";
  }

  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) {
    errors.email = "Escribe tu correo electrónico.";
  } else if (!EMAIL_SHAPE.test(cleanEmail)) {
    errors.email = "Ese correo no parece válido. Revisa que tenga el formato nombre@dominio.com";
  }

  return { valid: Object.keys(errors).length === 0, errors };
};

/**
 * Construye una identidad válida a partir de datos de formulario.
 *
 * @param {{name: string, email: string}} input
 * @param {string} [providedAt] Marca de tiempo ISO; se inyecta para poder probarla.
 * @returns {CitizenIdentity}
 * @throws {Error} si los datos no son válidos
 */
export const createIdentity = ({ name, email }, providedAt = new Date().toISOString()) => {
  const { valid, errors } = validateIdentity({ name, email });
  if (!valid) {
    throw new Error(`Identidad inválida: ${Object.values(errors).join(" ")}`);
  }
  return {
    name: normalizeName(name),
    email: normalizeEmail(email),
    providedAt
  };
};

/**
 * Primer nombre, para saludar sin sonar a formulario.
 * @param {CitizenIdentity|null} identity
 * @returns {string}
 */
export const getFirstName = (identity) => {
  if (!identity?.name) return "";
  return identity.name.split(/\s+/)[0] || "";
};
