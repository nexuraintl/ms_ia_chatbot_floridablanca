/**
 * Proxy de los RPA. Mismo patrón que `aiProxy.js`: la credencial vive aquí y no en el
 * navegador.
 *
 * Por qué existe: el API Gateway protege las rutas de los RPA con `google_sa_jwt`, y un
 * navegador no puede firmar ese token. Necesitaría la llave privada del service account
 * dentro del bundle, que es la vulnerabilidad H-01 que este repo ya cerró con la clave de
 * Gemini. Dos de las rutas no podrían llevar la cabecera ni queriendo: el stream usa
 * `EventSource` y la factura se abre como enlace de descarga, y ninguno de los dos admite
 * cabeceras personalizadas.
 *
 * Esta primera entrega cubre las cuatro rutas de JSON plano. El relay de SSE
 * (`jobs/{jobId}/stream`) y el paso del PDF (`facturas/{filename}`) quedan pendientes:
 * ver `docs/MANUAL.md`.
 *
 * Alcance deliberadamente cerrado: `ROUTES` es una lista blanca, no un passthrough
 * genérico. Un proxy que reenvía cualquier ruta que le llegue es un relé abierto hacia la
 * red interna.
 *
 * No sale de aquí el cuerpo de las peticiones: lleva documento, teléfono y correo del
 * ciudadano (Ley 1581). Los logs registran la ruta y el estado, nunca el payload.
 */

import { createRateLimiter } from "./rateLimit.js";
import { resolveClientIp, DEFAULT_TRUSTED_HOPS } from "./clientIdentity.js";
import { CORRELATION_HEADER, CONVERSATION_HEADER, getTraceContext } from "./correlation.js";
import { isOriginAllowed } from "./corsPolicy.js";
import { createIdentityTokenProvider } from "./googleIdentity.js";
import { info, warning, error } from "./logging.js";

/**
 * Rutas expuestas al navegador y su equivalente en el RPA.
 *
 * `path` sigue la nomenclatura del gateway (`/rpa/factura/v1/...`) y `upstream` es lo que
 * el RPA expone hoy (`/api/...`). Esa traducción es el motivo por el que el RPA no tiene
 * que cambiar sus rutas: el desajuste entre `/api` y `/v1` se resuelve en esta tabla.
 *
 * @type {ReadonlyArray<{path: string, methods: string[], upstream: string, query: string[]}>}
 */
export const ROUTES = Object.freeze([
  {
    path: "/rpa/factura/v1/clientes",
    methods: ["GET"],
    upstream: "/api/clientes",
    query: []
  },
  {
    // El frontend lo llama por POST sin cuerpo; el gateway lo declara para ambos métodos.
    path: "/rpa/factura/v1/prewarm",
    methods: ["GET", "POST"],
    upstream: "/api/prewarm",
    query: ["cliente"]
  },
  {
    path: "/rpa/factura/v1/generar_factura",
    methods: ["POST"],
    upstream: "/api/generar_factura",
    query: ["mode"]
  },
  {
    path: "/rpa/factura/v1/seleccionar_predio",
    methods: ["POST"],
    upstream: "/api/seleccionar_predio",
    query: ["mode"]
  }
]);

/** Prefijo común, para descartar rápido lo que no es del proxy. */
export const RPA_PATH_PREFIX = "/rpa/factura/v1/";

/**
 * Tope del cuerpo aceptado. Los payloads de estas rutas son un puñado de campos
 * (tipo de búsqueda, valor, teléfono, correo): 8 KB sobran.
 */
const MAX_BODY_BYTES = 8 * 1024;

/** Tope de la respuesta del RPA que se acepta retransmitir. */
const MAX_RESPONSE_BYTES = 256 * 1024;

/** Tope de longitud de un valor de query, para no reenviar cadenas absurdas. */
const MAX_QUERY_VALUE_CHARS = 200;

/** Motivos que el cliente puede interpretar. Forman parte del contrato del endpoint. */
export const RPA_REASONS = Object.freeze({
  NOT_CONFIGURED: "rpa_not_configured",
  FORBIDDEN_ORIGIN: "forbidden_origin",
  RATE_LIMITED: "rate_limited",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  INVALID_PAYLOAD: "invalid_payload",
  UPSTREAM_UNAVAILABLE: "rpa_unavailable"
});

