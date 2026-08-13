/**
 * Servidor del widget para Cloud Run (GOB-GCP-STD-01).
 *
 * Sirve el bundle estático de `dist/` y expone los endpoints de infraestructura que
 * exige el estándar. Es el equivalente de `api/main.py`: no contiene lógica de negocio,
 * solo configuración del logging, correlación y registro de rutas.
 *
 * Cumplimiento del estándar:
 *   · `setupLogging()` se llama ANTES de crear el servidor
 *   · Correlación aplicada a toda petición (equivalente a `add_middleware`)
 *   · `GET /health` y `GET /version` sin prefijo de versión y sin autenticación
 *   · Log `request_completed` con método, path, status, duration_ms y correlation_id
 *   · Respeta `$PORT` de Cloud Run
 *
 * Sin dependencias de terceros a propósito: usa solo módulos nativos de Node. Un
 * servidor de archivos estáticos no justifica arrastrar Express y su árbol de
 * dependencias a una imagen que sirve contenido público.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withCorrelation } from "./correlation.js";
import { setupLogging, info, warning, error } from "./logging.js";
import { createAiProxyHandler, createProxyConfig, AI_CHAT_PATH } from "./aiProxy.js";
import { describeIpResolution } from "./clientIdentity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuración desde el entorno ────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 8080;
const SERVICE_NAME = process.env.SERVICE_NAME || "ia-chatbot-floridablanca";
const SERVICE_VERSION = process.env.SERVICE_VERSION || "0.0.0-dev";
const ENVIRONMENT = process.env.ENVIRONMENT || "local";
const LOG_LEVEL = process.env.LOG_LEVEL || "INFO";
const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "";
const STATIC_ROOT = path.resolve(__dirname, "..", "dist");

// El logging se configura antes de atender cualquier petición.
setupLogging({
  logLevel: LOG_LEVEL,
  projectId: GOOGLE_CLOUD_PROJECT,
  serviceName: SERVICE_NAME,
  serviceVersion: SERVICE_VERSION,
  environment: ENVIRONMENT
});

/**
 * Proxy de IA con control de gasto. Sus limitadores viven en el proceso, así que se crea
 * una sola vez: el estado del contador ES el control de gasto de esta instancia.
 */
const aiProxyConfig = createProxyConfig();
const aiProxy = createAiProxyHandler({ config: aiProxyConfig });

/** Tipos MIME de los archivos que produce el build. */
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

/**
 * Resuelve una ruta de petición a un archivo dentro de `dist/`, impidiendo salir de
 * ese directorio.
 *
 * La comprobación es indispensable: sin ella, una petición a `/../../etc/passwd`
 * serviría archivos de fuera del directorio público. `path.normalize` por sí solo no
 * basta, hay que verificar que el resultado siga estando dentro de la raíz.
 *
 * @param {string} urlPath
 * @returns {string|null} Ruta absoluta segura, o null si el destino queda fuera.
 */
export const resolveStaticPath = (urlPath, root = STATIC_ROOT) => {
  // Normalizar también la raíz: `path.resolve` del candidato produce una ruta absoluta
  // del sistema, así que compararla contra una raíz sin resolver falla. En Windows es
  // evidente (`C:\srv\dist\...` frente a `/srv/dist`), pero el fallo es de fondo:
  // comparar dos rutas expresadas en formas distintas.
  const base = path.resolve(root);

  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    // Secuencia de escape malformada: entrada hostil, se rechaza.
    return null;
  }

  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(base, relative);

  // El separador final evita que `/dist-malicioso` pase por estar dentro de `/dist`.
  if (candidate !== base && !candidate.startsWith(base + path.sep)) {
    return null;
  }
  return candidate;
};

/**
 * Cabeceras de seguridad para el contenido servido.
 * El widget se embebe en portales de terceros, así que NO se envía
 * `X-Frame-Options: DENY`: rompería la integración legítima.
 */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Resource-Policy": "cross-origin"
};

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS
  });
  res.end(body);
};

/**
 * Sirve un archivo estático.
 * @param {import("node:http").ServerResponse} res
 * @param {string} filePath
 * @param {(status: number) => void} done
 */
