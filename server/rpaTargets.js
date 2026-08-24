/**
 * Registro de los microservicios RPA: donde estan, con que audience se les habla y que
 * rutas admiten.
 *
 * Las URLs vienen SIEMPRE del entorno. Fijarlas en el codigo ya rompio una vez: renombrar
 * `qa-rpa-pqrsd` a `qam-rpa-pqrsd` cambio el hash del host y todo lo que la tenia fija dejo
 * de funcionar sin aviso.
 *
 * La lista de rutas es una lista blanca, no una comodidad. El proxy que la usa esta expuesto
 * al publico y detras hay endpoints que producen efectos reales e irreversibles ante la
 * alcaldia (`/v1/pqrsd/crear`) y que gastan captchas pagados (`/v1/generar_factura`).
 */

/** Identificadores de servicio. */
export const SERVICE_IDS = Object.freeze(["factura", "pqrsd"]);

/**
 * Prefijo con el que cada servicio se publica, tanto en nuestro proxy como detras del API
 * Gateway. Coinciden a proposito: asi los campos `poll` y `stream` que devuelve el servicio
 * de factura sirven tal cual contra el proxy, sin tener que rearmarlos.
 */
export const MOUNT_PREFIXES = Object.freeze({
  factura: "/rpa/factura",
  pqrsd: "/rpa/pqrsd"
});

/** Quita las barras finales. Protege el audience: una barra sobrante devuelve 401. */
export const stripTrailingSlash = (value) => String(value || "").trim().replace(/\/+$/, "");

/**
 * Tipos de tratamiento del cuerpo. Determinan como reenvia el proxy la respuesta.
 *
 *   json       Se lee completo y se reenvia.
 *   sse        Se reenvia en streaming, sin bufferizar.
 *   binary     PDF. Se descarga con token y se reenvia; el ciudadano nunca ve la URL con IAM.
 *   multipart  Cuerpo del cliente en streaming hacia arriba.
 */
export const BODY_KINDS = Object.freeze({
  JSON: "json",
  SSE: "sse",
  BINARY: "binary",
  MULTIPART: "multipart"
});

/**
 * Rutas admitidas, por servicio.
 *
 * `effectful` marca las que producen un efecto real: entran por el control de admision y
 * cuentan para el limite de tasa. `noRetry` marca las que no se pueden reenviar nunca porque
 * un reenvio duplicaria un tramite oficial.
 *
 * `/v1/imprimir_factura` no esta: fue eliminado del servicio y disparaba una impresion fisica.
 * `/openapi.json` y `/docs` tampoco: describen la superficie interna del servicio.
 */
const JOB_ID = "[A-Za-z0-9_-]{1,64}";
const FILENAME = "[A-Za-z0-9_.-]{1,128}";

export const ROUTES = Object.freeze({
  factura: Object.freeze([
    { methods: ["GET"], pattern: new RegExp("^/health$"), kind: BODY_KINDS.JSON, timeoutMs: 10_000 },
    { methods: ["GET"], pattern: new RegExp("^/v1/clientes$"), kind: BODY_KINDS.JSON, timeoutMs: 20_000 },
    {
      methods: ["GET", "POST"],
      pattern: new RegExp("^/v1/prewarm$"),
      kind: BODY_KINDS.JSON,
      timeoutMs: 25_000
    },
    {
      methods: ["POST"],
      pattern: new RegExp("^/v1/generar_factura$"),
      kind: BODY_KINDS.JSON,
      timeoutMs: 60_000,
      effectful: true
    },
    {
      methods: ["POST"],
      pattern: new RegExp("^/v1/seleccionar_predio$"),
      kind: BODY_KINDS.JSON,
      timeoutMs: 60_000,
      effectful: true
    },
    { methods: ["GET"], pattern: new RegExp(`^/v1/jobs/${JOB_ID}$`), kind: BODY_KINDS.JSON, timeoutMs: 20_000 },
    {
      methods: ["GET"],
      pattern: new RegExp(`^/v1/jobs/${JOB_ID}/stream$`),
      kind: BODY_KINDS.SSE,
      // Sin timeout: el stream vive hasta `done` o hasta el corte del propio servicio (300s).
      timeoutMs: 0
    },
    {
      methods: ["GET"],
      pattern: new RegExp(`^/v1/facturas/${FILENAME}$`),
      kind: BODY_KINDS.BINARY,
      timeoutMs: 60_000
    }
  ]),

  pqrsd: Object.freeze([
    { methods: ["GET"], pattern: new RegExp("^/health$"), kind: BODY_KINDS.JSON, timeoutMs: 10_000 },
    {
      methods: ["GET"],
      pattern: new RegExp("^/v1/pqrsd/catalogos$"),
      kind: BODY_KINDS.JSON,
      timeoutMs: 25_000
    },
    {
      methods: ["POST"],
      pattern: new RegExp("^/v1/pqrsd/consultar$"),
      kind: BODY_KINDS.JSON,
      timeoutMs: 60_000
    },
    {
      methods: ["POST"],
      pattern: new RegExp("^/v1/pqrsd/crear$"),
      kind: BODY_KINDS.MULTIPART,
      timeoutMs: 180_000,
      effectful: true,
      // Un reenvio duplica un tramite oficial que nadie puede anular. Ver docs, regla 1.
      noRetry: true
    }
  ])
});