/**
 * Lee una variable numérica del entorno.
 * @param {string} name
 * @param {number} fallback
 * @param {NodeJS.ProcessEnv} env
 */
const readNumber = (name, fallback, env = process.env) => {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const normalizeBase = (url) => String(url || "").trim().replace(/\/+$/, "");

/**
 * Configuración del proxy.
 *
 * `RPA_PREDIAL_API_URL` es nueva y es de RUNTIME, no de compilación: a diferencia de
 * `VITE_RPA_PREDIAL_API_URL`, que Vite incrusta en el bundle público, esta la lee el
 * servidor y nunca llega al navegador.
 *
 * La audiencia por defecto es la propia URL del destino, que es la convención cuando se
 * llama a un Cloud Run. Si el destino es el gateway, hay que fijarla explícitamente a la
 * URL del gateway con `RPA_PREDIAL_AUDIENCE`.
 */
export const createRpaProxyConfig = (env = process.env) => ({
  predialBaseUrl: normalizeBase(env.RPA_PREDIAL_API_URL),
  predialAudience: normalizeBase(env.RPA_PREDIAL_AUDIENCE || env.RPA_PREDIAL_API_URL),
  ratePerMinute: readNumber("RPA_RATE_LIMIT_PER_MINUTE", 20, env),
  // El RPA navega un portal externo y resuelve un captcha. Mismo techo que usa el
  // frontend en `rpaPredialService.js`.
  requestTimeoutMs: readNumber("RPA_REQUEST_TIMEOUT_MS", 60_000, env),
  trustedProxyHops: readNumber("TRUSTED_PROXY_HOPS", DEFAULT_TRUSTED_HOPS, env),
  allowedOrigins: String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().toLowerCase())
    .filter((o) => o !== ""),
  isLocal: String(env.ENVIRONMENT || "local").toLowerCase() === "local"
});

/**
 * Busca la ruta que corresponde a un path, ignorando la barra final.
 *
 * @param {string} urlPath
 * @returns {(typeof ROUTES)[number]|undefined}
 */
export const matchRoute = (urlPath) => {
  const clean = String(urlPath || "").replace(/\/+$/, "") || "/";
  return ROUTES.find((route) => route.path === clean);
};

/**
 * Copia al destino solo los parámetros de query declarados en la ruta.
 *
 * Lista blanca y no passthrough: reenviar la query entera dejaría que el navegador
 * inyectara parámetros que el RPA interprete y que aquí no se están revisando.
 *
 * @param {string} rawUrl
 * @param {string[]} allowed
 * @returns {URLSearchParams}
 */
export const buildQuery = (rawUrl, allowed) => {
  const out = new URLSearchParams();
  if (allowed.length === 0) return out;

  let incoming;
  try {
    // La base es irrelevante: solo se necesita parsear la parte de query.
    incoming = new URL(rawUrl, "http://localhost").searchParams;
  } catch {
    return out;
  }

  for (const key of allowed) {
    const value = incoming.get(key);
    if (value === null || value === "") continue;
    out.set(key, value.slice(0, MAX_QUERY_VALUE_CHARS));
  }
  return out;
};

/**
 * Crea el manejador del proxy.
 *
 * @param {Object} [deps]
 * @param {ReturnType<createRpaProxyConfig>} [deps.config]
 * @param {typeof fetch} [deps.fetchImpl]  Inyectable para las pruebas.
 * @param {() => number} [deps.now]
 * @param {ReturnType<createIdentityTokenProvider>} [deps.identity]
 */
