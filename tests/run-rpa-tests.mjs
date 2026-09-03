/**
 * Pruebas de la integración con los microservicios RPA.
 *
 * Ejecuta:  node tests/run-rpa-tests.mjs
 *
 * NINGUNA prueba toca los servicios desplegados. Las respuestas están simuladas a propósito:
 * una prueba automatizada contra el despliegue gasta captchas pagados, bloquea predios con
 * una transacción PSE real y radica trámites oficiales que nadie puede anular.
 *
 * Cubre las trampas verificadas del contrato:
 *   · un audience con barra final da 401 — aquí se rechaza antes de salir
 *   · un token por servicio: compartirlo da 401 en el segundo
 *   · 404 con JSON es la aplicación; 404 con HTML es el balanceador
 *   · found:false llega con 200
 *   · las rutas de seguimiento se usan tal como las devuelve el servicio
 */

import http from "node:http";

import { setupLogging } from "../server/logging.js";
import { withCorrelation, CORRELATION_HEADER } from "../server/correlation.js";
import {
  AUTH_MODES,
  IdentityTokenError,
  assertValidAudience,
  createIdentityTokenProvider,
  readTokenExpiry
} from "../server/googleIdentity.js";
import {
  buildUpstreamUrl,
  matchRoute,
  normalizeUpstreamPath,
  resolveTargets,
  stripTrailingSlash
} from "../server/rpaTargets.js";
import { classifyUpstreamStatus, createRpaProxyConfig, createRpaProxyHandler, filterQuery } from "../server/rpaProxy.js";
import { createAdmissionControl, isTerminalJobPayload } from "../server/rpaAdmission.js";
import { probeService, describeDependencies } from "../server/startupChecks.js";

// Silencio salvo lo crítico: estas pruebas provocan fallos a propósito y sus logs taparían
// el resultado.
setupLogging({ logLevel: "CRITICAL", serviceName: "test", serviceVersion: "test", environment: "local" });

const results = [];
let currentSection = "";

const section = (name) => {
  currentSection = name;
  console.log(`\n\x1b[1m\x1b[36m━━━ ${name} ━━━\x1b[0m`);
};
const check = (name, passed, detail = "") => {
  results.push({ section: currentSection, name, passed });
  console.log(`  [${passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}] ${name}`);
  if (detail) console.log(`         \x1b[90m${detail}\x1b[0m`);
};

/** URLs simuladas. Tienen la forma real de un Cloud Run, con hash y todo. */
const FACTURA_URL = "https://qam-rpa-factura-58937908768.us-central1.run.app";
const PQRSD_URL = "https://qam-rpa-pqrsd-ghlnutfdwq-uc.a.run.app";
const GATEWAY_URL = "https://gw-gob.example-gateway.dev";

/**
 * Construye un JWT verosímil. La firma es de relleno: nada de este código la verifica, solo
 * se lee `exp` para saber cuándo renovar.
 */
const fakeJwt = (aud, expiresInSeconds = 3600) => {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return [
    enc({ alg: "RS256", typ: "JWT" }),
    enc({ aud, exp: Math.floor(Date.now() / 1000) + expiresInSeconds, iss: "https://accounts.google.com" }),
    "firma-de-relleno"
  ].join(".");
};

// ══════════════════════════════════════════════════════════════════════════════
section("1. Audience: la trampa de la barra final");
// ══════════════════════════════════════════════════════════════════════════════
{
  let rejected = null;
  try {
    assertValidAudience(`${FACTURA_URL}/`);
  } catch (err) {
    rejected = err;
  }
  check(
    "un audience con barra final se rechaza antes de salir",
    rejected instanceof IdentityTokenError && rejected.reason === "audience_trailing_slash",
    `reason=${rejected?.reason}`
  );
  check(
    "el mensaje explica por qué, porque el 401 del servicio no lo hace",
    /barra final/i.test(rejected?.message || "") && /401/.test(rejected?.message || "")
  );

  check("un audience correcto pasa", assertValidAudience(FACTURA_URL) === FACTURA_URL);

  for (const [caso, valor, reason] of [
    ["vacío", "", "audience_missing"],
    ["sin esquema", "qam-rpa-factura.run.app", "audience_malformed"],
    ["en http", "http://qam-rpa-factura.run.app", "audience_insecure"]
  ]) {
    let err = null;
    try {
      assertValidAudience(valor);
    } catch (e) {
      err = e;
    }
    check(`un audience ${caso} se rechaza`, err?.reason === reason, `reason=${err?.reason}`);
  }

  check(
    "stripTrailingSlash quita todas las barras finales",
    stripTrailingSlash(`${FACTURA_URL}///`) === FACTURA_URL
  );
  check("lee el exp del token", readTokenExpiry(fakeJwt(FACTURA_URL, 3600)) > Date.now());
  check("un token ilegible no finge una expiración", readTokenExpiry("no-es-un-jwt") === 0);
}

