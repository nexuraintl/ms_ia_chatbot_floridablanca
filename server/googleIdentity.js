/**
 * Identity tokens de Google (OIDC) para llamar a los Cloud Run protegidos por IAM.
 *
 * El `audience` de un identity token es la URL del servicio destino, asi que hay un token
 * POR SERVICIO y la cache va indexada por audience. Compartir un token entre los dos
 * servicios da 401 en el segundo, y el 401 no menciona el audience.
 *
 * Nunca hay un token literal en el codigo ni en el entorno, ni una llave JSON de service
 * account: el servidor de metadatos de Cloud Run acuña el token sin llaves.
 *
 * El mecanismo es una decision por ambiente (`RPA_AUTH_MODE`), no un `if` sembrado por el
 * codigo. Ver docs/INTEGRACION_RPA.md.
 */

import { spawnSync } from "node:child_process";

import { info, warning, error } from "./logging.js";

/** Servidor de metadatos de Cloud Run. Acuña el token sin llaves. */
const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

/** Margen de renovacion: se pide uno nuevo antes de que el vigente expire. */
const RENEW_MARGIN_MS = 300_000;

/** Vida asumida cuando el token no trae `exp` legible. */
const FALLBACK_TTL_MS = 3_600_000;

/** Timeout de la acuñacion. El metadata server responde en milisegundos; esto es red caida. */
const MINT_TIMEOUT_MS = 10_000;

/**
 * Mecanismos de obtencion del token.
 *
 *   metadata    Cloud Run directo, o gateway con `x-google-issuer: accounts.google.com`.
 *               Equivale a `fetch_id_token(request, audience)`.
 *   gcloud      Solo desarrollo. Acuña con la credencial del desarrollador, sin llaves.
 *   none        Servicios locales sin IAM. No se envia cabecera.
 *   signed_jwt  Gateway con `x-google-issuer` = email de la SA del cliente. NO implementado
 *               a proposito: es otro mecanismo (IAM Credentials `signJwt`) y otro permiso.
 *               Ver docs/INTEGRACION_RPA.md.
 */
export const AUTH_MODES = Object.freeze({
  METADATA: "metadata",
  GCLOUD: "gcloud",
  NONE: "none",
  SIGNED_JWT: "signed_jwt"
});

/** Error de acuñacion. `reason` es estable y forma parte del contrato de diagnostico. */
export class IdentityTokenError extends Error {
  /**
   * @param {string} message
   * @param {{reason: string, audience?: string, status?: number}} opts
   */
  constructor(message, { reason, audience = "", status = 0 }) {
    super(message);
    this.name = "IdentityTokenError";
    this.reason = reason;
    this.audience = audience;
    this.status = status;
  }
}

/**
 * Lee el `exp` de un JWT sin verificar la firma. El token es nuestro y lo acaba de emitir
 * Google; aqui solo interesa cuando caduca para programar la renovacion.
 *
 * @param {string} token
 * @returns {number} Instante de expiracion en ms, o 0 si no se pudo leer.
 */
export const readTokenExpiry = (token) => {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
};

/**
 * Valida un audience antes de usarlo. Una barra final sobrante devuelve 401 y el 401 no dice
 * por que, asi que se rechaza aqui donde si se puede explicar.
 *
 * @param {string} audience
 * @returns {string} El audience validado.
 */
export const assertValidAudience = (audience) => {
  const value = String(audience || "").trim();

  if (value === "") {
    throw new IdentityTokenError("El audience esta vacio", { reason: "audience_missing" });
  }
  if (value.endsWith("/")) {
    throw new IdentityTokenError(
      `El audience "${value}" termina en barra. Debe ser la URL exacta sin barra final: ` +
        "una barra sobrante devuelve 401.",
      { reason: "audience_trailing_slash", audience: value }
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new IdentityTokenError(`El audience "${value}" no es una URL valida`, {
      reason: "audience_malformed",
      audience: value
    });
  }

  const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !isLoopback) {
    throw new IdentityTokenError(
      `El audience "${value}" no usa https. Un Cloud Run con IAM solo acepta https.`,
      { reason: "audience_insecure", audience: value }
    );
  }
  return value;
};