export const createRpaProxyHandler = ({
  config = createRpaProxyConfig(),
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  identity = createIdentityTokenProvider({ fetchImpl, now })
} = {}) => {
  /**
   * Limitador por IP.
   *
   * Con el proxy en medio, el gateway ya no ve al ciudadano: ve a este servicio. O sea
   * que este limitador es lo único que separa al público del RPA, y una llamada al RPA
   * cuesta una sesión de navegador contra el portal municipal.
   */
  const burstLimiter = createRateLimiter({
    windowMs: 60_000,
    max: config.ratePerMinute,
    now
  });

  /**
   * @param {string|undefined} origin
   * @param {string[]} methods
   */
  const corsHeaders = (origin, methods) => ({
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": `${methods.join(", ")}, OPTIONS`,
    "Access-Control-Allow-Headers": `Content-Type, ${CORRELATION_HEADER}, ${CONVERSATION_HEADER}`,
    "Access-Control-Max-Age": "3600"
  });

  /**
   * @param {import("node:http").ServerResponse} res
   * @param {number} status
   * @param {Object} payload
   * @param {string|undefined} origin
   * @param {string[]} methods
   * @param {Object} [extraHeaders]
   */
  const send = (res, status, payload, origin, methods, extraHeaders = {}) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(origin, methods),
      ...extraHeaders
    });
    res.end(body);
    return status;
  };

  /**
   * Lee el cuerpo con tope de bytes.
   *
   * Igual que en `aiProxy`: pasado el tope NO se destruye el socket, porque cerrarlo
   * impediría que el 413 llegara al cliente. Se resuelve de inmediato y el resto se drena.
   *
   * @param {import("node:http").IncomingMessage} req
   * @returns {Promise<{ok: true, text: string}|{ok: false, tooLarge: true}>}
   */
  const readBody = (req) =>
    new Promise((resolve) => {
      let size = 0;
      /** @type {Buffer[]} */
      const chunks = [];
      let aborted = false;

      req.on("data", (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          aborted = true;
          resolve({ ok: false, tooLarge: true });
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (!aborted) resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
      });

      req.on("error", () => {
        if (!aborted) {
          aborted = true;
          resolve({ ok: true, text: "" });
        }
      });
    });

  /**
   * Llama al RPA.
   *
   * @param {Object} params
   * @param {(typeof ROUTES)[number]} params.route
   * @param {string} params.method
   * @param {URLSearchParams} params.query
   * @param {string|undefined} params.body
   * @returns {Promise<{ok: true, status: number, payload: unknown}|{ok: false, detail: string, status: number}>}
   */
  const callUpstream = async ({ route, method, query, body }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    const suffix = query.toString();
    const url = `${config.predialBaseUrl}${route.upstream}${suffix ? `?${suffix}` : ""}`;

    try {
      const token = await identity.getToken(config.predialAudience);

      /** @type {Record<string, string>} */
      const headers = { Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (token) headers.Authorization = `Bearer ${token}`;

      // Propagar la correlación. Hoy la cadena se rompe aquí, porque el navegador no
      // puede añadir cabeceras a un tercero: con el proxy en medio vuelve a ser continua.
      const trace = getTraceContext();
      if (trace?.correlationId) headers[CORRELATION_HEADER] = trace.correlationId;

      const response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal
      });

      const raw = (await response.text()).slice(0, MAX_RESPONSE_BYTES);

      let payload;
      try {
        payload = raw === "" ? {} : JSON.parse(raw);
      } catch {
        // El RPA devolvió algo que no es JSON: casi siempre una página de error de la
        // infraestructura. No se retransmite tal cual.
        return {
          ok: false,
          status: response.status,
          detail: `respuesta no-JSON: ${raw.slice(0, 200)}`
        };
      }

      // Se retransmite el estado y el cuerpo del RPA incluso en error: el traductor de
      // dominio (`rpaErrorTranslator`) reconoce esos mensajes ("paz y salvo", "pasarela
      // ocupada") y sin ellos el ciudadano recibiría un texto genérico.
      return { ok: true, status: response.status, payload };
    } catch (err) {
      const aborted = err?.name === "AbortError";
      return {
        ok: false,
        status: 0,
        detail: aborted
          ? `timeout tras ${config.requestTimeoutMs}ms`
          : `fallo de red: ${err?.message}`
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    /** ¿Este path lo atiende el proxy? */
    matches(urlPath) {
      return matchRoute(urlPath) !== undefined;
    },

    /** Estado para el log de arranque. */
    snapshot() {
      return {
        routes: ROUTES.length,
        configured: config.predialBaseUrl !== "",
        tracked_ips: burstLimiter.size,
        ...identity.snapshot()
      };
    },

    /** Reinicia los contadores. Solo para pruebas. */
    reset() {
      burstLimiter.reset();
      identity.reset();
    },

    /**
     * Atiende una petición al proxy.
     *
     * @param {import("node:http").IncomingMessage} req
     * @param {import("node:http").ServerResponse} res
     * @returns {Promise<number>} Código de estado, para el log de la petición.
     */
    async handle(req, res) {
      const origin = req.headers.origin;
      const urlPath = (req.url || "/").split("?")[0];
      const route = matchRoute(urlPath);

      // `handle` solo se invoca tras `matches`, pero no se asume: sin ruta no hay ni
      // métodos con los que construir las cabeceras de CORS.
      if (!route) {
        return send(res, 404, { error: "Not Found" }, origin, ["GET"]);
      }

      if (!isOriginAllowed(origin, req.headers.host, config)) {
        warning("rpa_origin_rejected", {
          path: route.path,
          origin: String(origin).slice(0, 120)
        });
        // Sin cabeceras CORS a propósito: al navegador no se le concede el permiso.
        return send(
          res,
          403,
          { error: "Forbidden", reason: RPA_REASONS.FORBIDDEN_ORIGIN },
          undefined,
          route.methods
        );
      }

      // Preflight antes de cualquier límite: bloquearlo dejaría al navegador sin saber
      // por qué falla la petición real.
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(origin, route.methods));
        res.end();
        return 204;
      }

      if (!route.methods.includes(req.method || "")) {
        return send(res, 405, { error: "Method Not Allowed" }, origin, route.methods, {
          Allow: `${route.methods.join(", ")}, OPTIONS`
        });
      }

      // Antes de leer el cuerpo: a un bot no se le dedica ni el ancho de banda de su
      // propio payload.
      const ip = resolveClientIp(req, { trustedHops: config.trustedProxyHops });
      const burst = burstLimiter.hit(ip);
      if (!burst.allowed) {
        warning("rpa_rate_limited", {
          path: route.path,
          client_ip: ip,
          used: burst.used,
          limit: burst.limit
        });
        return send(
          res,
          429,
          {
            error: "Too Many Requests",
            reason: RPA_REASONS.RATE_LIMITED,
            retryAfterSeconds: burst.retryAfterSeconds
          },
          origin,
          route.methods,
          { "Retry-After": String(burst.retryAfterSeconds) }
        );
      }

      if (config.predialBaseUrl === "") {
        warning("rpa_not_configured", {
          path: route.path,
          note: "RPA_PREDIAL_API_URL no está definida: el proxy no sabe a dónde llamar."
        });
        return send(
          res,
          503,
          { error: "RPA unavailable", reason: RPA_REASONS.NOT_CONFIGURED },
          origin,
          route.methods
        );
      }

      // ── Cuerpo ────────────────────────────────────────────────────────────
      /** @type {string|undefined} */
      let body;
      if (req.method === "POST") {
        const read = await readBody(req);
        if (!read.ok) {
          return send(
            res,
            413,
            { error: "Payload Too Large", reason: RPA_REASONS.PAYLOAD_TOO_LARGE },
            origin,
            route.methods
          );
        }

        if (read.text.trim() !== "") {
          // Se reserializa en vez de reenviar el texto crudo: valida que sea JSON y
          // normaliza lo que llega al RPA. `prewarm` se llama sin cuerpo, y ese caso pasa
          // sin body en lugar de con un `{}` que el RPA no espera.
          try {
            body = JSON.stringify(JSON.parse(read.text));
          } catch {
            return send(
              res,
              400,
              { error: "Invalid JSON", reason: RPA_REASONS.INVALID_PAYLOAD },
              origin,
              route.methods
            );
          }
        }
      }

      const startedAt = now();
      const result = await callUpstream({
        route,
        method: req.method || "GET",
        query: buildQuery(req.url || "", route.query),
        body
      });
      const durationMs = now() - startedAt;

      if (!result.ok) {
        // El detalle técnico describe el estado del RPA: se queda en el log del servidor.
        error("rpa_upstream_failed", {
          path: route.path,
          upstream_status: result.status,
          detail: result.detail,
          duration_ms: durationMs
        });
        return send(
          res,
          503,
          { error: "RPA unavailable", reason: RPA_REASONS.UPSTREAM_UNAVAILABLE },
          origin,
          route.methods
        );
      }

      // Nunca el cuerpo en el log: lleva documento, teléfono y correo.
      info("rpa_proxied", {
        path: route.path,
        method: req.method,
        upstream_status: result.status,
        duration_ms: durationMs
      });

      return send(res, result.status, result.payload, origin, route.methods);
    }
  };
};
