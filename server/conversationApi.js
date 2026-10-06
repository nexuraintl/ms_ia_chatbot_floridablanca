import { isOriginAllowed } from "./corsPolicy.js";
import { resolveClientIp } from "./clientIdentity.js";
import { createRateLimiter } from "./rateLimit.js";
import { ConversationError, validateConversationPayload } from "./conversationStore.js";
import { reportConversationFailure } from "./conversationDiagnostics.js";

export const CONVERSATION_PATH_PREFIX = "/api/v1/conversations";

const readBody = req => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  const timer = setTimeout(() => {
    reject(new ConversationError(408, "request_timeout"));
    req.resume();
  }, 10_000);
  const fail = error => { clearTimeout(timer); reject(error); };
  req.on("data", chunk => {
    size += chunk.length;
    // 50 mensajes de hasta 8000 caracteres Unicode deben caber en una tanda.
    if (size > 2 * 1024 * 1024) fail(new ConversationError(413, "payload_too_large"));
    else chunks.push(chunk);
  });
  req.on("end", () => {
    clearTimeout(timer);
    try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { fail(new ConversationError(400, "invalid_payload")); }
  });
  req.on("error", () => fail(new ConversationError(400, "invalid_payload")));
  req.on("aborted", () => fail(new ConversationError(400, "invalid_payload")));
});

export const createConversationApi = ({ config, store }) => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: config.ratePerMinute });
  return {
    async handle(req, res) {
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", Vary: "Origin" };
      const respond = (status, payload) => {
        res.writeHead(status, headers);
        res.end(payload ? JSON.stringify(payload) : undefined);
        return status;
      };
      if (!isOriginAllowed(req.headers.origin, req.headers.host, config)) {
        return respond(403, { reason: "forbidden_origin" });
      }
      if (req.headers.origin) headers["Access-Control-Allow-Origin"] = req.headers.origin;
      headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type, X-Correlation-ID, X-Conversation-ID";
      const url = (req.url || "").split("?")[0];
      const match = url.match(/^\/api\/v1\/conversations\/([a-zA-Z0-9_-]{1,64})\/(messages|close)$/);
      if (url !== CONVERSATION_PATH_PREFIX && !match) return respond(404, { reason: "not_found" });
      if (req.method === "OPTIONS") return respond(204);
      if (req.method !== "POST") {
        headers.Allow = "POST, OPTIONS";
        return respond(405, { reason: "method_not_allowed" });
      }
      if (!config.enabled) return respond(503, { reason: "persistence_not_configured" });
      const decision = limiter.hit(resolveClientIp(req, { trustedHops: config.trustedProxyHops }));
      if (!decision.allowed) {
        headers["Retry-After"] = String(decision.retryAfterSeconds);
        return respond(429, { reason: "rate_limited" });
      }
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        return respond(415, { reason: "unsupported_media_type" });
      }
      try {
        const kind = match?.[2] || "envelope";
        const conversationId = match?.[1];
        const payload = validateConversationPayload(await readBody(req), { kind, conversationId, tenantId: config.tenantId });
        const result = kind === "envelope" ? await store.openConversation(payload)
          : kind === "messages" ? await store.appendMessages(conversationId, payload.messages)
          : await store.closeConversation(conversationId);
        return respond(200, result);
      } catch (error) {
        // No registrar errores SQL: pueden incluir el texto o la identidad del ciudadano.
        if (!(error instanceof ConversationError)) reportConversationFailure(error);
        return respond(error instanceof ConversationError ? error.status : 503,
          { reason: error instanceof ConversationError ? error.reason : "persistence_unavailable" });
      }
    }
  };
};