/**
 * Acuña un token contra el servidor de metadatos.
 *
 * @param {string} audience
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string>}
 */
const mintFromMetadata = async (audience, fetchImpl) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);

  try {
    const url = `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}`;
    const response = await fetchImpl(url, {
      headers: { "Metadata-Flavor": "Google" },
      signal: controller.signal
    });
    const body = (await response.text()).trim();

    if (!response.ok) {
      throw new IdentityTokenError(
        `El servidor de metadatos respondio ${response.status}: ${body.slice(0, 200)}`,
        { reason: "metadata_rejected", audience, status: response.status }
      );
    }
    if (body.split(".").length !== 3) {
      // Fuera de GCP este host no existe; si algo responde, no es un JWT.
      throw new IdentityTokenError(
        "El servidor de metadatos no devolvio un JWT. Fuera de Cloud Run usa RPA_AUTH_MODE=gcloud o none.",
        { reason: "metadata_not_a_jwt", audience }
      );
    }
    return body;
  } catch (err) {
    if (err instanceof IdentityTokenError) throw err;
    const aborted = err?.name === "AbortError";
    throw new IdentityTokenError(
      aborted
        ? `El servidor de metadatos no respondio en ${MINT_TIMEOUT_MS}ms`
        : `No se pudo contactar el servidor de metadatos: ${err?.message}`,
      { reason: aborted ? "metadata_timeout" : "metadata_unreachable", audience }
    );
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Acuña un token con la credencial del desarrollador. Solo para desarrollo: en la imagen de
 * Cloud Run no existe el binario y el modo correcto alli es `metadata`.
 *
 * Se invoca con argumentos separados y sin shell, para que el audience no pueda inyectar
 * comandos.
 *
 * @param {string} audience
 * @returns {string}
 */
const mintFromGcloudCli = (audience) => {
  const result = spawnSync(
    process.platform === "win32" ? "gcloud.cmd" : "gcloud",
    ["auth", "print-identity-token", `--audiences=${audience}`],
    { encoding: "utf8", timeout: MINT_TIMEOUT_MS, shell: false }
  );

  if (result.error || result.status !== 0) {
    const detail = result.error?.message || String(result.stderr || "").trim().slice(0, 200);
    throw new IdentityTokenError(`gcloud no pudo acuñar el token: ${detail}`, {
      reason: "gcloud_failed",
      audience
    });
  }

  const token = String(result.stdout || "").trim();
  if (token.split(".").length !== 3) {
    throw new IdentityTokenError("gcloud no devolvio un JWT", {
      reason: "gcloud_not_a_jwt",
      audience
    });
  }
  return token;
};

/**
 * Crea el proveedor de tokens.
 *
 * La cache es por audience, y una acuñacion en vuelo se comparte entre las llamadas
 * concurrentes al mismo audience: es una peticion de red y no vale lanzar N en paralelo por
 * una rafaga.
 *
 * @param {Object} [deps]
 * @param {string} [deps.mode]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {(audience: string) => Promise<string>|string} [deps.mintImpl] Inyectable en pruebas.
 */
export const createIdentityTokenProvider = ({
  mode = process.env.RPA_AUTH_MODE || AUTH_MODES.METADATA,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  mintImpl
} = {}) => {
  /** @type {Map<string, {token: string, expiresAt: number}>} */
  const cache = new Map();
  /** @type {Map<string, Promise<string>>} Acuñaciones en vuelo, para no duplicarlas. */
  const inFlight = new Map();

  const resolvedMode = String(mode || "").trim().toLowerCase() || AUTH_MODES.METADATA;

  if (!Object.values(AUTH_MODES).includes(resolvedMode)) {
    throw new IdentityTokenError(
      `RPA_AUTH_MODE="${resolvedMode}" no es valido. Opciones: ${Object.values(AUTH_MODES).join(", ")}.`,
      { reason: "mode_invalid" }
    );
  }

  const mint = async (audience) => {
    if (mintImpl) return await mintImpl(audience);
    if (resolvedMode === AUTH_MODES.GCLOUD) return mintFromGcloudCli(audience);
    if (resolvedMode === AUTH_MODES.SIGNED_JWT) {
      throw new IdentityTokenError(
        "RPA_AUTH_MODE=signed_jwt no esta implementado. Exige IAM Credentials signJwt y el rol " +
          "roles/iam.serviceAccountTokenCreator sobre la propia SA. Confirmar antes con plataforma " +
          "cual x-google-issuer tiene el gateway: si es accounts.google.com basta " +
          "RPA_AUTH_MODE=metadata con el host del gateway como audience.",
        { reason: "signed_jwt_not_implemented", audience }
      );
    }
    return await mintFromMetadata(audience, fetchImpl);
  };

  return {
    mode: resolvedMode,

    /** ¿Este ambiente envia cabecera de autorizacion? */
    get enabled() {
      return resolvedMode !== AUTH_MODES.NONE;
    },

    /**
     * Token vigente para un audience. Renueva `RENEW_MARGIN_MS` antes de expirar.
     *
     * @param {string} audience URL exacta del servicio destino, sin barra final.
     * @returns {Promise<string>}
     */
    async token(audience) {
      if (resolvedMode === AUTH_MODES.NONE) return "";

      const key = assertValidAudience(audience);

      const cached = cache.get(key);
      if (cached && now() < cached.expiresAt - RENEW_MARGIN_MS) {
        return cached.token;
      }

      const pending = inFlight.get(key);
      if (pending) return await pending;

      const promise = (async () => {
        const token = await mint(key);
        const expiresAt = readTokenExpiry(token) || now() + FALLBACK_TTL_MS;
        cache.set(key, { token, expiresAt });
        info("rpa_token_minted", {
          audience: key,
          mode: resolvedMode,
          expires_in_s: Math.round((expiresAt - now()) / 1000)
        });
        return token;
      })();

      inFlight.set(key, promise);
      try {
        return await promise;
      } finally {
        inFlight.delete(key);
      }
    },

    /**
     * Cabecera de autorizacion para un servicio. Objeto vacio en modo `none`, de forma que
     * quien llama no tenga que ramificar.
     *
     * @param {string} audience
     * @returns {Promise<Record<string, string>>}
     */
    async headers(audience) {
      if (resolvedMode === AUTH_MODES.NONE) return {};
      return { Authorization: `Bearer ${await this.token(audience)}` };
    },

    /** Descarta un token cacheado. Se usa tras un 401, para no repetirlo hasta su expiracion. */
    invalidate(audience) {
      const removed = cache.delete(String(audience || ""));
      if (removed) warning("rpa_token_invalidated", { audience });
      return removed;
    },

    /** Estado de la cache, para diagnostico y pruebas. */
    stats() {
      return {
        mode: resolvedMode,
        cached_audiences: cache.size,
        audiences: Array.from(cache.keys())
      };
    },

    /** Solo para pruebas. */
    reset() {
      cache.clear();
      inFlight.clear();
    }
  };
};

/**
 * Avisa en el arranque si el mecanismo elegido no encaja con el ambiente. No lanza: la
 * validacion que si corta el arranque es la de `startupChecks.js`.
 *
 * @param {string} mode
 * @param {string} environment
 */
export const warnIfModeLooksWrong = (mode, environment) => {
  const isLocal = String(environment || "").toLowerCase() === "local";

  if (mode === AUTH_MODES.NONE && !isLocal) {
    error("rpa_auth_disabled_outside_local", {
      mode,
      environment,
      note: "RPA_AUTH_MODE=none no envia token. Contra un Cloud Run con IAM todo dara 403."
    });
  }
  if (mode === AUTH_MODES.GCLOUD && !isLocal) {
    warning("rpa_auth_gcloud_outside_local", {
      mode,
      environment,
      note: "El modo gcloud es de desarrollo: el binario no existe en la imagen de Cloud Run."
    });
  }
};