/**
 * Normaliza una ruta de peticion a la ruta canonica del servicio (`/v1/...`).
 *
 * Acepta las tres formas en que puede llegar: con el prefijo de nuestro proxy, con el del
 * gateway (que es el mismo) y ya canonica. Asi los campos `poll` y `stream` que devuelve el
 * servicio sirven tal cual vengan del Cloud Run directo o de detras del gateway.
 *
 * @param {string} servicio
 * @param {string} path
 * @returns {string}
 */
export const normalizeUpstreamPath = (servicio, path) => {
  const prefix = MOUNT_PREFIXES[servicio];
  let result = String(path || "").split("?")[0];

  // Se aplica en bucle: una ruta puede llegar con el prefijo duplicado si un cliente
  // concatena el prefijo local sobre un `poll` que ya lo traia.
  while (prefix && (result === prefix || result.startsWith(`${prefix}/`))) {
    result = result.slice(prefix.length) || "/";
  }

  if (!result.startsWith("/")) result = `/${result}`;
  // Colapsar barras repetidas: `//v1/clientes` no debe esquivar la lista blanca.
  return result.replace(/\/{2,}/g, "/");
};

/**
 * Busca la ruta en la lista blanca del servicio.
 *
 * @param {string} servicio
 * @param {string} method
 * @param {string} canonicalPath
 * @returns {{route: Object|null, pathKnown: boolean}} `pathKnown` distingue "ruta no
 *          existe" de "existe pero no con ese metodo", que son dos errores distintos.
 */
export const matchRoute = (servicio, method, canonicalPath) => {
  const table = ROUTES[servicio];
  if (!table) return { route: null, pathKnown: false };

  let pathKnown = false;
  for (const route of table) {
    if (!route.pattern.test(canonicalPath)) continue;
    pathKnown = true;
    if (route.methods.includes(String(method || "").toUpperCase())) {
      return { route, pathKnown: true };
    }
  }
  return { route: null, pathKnown };
};

/**
 * Resuelve la configuracion de los dos servicios desde el entorno.
 *
 * Dos caminos, decididos por variable de entorno y no por un `if` en el codigo de negocio:
 *
 *   Directo   (QAM)         base = URL del Cloud Run, audience = esa misma URL.
 *   Gateway   (PREM/PROD)   base = URL del gateway, audience = URL del gateway, y la ruta
 *                           lleva el prefijo del servicio.
 *
 * El segundo camino solo es correcto si el gateway tiene `x-google-issuer:
 * https://accounts.google.com`. Con el otro valor el mecanismo es un JWT auto-firmado, que
 * es otra cosa: ver `AUTH_MODES.SIGNED_JWT`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{services: Record<string, Object>, errors: string[], viaGateway: boolean}}
 */
export const resolveTargets = (env = process.env) => {
  const gatewayUrl = stripTrailingSlash(env.RPA_GATEWAY_URL);
  const viaGateway = gatewayUrl !== "";

  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, Object>} */
  const services = {};

  const declared = {
    factura: stripTrailingSlash(env.RPA_FACTURA_URL),
    pqrsd: stripTrailingSlash(env.RPA_PQRSD_URL)
  };

  for (const id of SERVICE_IDS) {
    const directUrl = declared[id];
    const base = viaGateway ? gatewayUrl : directUrl;
    const varName = id === "factura" ? "RPA_FACTURA_URL" : "RPA_PQRSD_URL";

    if (!viaGateway && directUrl === "") {
      errors.push(
        `Falta ${varName}: es la URL del Cloud Run de ${id} y tambien su audience. ` +
          "Sin ella no hay ni destino ni token."
      );
      continue;
    }

    try {
      const parsed = new URL(base);
      const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (parsed.protocol !== "https:" && !isLoopback) {
        errors.push(`${varName}="${base}" no usa https. Por ahi viajan datos personales del ciudadano.`);
      }
    } catch {
      errors.push(`${varName}="${base}" no es una URL valida.`);
      continue;
    }

    services[id] = Object.freeze({
      id,
      /** Origen al que se envia la peticion. */
      base,
      /**
       * Prefijo que hay que añadir a la ruta canonica en el destino. Vacio contra el Cloud
       * Run directo; el prefijo del servicio cuando se entra por el gateway.
       */
      upstreamPrefix: viaGateway ? MOUNT_PREFIXES[id] : "",
      /** Prefijo con el que este proxy publica el servicio. */
      mountPrefix: MOUNT_PREFIXES[id],
      /**
       * Audience del identity token: la URL exacta del destino, sin barra final. Detras del
       * gateway es la del gateway, y entonces los dos servicios comparten audience porque
       * comparten destino.
       */
      audience: base,
      viaGateway
    });
  }

  return { services, errors, viaGateway };
};

/**
 * Construye la URL final de una peticion al servicio.
 *
 * @param {Object} service Entrada de `resolveTargets().services`.
 * @param {string} canonicalPath Ruta ya normalizada y validada (`/v1/...`).
 * @param {string} [query] Query string sin `?`.
 * @returns {string}
 */
export const buildUpstreamUrl = (service, canonicalPath, query = "") => {
  const url = `${service.base}${service.upstreamPrefix}${canonicalPath}`;
  return query ? `${url}?${query}` : url;
};