// ══════════════════════════════════════════════════════════════════════════════
section("2. Un token por servicio");
// ══════════════════════════════════════════════════════════════════════════════
{
  const minted = [];
  const identity = createIdentityTokenProvider({
    mode: AUTH_MODES.METADATA,
    mintImpl: async (audience) => {
      minted.push(audience);
      return fakeJwt(audience);
    }
  });

  const tokenFactura = await identity.token(FACTURA_URL);
  const tokenPqrsd = await identity.token(PQRSD_URL);

  check(
    "cada servicio recibe un token distinto",
    tokenFactura !== tokenPqrsd,
    "compartirlo da 401 en el segundo servicio, y el 401 no menciona el audience"
  );
  check("se acuñó uno por audience", minted.length === 2, `acuñados=${minted.length}`);
  check(
    "el audience del token es la URL del servicio",
    JSON.parse(Buffer.from(tokenFactura.split(".")[1], "base64url")).aud === FACTURA_URL
  );

  // Segunda llamada: debe salir de la cache.
  await identity.token(FACTURA_URL);
  check("la cache evita reacuñar", minted.length === 2, `acuñados=${minted.length}`);
  check("la cache va indexada por audience", identity.stats().cached_audiences === 2);

  // Ráfaga concurrente sobre el mismo audience: una sola acuñación.
  identity.reset();
  minted.length = 0;
  await Promise.all(Array.from({ length: 5 }, () => identity.token(PQRSD_URL)));
  check(
    "una ráfaga sobre el mismo audience acuña una sola vez",
    minted.length === 1,
    `acuñados=${minted.length} para 5 peticiones simultáneas`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
section("3. Renovación y modos de autenticación");
// ══════════════════════════════════════════════════════════════════════════════
{
  let clock = Date.now();
  const minted = [];
  const identity = createIdentityTokenProvider({
    mode: AUTH_MODES.METADATA,
    now: () => clock,
    mintImpl: async (audience) => {
      minted.push(audience);
      // Token de 10 minutos: el margen de renovación es de 5.
      return fakeJwt(audience, 600);
    }
  });

  await identity.token(FACTURA_URL);
  clock += 4 * 60_000;
  await identity.token(FACTURA_URL);
  check("a los 4 minutos aún se reutiliza", minted.length === 1, `acuñados=${minted.length}`);

  clock += 2 * 60_000; // 6 minutos: quedan 4, menos que el margen de 5
  await identity.token(FACTURA_URL);
  check(
    "se renueva 5 minutos antes de expirar",
    minted.length === 2,
    "renovar al expirar deja un hueco de peticiones con 401"
  );

  const sinAuth = createIdentityTokenProvider({ mode: AUTH_MODES.NONE });
  check("el modo none no envía cabecera", Object.keys(await sinAuth.headers(FACTURA_URL)).length === 0);
  check("el modo none se declara deshabilitado", sinAuth.enabled === false);

  const gateway = createIdentityTokenProvider({ mode: AUTH_MODES.SIGNED_JWT });
  let gwError = null;
  try {
    await gateway.token(GATEWAY_URL);
  } catch (err) {
    gwError = err;
  }
  check(
    "el modo signed_jwt falla con instrucciones en vez de fingir",
    gwError?.reason === "signed_jwt_not_implemented",
    "es otro mecanismo: exige signJwt y serviceAccountTokenCreator"
  );
  check(
    "el error dice qué preguntarle a plataforma",
    /x-google-issuer/i.test(gwError?.message || "")
  );

  let modoInvalido = null;
  try {
    createIdentityTokenProvider({ mode: "inventado" });
  } catch (err) {
    modoInvalido = err;
  }
  check("un RPA_AUTH_MODE desconocido no arranca en silencio", modoInvalido?.reason === "mode_invalid");
}

// ══════════════════════════════════════════════════════════════════════════════
section("4. Destinos desde el entorno");
// ══════════════════════════════════════════════════════════════════════════════
{
  const directo = resolveTargets({ RPA_FACTURA_URL: `${FACTURA_URL}/`, RPA_PQRSD_URL: PQRSD_URL });
  check("no hay errores de configuración con las dos URLs", directo.errors.length === 0, directo.errors.join("; "));
  check(
    "la barra final se quita al resolver el destino",
    directo.services.factura.audience === FACTURA_URL,
    directo.services.factura.audience
  );
  check(
    "en directo el audience es la URL del propio servicio",
    directo.services.pqrsd.audience === PQRSD_URL &&
      directo.services.factura.audience !== directo.services.pqrsd.audience
  );
  check("en directo no se añade prefijo a la ruta", directo.services.factura.upstreamPrefix === "");
  check(
    "la URL final es base + ruta",
    buildUpstreamUrl(directo.services.factura, "/v1/clientes") === `${FACTURA_URL}/v1/clientes`
  );

  const faltante = resolveTargets({ RPA_FACTURA_URL: FACTURA_URL });
  check(
    "falta una variable y se nombra en el error",
    faltante.errors.some((e) => e.includes("RPA_PQRSD_URL")),
    faltante.errors.join("; ")
  );

  const insegura = resolveTargets({
    RPA_FACTURA_URL: "http://qam-rpa-factura.example.com",
    RPA_PQRSD_URL: PQRSD_URL
  });
  check("avisa de un destino sin https", insegura.errors.some((e) => /https/.test(e)));

  const porGateway = resolveTargets({
    RPA_GATEWAY_URL: GATEWAY_URL,
    RPA_FACTURA_URL: FACTURA_URL,
    RPA_PQRSD_URL: PQRSD_URL
  });
  check("con gateway el destino es el gateway", porGateway.services.factura.base === GATEWAY_URL);
  check("con gateway la ruta lleva el prefijo del servicio", porGateway.services.pqrsd.upstreamPrefix === "/rpa/pqrsd");
  check(
    "con gateway la URL final incluye el prefijo",
    buildUpstreamUrl(porGateway.services.pqrsd, "/v1/pqrsd/catalogos") ===
      `${GATEWAY_URL}/rpa/pqrsd/v1/pqrsd/catalogos`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
section("5. Normalización de rutas de seguimiento");
// ══════════════════════════════════════════════════════════════════════════════
{
  check(
    "una ruta canónica no cambia",
    normalizeUpstreamPath("factura", "/v1/jobs/abc123/stream") === "/v1/jobs/abc123/stream"
  );
  check(
    "quita el prefijo del proxy",
    normalizeUpstreamPath("factura", "/rpa/factura/v1/jobs/abc123") === "/v1/jobs/abc123"
  );
  check(
    "quita el prefijo aunque venga duplicado",
    normalizeUpstreamPath("factura", "/rpa/factura/rpa/factura/v1/clientes") === "/v1/clientes",
    "pasa cuando un cliente concatena el prefijo sobre un poll que ya lo traía"
  );
  check(
    "colapsa barras repetidas",
    normalizeUpstreamPath("pqrsd", "//v1//pqrsd/catalogos") === "/v1/pqrsd/catalogos",
    "sin esto //v1/... esquivaría la lista blanca"
  );
}

// ══════════════════════════════════════════════════════════════════════════════
section("6. Lista blanca de rutas");
// ══════════════════════════════════════════════════════════════════════════════
{
  check("admite GET /v1/clientes", matchRoute("factura", "GET", "/v1/clientes").route !== null);
  check(
    "admite el stream de un job",
    matchRoute("factura", "GET", "/v1/jobs/b3f1-x/stream").route?.kind === "sse"
  );
  check(
    "admite la descarga de la factura",
    matchRoute("factura", "GET", "/v1/facturas/Factura3205346.pdf").route?.kind === "binary"
  );
  check(
    "rechaza la ruta vieja /api/generar_factura",
    matchRoute("factura", "POST", "/api/generar_factura").route === null,
    "las rutas /api/... ya no existen"
  );
  check(
    "rechaza /v1/imprimir_factura",
    matchRoute("factura", "POST", "/v1/imprimir_factura").route === null,
    "el endpoint fue eliminado y disparaba una impresión física"
  );
  check("rechaza /openapi.json", matchRoute("factura", "GET", "/openapi.json").route === null);
  check(
    "un recorrido de rutas no llega a un archivo del servidor",
    matchRoute("factura", "GET", "/v1/facturas/../../etc/passwd").route === null
  );

  const metodoMalo = matchRoute("pqrsd", "GET", "/v1/pqrsd/crear");
  check(
    "distingue método no permitido de ruta inexistente",
    metodoMalo.route === null && metodoMalo.pathKnown === true,
    "uno es 405 y el otro 404: son dos diagnósticos distintos"
  );
  check(
    "la radicación está marcada para no reintentarse nunca",
    matchRoute("pqrsd", "POST", "/v1/pqrsd/crear").route?.noRetry === true
  );
}

// ══════════════════════════════════════════════════════════════════════════════
section("7. Query: nada personal en la URL");
// ══════════════════════════════════════════════════════════════════════════════
{
  const { query, dropped } = filterQuery(
    "mode=async&cliente=floridablanca&search_value=1098765432&phone=3101234567&email=a@b.co"
  );
  check("conserva los parámetros de operación", query.includes("mode=async") && query.includes("cliente=floridablanca"));
  check(
    "descarta el documento, el teléfono y el correo",
    !query.includes("1098765432") && !query.includes("3101234567") && !query.includes("a%40b.co"),
    `descartados=${dropped.join(",")}`
  );
  check("descarta también el cid, que consume el proxy", filterQuery("cid=x").query === "");
}

// ══════════════════════════════════════════════════════════════════════════════
section("8. Clasificación de los fallos del destino");
// ══════════════════════════════════════════════════════════════════════════════
{
  check(
    "401 no reenvía el cuerpo del destino",
    classifyUpstreamStatus(401, "application/json").reason === "rpa_unauthenticated" &&
      classifyUpstreamStatus(401, "application/json").safeToForwardBody === false
  );
  check("403 se identifica como falta de run.invoker", classifyUpstreamStatus(403, "text/html").reason === "rpa_forbidden");
  check(
    "404 con JSON es la aplicación: la ruta no existe",
    classifyUpstreamStatus(404, "application/json").reason === "route_unknown"
  );
  check(
    "404 con HTML es el balanceador: no se pasó el ingress",
    classifyUpstreamStatus(404, "text/html; charset=utf-8").reason === "rpa_ingress_blocked",
    "esta distinción es la que más tiempo ahorra"
  );
  check("504 se identifica como corte por tiempo", classifyUpstreamStatus(504, "").reason === "rpa_upstream_timeout");
  check("un 200 no tiene motivo de fallo", classifyUpstreamStatus(200, "application/json").reason === "");
}

// ══════════════════════════════════════════════════════════════════════════════
section("9. Control de admisión del techo de dos trámites");
// ══════════════════════════════════════════════════════════════════════════════
{
  let clock = 0;
  const admission = createAdmissionControl({ maxConcurrent: 2, leaseMs: 1000, now: () => clock });

  const a = admission.acquire();
  const b = admission.acquire();
  const c = admission.acquire();

  check("los dos primeros trámites entran", a.admitted && b.admitted);
  check("el tercero espera en lugar de sumarse a la cola del RPA", c.admitted === false);
  check("y sabe qué decirle al ciudadano", c.queuePosition === 1 && c.retryAfterSeconds > 0);

  admission.bind(a.slotId, "job-1");
  admission.release("job-1");
  check("liberado un cupo, entra el siguiente", admission.acquire().admitted === true);

  clock += 2000; // vence el contrato de todos
  check("un cupo huérfano se libera al vencer su contrato", admission.snapshot().in_flight === 0);

  check("un job terminado libera el cupo", isTerminalJobPayload({ status: "done" }) === true);
  check("un job en curso no", isTerminalJobPayload({ status: "running" }) === false);
  check(
    "un error también es terminal",
    isTerminalJobPayload({ status: "error" }) === true,
    "para el cupo da igual el desenlace; el desenlace lo lee el frontend en result.status"
  );
}

// ══════════════════════════════════════════════════════════════════════════════
section("10. El proxy sobre HTTP real, con respuestas simuladas");
// ══════════════════════════════════════════════════════════════════════════════

/** Registro de lo que el proxy envió hacia arriba, para poder afirmar sobre las cabeceras. */
let upstreamCalls = [];
/** Respuesta que devolverá el destino simulado en la próxima llamada. */
let upstreamHandler = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

const mockFetch = async (url, init = {}) => {
  upstreamCalls.push({ url: String(url), init, headers: init.headers || {} });
  return upstreamHandler(String(url), init);
};

const targets = resolveTargets({ RPA_FACTURA_URL: FACTURA_URL, RPA_PQRSD_URL: PQRSD_URL });
const identity = createIdentityTokenProvider({
  mode: AUTH_MODES.METADATA,
  mintImpl: async (audience) => fakeJwt(audience)
});
const proxyConfig = createRpaProxyConfig({
  ENVIRONMENT: "qam",
  // La lista real del despliegue. El portal de pruebas va explícito porque no cae bajo el
  // comodín del dominio oficial: son dominios distintos.
  ALLOWED_ORIGINS: ".floridablanca.gov.co,pruebas-se-floridablanca.nexura.com",
  RPA_MAX_UPLOAD_BYTES: "2048",
  RPA_RATE_LIMIT_PER_MINUTE: "50",
  RPA_EFFECTFUL_LIMIT_PER_HOUR: "20",
  TRUSTED_PROXY_HOPS: "0"
});
const proxy = createRpaProxyHandler({
  config: proxyConfig,
  services: targets.services,
  identity,
  fetchImpl: mockFetch
});

const TEST_PORT = 8897;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const server = http.createServer((req, res) => {
  withCorrelation(req, res, () => {
    proxy.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
});
await new Promise((resolve) => server.listen(TEST_PORT, "127.0.0.1", resolve));

/** Atajo: limpia el estado entre casos. */
const resetMock = (handler) => {
  upstreamCalls = [];
  proxy.reset();
  if (handler) upstreamHandler = handler;
};

const jsonResponse = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });

{
  resetMock(() => jsonResponse({ status: "success", clientes: [{ id: "floridablanca" }] }));

  const res = await fetch(`${BASE}/rpa/factura/v1/clientes`);
  const body = await res.json();

  check("una consulta pasa y devuelve el cuerpo del servicio", res.status === 200 && body.status === "success");
  check(
    "el proxy pone el token que el navegador no puede acuñar",
    /^Bearer [\w-]+\.[\w-]+\./.test(upstreamCalls[0]?.headers?.Authorization || ""),
    upstreamCalls[0]?.headers?.Authorization?.slice(0, 24)
  );
  check(
    "la URL de destino es la del Cloud Run, no la del proxy",
    upstreamCalls[0]?.url === `${FACTURA_URL}/v1/clientes`,
    upstreamCalls[0]?.url
  );
  check(
    "la respuesta lleva el identificador de correlación",
    Boolean(res.headers.get(CORRELATION_HEADER))
  );
  check(
    "y el mismo identificador viajó hacia el servicio",
    upstreamCalls[0]?.headers?.[CORRELATION_HEADER] === res.headers.get(CORRELATION_HEADER),
    "es la única forma de cruzar un trámite entre el chatbot y los dos RPA"
  );
}

{
  // Dos servicios en la misma instancia: cada uno con su token.
  resetMock(() => jsonResponse({ ok: true }));
  await fetch(`${BASE}/rpa/factura/v1/clientes`);
  await fetch(`${BASE}/rpa/pqrsd/v1/pqrsd/catalogos`);

  const tokens = upstreamCalls.map((c) => c.headers.Authorization);
  check("cada servicio se llama con su propio token", tokens[0] !== tokens[1]);
  check(
    "el segundo va al host del segundo servicio",
    upstreamCalls[1]?.url === `${PQRSD_URL}/v1/pqrsd/catalogos`,
    upstreamCalls[1]?.url
  );
}

{
  resetMock(() => jsonResponse({ detail: "Not Found" }, 404));
  const res = await fetch(`${BASE}/rpa/factura/v1/imprimir_factura`, { method: "POST" });
  check(
    "una ruta fuera de la lista blanca no sale del proxy",
    res.status === 404 && upstreamCalls.length === 0,
    `status=${res.status} llamadas=${upstreamCalls.length}`
  );

  const viejo = await fetch(`${BASE}/rpa/factura/api/generar_factura`, { method: "POST" });
  check("una ruta /api/... tampoco", viejo.status === 404 && upstreamCalls.length === 0);

  const metodo = await fetch(`${BASE}/rpa/pqrsd/v1/pqrsd/crear`);
  check(
    "un método no permitido responde 405, no 404",
    metodo.status === 405,
    `status=${metodo.status}`
  );
}

{
  resetMock(() => jsonResponse({ ok: true }));
  await fetch(`${BASE}/rpa/factura/v1/prewarm?cliente=floridablanca&search_value=1098765432`, {
    method: "POST"
  });
  check(
    "el documento del ciudadano no llega a la URL del servicio",
    !upstreamCalls[0]?.url.includes("1098765432"),
    upstreamCalls[0]?.url
  );
  check("el municipio sí", upstreamCalls[0]?.url.includes("cliente=floridablanca"));
}

{
  resetMock(() => new Response("<html>Error 404 (Not Found)</html>", {
    status: 404,
    headers: { "content-type": "text/html; charset=UTF-8" }
  }));
  const res = await fetch(`${BASE}/rpa/factura/v1/clientes`);
  const body = await res.json();
  check(
    "un 404 con HTML se traduce a ingress bloqueado",
    body.reason === "rpa_ingress_blocked",
    "no es un problema de ruta: el tráfico no pasó del balanceador"
  );
  check("y el HTML de Google no se reenvía al navegador", !JSON.stringify(body).includes("<html>"));
}

{
  resetMock(() => new Response("Unauthorized", { status: 401, headers: { "content-type": "text/plain" } }));
  const res = await fetch(`${BASE}/rpa/factura/v1/clientes`);
  const body = await res.json();
  check("un 401 del servicio se identifica", body.reason === "rpa_unauthenticated");

  resetMock(() => new Response("Forbidden", { status: 403 }));
  const res403 = await fetch(`${BASE}/rpa/pqrsd/v1/pqrsd/catalogos`);
  check("un 403 se identifica como falta de permisos", (await res403.json()).reason === "rpa_forbidden");
}

{
  // Un 422 trae las opciones válidas: el cuerpo de la aplicación sí se reenvía, porque el
  // frontend lo necesita para corregir al ciudadano.
  resetMock(() =>
    jsonResponse(
      { detail: "'Código X' no es un tipo de búsqueda válido para 'floridablanca'.", search_types: ["Código Predial"] },
      422
    )
  );
  const res = await fetch(`${BASE}/rpa/factura/v1/generar_factura?mode=async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ search_type: "Código X" })
  });
  const body = await res.json();
  check("un 422 conserva el cuerpo de la aplicación", res.status === 422 && Array.isArray(body.search_types));
}

{
  // found:false llega con 200: se distingue por el campo, no por el código.
  resetMock(() =>
    jsonResponse({ success: true, found: false, message: "No se encontró un registro", anexos: [], flujo: [] })
  );
  const res = await fetch(`${BASE}/rpa/pqrsd/v1/pqrsd/consultar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ radicado: "1", codigo_autenticacion: "x" })
  });
  const body = await res.json();
  check("un radicado inexistente llega como 200 con found:false", res.status === 200 && body.found === false);
  check("y los accesorios vacíos pasan intactos", Array.isArray(body.anexos) && Array.isArray(body.flujo));
}

{
  // Las rutas de seguimiento se reenvían tal cual: el frontend no debe rearmarlas.
  resetMock(() =>
    jsonResponse(
      { status: "accepted", job_id: "b3f1x", poll: "/v1/jobs/b3f1x", stream: "/v1/jobs/b3f1x/stream" },
      202
    )
  );
  const res = await fetch(`${BASE}/rpa/factura/v1/generar_factura?mode=async`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ search_type: "Código NUPRE", search_value: "X", phone: "3", email: "a@b.co" })
  });
  const body = await res.json();
  check("un trámite aceptado devuelve 202 con job_id", res.status === 202 && body.job_id === "b3f1x");
  check(
    "poll y stream llegan al frontend tal como los dio el servicio",
    body.poll === "/v1/jobs/b3f1x" && body.stream === "/v1/jobs/b3f1x/stream"
  );
  check(
    "el cuerpo con datos personales viajó en el cuerpo, no en la URL",
    !upstreamCalls[0]?.url.includes("a@b.co") && String(upstreamCalls[0]?.init?.body || "").includes("a@b.co")
  );
}

