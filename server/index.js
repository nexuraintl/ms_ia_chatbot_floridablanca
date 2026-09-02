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
import { setupLogging, info, warning, error, critical } from "./logging.js";
import {
  createAiProxyHandler,
  createProxyConfig,
  AI_CHAT_PATH,
  isOriginAllowed
} from "./aiProxy.js";
import { describeIpResolution } from "./clientIdentity.js";
import { createIdentityTokenProvider, warnIfModeLooksWrong } from "./googleIdentity.js";
import { createRpaProxyConfig, createRpaProxyHandler, matchMount } from "./rpaProxy.js";
import { resolveTargets } from "./rpaTargets.js";
import { PROBE_POLICIES, describeDependencies, runStartupChecks } from "./startupChecks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuración desde el entorno ────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 8080;
const SERVICE_NAME = process.env.SERVICE_NAME || "ia-chatbot-floridablanca";
const SERVICE_VERSION = process.env.SERVICE_VERSION || "0.0.0-dev";
const ENVIRONMENT = process.env.ENVIRONMENT || "local";
const LOG_LEVEL = process.env.LOG_LEVEL || "INFO";
const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "";
const STATIC_ROOT = path.resolve(__dirname, "..", "dist");

/**
 * Prefijo bajo el que un proxy de delante publica este servicio, normalizado con barra
 * inicial y sin barra final. Cadena vacía = sin prefijo, que es el comportamiento de
 * siempre y el de QAM mientras el ingress sea `all`.
 *
 * Hace falta cuando el widget se sirve detrás del API Gateway o del balanceador con una
 * ruta por delante (`/apig/qa/chatbot/floridablanca`). Con `APPEND_PATH_TO_ADDRESS` el
 * gateway reenvía la ruta COMPLETA, así que el servidor recibe
 * `/apig/qa/chatbot/floridablanca/health` y no `/health`: sin recortarlo, `/health` y
 * `/version` caen al servidor de archivos, el proxy de IA devuelve 405, los montajes de
 * los RPA no coinciden y los assets acaban en el fallback de SPA.
 *
 * NO tiene que coincidir con el `base` del bundle (`VITE_BASE_PATH`). Son dos prefijos
 * distintos y en QAM difieren: el navegador pide
 * `/apig/qa/chatbot/floridablanca/...` y el balanceador recorta `/apig/qa` antes de llegar
 * aquí, así que este servidor solo ve `/chatbot/floridablanca/...`.
 *
 * `VITE_BASE_PATH` es el prefijo PÚBLICO, el que se incrusta en el bundle porque es el que
 * el navegador tiene que pedir. `BASE_PATH` es el que llega. Coinciden solo cuando nada
 * recorta en medio.
 */
const BASE_PATH = (() => {
  const raw = String(process.env.BASE_PATH || "").trim();
  if (raw === "" || raw === "/") return "";
  return `/${raw.replace(/^\/+/, "").replace(/\/+$/, "")}`;
})();

/**
 * Quita el prefijo del comienzo de una URL, dejando la ruta que las tablas de rutas de
 * este servidor esperan.
 *
 * Una ruta que NO empieza por el prefijo se devuelve intacta, a propósito: las sondas de
 * salud de Cloud Run y del balanceador llegan a `/health` sin prefijo, y rechazarlas
 * dejaría el servicio marcado como caído estando sano.
 *
 * La comparación exige frontera de segmento. Sin eso, un prefijo que solo coincide como
 * texto —`/chatbot/floridablanca-otro`— se recortaría y serviría contenido de este
 * servicio como si fuera de otro.
 *
 * @param {string} rawUrl  URL completa, con query.
 * @param {string} [basePath]
 * @returns {string}
 */
export const stripBasePath = (rawUrl, basePath = BASE_PATH) => {
  const url = rawUrl || "/";
  if (basePath === "") return url;
  if (url === basePath) return "/";
  if (url.startsWith(`${basePath}/`) || url.startsWith(`${basePath}?`)) {
    return url.slice(basePath.length) || "/";
  }
  return url;
};

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

// ── Integración con los microservicios RPA ────────────────────────────────────
// El navegador no puede acuñar un identity token de Google, así que todo el tráfico hacia
// los RPA pasa por aquí: el token se pone en el servidor, por servicio.
const rpaTargets = resolveTargets();
const identity = createIdentityTokenProvider();
const rpaProxyConfig = createRpaProxyConfig();
const rpaProxy = createRpaProxyHandler({
  config: rpaProxyConfig,
  services: rpaTargets.services,
  identity
});

/**
 * Política de la sonda de arranque. En un ambiente desplegado, un fallo de configuración debe
 * cortar el arranque; en local se avisa y se sigue, porque lo normal es no tener los dos RPA
 * levantados mientras se trabaja en el widget.
 */
const STARTUP_PROBE_POLICY =
  process.env.RPA_STARTUP_PROBE ||
  (ENVIRONMENT.toLowerCase() === "local" ? PROBE_POLICIES.OFF : PROBE_POLICIES.STRICT);

/** Resultado de las sondas, para exponerlo en /health. */
let rpaDependencies = {};

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

