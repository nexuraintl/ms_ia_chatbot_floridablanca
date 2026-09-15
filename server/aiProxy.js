/**
 * Proxy de Gemini con control de gasto. `POST /api/ai/chat`. Cierra H-01: la clave vive
 * aquí y no en el navegador.
 *
 * Control en tres capas: coste acotado por petición (el cuerpo que llega no se reenvía,
 * se reconstruye con lista blanca y topes propios), ráfagas por IP y cuota diaria por
 * sesión. Más un cortacircuitos global sobre los tokens de `usageMetadata`.
 *
 * Acota el coste, no el contenido: la instrucción de sistema la sigue construyendo el
 * frontend, donde viven el catálogo de FAQ y el serializador de contexto.
 *
 * No sale de aquí: el texto del ciudadano (dato personal, Ley 1581) ni el mensaje de
 * error de Gemini (describe el estado de la credencial). Al cliente, motivo genérico.
 */

import { buildKnowledgePrompt, citedArticles, isKnowledgeAvailable } from "./knowledge/index.js";
import { createRateLimiter, createDailyQuota, createTokenBudget } from "./rateLimit.js";
import { resolveClientIp, resolveSessionKey, DEFAULT_TRUSTED_HOPS } from "./clientIdentity.js";
import { CORRELATION_HEADER, CONVERSATION_HEADER } from "./correlation.js";
import { isOriginAllowed } from "./corsPolicy.js";
import { info, warning, error } from "./logging.js";

/** Ruta del endpoint. */
export const AI_CHAT_PATH = "/api/ai/chat";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Tope del cuerpo aceptado. Un historial de 20 turnos largos cabe de sobra. */
const MAX_BODY_BYTES = 128 * 1024;

/**
 * Topes de la petición que se envía a Gemini. Son los mismos que hoy aplica el cliente
 * (`GeminiApiProvider`), pero aquí no son una cortesía del navegador: son el contrato.
 */
const LIMITS = Object.freeze({
  maxHistoryTurns: 20,
  maxTurnChars: 4000,
  // Ampliado para que quepan las reglas más los fragmentos del Estatuto. No sube el coste
  // máximo por petición: el techo que lo fija es `maxTotalInputChars`, que no cambia.
  maxSystemChars: 12_000,
  /** Techo de caracteres de entrada. ~4 caracteres por token: unos 6.000 tokens. */
  maxTotalInputChars: 24_000,
  maxOutputTokens: 200,
  maxTemperature: 1
});

/** Motivos que el cliente puede interpretar. Forman parte del contrato del endpoint. */
export const REASONS = Object.freeze({
  INVALID_PAYLOAD: "invalid_payload",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  FORBIDDEN_ORIGIN: "forbidden_origin",
  RATE_LIMITED: "rate_limited",
  QUOTA_EXHAUSTED: "quota_exhausted",
  AI_UNAVAILABLE: "ai_unavailable"
});

/**
 * Lee una variable numérica del entorno.
 * @param {string} name
 * @param {number} fallback
 */
const readNumber = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

/**
 * Configuración del proxy, resuelta una vez al cargar el módulo. Los valores por defecto
 * son conservadores a propósito: sin configurar, mejor degradar al banco de preguntas que
 * descubrir el gasto en la factura.
 */
export const createProxyConfig = (env = process.env) => ({
  apiKey: String(env.GEMINI_API_KEY || "").trim(),
  model: String(env.GEMINI_MODEL || "gemini-2.5-flash-lite").trim(),
  ratePerMinute: readNumber("AI_RATE_LIMIT_PER_MINUTE", 10),
  dailyQuotaPerSession: readNumber("AI_DAILY_QUOTA_PER_SESSION", 30),
  dailyTokenCeiling: readNumber("AI_DAILY_TOKEN_CEILING", 500_000),
  trustedProxyHops: readNumber("TRUSTED_PROXY_HOPS", DEFAULT_TRUSTED_HOPS),
  requestTimeoutMs: readNumber("AI_REQUEST_TIMEOUT_MS", 30_000),
  allowedOrigins: String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().toLowerCase())
    .filter((o) => o !== ""),
  isLocal: String(env.ENVIRONMENT || "local").toLowerCase() === "local"
});

// `isOriginAllowed` vive ahora en `corsPolicy.js`, compartida con el proxy de los RPA.
// Se re-exporta para no cambiar la superficie pública de este módulo.
export { isOriginAllowed };

/** Marcador del turno de datos de la página, que no es una consulta del ciudadano. */
const UNTRUSTED_PAGE_MARKER = "<<<DATOS_NO_CONFIABLES_DE_LA_PAGINA>>>";

