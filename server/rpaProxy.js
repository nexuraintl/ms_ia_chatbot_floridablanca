/**
 * Proxy de los microservicios RPA. Monta `/rpa/factura/*` y `/rpa/pqrsd/*`.
 *
 * Existe porque los dos servicios exigen un identity token de Google y el navegador no puede
 * acuñar uno: hacerlo requeriria una llave de service account en el cliente. El token se pone
 * aqui, por servicio, y al navegador solo se le expone este origen.
 *
 * Lo que aporta ademas de la cabecera:
 *   · Lista blanca de rutas y metodos. El proxy es publico y detras hay endpoints que crean
 *     tramites oficiales irreversibles y gastan captchas pagados.
 *   · Lista blanca de parametros de query, para que ningun dato personal acabe en una URL.
 *   · Limite de tasa por IP y control de admision del techo de dos tramites simultaneos.
 *   · El PDF de la factura se descarga aqui y se reenvia: el ciudadano nunca recibe una URL
 *     protegida por IAM que su navegador no podria abrir.
 *   · Correlacion en los dos sentidos.
 *
 * Diagnostico de los codigos de error en docs/INTEGRACION_RPA.md.
 */

import { Readable } from "node:stream";

import { isOriginAllowed } from "./aiProxy.js";
import { resolveClientIp, DEFAULT_TRUSTED_HOPS } from "./clientIdentity.js";
import { CORRELATION_HEADER, CONVERSATION_HEADER, getTraceContext } from "./correlation.js";
import { IdentityTokenError } from "./googleIdentity.js";
import { info, warning, error, critical } from "./logging.js";
import { createAdmissionControl, isTerminalJobPayload, DEFAULT_MAX_CONCURRENT } from "./rpaAdmission.js";
import { createRateLimiter } from "./rateLimit.js";
import {
  BODY_KINDS,
  MOUNT_PREFIXES,
  SERVICE_IDS,
  buildUpstreamUrl,
  matchRoute,
  normalizeUpstreamPath
} from "./rpaTargets.js";

/** Motivos que el cliente puede interpretar. Forman parte del contrato del proxy. */
export const RPA_REASONS = Object.freeze({
  NOT_CONFIGURED: "rpa_not_configured",
  FORBIDDEN_ORIGIN: "forbidden_origin",
  ROUTE_UNKNOWN: "route_unknown",
  METHOD_NOT_ALLOWED: "method_not_allowed",
  RATE_LIMITED: "rate_limited",
  QUEUE_FULL: "rpa_queue_full",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  AUTH_UNAVAILABLE: "rpa_auth_unavailable",
  UNAUTHENTICATED: "rpa_unauthenticated",
  FORBIDDEN: "rpa_forbidden",
  INGRESS_BLOCKED: "rpa_ingress_blocked",
  UPSTREAM_UNAVAILABLE: "rpa_upstream_unavailable",
  UPSTREAM_TIMEOUT: "rpa_upstream_timeout"
});

/**
 * Parametros de query que se reenvian. Cualquier otro se descarta: los datos personales van
 * en el cuerpo porque las URLs se registran en los logs de todos los saltos intermedios.
 */
const ALLOWED_QUERY_PARAMS = Object.freeze(["mode", "cliente", "client_id", "q"]);

/**
 * Parametros que consume el proxy y por tanto no se reenvian, pero tampoco son un descarte
 * digno de aviso.
 */
const CONSUMED_QUERY_PARAMS = Object.freeze(["cid"]);

/** Tope del cuerpo JSON. Ninguna peticion del chatbot se acerca. */
const MAX_JSON_BODY_BYTES = 128 * 1024;

/**
 * Tope de una radicacion con anexos. El servicio admite 25 MB en total; se deja margen para
 * los delimitadores del multipart.
 */
const DEFAULT_MAX_UPLOAD_BYTES = 27 * 1024 * 1024;

/** Cabeceras del cliente que se reenvian. El resto se descarta. */
const FORWARDED_REQUEST_HEADERS = Object.freeze(["content-type", "accept"]);

/**
 * Lee una variable numerica del entorno.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {number} fallback
 */