const sendFile = (res, filePath, done) => {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      done(404);
      sendJson(res, 404, { error: "Not Found" });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    // Los assets del build llevan hash en el nombre, así que se pueden cachear de
    // forma agresiva. El HTML no: debe revalidarse para que un despliegue nuevo se
    // vea sin esperar a que expire la caché.
    const isHashedAsset = ext !== ".html" && /-[A-Za-z0-9_-]{8,}\./.test(path.basename(filePath));

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      ...SECURITY_HEADERS
    });
    res.end(data);
    done(200);
  });
};

/**
 * Manejador de peticiones.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
const handleRequest = (req, res) => {
  const startedAt = process.hrtime.bigint();
  const urlPath = (req.url || "/").split("?")[0];

  /** Registra el cierre de la petición, como exige el estándar. */
  const complete = (status) => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    info("request_completed", {
      method: req.method,
      path: urlPath,
      status,
      duration_ms: Math.round(durationMs * 100) / 100
    });
  };

  // ── Proxy de IA ───────────────────────────────────────────────────────────
  // Se atiende antes de la comprobación de método, porque es la ÚNICA ruta que admite
  // POST y OPTIONS. El resto del servidor sigue sirviendo solo lectura.
  if (urlPath === AI_CHAT_PATH) {
    aiProxy
      .handle(req, res)
      .then(complete)
      .catch((err) => {
        // Una excepción no prevista aquí no debe dejar la petición colgada ni revelar la
        // traza al cliente.
        error("ai_proxy_unhandled", { error: err?.message });
        if (!res.headersSent) {
          sendJson(res, 503, { error: "AI unavailable", reason: "ai_unavailable" });
        }
        complete(503);
      });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    complete(405);
    return;
  }

  // ── Endpoints de infraestructura (sin prefijo de versión, sin autenticación) ──
  if (urlPath === "/health") {
    sendJson(res, 200, { status: "UP" });
    complete(200);
    return;
  }

  if (urlPath === "/version") {
    sendJson(res, 200, {
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      environment: ENVIRONMENT
    });
    complete(200);
    return;
  }

  // ── Contenido estático ────────────────────────────────────────────────────
  const filePath = resolveStaticPath(urlPath);
  if (!filePath) {
    warning("path_traversal_blocked", { path: urlPath });
    sendJson(res, 400, { error: "Bad Request" });
    complete(400);
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // El widget es una aplicación de una sola página: cualquier ruta desconocida
      // devuelve index.html para que el enrutado del cliente pueda resolverla.
      const fallback = path.join(STATIC_ROOT, "index.html");
      sendFile(res, fallback, complete);
      return;
    }
    sendFile(res, filePath, complete);
  });
};

const server = http.createServer((req, res) => {
  withCorrelation(req, res, () => handleRequest(req, res));
});

server.on("error", (err) => {
  error("server_error", { error: err.message });
  process.exit(1);
});

// Cloud Run envía SIGTERM antes de retirar una instancia: cerrar limpio evita
// cortar peticiones en curso.
const shutdown = (signal) => {
  info("shutdown_started", { signal });
  server.close(() => {
    info("shutdown_complete", { signal });
    process.exit(0);
  });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, "0.0.0.0", () => {
  info("server_started", {
    port: PORT,
    static_root: STATIC_ROOT,
    node_version: process.version
  });

  // Se deja constancia de la configuración del control de gasto en el arranque. Una
  // configuración errónea de `TRUSTED_PROXY_HOPS` o de `ALLOWED_ORIGINS` no produce
  // ningún error visible —el limitador simplemente deja de limitar— así que este log es
  // la forma más barata de detectarlo.
  info("ai_proxy_configured", {
    path: AI_CHAT_PATH,
    ai_enabled: aiProxyConfig.apiKey !== "",
    model: aiProxyConfig.model,
    rate_limit_per_minute: aiProxyConfig.ratePerMinute,
    daily_quota_per_session: aiProxyConfig.dailyQuotaPerSession,
    daily_token_ceiling: aiProxyConfig.dailyTokenCeiling,
    allowed_origins: aiProxyConfig.allowedOrigins.length,
    ...describeIpResolution(aiProxyConfig.trustedProxyHops)
  });

  if (aiProxyConfig.apiKey === "") {
    warning("ai_key_missing", {
      note:
        "GEMINI_API_KEY no está definida: el proxy responderá ai_unavailable y el widget " +
        "atenderá con el banco de preguntas frecuentes."
    });
  }
});

export { server, handleRequest, aiProxy };