/** Tope de cada mensaje que entra en la consulta de recuperación. */
const MAX_QUERY_CHARS = 500;

/** Mensajes del ciudadano que entran en la consulta: el actual y el anterior. */
const QUERY_USER_TURNS = 2;

/** Un artículo citado con su número: la consulta ya se basta sola. */
const ARTICLE_WITH_NUMBER_RE = /art[íi]?c?u?l?o?s?\s*\d{1,3}\b/i;

/**
 * Señales de que el mensaje continúa el tema anterior en vez de abrir uno nuevo
 * ("de ese artículo", "dame más detalles", "y los requisitos"). Sin ellas, arrastrar el
 * artículo del turno anterior desviaría una consulta nueva.
 */
const FOLLOW_UP_RE =
  /\b(ese|esa|eso|esos|esas|este|esta|esto|dicho|dicha|mismo|misma|anterior|detalle|detalles|amplia|amplía|ampliar|explica|expl[íi]came|profundiza|m[áa]s)\b/i;

/** Cuántos artículos se arrastran de un turno del asistente. */
const MAX_HINTED_ARTICLES = 2;

/** Longitud hasta la que un mensaje con marca de seguimiento se trata como tal. */
const FOLLOW_UP_MAX_CHARS = 80;

/**
 * Mensajes del ciudadano, del más reciente al más antiguo. Se salta el turno de datos de
 * la página: viene del DOM del portal anfitrión y no debe decidir qué se recupera.
 *
 * @param {unknown} payload
 * @returns {string[]}
 */
const citizenTurns = (payload) => {
  const turns = Array.isArray(payload?.contents) ? payload.contents : [];
  const out = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.role !== "user") continue;
    const text = turn?.parts?.[0]?.text;
    if (typeof text !== "string" || text.trim() === "") continue;
    if (text.includes(UNTRUSTED_PAGE_MARKER)) continue;
    out.push(text.slice(0, MAX_QUERY_CHARS));
  }
  return out;
};

/** Último turno del asistente, de donde se arrastran los artículos ya citados. */
const lastModelText = (payload) => {
  const turns = Array.isArray(payload?.contents) ? payload.contents : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.role === "user") continue;
    const text = turn?.parts?.[0]?.text;
    if (typeof text === "string" && text.trim() !== "") return text;
  }
  return "";
};

/**
 * Último mensaje escrito por el ciudadano.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export const lastUserText = (payload) => citizenTurns(payload)[0] || "";

/**
 * Las dos consultas con las que se recupera del Estatuto.
 *
 * Van SEPARADAS a propósito. Mezclarlas en una sola cadena hacía que el mensaje anterior
 * ganara por número de términos: ante "y de ICA?" tras una pregunta de predial, BM25
 * prefería los fragmentos de predial —que casaban cinco términos— frente al único
 * término nuevo, y el modelo se quedaba sin nada de ICA que citar.
 *
 * - `query`: el mensaje actual, más los artículos que el asistente acababa de citar
 *   cuando el mensaje es un seguimiento ("dame detalles de ese artículo").
 * - `contextQuery`: el mensaje anterior del ciudadano, que sostiene el tema cuando el
 *   actual no lo repite ("¿cuáles son los requisitos?").
 *
 * @param {unknown} payload
 * @returns {{query: string, contextQuery: string}}
 */
export const buildRetrievalQueries = (payload) => {
  const turns = citizenTurns(payload).slice(0, QUERY_USER_TURNS);
  if (turns.length === 0) return { query: "", contextQuery: "" };

  const [current, previous = ""] = turns;
  const parts = [current];

  // Se arrastra el artículo anterior solo con señal clara: o el mensaje nombra un
  // artículo sin decir cuál, o es un seguimiento corto. Un mensaje largo con un "más"
  // suelto suele ser una consulta nueva, y arrastrar el artículo la desviaría.
  const citesArticle = ARTICLE_WITH_NUMBER_RE.test(current);
  const namesArticleWithoutNumber = /art[íi]?culo/i.test(current) && !citesArticle;
  const isShortFollowUp = current.length <= FOLLOW_UP_MAX_CHARS && FOLLOW_UP_RE.test(current);

  if (!citesArticle && (namesArticleWithoutNumber || isShortFollowUp)) {
    const cited = [...citedArticles(lastModelText(payload))].slice(0, MAX_HINTED_ARTICLES);
    // El plural importa: es la señal con la que el recuperador lee una enumeración.
    if (cited.length === 1) parts.push(`artículo ${cited[0]}`);
    else if (cited.length > 1) parts.push(`artículos ${cited.join(" y ")}`);
  }

  return { query: parts.join(" ").trim(), contextQuery: previous.trim() };
};

