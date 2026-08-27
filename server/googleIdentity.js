/**
 * Token de identidad del service account (OIDC) para llamar servicios protegidos.
 *
 * El navegador no puede firmar un `google_sa_jwt`: exigiría la llave privada del service
 * account dentro del bundle, que es exactamente la vulnerabilidad H-01 que este repo ya
 * cerró con la clave de Gemini. El token se pide aquí, al metadata server de Cloud Run,
 * que solo responde a procesos que corren dentro de la instancia.
 *
 * Fuera de GCP el metadata server no existe. `getToken` devuelve null y el llamador
 * decide qué hacer; en local eso significa llamar al RPA sin credencial, que es lo que
 * se quiere para desarrollo.
 */

import { warning, error } from "./logging.js";

const METADATA_BASE = "http://metadata.google.internal";
const IDENTITY_PATH = "/computeMetadata/v1/instance/service-accounts/default/identity";

/** El metadata server es local. Si tarda más que esto, no está. */
const METADATA_TIMEOUT_MS = 3_000;

/** Margen de renovación: un token de una hora se renueva a los 55 minutos. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * Cuánto esperar antes de reintentar tras un fallo. Sin esto, cada petición del widget
 * dispararía un intento contra un metadata server que no está, y en local eso son tres
 * segundos de espera por llamada.
 */
const FAILURE_BACKOFF_MS = 60_000;

/**
 * Lee el `exp` de un JWT sin verificar la firma.
 *
 * No hay nada que verificar: el token lo acaba de emitir el metadata server por un canal
 * local, no llega de fuera. El `exp` se lee solo para saber cuándo renovarlo.
 *
 * @param {string} token
 * @returns {number} Epoch en milisegundos, o 0 si no se puede leer.
 */
export const readTokenExpiry = (token) => {
  const segments = String(token || "").split(".");
  if (segments.length < 2) return 0;

  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
};

/**
 * Proveedor de tokens de identidad, con caché por audiencia.
 *
 * @param {Object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]   Inyectable para las pruebas.
 * @param {() => number} [deps.now]
 * @param {string} [deps.metadataBase]      Inyectable para las pruebas.
 */
export const createIdentityTokenProvider = ({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  metadataBase = METADATA_BASE
} = {}) => {
  /**
   * Caché por audiencia. Un token sirve para una sola audiencia, así que la clave del
   * mapa es la audiencia.
   *
   * @type {Map<string, {token: string, expiresAt: number}>}
   */
  const cache = new Map();

  /**
   * Momento a partir del cual se puede volver a intentar tras un fallo.
   * @type {Map<string, number>}
   */
  const backoffUntil = new Map();

  /** Para no repetir el mismo aviso en cada petición. */
  const warned = new Set();

  /**
   * Pide un token nuevo al metadata server.
   *
   * @param {string} audience
   * @returns {Promise<string|null>}
   */
  const fetchToken = async (audience) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);

    try {
      const url =
        `${metadataBase}${IDENTITY_PATH}?audience=${encodeURIComponent(audience)}&format=full`;

      const response = await fetchImpl(url, {
        headers: { "Metadata-Flavor": "Google" },
        signal: controller.signal
      });

      if (!response.ok) {
        // El cuerpo puede describir el estado del service account: se queda en el log.
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        error("identity_token_rejected", { status: response.status, detail });
        return null;
      }

      const token = (await response.text()).trim();
      // El metadata server devuelve el JWT en crudo, sin envolverlo en JSON.
      return token === "" ? null : token;
    } catch (err) {
      const aborted = err?.name === "AbortError";
      if (!warned.has(audience)) {
        warned.add(audience);
        warning("identity_metadata_unreachable", {
          audience,
          reason: aborted ? `timeout tras ${METADATA_TIMEOUT_MS}ms` : err?.message,
          note:
            "Sin metadata server no se puede firmar el JWT. Es lo esperado fuera de GCP: " +
            "en local el RPA se llama sin credencial."
        });
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    /**
     * Token vigente para una audiencia, renovándolo si hace falta.
     *
     * @param {string} audience
     * @returns {Promise<string|null>} null si no se pudo obtener.
     */
    async getToken(audience) {
      const key = String(audience || "").trim();
      if (key === "") return null;

      const current = now();

      const cached = cache.get(key);
      if (cached && cached.expiresAt - REFRESH_MARGIN_MS > current) {
        return cached.token;
      }

      const retryAt = backoffUntil.get(key);
      if (retryAt !== undefined && retryAt > current) {
        return null;
      }

      const token = await fetchToken(key);
      if (token === null) {
        backoffUntil.set(key, current + FAILURE_BACKOFF_MS);
        return null;
      }

      const expiresAt = readTokenExpiry(token);
      cache.set(key, {
        token,
        // Sin `exp` legible se asume la vida mínima habitual, para renovar pronto en vez
        // de quedarse con un token que quizá ya venció.
        expiresAt: expiresAt > 0 ? expiresAt : current + REFRESH_MARGIN_MS + 60_000
      });
      backoffUntil.delete(key);
      warned.delete(key);

      return token;
    },

    /** Estado de la caché, para el log de arranque y las pruebas. */
    snapshot() {
      return { cached_audiences: cache.size, backed_off: backoffUntil.size };
    },

    /** Solo para pruebas. */
    reset() {
      cache.clear();
      backoffUntil.clear();
      warned.clear();
    }
  };
};