const readNumber = (env, name, fallback) => {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

/**
 * Configuracion del proxy.
 * @param {NodeJS.ProcessEnv} [env]
 */
export const createRpaProxyConfig = (env = process.env) => ({
  /** Peticiones por minuto y por IP, cualquier ruta. */
  ratePerMinute: readNumber(env, "RPA_RATE_LIMIT_PER_MINUTE", 30),
  /**
   * Tramites por hora y por IP. Cada uno abre un navegador y gasta un captcha pagado, asi que
   * el limite es mucho mas estrecho que el de consulta.
   */
  effectfulPerHour: readNumber(env, "RPA_EFFECTFUL_LIMIT_PER_HOUR", 10),
  maxConcurrentTramites: readNumber(env, "RPA_MAX_CONCURRENT_TRAMITES", DEFAULT_MAX_CONCURRENT),
  maxUploadBytes: readNumber(env, "RPA_MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES),
  trustedProxyHops: readNumber(env, "TRUSTED_PROXY_HOPS", DEFAULT_TRUSTED_HOPS),
  allowedOrigins: String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().toLowerCase())
    .filter((o) => o !== ""),
  isLocal: String(env.ENVIRONMENT || "local").toLowerCase() === "local"
});

/**
 * ¿La ruta pertenece a algun servicio montado?
 *
 * @param {string} urlPath
 * @returns {{serviceId: string, prefix: string}|null}
 */
export const matchMount = (urlPath) => {
  const path = String(urlPath || "").split("?")[0];
  for (const serviceId of SERVICE_IDS) {
    const prefix = MOUNT_PREFIXES[serviceId];
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return { serviceId, prefix };
    }
  }
  return null;
};

/**
 * Filtra la query a la lista blanca.
 *
 * @param {string} rawQuery
 * @returns {{query: string, dropped: string[]}}
 */
export const filterQuery = (rawQuery) => {
  const params = new URLSearchParams(rawQuery || "");
  const kept = new URLSearchParams();
  /** @type {string[]} */
  const dropped = [];

  for (const [key, value] of params) {
    if (ALLOWED_QUERY_PARAMS.includes(key)) {
      kept.append(key, value);
    } else if (!CONSUMED_QUERY_PARAMS.includes(key)) {
      // Solo el nombre: el valor puede ser el dato personal que justamente no debe registrarse.
      dropped.push(key);
    }
  }
  return { query: kept.toString(), dropped };
};

/**
 * Clasifica una respuesta del destino en un motivo estable.
 *
 * La distincion que mas tiempo ahorra: un 404 con cuerpo JSON viene de la aplicacion y solo
 * significa que la ruta esta mal; un 404 con HTML viene del balanceador de Google y significa
 * que el trafico no pasa el ingress.
 *
 * @param {number} status
 * @param {string} contentType
 * @returns {{reason: string, safeToForwardBody: boolean}}
 */
export const classifyUpstreamStatus = (status, contentType) => {
  const isJson = String(contentType || "").toLowerCase().includes("json");

  if (status === 401) return { reason: RPA_REASONS.UNAUTHENTICATED, safeToForwardBody: false };
  if (status === 403) return { reason: RPA_REASONS.FORBIDDEN, safeToForwardBody: false };
  if (status === 404 && !isJson) {
    return { reason: RPA_REASONS.INGRESS_BLOCKED, safeToForwardBody: false };
  }
  if (status === 404) return { reason: RPA_REASONS.ROUTE_UNKNOWN, safeToForwardBody: true };
  if (status === 504) return { reason: RPA_REASONS.UPSTREAM_TIMEOUT, safeToForwardBody: isJson };
  if (status >= 500) return { reason: RPA_REASONS.UPSTREAM_UNAVAILABLE, safeToForwardBody: isJson };
  return { reason: "", safeToForwardBody: isJson };
};