/**
 * Cabeceras CORS del contenido estático.
 *
 * Hacen falta porque el widget se carga como MÓDULO desde portales de otro dominio
 * (`<script type="module" src="https://…">`), y un módulo ES se pide SIEMPRE en modo CORS:
 * sin `Access-Control-Allow-Origin` el navegador descarta la respuesta aunque llegue con
 * 200. Un `<script>` clásico no lo exige, y esa diferencia es lo que hace el caso fácil de
 * pasar por alto. La firma en la consola es `net::ERR_FAILED 200 (OK)`.
 *
 * El CSS del widget viaja por la misma vía, así que le aplica igual.
 *
 * Se refleja el origen concreto contra `ALLOWED_ORIGINS`, nunca `*`. No es por proteger los
 * archivos —son públicos y cualquiera los descarga con curl— sino porque un portal no
 * autorizado que lograra cargar el widget consumiría la cuota de IA y la capacidad de los
 * RPA a nombre de la Alcaldía, y encima con los proxies rechazándole cada llamada: un
 * widget a medias en vez de un fallo claro al cargar.
 *
 * @param {string|undefined} origin
 * @param {string|undefined} host
 * @returns {Record<string, string>}
 */
export const staticCorsHeaders = (origin, host, config = aiProxyConfig) => {
  if (!origin) return {};
  if (!isOriginAllowed(origin, host, config)) return {};
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
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
const sendFile = (res, filePath, done, cors = {}) => {
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
      ...SECURITY_HEADERS,
      ...cors
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

  // Se reescribe `req.url` en vez de pasar la ruta recortada por parámetro: así todo lo
  // que va detrás —los dos proxies incluidos, que leen `req.url` para su propio enrutado
  // y su query— funciona sin saber que existe un prefijo.
  const receivedPath = (req.url || "/").split("?")[0];
  req.url = stripBasePath(req.url);
  const urlPath = (req.url || "/").split("?")[0];

  /** Registra el cierre de la petición, como exige el estándar. */
  const complete = (status) => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    info("request_completed", {
      method: req.method,
      // La ruta tal como llegó, que es la que se puede cruzar con los logs del gateway y
      // del balanceador. `route` es la que resolvió este servidor.
      path: receivedPath,
      ...(receivedPath === urlPath ? {} : { route: urlPath }),
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

  // ── Proxy de los RPA ──────────────────────────────────────────────────────
  // También antes de la comprobación de método: admite POST y OPTIONS.
  if (matchMount(urlPath)) {
    rpaProxy
      .handle(req, res)
      .then(complete)
      .catch((err) => {
        error("rpa_proxy_unhandled", { error: err?.message });
        if (!res.headersSent) {
          sendJson(res, 502, { error: "Bad Gateway", reason: "rpa_upstream_unavailable" });
        }
        complete(502);
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
    // `status` no depende de los RPA: es la sonda con la que Cloud Run decide si mata la
    // instancia, y matarla no arregla una dependencia caída. El detalle va aparte.
    sendJson(res, 200, { status: "UP", dependencies: rpaDependencies });
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

  // El widget se carga como módulo desde portales de otro dominio, y un módulo ES exige
  // CORS. Se resuelve una vez por petición, antes de leer el archivo.
  const cors = staticCorsHeaders(req.headers.origin, req.headers.host);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // El widget es una aplicación de una sola página: cualquier ruta desconocida
      // devuelve index.html para que el enrutado del cliente pueda resolverla.
      const fallback = path.join(STATIC_ROOT, "index.html");
      sendFile(res, fallback, complete, cors);
      return;
    }
    sendFile(res, filePath, complete, cors);
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

  // La configuración del RPA se deja registrada antes de sondear: si el arranque se corta,
  // este log es el que dice con qué valores lo intentó.
  info("rpa_proxy_configured", {
    auth_mode: identity.mode,
    via_gateway: rpaTargets.viaGateway,
    startup_probe: STARTUP_PROBE_POLICY,
    max_concurrent_tramites: rpaProxyConfig.maxConcurrentTramites,
    rate_limit_per_minute: rpaProxyConfig.ratePerMinute,
    effectful_limit_per_hour: rpaProxyConfig.effectfulPerHour,
    services: Object.fromEntries(
      Object.values(rpaTargets.services).map((s) => [s.id, { audience: s.audience, mount: s.mountPrefix }])
    )
  });
  warnIfModeLooksWrong(identity.mode, ENVIRONMENT);

  // Falla al arrancar, no en el primer trámite de un ciudadano.
  runStartupChecks({
    services: rpaTargets.services,
    configErrors: rpaTargets.errors,
    identity,
    policy: STARTUP_PROBE_POLICY
  })
    .then(({ fatal, results }) => {
      rpaDependencies = describeDependencies(results);
      if (fatal && STARTUP_PROBE_POLICY === PROBE_POLICIES.STRICT) {
        critical("startup_aborted", {
          note: "Configuración inválida de los RPA. Ver los registros rpa_config_invalid y rpa_probe_fatal."
        });
        process.exit(1);
      }
    })
    .catch((err) => {
      // Un fallo de la propia comprobación no debe dejar el servicio en un estado ambiguo.
      critical("startup_checks_failed", { error: err?.message });
    });
});

export { server, handleRequest, aiProxy, rpaProxy, identity };
