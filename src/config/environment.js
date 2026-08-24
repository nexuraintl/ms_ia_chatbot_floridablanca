/**
 * Configuración de entorno.
 *
 * Leer `import.meta.env` solo con acceso estático y literal: un acceso dinámico
 * (`import.meta.env[nombre]`) hace que Vite incruste el objeto de entorno COMPLETO en el
 * bundle. No convertirlo en un bucle ni en un helper parametrizado.
 *
 * Nunca leer aquí `VITE_GEMINI_API_KEY`. Ver SECURITY.md (H-01).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS RPA YA NO SE LLAMAN DESDE EL NAVEGADOR
 *
 * Los dos microservicios exigen un identity token de Google, y el navegador no puede
 * acuñar uno sin una llave de service account en el cliente. Así que el widget habla con
 * el backend de este mismo chatbot (`/rpa/factura`, `/rpa/pqrsd`), que pone el token.
 *
 * De ahí que aquí ya no haya URLs de microservicio, solo el origen del backend propio.
 * Ver docs/INTEGRACION_RPA.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Prefijos con los que el backend del chatbot publica cada RPA. */
export const RPA_MOUNTS = Object.freeze({
  factura: "/rpa/factura",
  pqrsd: "/rpa/pqrsd"
});

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
 * Valida el origen del backend propio y avisa de los problemas detectables.
 *
 * Vacío es el caso normal y correcto: significa "el mismo origen que sirve el widget", que
 * es lo que ocurre cuando el chatbot se abre desde su propio Cloud Run. Solo hace falta
 * definirlo cuando el widget va incrustado en un portal de otro dominio.
 *
 * @param {string} value
 * @returns {string} El origen normalizado, o "" para mismo origen.
 */
const resolveBackendOrigin = (value) => {
  const url = normalizeBaseUrl(value);
  if (!url) return "";

  try {
    const pageProtocol = globalThis.window?.location?.protocol;
    // Contenido mixto: página https:// llamando a http://
    if (pageProtocol === "https:" && url.startsWith("http://")) {
      console.error(
        `[config] VITE_BACKEND_ORIGIN usa http:// (${url}) pero la página se sirve por https://. ` +
        "El navegador bloqueará estas peticiones por contenido mixto. Usa https://."
      );
    }
    if (pageProtocol === "http:" && isProduction) {
      console.warn(
        "[config] La página se sirve por http://. Los datos personales del ciudadano " +
        "(documento, teléfono, correo) viajarían sin cifrar. Habilita HTTPS."
      );
    }
  } catch {
    /* sin window: entorno de pruebas */
  }

  if (isProduction && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url)) {
    console.error(
      `[config] VITE_BACKEND_ORIGIN apunta a ${url} en un build de producción. ` +
      "Ningún ciudadano tiene ese servicio en su máquina."
    );
  }

  return url;
};

/**
 * Avisa si sigue definida una variable de la etapa anterior. Ya no se lee: apuntar el
 * navegador directo a un Cloud Run con IAM devuelve 403 en todas las llamadas, y el aviso
 * es más barato que descubrirlo en un trámite real.
 */
const warnAboutRetiredVars = () => {
  const retired = [
    ["VITE_RPA_PREDIAL_API_URL", safeRead(() => import.meta.env.VITE_RPA_PREDIAL_API_URL)],
    ["VITE_RPA_PQRSD_API_URL", safeRead(() => import.meta.env.VITE_RPA_PQRSD_API_URL)]
  ];
  for (const [name, value] of retired) {
    if (value) {
      console.warn(
        `[config] ${name} ya no se usa y se ignora. Los RPA exigen IAM, así que el widget ` +
        "los llama a través del backend del chatbot. Configura RPA_FACTURA_URL y " +
        "RPA_PQRSD_URL como variables de RUNTIME del contenedor, no como VITE_*."
      );
    }
  }
};

warnAboutRetiredVars();

/** Origen del backend propio del chatbot. Vacío = mismo origen que sirve el widget. */
const backendOrigin = resolveBackendOrigin(
  // Acceso estático obligatorio: ver la nota de cabecera.
  safeRead(() => import.meta.env.VITE_BACKEND_ORIGIN)
);

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

  /**
   * Origen del backend propio del chatbot. Vacío = mismo origen que sirve el widget.
   * Solo hace falta definirlo cuando el widget va incrustado en un portal de otro dominio.
   */
  backendOrigin,

  /**
   * Base del RPA de Impuesto Predial, vista desde el navegador: es el proxy del propio
   * backend, no el Cloud Run. El token lo pone el servidor.
   */
  predialApiUrl: `${backendOrigin}${RPA_MOUNTS.factura}`,

  /** Base del RPA de PQRSD, vista desde el navegador. Mismo motivo. */
  pqrsdApiUrl: `${backendOrigin}${RPA_MOUNTS.pqrsd}`,

  /**
   * Origen del proxy de IA del backend.
   *
   * Es una URL pública, así que puede ir en el bundle sin problema —a diferencia de la
   * clave, que es justamente lo que este proxy existe para no publicar—. Vacío significa
   * "mismo origen que el widget", que es el caso cuando lo sirve el propio Cloud Run.
   *
   * Por defecto es el mismo origen del backend: el proxy de IA y el de los RPA viven en el
   * mismo servicio. `VITE_AI_PROXY_URL` sigue admitiéndose para separarlos.
   */
  aiProxyUrl: normalizeBaseUrl(safeRead(() => import.meta.env.VITE_AI_PROXY_URL)) || backendOrigin,

  /**
   * ¿Hay un backend con el proxy de IA montado?
   *
   * No basta con mirar `aiProxyUrl`: en el despliegue normal el widget lo sirve su propio
   * backend, así que el proxy está en el MISMO origen y su URL base es la cadena vacía. Sin
   * esta bandera, ese caso —el de producción— caía en el modo de desarrollo y volvía a
   * pedir la clave de Gemini en el navegador. Ver SECURITY.md (H-01).
   *
   * Por defecto activo en un build de producción, que siempre lo sirve este servidor.
   * `VITE_AI_PROXY_ENABLED=false` lo desactiva para trabajar con la clave del navegador.
   */
  aiProxyEnabled:
    safeRead(() => import.meta.env.VITE_AI_PROXY_ENABLED).toLowerCase() === "false"
      ? false
      : safeRead(() => import.meta.env.VITE_AI_PROXY_ENABLED).toLowerCase() === "true" || isProduction,

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
 * Los RPA ya no aportan host propio: se llaman por el backend del chatbot. El host que sí
 * hay que reconocer es el del propio backend, porque de ahí sale el PDF de la factura.
 *
 * @returns {string[]}
 */
export const getBackendHosts = () => {
  const hosts = new Set();
  const candidates = [environment.backendOrigin, globalThis.window?.location?.origin];

  for (const url of candidates) {
    if (!url) continue;
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      /* origen inválido: ya se avisó arriba */
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
