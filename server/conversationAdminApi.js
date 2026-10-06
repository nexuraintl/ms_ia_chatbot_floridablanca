import { createHash, timingSafeEqual } from "node:crypto";
import { ConversationError } from "./conversationStore.js";
import { parseConversationFilters } from "./conversationReadStore.js";
import { resolveClientIp } from "./clientIdentity.js";
import { createRateLimiter } from "./rateLimit.js";
import { reportConversationFailure } from "./conversationDiagnostics.js";

export const CONVERSATION_ADMIN_PREFIX = "/api/v1/admin/conversations";
const digest = value => createHash("sha256").update(value).digest();
const csvCell = value => {
  let text = value == null ? "" : Array.isArray(value) ? value.join(" | ") : String(value);
  // Evita que una celda controlada por un ciudadano ejecute formulas al abrir en Excel.
  const first = [...text].find(char => char.charCodeAt(0) > 32 && !/\s/.test(char));
  if ((first && "=+@-".includes(first)) || [9, 10, 13].includes(text.charCodeAt(0))) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
};
export const conversationsCsv = rows => {
  const columns = ["chat_id", "citizen_name", "citizen_email", "started_at", "last_message_at", "ended_at",
    "message_count", "duration_seconds", "used_rpa", "rpa_flows", "consent_version", "redacted_at"];
  return "\uFEFF" + [columns.join(","), ...rows.map(row => columns.map(key => csvCell(row[key])).join(","))].join("\r\n") + "\r\n";
};

export const createConversationAdminApi = ({ config, store }) => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });
  const configured = typeof config.adminToken === "string" && config.adminToken.length >= 32 && config.adminToken.length <= 512;
  const expected = configured ? digest(config.adminToken) : null;
  return {
    async handle(req, res) {
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
      const respond = (status, data) => {
        res.writeHead(status, headers);
        res.end(data === undefined ? undefined : JSON.stringify(data));
        return status;
      };
      // El panel solo consulta desde el mismo dominio. Nunca hereda el CORS del widget.
      if (req.headers["sec-fetch-site"] === "cross-site") return respond(403, { reason: "forbidden_origin" });
      if (req.headers.origin) {
        try { if (new URL(req.headers.origin).host !== req.headers.host) return respond(403, { reason: "forbidden_origin" }); }
        catch { return respond(403, { reason: "forbidden_origin" }); }
      }
      const decision = limiter.hit(resolveClientIp(req, { trustedHops: config.trustedProxyHops }));
      if (!decision.allowed) {
        headers["Retry-After"] = String(decision.retryAfterSeconds);
        return respond(429, { reason: "rate_limited" });
      }
      if (!configured) return respond(503, { reason: "admin_not_configured" });
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer ") || auth.length > 520 || !timingSafeEqual(digest(auth.slice(7)), expected)) {
        headers["WWW-Authenticate"] = 'Bearer realm="floria-admin"';
        return respond(401, { reason: "unauthorized" });
      }
      if (req.method !== "GET") {
        headers.Allow = "GET";
        return respond(405, { reason: "method_not_allowed" });
      }
      if (!config.enabled) return respond(503, { reason: "persistence_not_configured" });
      try {
        const url = new URL(req.url, "http://internal");
        const route = url.pathname.slice(CONVERSATION_ADMIN_PREFIX.length);
        if (!route || route === "/") {
          return respond(200, await store.listConversations(parseConversationFilters(url.searchParams)));
        }
        if (route === "/export.csv") {
          const rows = await store.exportConversationSummaries(parseConversationFilters(url.searchParams));
          const body = conversationsCsv(rows);
          res.writeHead(200, { ...headers, "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="floria-conversaciones.csv"',
            "Content-Length": Buffer.byteLength(body), "X-Exported-Count": String(rows.length) });
          res.end(body);
          return 200;
        }
        const match = route.match(/^\/([a-zA-Z0-9_-]{1,64})(\/export.json)?$/);
        if (!match) return respond(404, { reason: "not_found" });
        if (url.search) throw new ConversationError(400, "invalid_filters");
        const data = await store.getConversation(match[1]);
        if (match[2]) headers["Content-Disposition"] = `attachment; filename="floria-chat-${match[1]}.json"`;
        return respond(200, data);
      } catch (error) {
        // No devolver ni registrar errores SQL, textos, filtros de identidad o credenciales.
        if (!(error instanceof ConversationError)) reportConversationFailure(error);
        return respond(error instanceof ConversationError ? error.status : 503,
          { reason: error instanceof ConversationError ? error.reason : "persistence_unavailable" });
      }
    }
  };
};