/**
 * Crea el manejador del proxy.
 *
 * @param {Object} deps
 * @param {ReturnType<createRpaProxyConfig>} deps.config
 * @param {Record<string, Object>} deps.services Salida de `resolveTargets().services`.
 * @param {Object} deps.identity Proveedor de tokens.
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 */
export const createRpaProxyHandler = ({
  config,
  services,
  identity,
  fetchImpl = globalThis.fetch,
  now = () => Date.now()
}) => {
  const burstLimiter = createRateLimiter({ windowMs: 60_000, max: config.ratePerMinute, now });
  const effectfulLimiter = createRateLimiter({
    windowMs: 3_600_000,
    max: config.effectfulPerHour,
    now
  });
  const admission = createAdmissionControl({
    maxConcurrent: config.maxConcurrentTramites,
    now
  });

  /**
   * Cabeceras CORS. Nunca `*`: por aqui pasan tramites oficiales.
   * @param {string|undefined} origin
   */
  const corsHeaders = (origin) => ({
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, Accept, ${CORRELATION_HEADER}, ${CONVERSATION_HEADER}`,
    "Access-Control-Expose-Headers": CORRELATION_HEADER,
    "Access-Control-Max-Age": "3600"
  });

  /**
   * @param {import("node:http").ServerResponse} res
   * @param {number} status
   * @param {Object} payload
   * @param {string|undefined} origin
   * @param {Object} [extraHeaders]
   */
  const send = (res, status, payload, origin, extraHeaders = {}) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(origin),
      ...extraHeaders
    });
    res.end(body);
    return status;
  };

  /**
   * Lee el cuerpo JSON con tope de bytes.
   * @param {import("node:http").IncomingMessage} req
   * @returns {Promise<{ok: true, raw: string}|{ok: false}>}
   */
  const readJsonBody = (req) =>
    new Promise((resolve) => {
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      let aborted = false;

      req.on("data", (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_JSON_BODY_BYTES) {
          aborted = true;
          // No se destruye el socket: hacerlo impide que el 413 llegue al cliente, que veria
          // un fallo de red indistinguible de un problema real. El resto se lee y se tira.
          resolve({ ok: false });
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!aborted) resolve({ ok: true, raw: Buffer.concat(chunks).toString("utf8") });
      });
      req.on("error", () => {
        if (!aborted) {
          aborted = true;
          resolve({ ok: true, raw: "" });
        }
      });
    });

  /**
   * Envuelve el cuerpo entrante como iterable con tope, para reenviar una radicacion con
   * anexos sin acumular 25 MB en memoria.
   *
   * @param {import("node:http").IncomingMessage} req
   * @param {number} maxBytes
   */
  const cappedStream = async function* (req, maxBytes) {
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new Error(`upload_exceeds_${maxBytes}`);
      }
      yield chunk;
    }
  };

  /**
   * Cabeceras hacia el destino: token, correlacion y lo imprescindible del cliente.
   *
   * @param {Object} service
   * @param {import("node:http").IncomingMessage} req
   * @param {string} [correlationOverride]
   * @returns {Promise<Record<string, string>>}
   */
  const upstreamHeaders = async (service, req, correlationOverride) => {
    const trace = getTraceContext();
    /** @type {Record<string, string>} */
    const headers = {
      ...(await identity.headers(service.audience)),
      [CORRELATION_HEADER]: correlationOverride || trace?.correlationId || ""
    };

    const conversation = req.headers[CONVERSATION_HEADER];
    if (conversation) {
      headers[CONVERSATION_HEADER] = Array.isArray(conversation) ? conversation[0] : conversation;
    }
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (value) headers[name] = Array.isArray(value) ? value[0] : value;
    }
    return headers;
  };

  /**
   * Registra un fallo del destino con el diagnostico concreto, que es lo que ahorra el tiempo.
   *
   * @param {string} reason
   * @param {Object} ctx
   */
  const logUpstreamFailure = (reason, ctx) => {
    if (reason === RPA_REASONS.UNAUTHENTICATED) {
      error("rpa_unauthenticated", {
        ...ctx,
        note:
          "401: el audience debe ser la URL EXACTA del servicio destino, sin barra final, y no " +
          "puede compartirse entre los dos servicios."
      });
      return;
    }
    if (reason === RPA_REASONS.FORBIDDEN) {
      error("rpa_forbidden", {
        ...ctx,
        note: "403: el token es valido pero falta roles/run.invoker de esta SA sobre ese servicio."
      });
      return;
    }
    if (reason === RPA_REASONS.INGRESS_BLOCKED) {
      critical("rpa_ingress_blocked", {
        ...ctx,
        note:
          "404 con cuerpo HTML: la respuesta es del balanceador de Google, no de la aplicacion. " +
          "El ingress no admite este trafico; en PREM y PROD hay que entrar por el API Gateway."
      });
      return;
    }
    if (reason === RPA_REASONS.ROUTE_UNKNOWN) {
      error("rpa_route_not_found", {
        ...ctx,
        note: "404 con cuerpo JSON: respondio la aplicacion. La ruta no existe; comparar con /openapi.json."
      });
      return;
    }
    warning("rpa_upstream_failed", ctx);
  };

  return {
    prefixes: Object.values(MOUNT_PREFIXES),

    /** Estado del proxy, para diagnostico y pruebas. */
    stats() {
      return {
        ...admission.snapshot(),
        tracked_ips: burstLimiter.size,
        identity: identity.stats()
      };
    },

    /** Reinicia contadores y cache. Solo para pruebas. */
    reset() {
      burstLimiter.reset();
      effectfulLimiter.reset();
      admission.reset();
      identity.reset();
    },

    /**
     * @param {import("node:http").IncomingMessage} req
     * @param {import("node:http").ServerResponse} res
     * @returns {Promise<number>} Codigo de estado, para el log de la peticion.
     */
    async handle(req, res) {
      const origin = req.headers.origin;
      const [urlPath, rawQuery = ""] = String(req.url || "/").split("?");

      const mount = matchMount(urlPath);
      if (!mount) return send(res, 404, { error: "Not Found", reason: RPA_REASONS.ROUTE_UNKNOWN }, origin);

      if (!isOriginAllowed(origin, req.headers.host, config)) {
        warning("rpa_origin_rejected", { origin: String(origin).slice(0, 120) });
        // Sin cabeceras CORS a proposito: al navegador no se le concede el permiso.
        return send(res, 403, { error: "Forbidden", reason: RPA_REASONS.FORBIDDEN_ORIGIN }, undefined);
      }

      // El preflight se responde antes de cualquier limite: bloquearlo deja al navegador sin
      // saber por que falla la peticion real.
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(origin));
        res.end();
        return 204;
      }

      const service = services[mount.serviceId];
      if (!service) {
        error("rpa_service_not_configured", { service: mount.serviceId });
        return send(
          res,
          503,
          { error: "Service not configured", reason: RPA_REASONS.NOT_CONFIGURED },
          origin
        );
      }

      const canonicalPath = normalizeUpstreamPath(mount.serviceId, urlPath);
      const { route, pathKnown } = matchRoute(mount.serviceId, req.method, canonicalPath);

      if (!route) {
        const reason = pathKnown ? RPA_REASONS.METHOD_NOT_ALLOWED : RPA_REASONS.ROUTE_UNKNOWN;
        warning("rpa_route_rejected", {
          service: mount.serviceId,
          method: req.method,
          path: canonicalPath,
          reason
        });
        return send(
          res,
          pathKnown ? 405 : 404,
          { error: pathKnown ? "Method Not Allowed" : "Not Found", reason },
          origin
        );
      }

      // ── Limite de tasa ────────────────────────────────────────────────────
      const ip = resolveClientIp(req, { trustedHops: config.trustedProxyHops });
      const burst = burstLimiter.hit(ip);
      if (!burst.allowed) {
        warning("rpa_rate_limited", { client_ip: ip, used: burst.used, limit: burst.limit });
        return send(
          res,
          429,
          {
            error: "Too Many Requests",
            reason: RPA_REASONS.RATE_LIMITED,
            retryAfterSeconds: burst.retryAfterSeconds
          },
          origin,
          { "Retry-After": String(burst.retryAfterSeconds) }
        );
      }

      if (route.effectful) {
        const quota = effectfulLimiter.hit(ip);
        if (!quota.allowed) {
          warning("rpa_effectful_rate_limited", {
            client_ip: ip,
            path: canonicalPath,
            used: quota.used,
            limit: quota.limit
          });
          return send(
            res,
            429,
            {
              error: "Too Many Requests",
              reason: RPA_REASONS.RATE_LIMITED,
              retryAfterSeconds: quota.retryAfterSeconds
            },
            origin,
            { "Retry-After": String(quota.retryAfterSeconds) }
          );
        }
      }

      const { query, dropped } = filterQuery(rawQuery);
      if (dropped.length > 0) {
        warning("rpa_query_params_dropped", { path: canonicalPath, dropped });
      }

      // ── Control de admision del techo de dos tramites ─────────────────────
      const needsSlot = route.effectful && mount.serviceId === "factura";
      let slotId = "";
      if (needsSlot) {
        const seat = admission.acquire();
        if (!seat.admitted) {
          info("rpa_queue_full", { in_flight: seat.inFlight, path: canonicalPath });
          return send(
            res,
            429,
            {
              error: "Busy",
              reason: RPA_REASONS.QUEUE_FULL,
              queuePosition: seat.queuePosition,
              retryAfterSeconds: seat.retryAfterSeconds
            },
            origin,
            { "Retry-After": String(seat.retryAfterSeconds) }
          );
        }
        slotId = seat.slotId;
      }

      /** Libera el cupo si el tramite no llego a arrancar. */
      const releaseSlot = () => {
        if (slotId) {
          admission.release(slotId);
          slotId = "";
        }
      };

      // ── Token ─────────────────────────────────────────────────────────────
      let headers;
      try {
        headers = await upstreamHeaders(service, req, readCorrelationOverride(rawQuery));
      } catch (err) {
        releaseSlot();
        const reason = err instanceof IdentityTokenError ? err.reason : "unknown";
        critical("rpa_token_unavailable", {
          service: mount.serviceId,
          audience: service.audience,
          mode: identity.mode,
          reason,
          detail: String(err?.message || "").slice(0, 300)
        });
        return send(
          res,
          503,
          { error: "Service Unavailable", reason: RPA_REASONS.AUTH_UNAVAILABLE },
          origin
        );
      }

      const upstreamUrl = buildUpstreamUrl(service, canonicalPath, query);

      try {
        if (route.kind === BODY_KINDS.SSE) {
          return await this.pipeStream({ res, service, headers, upstreamUrl, origin, canonicalPath });
        }
        if (route.kind === BODY_KINDS.BINARY) {
          return await this.pipeBinary({
            res,
            route,
            service,
            headers,
            upstreamUrl,
            origin,
            canonicalPath
          });
        }
        return await this.pipeJson({
          req,
          res,
          route,
          service,
          headers,
          upstreamUrl,
          origin,
          canonicalPath,
          slotId,
          onSlotConsumed: () => {
            slotId = "";
          }
        });
      } catch (err) {
        releaseSlot();
        error("rpa_proxy_unhandled", {
          service: mount.serviceId,
          path: canonicalPath,
          detail: String(err?.message || "").slice(0, 300)
        });
        if (res.headersSent) {
          res.end();
          return 502;
        }
        return send(
          res,
          502,
          { error: "Bad Gateway", reason: RPA_REASONS.UPSTREAM_UNAVAILABLE },
          origin
        );
      } finally {
        releaseSlot();
      }
    },

    /**
     * Reenvia una peticion con cuerpo y respuesta JSON (o multipart de subida).
     * @param {Object} ctx
     */
    async pipeJson({
      req,
      res,
      route,
      service,
      headers,
      upstreamUrl,
      origin,
      canonicalPath,
      slotId,
      onSlotConsumed
    }) {
      /** @type {RequestInit} */
      const init = { method: req.method, headers };

      if (route.kind === BODY_KINDS.MULTIPART) {
        const declared = Number(req.headers["content-length"] || 0);
        if (declared > config.maxUploadBytes) {
          warning("rpa_upload_too_large", { declared, limit: config.maxUploadBytes });
          return send(
            res,
            413,
            { error: "Payload Too Large", reason: RPA_REASONS.PAYLOAD_TOO_LARGE },
            origin
          );
        }
        // En streaming: una radicacion con 25 MB de anexos no debe pasar por memoria.
        init.body = Readable.from(cappedStream(req, config.maxUploadBytes));
        init.duplex = "half";
      } else if (req.method !== "GET" && req.method !== "HEAD") {
        const body = await readJsonBody(req);
        if (!body.ok) {
          return send(
            res,
            413,
            { error: "Payload Too Large", reason: RPA_REASONS.PAYLOAD_TOO_LARGE },
            origin
          );
        }
        if (body.raw !== "") init.body = body.raw;
      }

      const controller = new AbortController();
      const timer =
        route.timeoutMs > 0 ? setTimeout(() => controller.abort(), route.timeoutMs) : null;
      init.signal = controller.signal;

      let response;
      let raw;
      try {
        response = await fetchImpl(upstreamUrl, init);
        raw = await response.text();
      } catch (err) {
        const aborted = err?.name === "AbortError";
        const tooLarge = String(err?.message || "").startsWith("upload_exceeds_");
        if (tooLarge) {
          warning("rpa_upload_too_large", { limit: config.maxUploadBytes });
          return send(
            res,
            413,
            { error: "Payload Too Large", reason: RPA_REASONS.PAYLOAD_TOO_LARGE },
            origin
          );
        }
        error("rpa_upstream_unreachable", {
          service: service.id,
          path: canonicalPath,
          aborted,
          detail: String(err?.message || "").slice(0, 200)
        });
        return send(
          res,
          aborted ? 504 : 502,
          {
            error: aborted ? "Gateway Timeout" : "Bad Gateway",
            reason: aborted ? RPA_REASONS.UPSTREAM_TIMEOUT : RPA_REASONS.UPSTREAM_UNAVAILABLE
          },
          origin
        );
      } finally {
        if (timer) clearTimeout(timer);
      }

      const contentType = response.headers.get("content-type") || "";
      // Parseo tolerante: un 502 con cuerpo HTML no debe reventar aquí.
      let payload;
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }

      const upstreamCorrelation = response.headers.get(CORRELATION_HEADER);
      const passthroughHeaders = upstreamCorrelation
        ? { [CORRELATION_HEADER]: upstreamCorrelation }
        : {};

      if (!response.ok) {
        const { reason, safeToForwardBody } = classifyUpstreamStatus(response.status, contentType);
        logUpstreamFailure(reason, {
          service: service.id,
          audience: service.audience,
          path: canonicalPath,
          upstream_status: response.status,
          content_type: contentType.slice(0, 60),
          // El cuerpo del portal no lleva datos del ciudadano, pero se recorta igualmente.
          detail: safeToForwardBody ? String(raw).slice(0, 200) : ""
        });

        // El cuerpo de la aplicacion se reenvia porque el frontend lo necesita para traducir
        // el motivo al ciudadano (paz y salvo, pasarela ocupada, opciones validas de un 422).
        // Lo que no sale de aqui es el cuerpo de la infraestructura: describe el estado de la
        // credencial y del ingress.
        return send(
          res,
          response.status,
          safeToForwardBody && payload ? { ...payload, reason } : { error: "Upstream error", reason },
          origin,
          passthroughHeaders
        );
      }

      // Un tramite aceptado ata el cupo a su `job_id`, para poder liberarlo al verlo terminar.
      if (slotId && payload?.job_id) {
        admission.bind(slotId, String(payload.job_id));
        onSlotConsumed?.();
      }
      // Un poll que ya muestra estado terminal libera el cupo sin esperar a que venza.
      if (route.kind === BODY_KINDS.JSON && payload?.id && isTerminalJobPayload(payload)) {
        admission.release(String(payload.id));
      }

      info("rpa_request_served", {
        service: service.id,
        path: canonicalPath,
        upstream_status: response.status,
        ...admission.snapshot()
      });

      return send(res, response.status, payload ?? {}, origin, passthroughHeaders);
    },

    /**
     * Reenvia un stream SSE sin bufferizarlo. Es lo que permite dar mensajes de progreso
     * verdaderos en lugar de un temporizador inventado.
     * @param {Object} ctx
     */
    async pipeStream({ res, service, headers, upstreamUrl, origin, canonicalPath }) {
      const controller = new AbortController();
      // Si el ciudadano cierra el chat, se corta tambien la conexion hacia arriba.
      res.on("close", () => controller.abort());

      let response;
      try {
        response = await fetchImpl(upstreamUrl, {
          method: "GET",
          headers: { ...headers, Accept: "text/event-stream" },
          signal: controller.signal
        });
      } catch (err) {
        if (controller.signal.aborted) return 499;
        error("rpa_stream_unreachable", {
          service: service.id,
          detail: String(err?.message || "").slice(0, 200)
        });
        return send(res, 502, { error: "Bad Gateway", reason: RPA_REASONS.UPSTREAM_UNAVAILABLE }, origin);
      }

      if (!response.ok) {
        const { reason } = classifyUpstreamStatus(
          response.status,
          response.headers.get("content-type") || ""
        );
        logUpstreamFailure(reason, {
          service: service.id,
          audience: service.audience,
          path: "stream",
          upstream_status: response.status
        });
        return send(res, response.status, { error: "Upstream error", reason }, origin);
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // Sin esto un proxy intermedio acumula el stream y los eventos llegan todos al final.
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        ...corsHeaders(origin)
      });

      try {
        for await (const chunk of response.body) {
          if (!res.write(chunk)) {
            // Respetar la contrapresion: sin esto un cliente lento acumula memoria aqui.
            await new Promise((resolve) => res.once("drain", resolve));
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          warning("rpa_stream_interrupted", { detail: String(err?.message || "").slice(0, 200) });
        }
      } finally {
        res.end();
        // El servicio cierra el stream al terminar el tramite, asi que el fin del stream es
        // la señal mas temprana de que el cupo quedo libre. Sin esto habria que esperar a que
        // venciera su contrato, y el siguiente ciudadano esperaria de mas.
        //
        // Si el ciudadano cerro el chat antes, se libera un cupo cuyo tramite sigue vivo. Es
        // deliberado: ser permisivo aqui solo adelanta lo que el contrato iba a hacer igual, y
        // bloquear a un ciudadano por un tramite que nadie esta mirando es peor.
        const jobId = canonicalPath?.match(/^\/v1\/jobs\/([A-Za-z0-9_-]+)\/stream$/)?.[1];
        if (jobId) admission.release(jobId);
      }
      return 200;
    },

    /**
     * Descarga el PDF con token y lo reenvia. El ciudadano nunca recibe la URL protegida por
     * IAM: su navegador no lleva token y solo veria un 403.
     * @param {Object} ctx
     */
    async pipeBinary({ res, route, service, headers, upstreamUrl, origin, canonicalPath }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), route.timeoutMs || 60_000);

      try {
        const response = await fetchImpl(upstreamUrl, {
          method: "GET",
          headers,
          signal: controller.signal
        });

        if (!response.ok) {
          const { reason } = classifyUpstreamStatus(
            response.status,
            response.headers.get("content-type") || ""
          );
          logUpstreamFailure(reason, {
            service: service.id,
            audience: service.audience,
            path: canonicalPath,
            upstream_status: response.status
          });
          return send(res, response.status, { error: "Upstream error", reason }, origin);
        }

        // El nombre se toma de la ruta ya validada por la lista blanca, nunca de una cabecera
        // del destino: `Content-Disposition` es texto ajeno y acabaria en un nombre de archivo.
        const filename = canonicalPath.split("/").pop() || "factura.pdf";

        res.writeHead(200, {
          "Content-Type": response.headers.get("content-type") || "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          // La factura lleva el detalle tributario del ciudadano: no se cachea en ningun salto.
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...corsHeaders(origin)
        });

        for await (const chunk of response.body) {
          if (!res.write(chunk)) {
            await new Promise((resolve) => res.once("drain", resolve));
          }
        }
        res.end();
        return 200;
      } catch (err) {
        const aborted = err?.name === "AbortError";
        error("rpa_pdf_failed", {
          service: service.id,
          path: canonicalPath,
          aborted,
          detail: String(err?.message || "").slice(0, 200)
        });
        if (res.headersSent) {
          res.end();
          return 502;
        }
        return send(
          res,
          aborted ? 504 : 502,
          {
            error: aborted ? "Gateway Timeout" : "Bad Gateway",
            reason: aborted ? RPA_REASONS.UPSTREAM_TIMEOUT : RPA_REASONS.UPSTREAM_UNAVAILABLE
          },
          origin
        );
      } finally {
        clearTimeout(timer);
      }
    }
  };
};

/**
 * Correlacion que llega por query. `EventSource` no admite cabeceras propias, asi que es la
 * unica forma de que un stream comparta identificador con el resto de la conversacion. Se
 * acepta solo con forma de UUID: es un identificador, no un dato personal, y validarlo evita
 * que se cuele texto arbitrario en los logs.
 *
 * @param {string} rawQuery
 * @returns {string}
 */
export const readCorrelationOverride = (rawQuery) => {
  const value = new URLSearchParams(rawQuery || "").get("cid") || "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : "";
};
