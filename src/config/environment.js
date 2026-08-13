/**
 * Lectura y validación de la configuración de entorno.
 *
 * Antes cada servicio hacía su propio
 * `import.meta.env.VITE_X || "http://localhost:8000"`, con dos consecuencias malas:
 *
 *   1. Si la variable no estaba definida al compilar, el bundle de PRODUCCIÓN salía
 *      apuntando a `http://localhost:8000`. Los trámites fallaban de forma silenciosa
 *      en el navegador del ciudadano, sin ninguna señal de por qué.
 *   2. Un `http://` en una página servida por `https://` es contenido mixto: el
 *      navegador bloquea la petición. Y si la página fuera `http://`, la cédula, el
 *      teléfono y el correo del ciudadano viajarían en claro.
 *
 * Ahora la validación es explícita y ruidosa al arrancar.
 *
 * NOTA DELIBERADA: aquí NO se lee `VITE_GEMINI_API_KEY`. Vite incrusta el valor de
 * toda variable `VITE_*` literalmente en el JavaScript compilado, así que definirla
 * publicaba la credencial en un archivo estático descargable por cualquiera. Se
 * verificó compilando: la clave aparecía en claro dentro de `dist/assets/*.js`.
 * La clave se introduce ahora solo desde la consola y queda en el navegador del
 * operador.
 */

/** Valor por defecto para desarrollo local. */
const LOCAL_DEFAULT = "http://localhost:8000";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * LEER `import.meta.env` SIEMPRE CON ACCESO ESTÁTICO
 *
 * Vite reemplaza `import.meta.env.NOMBRE_LITERAL` por su valor en tiempo de
 * compilación mediante sustitución textual. Pero ante un acceso DINÁMICO
 * —`import.meta.env[variable]`— no puede saber qué clave se pedirá, así que emite el
 * OBJETO COMPLETO de variables en el bundle.
 *
 * Eso significa que un helper aparentemente inocente como
 *
 *     const readEnv = (name) => import.meta.env?.[name]
 *
 * publica TODAS las variables `VITE_*` en el JavaScript compilado, incluida
 * `VITE_GEMINI_API_KEY`, aunque este archivo nunca la mencione. Se comprobó
 * compilando: la clave aparecía dentro del objeto inlineado.
 *
 * Por eso cada variable se lee aquí de forma explícita y literal. No convertir esto
 * en un bucle ni en un helper parametrizado.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Envuelve una lectura estática para que no falle fuera de un bundle de Vite
 * (por ejemplo al ejecutar la suite de pruebas con Node).
 * @param {() => unknown} read
 * @returns {string}
 */
const safeRead = (read) => {
  try {
    return String(read() ?? "").trim();
  } catch {
    return "";
  }
};

/** ¿Estamos en un build de producción? */
const isProduction = safeRead(() => import.meta.env.PROD) === "true";

/**
 * Normaliza una URL base: sin barra final, con esquema válido.
 * @param {string} url
 * @returns {string}
 */
const normalizeBaseUrl = (url) => String(url || "").replace(/\/+$/, "");

/**
 * Valida una URL base de microservicio y avisa de los problemas detectables.
 *
 * @param {string} value
 * @param {string} varName
 * @returns {string} La URL normalizada (se devuelve incluso si hay avisos, para no
 *          romper el desarrollo local).
 */
const resolveServiceUrl = (value, varName) => {
  const url = normalizeBaseUrl(value || LOCAL_DEFAULT);

  if (!value) {
    const msg =
      `[config] ${varName} no está definida; se usará ${LOCAL_DEFAULT}.`;
    if (isProduction) {
      console.error(
        `❌ ${msg} En un build de producción esto deja los trámites apuntando a la ` +
        `máquina del propio ciudadano y fallarán todos. Define ${varName} antes de compilar.`
      );
    } else {
      console.info(`ℹ️ ${msg}`);
    }
    return url;
  }

  // Contenido mixto: página https:// llamando a http://
  try {
    const pageProtocol = globalThis.window?.location?.protocol;
    if (pageProtocol === "https:" && url.startsWith("http://")) {
      console.error(
        `❌ [config] ${varName} usa http:// (${url}) pero la página se sirve por https://. ` +
        `El navegador bloqueará estas peticiones por contenido mixto. Usa https://.`
      );
    }
    if (pageProtocol === "http:" && isProduction) {
      console.warn(
        "⚠️ [config] La página se sirve por http://. Los datos personales del ciudadano " +
        "(documento, teléfono, correo) viajarían sin cifrar. Habilita HTTPS."
      );
    }
  } catch {
    /* sin window: entorno de pruebas */
  }

  if (isProduction && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url)) {
    console.error(
      `❌ [config] ${varName} apunta a ${url} en un build de producción. ` +
      "Ningún ciudadano tiene ese servicio en su máquina."
    );
  }

  return url;
};

/**
 * Ambientes válidos según GOB-GCP-STD-01.
 * QAM (dev/qa) → PREM (master) → PROD (main).
 */
const VALID_ENVIRONMENTS = ["dev", "qa", "qam", "prem", "preprod", "prod", "local"];

/**
 * Normaliza y valida el ambiente declarado.
 * @param {string} value
 * @returns {string}
 */