{
  // Techo de dos trámites: el tercero recibe una espera explicable.
  resetMock(() =>
    jsonResponse(
      { status: "accepted", job_id: `job-${upstreamCalls.length}`, poll: "/v1/jobs/x", stream: "/v1/jobs/x/stream" },
      202
    )
  );
  const lanzar = () =>
    fetch(`${BASE}/rpa/factura/v1/generar_factura?mode=async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ search_type: "Código NUPRE", search_value: "X" })
    });

  const uno = await lanzar();
  const dos = await lanzar();
  const tres = await lanzar();
  const cuerpoTres = await tres.json();

  check("dos trámites simultáneos entran", uno.status === 202 && dos.status === 202);
  check(
    "el tercero recibe 429 en lugar de esperar en la cola del RPA",
    tres.status === 429 && cuerpoTres.reason === "rpa_queue_full",
    `status=${tres.status} reason=${cuerpoTres.reason}`
  );
  check("con una espera que el chatbot puede comunicar", Number(cuerpoTres.retryAfterSeconds) > 0);
  check("y sin haber llegado al servicio", upstreamCalls.length === 2, `llamadas=${upstreamCalls.length}`);
}

{
  // Stream SSE: se reenvía sin bufferizar y con las cabeceras que exige el navegador.
  resetMock(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode(': ping\n\n'));
            controller.enqueue(enc.encode('data: {"event":"started","ts":1}\n\n'));
            controller.enqueue(enc.encode('data: {"event":"pdf_ready","ts":2,"filename":"Factura1.pdf","amount":"66122546"}\n\n'));
            controller.enqueue(enc.encode('data: {"event":"done","ts":3,"result":{"status":"success"}}\n\n'));
            controller.close();
          }
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
  );

  const res = await fetch(`${BASE}/rpa/factura/v1/jobs/b3f1x/stream?cid=11111111-2222-4333-8444-555555555555`);
  const text = await res.text();

  check("el stream se sirve como text/event-stream", res.headers.get("content-type")?.includes("text/event-stream"));
  check(
    "y sin acumulación intermedia",
    res.headers.get("x-accel-buffering") === "no",
    "sin esto los eventos llegarían todos juntos al final"
  );
  check("los eventos llegan completos", text.includes('"event":"started"') && text.includes('"event":"done"'));
  check("el heartbeat pasa tal cual", text.includes(": ping"));
  check(
    "la correlación del stream viaja por query porque EventSource no admite cabeceras",
    upstreamCalls[0]?.headers?.[CORRELATION_HEADER] === "11111111-2222-4333-8444-555555555555"
  );
  check(
    "al cerrarse el stream se libera el cupo del trámite",
    proxy.stats().in_flight === 0,
    "sin esto el siguiente ciudadano esperaría hasta que venciera el contrato del cupo"
  );
  check(
    "y el cid no se reenvía al servicio",
    !upstreamCalls[0]?.url.includes("cid="),
    upstreamCalls[0]?.url
  );
}

{
  // El PDF se descarga con token y se reenvía: el ciudadano nunca recibe la URL con IAM.
  resetMock(
    () =>
      new Response(new Uint8Array([37, 80, 68, 70, 45]), {
        status: 200,
        headers: { "content-type": "application/pdf" }
      })
  );
  const res = await fetch(`${BASE}/rpa/factura/v1/facturas/Factura3205346.pdf`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  check("el PDF llega al navegador", res.status === 200 && bytes[0] === 37);
  check(
    "el token viajó en la descarga",
    String(upstreamCalls[0]?.headers?.Authorization || "").startsWith("Bearer ")
  );
  check(
    "se ofrece como descarga con el nombre del portal",
    res.headers.get("content-disposition")?.includes("Factura3205346.pdf"),
    res.headers.get("content-disposition")
  );
  check(
    "y no se cachea en ningún salto",
    res.headers.get("cache-control") === "no-store",
    "la factura lleva el detalle tributario del ciudadano"
  );
}

{
  resetMock(() => jsonResponse({ ok: true }));
  const grande = await fetch(`${BASE}/rpa/pqrsd/v1/pqrsd/crear`, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
    body: "x".repeat(4096)
  });
  check(
    "unos anexos por encima del tope se cortan con 413",
    grande.status === 413 && (await grande.json()).reason === "payload_too_large",
    `status=${grande.status} (tope 2048 B en esta prueba)`
  );
  check("y no se malgasta ancho de banda hacia el servicio", upstreamCalls.length === 0);
}

{
  resetMock(() => jsonResponse({ ok: true }));
  const ajeno = await fetch(`${BASE}/rpa/factura/v1/clientes`, {
    headers: { Origin: "https://portal-falso.example.com" }
  });
  check(
    "un origen no autorizado no llega al servicio",
    ajeno.status === 403 && upstreamCalls.length === 0,
    `status=${ajeno.status}`
  );
  check(
    "y no se le concede permiso CORS",
    ajeno.headers.get("access-control-allow-origin") === null
  );

  const preflight = await fetch(`${BASE}/rpa/factura/v1/generar_factura`, {
    method: "OPTIONS",
    headers: { Origin: "https://tramites.floridablanca.gov.co" }
  });
  check("el preflight de un portal autorizado responde 204", preflight.status === 204);
  check(
    "declarando las cabeceras de correlación",
    preflight.headers.get("access-control-allow-headers")?.toLowerCase().includes("x-correlation-id")
  );
  check(
    "nunca con comodín en el origen",
    preflight.headers.get("access-control-allow-origin") === "https://tramites.floridablanca.gov.co"
  );

  const pruebas = await fetch(`${BASE}/rpa/factura/v1/clientes`, {
    headers: { Origin: "https://pruebas-se-floridablanca.nexura.com" }
  });
  check(
    "el portal de pruebas embebido está autorizado",
    pruebas.status === 200,
    "no cae bajo el comodín .floridablanca.gov.co, así que va explícito en ALLOWED_ORIGINS"
  );
}

{
  // Límite de tasa: el proxy es público y detrás hay captchas pagados.
  resetMock(() => jsonResponse({ ok: true }));
  const acotado = createRpaProxyHandler({
    config: { ...proxyConfig, ratePerMinute: 2 },
    services: targets.services,
    identity,
    fetchImpl: mockFetch
  });
  const fakeRes = () => {
    const chunks = [];
    return {
      statusCode: 0,
      headersSent: false,
      setHeader() {},
      writeHead(status) {
        this.statusCode = status;
        this.headersSent = true;
        return this;
      },
      write(c) {
        chunks.push(c);
        return true;
      },
      end(c) {
        if (c) chunks.push(c);
      },
      once() {},
      on() {}
    };
  };
  const fakeReq = () => ({
    url: "/rpa/factura/v1/clientes",
    method: "GET",
    headers: { host: "127.0.0.1" },
    socket: { remoteAddress: "203.0.113.7" },
    on() {}
  });

  const statuses = [];
  for (let i = 0; i < 3; i += 1) {
    const res = fakeRes();
    statuses.push(await acotado.handle(fakeReq(), res));
  }
  check(
    "el límite por IP corta la ráfaga",
    statuses[0] === 200 && statuses[1] === 200 && statuses[2] === 429,
    `códigos=${statuses.join(",")}`
  );
}

server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));

// ══════════════════════════════════════════════════════════════════════════════
section("11. Sonda de arranque");
// ══════════════════════════════════════════════════════════════════════════════
{
  const service = targets.services.factura;
  const sano = await probeService({
    service,
    identity,
    fetchImpl: async () => jsonResponse({ status: "UP" })
  });
  check("un /health correcto es OK", sano.ok === true && sano.fatal === false);

  const sinPermiso = await probeService({
    service,
    identity,
    fetchImpl: async () => new Response("Forbidden", { status: 403 })
  });
  check(
    "un 403 en el arranque es fatal, no algo que se arregle esperando",
    sinPermiso.fatal === true,
    "falta roles/run.invoker: el despliegue está mal"
  );

  const portalCaido = await probeService({
    service,
    identity,
    fetchImpl: async () => new Response("", { status: 502 })
  });
  check(
    "un 502 no tumba el chatbot",
    portalCaido.ok === false && portalCaido.fatal === false,
    "el portal caído es transitorio; el widget sigue atendiendo con las preguntas frecuentes"
  );

  const ingress = await probeService({
    service,
    identity,
    fetchImpl: async () => new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } })
  });
  check("un 404 con HTML se explica como ingress", /ingress/i.test(ingress.detail));

  const resumen = describeDependencies([sano, { ...portalCaido, service: "pqrsd" }]);
  check(
    "el resumen para /health distingue arriba de abajo",
    resumen.factura === "UP" && resumen.pqrsd.startsWith("DOWN"),
    JSON.stringify(resumen)
  );
}

// ══════════════════════════════════════════════════════════════════════════════
section("12. Contrato del frontend");
// ══════════════════════════════════════════════════════════════════════════════
{
  const { resolveTrackingUrl, getFacturaPdfUrl, formatPesos } = await import(
    "../src/services/rpaPredialService.js"
  );
  const { classifyRetry } = await import("../src/domain/errors/rpaErrorTranslator.js");

  check(
    "usa la ruta de seguimiento del Cloud Run directo",
    resolveTrackingUrl("/v1/jobs/b3f1x/stream") === "/rpa/factura/v1/jobs/b3f1x/stream"
  );
  check(
    "y la que devuelve el gateway, sin duplicar el prefijo",
    resolveTrackingUrl("/rpa/factura/v1/jobs/b3f1x") === "/rpa/factura/v1/jobs/b3f1x",
    "concatenar a mano funciona en directo y se rompe detrás del gateway"
  );

  let rechazada = null;
  try {
    resolveTrackingUrl("https://sitio-del-atacante.example.com/v1/jobs/x/stream");
  } catch (err) {
    rechazada = err;
  }
  check("una ruta de seguimiento con otra forma se rechaza", rechazada !== null);

  check(
    "el PDF se pide al proxy, no al Cloud Run",
    getFacturaPdfUrl("Factura3205346.pdf") === "/rpa/factura/v1/facturas/Factura3205346.pdf",
    "el endpoint está detrás de IAM: el navegador del ciudadano no lleva token"
  );
  check("un nombre de archivo inesperado no genera enlace", getFacturaPdfUrl("../../etc/passwd") === "#");
  check("el monto se formatea desde un string de pesos", formatPesos("66122546").includes("66.122.546"));

  check(
    "el fallo del captcha admite un reintento inmediato",
    classifyRetry("El worker de CAPSOLVER retornó None o falló.").retryable === true
  );
  check(
    "el portal caído a mitad del trámite admite un reintento con espera",
    classifyRetry("El portal abandonó la página de factura durante la generación del recibo").delayMs > 0
  );
  check(
    "un predio a paz y salvo NO se reintenta",
    classifyRetry(
      "El botón 'Generar Factura' no se habilitó; el predio podría estar a paz y salvo o sin deuda pendiente."
    ).retryable === false,
    "no es un fallo: es la respuesta"
  );
  check(
    "una transacción PSE en curso NO se reintenta",
    classifyRetry("Se esta procesando una transacción con la pasarela de pago").retryable === false,
    "bloquea el predio una hora"
  );
}

// ── Resumen ────────────────────────────────────────────────────────────────────
const fallos = results.filter((r) => !r.passed);
console.log(`\n\x1b[1m${"═".repeat(74)}\x1b[0m`);
console.log(
  `\x1b[1mRPA\x1b[0m  ${results.length - fallos.length}/${results.length} verificaciones superadas` +
    (fallos.length ? `, \x1b[31m${fallos.length} fallo(s)\x1b[0m` : ", \x1b[32mtodo en verde\x1b[0m")
);
console.log(`\x1b[1m${"═".repeat(74)}\x1b[0m\n`);

if (fallos.length) {
  for (const f of fallos) console.log(`  · [${f.section}] ${f.name}`);
  process.exit(1);
}
