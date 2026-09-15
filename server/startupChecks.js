/**
 * Comprobaciones de arranque de la integracion con los RPA.
 *
 * Un chatbot que arranca "bien" y falla recien cuando un ciudadano pide su factura es mucho
 * mas caro de diagnosticar que uno que no arranca. Aqui se separan los dos tipos de fallo:
 *
 *   Configuracion  Falta una variable, la URL no es valida, el token no se acuña, falta
 *                  `roles/run.invoker`, la ruta no existe. Nunca se arregla solo, asi que
 *                  corta el arranque.
 *   Disponibilidad El portal de la alcaldia no responde o el servicio esta reiniciando. Se
 *                  registra como CRITICAL y el chatbot sigue en pie atendiendo con el banco
 *                  de preguntas: tirar el widget entero no arregla el RPA.
 */

import { info, warning, error, critical } from "./logging.js";
import { buildUpstreamUrl } from "./rpaTargets.js";

/** Politica ante un fallo de la sonda: `strict` corta el arranque, `warn` solo registra. */
export const PROBE_POLICIES = Object.freeze({ STRICT: "strict", WARN: "warn", OFF: "off" });

/** Timeout de cada sonda. Es un /health, no un tramite. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Estados en los que el despliegue esta mal y no se va a arreglar esperando.
 * 401 audience o token, 403 permisos, 404 ruta o ingress.
 */
const FATAL_STATUSES = Object.freeze([401, 403, 404]);

/**
 * Sondea el `/health` de un servicio con token.
 *
 * @param {Object} params
 * @param {Object} params.service
 * @param {Object} params.identity
 * @param {typeof fetch} params.fetchImpl
 * @returns {Promise<{service: string, ok: boolean, fatal: boolean, status: number, detail: string}>}
 */
export const probeService = async ({ service, identity, fetchImpl }) => {
  const url = buildUpstreamUrl(service, "/health");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const headers = await identity.headers(service.audience);
    const response = await fetchImpl(url, { headers, signal: controller.signal });

    if (response.ok) {
      return { service: service.id, ok: true, fatal: false, status: response.status, detail: "" };
    }

    const contentType = response.headers.get("content-type") || "";
    const body = (await response.text()).slice(0, 200);
    // Un 404 con HTML es del balanceador, no de la aplicacion: el ingress no admite este
    // trafico y hay que entrar por el gateway. Con JSON, la ruta simplemente no existe.
    const html404 = response.status === 404 && !contentType.toLowerCase().includes("json");

    return {
      service: service.id,
      ok: false,
      fatal: FATAL_STATUSES.includes(response.status),
      status: response.status,
      detail: html404 ? "404 con cuerpo HTML: el ingress no admite este trafico" : body
    };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return {
      service: service.id,
      ok: false,
      // Un problema al acuñar el token si es de configuracion: la sonda ni salio.
      fatal: err?.name === "IdentityTokenError",
      status: 0,
      detail: aborted ? `sin respuesta en ${PROBE_TIMEOUT_MS}ms` : String(err?.message || "").slice(0, 200)
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Ejecuta las comprobaciones de arranque.
 *
 * @param {Object} params
 * @param {Record<string, Object>} params.services
 * @param {string[]} params.configErrors Salida de `resolveTargets().errors`.
 * @param {Object} params.identity
 * @param {string} [params.policy]
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<{ok: boolean, fatal: boolean, results: Object[]}>}
 */
export const runStartupChecks = async ({
  services,
  configErrors,
  identity,
  policy = PROBE_POLICIES.STRICT,
  fetchImpl = globalThis.fetch
}) => {
  if (configErrors.length > 0) {
    for (const detail of configErrors) {
      critical("rpa_config_invalid", { detail });
    }
    return { ok: false, fatal: true, results: [] };
  }

  if (policy === PROBE_POLICIES.OFF) {
    warning("rpa_startup_probe_skipped", {
      note: "RPA_STARTUP_PROBE=off. El primer fallo de token o de permisos aparecera en un tramite real."
    });
    return { ok: true, fatal: false, results: [] };
  }

  const results = await Promise.all(
    Object.values(services).map((service) => probeService({ service, identity, fetchImpl }))
  );

  let fatal = false;
  for (const result of results) {
    if (result.ok) {
      info("rpa_probe_ok", { service: result.service });
      continue;
    }
    if (result.fatal) {
      fatal = true;
      critical("rpa_probe_fatal", {
        service: result.service,
        status: result.status,
        detail: result.detail,
        note:
          "401: audience equivocado o con barra final. 403: falta roles/run.invoker. " +
          "404 JSON: ruta inexistente. 404 HTML: ingress."
      });
      continue;
    }
    critical("rpa_probe_unavailable", {
      service: result.service,
      status: result.status,
      detail: result.detail,
      note: "El servicio no respondio. El chatbot arranca, pero ese tramite no funcionara."
    });
  }

  const ok = results.every((r) => r.ok);
  if (!ok && !fatal && policy === PROBE_POLICIES.WARN) {
    warning("rpa_startup_degraded", { note: "RPA_STARTUP_PROBE=warn: se continua con dependencias caidas." });
  }
  if (fatal) {
    error("rpa_startup_aborted", {
      note: "Fallo de configuracion en una dependencia. Corregir antes de volver a desplegar."
    });
  }

  return { ok, fatal, results };
};

/**
 * Resume el resultado de las sondas para exponerlo en `/health`.
 *
 * `status` se mantiene en "UP" aunque una dependencia este caida: es la sonda con la que Cloud
 * Run decide si mata la instancia, y matarla no arregla el RPA. El detalle va aparte.
 *
 * @param {Object[]} results
 * @returns {Record<string, string>}
 */
export const describeDependencies = (results) =>
  Object.fromEntries(results.map((r) => [r.service, r.ok ? "UP" : `DOWN (${r.status || "sin respuesta"})`]));