const resolveEnvironment = (value) => {
  const env = String(value || "").toLowerCase().trim();
  if (!env) return isProduction ? "prod" : "local";
  if (!VALID_ENVIRONMENTS.includes(env)) {
    console.warn(
      `⚠️ [config] ENVIRONMENT="${env}" no es uno de los ambientes del estándar ` +
      `(${VALID_ENVIRONMENTS.join(", ")}).`
    );
  }
  return env;
};

/** Configuración resuelta del entorno. */
export const environment = Object.freeze({
  isProduction,

  // ── Variables base exigidas por GOB-GCP-STD-01 ──────────────────────────────
  // Se exponen en /version y acompañan a los registros, igual que en los
  // microservicios FastAPI de la plataforma.

  /** Nombre del servicio. Convención: [módulo]-[microservicio]. */
  serviceName: safeRead(() => import.meta.env.VITE_SERVICE_NAME) || "ia-chatbot-floridablanca",

  /** Versión desplegada. En Cloud Build se inyecta el SHA del commit. */
  serviceVersion: safeRead(() => import.meta.env.VITE_SERVICE_VERSION) || "0.0.0-dev",

  /** Ambiente: qam | prem | prod | local. */
  environmentName: resolveEnvironment(safeRead(() => import.meta.env.VITE_ENVIRONMENT)),

  /** Proyecto GCP, para correlacionar trazas en Cloud Logging. */
  googleCloudProject: safeRead(() => import.meta.env.VITE_GOOGLE_CLOUD_PROJECT),

  /** URL base del microservicio RPA de Impuesto Predial. */
  predialApiUrl: resolveServiceUrl(
    // Acceso estático obligatorio: ver la nota de cabecera.
    safeRead(() => import.meta.env.VITE_RPA_PREDIAL_API_URL),
    "VITE_RPA_PREDIAL_API_URL"
  ),

  /** URL base del microservicio RPA de PQRSD. */
  pqrsdApiUrl: resolveServiceUrl(
    safeRead(() => import.meta.env.VITE_RPA_PQRSD_API_URL),
    "VITE_RPA_PQRSD_API_URL"
  ),

  /**
   * Origen del proxy de IA del backend.
   *
   * Es una URL pública, así que puede ir en el bundle sin problema —a diferencia de la
   * clave, que es justamente lo que este proxy existe para no publicar—. Vacío significa
   * "mismo origen que el widget", que es el caso cuando lo sirve el propio Cloud Run.
   *
   * Definirla cambia el proveedor de IA: con proxy, la clave de Gemini vive en el servidor
   * y el gasto se controla ahí (límite por IP, cuota por sesión y techo diario de tokens).
   * Sin ella, el widget vuelve al modo de desarrollo, en el que la clave la escribe el
   * operador en la consola y queda visible en su navegador.
   */
  aiProxyUrl: normalizeBaseUrl(safeRead(() => import.meta.env.VITE_AI_PROXY_URL)),

  /**
   * Activa el registro de consumo de tokens en el servidor de desarrollo.
   * En producción está apagado por defecto: el endpoint `/api/log-tokens` solo
   * existe en el plugin del servidor de Vite y no debería llevarse a producción
   * sin autenticación ni límite de tasa.
   */
  telemetryEnabled: !isProduction,

  /**
   * URL base del backend que almacena el registro de conversaciones.
   *
   * Aún sin definir: se sabe que estará alojado en Cloud Run. Mientras esté vacía, la
   * persistencia queda en el modo que indique la configuración (`off` o `console`) y no
   * se envía ningún dato personal a ninguna parte.
   */
  conversationApiUrl: safeRead(() => import.meta.env.VITE_CONVERSATION_API_URL),

  /**
   * Modo de persistencia: `off` | `console` | `http`.
   *
   * La variable de entorno tiene prioridad sobre `chatbotConfig.json`, para poder
   * activar el registro por entorno sin modificar la configuración del tenant.
   */
  persistenceMode: safeRead(() => import.meta.env.VITE_PERSISTENCE_MODE)
});

/**
 * Hosts de los backends propios, derivados de la configuración.
 * Se usan en `urlPolicy` para reconocer los recursos que devuelven los RPA.
 *
 * @returns {string[]}
 */
export const getBackendHosts = () => {
  const hosts = new Set();
  for (const url of [environment.predialApiUrl, environment.pqrsdApiUrl]) {
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      /* URL inválida: ya se avisó arriba */
    }
  }
  return Array.from(hosts);
};

/** Hosts propios que pueden recibir cabeceras internas. */
const getInternalHosts = () => {
  const hosts = new Set(getBackendHosts());
  for (const url of [environment.aiProxyUrl, environment.conversationApiUrl]) {
    if (!url) continue;
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      /* URL inválida */
    }
  }
  return hosts;
};

/**
 * ¿La URL apunta a un backend propio? Las APIs de terceros no reciben cabeceras
 * internas: `X-Correlation-ID` fuerza un preflight CORS que Google rechaza, lo que
 * tumbaba toda llamada directa a Gemini.
 *
 * @param {string} url
 * @returns {boolean}
 */
export const isOwnBackendUrl = (url) => {
  const base = globalThis.window?.location?.href;
  try {
    const target = new URL(url, base);
    if (base && target.origin === new URL(base).origin) return true;
    return getInternalHosts().has(target.hostname);
  } catch {
    // Relativa y sin base: mismo origen.
    return !/^[a-z][a-z0-9+.-]*:/i.test(String(url));
  }
};