/**
 * Reconstruye la petición a Gemini con lista blanca y topes. Capa 1 del control de gasto.
 * El historial se recorta por el PRINCIPIO: si hay que sacrificar contexto, el más antiguo.
 *
 * @param {unknown} payload
 * @param {Object} [options]
 * @param {string} [options.systemOverride]  Instrucción armada por el servidor. Cuando
 *   viene, sustituye a la del cliente: la del cliente es un dato del navegador.
 * @returns {{ ok: true, request: Object, inputChars: number } | { ok: false, detail: string }}
 */
export const buildGeminiRequest = (payload, { systemOverride } = {}) => {
  if (!payload || typeof payload !== "object") {
    return { ok: false, detail: "cuerpo ausente o no es un objeto" };
  }

  const rawContents = Array.isArray(payload.contents) ? payload.contents : null;
  if (!rawContents || rawContents.length === 0) {
    return { ok: false, detail: "contents ausente o vacío" };
  }

  /** @type {{role: string, parts: {text: string}[]}[]} */
  const contents = [];
  for (const turn of rawContents.slice(-LIMITS.maxHistoryTurns)) {
    const text = turn?.parts?.[0]?.text;
    if (typeof text !== "string" || text.trim() === "") continue;
    contents.push({
      // Cualquier valor distinto de `user` se normaliza a `model`: son los dos únicos
      // roles que acepta la API, y así un `role` inventado no llega a Google.
      role: turn.role === "user" ? "user" : "model",
      parts: [{ text: text.slice(0, LIMITS.maxTurnChars) }]
    });
  }

  if (contents.length === 0) {
    return { ok: false, detail: "ningún turno con texto utilizable" };
  }

  const rawSystem =
    typeof systemOverride === "string" && systemOverride !== ""
      ? systemOverride
      : String(payload.systemInstruction?.parts?.[0]?.text || "");
  const systemText = rawSystem.slice(0, LIMITS.maxSystemChars);

  // Recorte por techo total de entrada, empezando por los turnos más antiguos.
  let inputChars = systemText.length + contents.reduce((acc, t) => acc + t.parts[0].text.length, 0);
  while (inputChars > LIMITS.maxTotalInputChars && contents.length > 1) {
    inputChars -= contents.shift().parts[0].text.length;
  }
  // Si un único turno sigue pasándose del techo, se recorta ese turno.
  if (inputChars > LIMITS.maxTotalInputChars) {
    const allowance = Math.max(200, LIMITS.maxTotalInputChars - systemText.length);
    contents[0].parts[0].text = contents[0].parts[0].text.slice(0, allowance);
    inputChars = systemText.length + contents[0].parts[0].text.length;
  }

  const requestedTokens = Number(payload.generationConfig?.maxOutputTokens);
  const requestedTemp = Number(payload.generationConfig?.temperature);

  /** @type {Object} */
  const request = {
    contents,
    generationConfig: {
      // `Math.min` sobre el valor pedido: el cliente puede pedir menos, nunca más.
      maxOutputTokens: Number.isFinite(requestedTokens) && requestedTokens > 0
        ? Math.min(requestedTokens, LIMITS.maxOutputTokens)
        : LIMITS.maxOutputTokens,
      temperature: Number.isFinite(requestedTemp)
        ? Math.min(Math.max(requestedTemp, 0), LIMITS.maxTemperature)
        : 0.6
    }
  };

  if (systemText !== "") {
    request.systemInstruction = { parts: [{ text: systemText }] };
  }

  return { ok: true, request, inputChars };
};

/**
 * Crea el manejador del proxy. Los limitadores se crean una vez por proceso: su estado
 * ES el control de gasto de esta instancia.
 *
 * @param {Object} [deps]
 * @param {ReturnType<createProxyConfig>} [deps.config]
 * @param {typeof fetch} [deps.fetchImpl]  Inyectable para las pruebas.
 * @param {() => number} [deps.now]
 */
