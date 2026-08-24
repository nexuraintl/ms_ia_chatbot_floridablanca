/**
 * Identificación del cliente para los limitadores. Lógica pura.
 *
 * Detrás del balanceador, `req.socket.remoteAddress` es la IP del BALANCEADOR, no la del
 * ciudadano. La real llega en `X-Forwarded-For`, que es una lista donde el cliente
 * controla la parte inicial y Google añade al final. La única entrada fiable es la que
 * está a `trustedHops` posiciones del FINAL; tomar la primera deja el límite decorativo,
 * porque basta enviar un `X-Forwarded-For` distinto en cada petición.
 *
 * `trustedHops`: 2 con balanceador externo por delante, 1 con Cloud Run en `*.run.app`.
 * Mal configurado el fallo es silencioso, así que el arranque avisa (`describeIpResolution`).
 */

import { CONVERSATION_HEADER } from "./correlation.js";

/** Saltos de confianza por defecto: balanceador externo de GCP delante de Cloud Run. */
export const DEFAULT_TRUSTED_HOPS = 2;

/** Valor devuelto cuando no se puede determinar la dirección. */
const UNKNOWN_IP = "unknown";

/**
 * Normaliza una dirección IP para usarla como clave de limitador.
 *
 * Se quita el prefijo IPv4-mapeado-en-IPv6 (`::ffff:1.2.3.4`) y el puerto de las formas
 * `1.2.3.4:5678`, porque si no la misma máquina generaría claves distintas en cada
 * conexión y el límite no se aplicaría nunca.
 *
 * @param {unknown} value
 * @returns {string}
 */
export const normalizeIp = (value) => {
  const raw = String(value ?? "").trim();
  if (raw === "") return "";

  // IPv6 entre corchetes, con o sin puerto: [::1]:443
  const bracketed = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1].toLowerCase();

  let address = raw;

  // IPv4 con puerto. Se comprueba que solo haya dos puntos para no romper una IPv6 pelada.
  if ((address.match(/:/g) || []).length === 1 && address.includes(".")) {
    address = address.split(":")[0];
  }

  // IPv4 mapeada en IPv6.
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];

  return address.toLowerCase();
};

/**
 * Resuelve la IP del cliente a partir de la petición.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {Object} [opts]
 * @param {number} [opts.trustedHops]  Entradas finales de `X-Forwarded-For` que escribe
 *        nuestra propia infraestructura. La IP del cliente es la que está justo antes.
 * @returns {string} IP normalizada, o `"unknown"` si no hay forma de saberla.
 */
export const resolveClientIp = (req, { trustedHops = DEFAULT_TRUSTED_HOPS } = {}) => {
  const header = req?.headers?.["x-forwarded-for"];
  const value = Array.isArray(header) ? header.join(",") : header;

  if (typeof value === "string" && value.trim() !== "") {
    const parts = value
      .split(",")
      .map((part) => normalizeIp(part))
      .filter((part) => part !== "");

    if (parts.length > 0) {
      const hops = Math.max(1, Math.floor(Number(trustedHops) || DEFAULT_TRUSTED_HOPS));
      // Índice contando desde el final. Si la lista es más corta de lo esperado —petición
      // directa sin pasar por el balanceador, o un salto menos— se toma la primera, que en
      // ese caso es la única candidata posible.
      const index = parts.length - hops;
      return parts[index >= 0 ? index : 0];
    }
  }

  const direct = normalizeIp(req?.socket?.remoteAddress);
  return direct === "" ? UNKNOWN_IP : direct;
};

/**
 * Resuelve el identificador de sesión para la cuota diaria.
 *
 * Se reutiliza `X-Conversation-ID`, la cabecera que el widget ya emite en cada petición
 * (`domain/observability/correlation.js`), atada al `conversationId` que vive en
 * `sessionStorage`. No hace falta inventar ninguna cookie ni identificador nuevo.
 *
 * LÍMITE CONOCIDO: lo genera el cliente, así que puede rotarlo para renovarse la cuota.
 * Contra el abuso deliberado trabaja el límite por IP; esta capa reparte la ración entre
 * usuarios de buena fe. Cuando falta la cabecera se cae a la IP, para que quitar la
 * correlación no equivalga a quitar la cuota.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {string} fallbackKey  Normalmente la IP resuelta.
 * @returns {{ key: string, source: "conversation"|"ip" }}
 */
export const resolveSessionKey = (req, fallbackKey) => {
  const header = req?.headers?.[CONVERSATION_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  const conversationId = String(value ?? "").trim();

  // Se acota la longitud y el alfabeto: esta cadena se usa como clave de un Map y se
  // escribe en los logs, así que no puede ser un texto arbitrario de tamaño libre.
  if (/^[A-Za-z0-9_-]{8,64}$/.test(conversationId)) {
    return { key: `conv:${conversationId}`, source: "conversation" };
  }

  return { key: `ip:${fallbackKey}`, source: "ip" };
};

/**
 * Describe la configuración de resolución de IP, para registrarla en el arranque.
 *
 * Una configuración errónea de `trustedHops` no produce ningún error visible: el
 * limitador simplemente deja de limitar (si se toma una entrada falsificable) o limita a
 * todo el mundo junto (si se toma la del balanceador). Dejar constancia en el log de
 * arranque es la forma más barata de que eso se detecte.
 *
 * @param {number} trustedHops
 * @returns {{trusted_proxy_hops: number, note: string}}
 */
export const describeIpResolution = (trustedHops) => ({
  trusted_proxy_hops: trustedHops,
  note:
    trustedHops === 1
      ? "Cloud Run expuesto directamente: se toma la última entrada de X-Forwarded-For."
      : "Balanceador de GCP por delante: se toma la penúltima entrada de X-Forwarded-For."
});
