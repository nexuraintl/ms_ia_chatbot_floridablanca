/**
 * Correlación de peticiones (GOB-GCP-STD-01). Capa de dominio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTE MÓDULO EXISTE EN UN FRONTEND
 *
 * El estándar exige que cada microservicio genere o propague `X-Correlation-ID`. Ese
 * requisito está escrito desde la perspectiva del servicio que RECIBE una petición.
 *
 * Pero este widget es el ORIGEN de la traza: cuando un ciudadano consulta su predial,
 * la cadena empieza en su navegador y sigue por el RPA de Predial, el de PQRSD y el
 * backend de conversaciones. Si el frontend no emite el identificador, cada
 * microservicio genera el suyo propio y la traza nace rota: ante un fallo del RPA no
 * hay forma de vincular ese log con la conversación que lo provocó.
 *
 * Así que aquí el estándar se cumple emitiendo, no propagando.
 *
 * DOS IDENTIFICADORES, DOS PROPÓSITOS
 *
 *   · `X-Correlation-ID`  — uno por PETICIÓN. Es el que exige el estándar y el que
 *                           permite seguir una llamada concreta entre servicios.
 *   · `X-Conversation-ID` — estable durante toda la conversación. Permite agrupar
 *                           todas las peticiones de una misma atención ciudadana.
 *
 * AVISO SOBRE CORS: enviar cabeceras personalizadas en peticiones cross-origin obliga
 * al navegador a hacer una petición previa de tipo OPTIONS (preflight). Si el
 * microservicio destino no incluye estas cabeceras en `Access-Control-Allow-Headers`,
 * la petición FALLA y el trámite se rompe. Por eso el envío es configurable
 * (`chatbotConfig.json > observability.sendCorrelationId`): implementa el estándar,
 * pero se puede desactivar en una línea si algún backend aún no lo admite.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Nombres de cabecera, según GOB-GCP-STD-01. */
export const CORRELATION_HEADER = "X-Correlation-ID";
export const CONVERSATION_HEADER = "X-Conversation-ID";

/**
 * Genera un identificador de correlación.
 * Usa `crypto.randomUUID` cuando está disponible, igual que el `uuid.uuid4()` que el
 * estándar especifica para los middlewares en Python.
 *
 * @returns {string}
 */
export const createCorrelationId = () => {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  if (cryptoObj?.getRandomValues) {
    const buf = new Uint8Array(16);
    cryptoObj.getRandomValues(buf);
    // Formatear como UUID v4 para que sea indistinguible de los que emiten los servicios.
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Último recurso: sin API de criptografía disponible.
  return `cid-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
};

/** Configuración del módulo, inyectada al arrancar. */
let config = {
  enabled: true,
  conversationId: null
};

/**
 * Configura la emisión de cabeceras de correlación.
 *
 * @param {Object} next
 * @param {boolean} [next.enabled]
 * @param {string|null} [next.conversationId]
 */
export const configureCorrelation = (next = {}) => {
  config = {
    enabled: next.enabled ?? config.enabled,
    conversationId: next.conversationId ?? config.conversationId
  };
};

/** Identificador de conversación vigente, para agrupar peticiones. */
export const getConversationId = () => config.conversationId;

/**
 * Construye las cabeceras de correlación para una petición saliente.
 * Devuelve un objeto vacío si la emisión está desactivada, de modo que quien llama no
 * necesita ramificar.
 *
 * @param {string} [correlationId] Identificador a usar; si no se da, se genera uno.
 * @returns {Record<string, string>}
 */
export const buildCorrelationHeaders = (correlationId) => {
  if (!config.enabled) return {};

  const headers = { [CORRELATION_HEADER]: correlationId || createCorrelationId() };
  if (config.conversationId) {
    headers[CONVERSATION_HEADER] = config.conversationId;
  }
  return headers;
};