export const createAiProxyHandler = ({
  config = createProxyConfig(),
  fetchImpl = globalThis.fetch,
  now = () => Date.now()
} = {}) => {
  const burstLimiter = createRateLimiter({
    windowMs: 60_000,
    max: config.ratePerMinute,
    now
  });

  const sessionQuota = createDailyQuota({ limit: config.dailyQuotaPerSession, now });

  const tokenBudget = createTokenBudget({
    dailyTokenCeiling: config.dailyTokenCeiling,
    now
  });

  /**
   * Cabeceras CORS. Refleja el origen concreto, nunca `*`, y declara las cabeceras
   * personalizadas del widget: sin ellas el navegador falla en el preflight.
   *
   * @param {string|undefined} origin
   */
  const corsHeaders = (origin) => ({
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, ${CORRELATION_HEADER}, ${CONVERSATION_HEADER}`,
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
   * Lee el cuerpo con tope de bytes.
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
        // Pasado el tope se descarta lo que siga llegando, sin acumularlo.
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          aborted = true;
          // NO se destruye el socket. Cerrarlo aquí impide que el 413 llegue al cliente:
          // vería un ECONNRESET, es decir un fallo de red indistinguible de un problema
          // real, en lugar de un error que explica qué pasó. Se resuelve de inmediato para
          // que la respuesta salga, y el resto del cuerpo se lee y se tira.
          //
          // El tope aquí es de 128 KB, así que drenar lo que quede es barato. La defensa
          // contra una subida enorme no es este `if`, sino el límite por IP de más arriba y
          // el tope de tamaño de petición que impone Cloud Run.
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
   * Llama a Gemini. Devuelve el texto y el uso real, o un fallo sin detalles para el
   * cliente.
   *
   * @param {Object} request
   * @returns {Promise<{ok: true, text: string, usageMetadata: Object}|{ok: false, detail: string, status: number}>}
   */
  const callGemini = async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    try {
      const response = await fetchImpl(
        `${GEMINI_BASE}/${encodeURIComponent(config.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Cabecera y no `?key=`: no queda en logs de proxy ni en historiales.
            "x-goog-api-key": config.apiKey
          },
          body: JSON.stringify(request),
          signal: controller.signal
        }
      );

      const raw = await response.text();

      if (!response.ok) {
        // El cuerpo de error de Google describe el estado de la credencial: se queda aquí.
        return { ok: false, status: response.status, detail: raw.slice(0, 300) };
      }

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return { ok: false, status: 502, detail: "respuesta no era JSON" };
      }

      const text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
      if (text === "") {
        // Sin texto: normalmente un bloqueo por filtros de seguridad del modelo.
        return {
          ok: false,
          status: 502,
          detail: `sin texto en la respuesta (finishReason=${data?.candidates?.[0]?.finishReason || "?"})`
        };
      }

      return { ok: true, text, usageMetadata: data?.usageMetadata || null };
    } catch (err) {
      const aborted = err?.name === "AbortError";
      return {
        ok: false,
        status: aborted ? 504 : 0,
        detail: aborted ? `timeout tras ${config.requestTimeoutMs}ms` : `fallo de red: ${err?.message}`
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    path: AI_CHAT_PATH,

    /** Estado de los limitadores, para diagnóstico y pruebas. */
    stats() {
      return {
        ...tokenBudget.snapshot(),
        tracked_ips: burstLimiter.size,
        tracked_sessions: sessionQuota.size
      };
    },

    /** Reinicia los contadores. Solo para pruebas. */
    reset() {
      burstLimiter.reset();
      sessionQuota.reset();
      tokenBudget.reset();
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

      if (!isOriginAllowed(origin, req.headers.host, config)) {
        warning("ai_origin_rejected", { origin: String(origin).slice(0, 120) });
        // Sin cabeceras CORS a propósito: al navegador no se le concede el permiso.
        return send(res, 403, { error: "Forbidden", reason: REASONS.FORBIDDEN_ORIGIN }, undefined);
      }

      // Preflight. Debe responderse antes de cualquier límite: bloquearlo dejaría al
      // navegador sin saber por qué falla la petición real.
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(origin));
        res.end();
        return 204;
      }

      if (req.method !== "POST") {
        return send(res, 405, { error: "Method Not Allowed" }, origin, { Allow: "POST, OPTIONS" });
      }

      // ── Capa 2: ráfagas por IP ────────────────────────────────────────────
      // Se evalúa ANTES de leer el cuerpo: a un bot no se le dedica ni el ancho de banda
      // de su propio payload.
      const ip = resolveClientIp(req, { trustedHops: config.trustedProxyHops });
      const burst = burstLimiter.hit(ip);
      if (!burst.allowed) {
        warning("ai_rate_limited", { client_ip: ip, used: burst.used, limit: burst.limit });
        return send(
          res,
          429,
          { error: "Too Many Requests", reason: REASONS.RATE_LIMITED, retryAfterSeconds: burst.retryAfterSeconds },
          origin,
          { "Retry-After": String(burst.retryAfterSeconds) }
        );
      }

      // ── Cortacircuitos global de gasto ────────────────────────────────────
      if (!tokenBudget.hasBudget()) {
        const budget = tokenBudget.snapshot();
        warning("ai_global_budget_exhausted", { spent: budget.spent, ceiling: budget.ceiling });
        return send(
          res,
          429,
          {
            error: "Daily budget exhausted",
            reason: REASONS.QUOTA_EXHAUSTED,
            retryAfterSeconds: budget.retryAfterSeconds
          },
          origin,
          { "Retry-After": String(budget.retryAfterSeconds) }
        );
      }

      // ── Capa 3: cuota diaria de la sesión ─────────────────────────────────
      // Se CONSULTA sin consumir. La unidad se cobra solo si Gemini responde de verdad:
      // una caída del proveedor no debe gastarle la ración del día a nadie.
      const session = resolveSessionKey(req, ip);
      const seen = sessionQuota.peek(session.key);
      if (seen.limit > 0 && seen.used >= seen.limit) {
        info("ai_session_quota_exhausted", {
          session_source: session.source,
          used: seen.used,
          limit: seen.limit
        });
        return send(
          res,
          429,
          {
            error: "Session quota exhausted",
            reason: REASONS.QUOTA_EXHAUSTED,
            retryAfterSeconds: 3600
          },
          origin,
          { "Retry-After": "3600" }
        );
      }

      // ── Cuerpo ────────────────────────────────────────────────────────────
      const body = await readBody(req);
      if (!body.ok) {
        return send(res, 413, { error: "Payload Too Large", reason: REASONS.PAYLOAD_TOO_LARGE }, origin);
      }

      let parsed;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        return send(res, 400, { error: "Invalid JSON", reason: REASONS.INVALID_PAYLOAD }, origin);
      }

      // ── Base de conocimiento ──────────────────────────────────────────────
      // La instrucción de sistema se arma AQUÍ cuando hay corpus: es la sección de
      // máxima autoridad para el modelo y no puede depender de lo que envíe el cliente.
      let systemOverride;
      if (isKnowledgeAvailable()) {
        const { query, contextQuery } = buildRetrievalQueries(parsed);
        const prompt = buildKnowledgePrompt({
          query,
          contextQuery,
          maxChars: LIMITS.maxSystemChars
        });
        if (prompt) {
          systemOverride = prompt.text;
          // Se registran los fragmentos citados, nunca la consulta: es dato personal.
          info("ai_knowledge_context", {
            matches: prompt.coincidencias,
            chunks: prompt.incluidos.join(",")
          });
        }
      }

      // ── Capa 1: coste acotado ─────────────────────────────────────────────
      const built = buildGeminiRequest(parsed, { systemOverride });
      if (!built.ok) {
        warning("ai_invalid_payload", { detail: built.detail });
        return send(res, 400, { error: "Invalid payload", reason: REASONS.INVALID_PAYLOAD }, origin);
      }

      // Sin credencial el proxy no puede trabajar. Se responde con el mismo motivo que una
      // cuota agotada en cuanto a efecto para el cliente: degradar al banco de preguntas.
      if (config.apiKey === "") {
        warning("ai_key_not_configured", {});
        return send(res, 503, { error: "AI unavailable", reason: REASONS.AI_UNAVAILABLE }, origin);
      }

      const result = await callGemini(built.request);

      if (!result.ok) {
        // El detalle técnico queda en el log del servidor, nunca en la respuesta.
        error("ai_upstream_failed", { upstream_status: result.status, detail: result.detail });
        return send(res, 503, { error: "AI unavailable", reason: REASONS.AI_UNAVAILABLE }, origin);
      }

      // La llamada se hizo y costó: ahora sí se cobra la unidad de cuota y se acumula el
      // gasto real que reportó Google.
      const spend = sessionQuota.hit(session.key);
      const totalTokens = Number(result.usageMetadata?.totalTokenCount) || 0;
      tokenBudget.record(totalTokens);

      info("ai_reply_served", {
        session_source: session.source,
        session_used: spend.used,
        session_limit: spend.limit,
        input_chars: built.inputChars,
        total_tokens: totalTokens,
        model: config.model
      });

      return send(
        res,
        200,
        {
          text: result.text,
          usageMetadata: result.usageMetadata,
          model: config.model,
          quota: { used: spend.used, limit: spend.limit, remaining: spend.remaining }
        },
        origin
      );
    }
  };
};
