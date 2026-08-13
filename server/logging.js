/**
 * Logging estructurado JSON para Cloud Logging (GOB-GCP-STD-01).
 *
 * Equivalente en Node del `api/core/logging.py` que el estándar define para FastAPI.
 * Los requisitos son de formato, no de lenguaje, así que se cumplen igual:
 *
 *   · JSON a stdout (Cloud Run captura stdout y lo envía a Cloud Logging)
 *   · Campo `severity` — NO `level` ni `levelname`. Cloud Logging solo reconoce
 *     `severity`; con cualquier otro nombre todas las entradas aparecen como INFO y
 *     se pierde la capacidad de filtrar por gravedad.
 *   · `timestamp` en cada entrada
 *   · `logging.googleapis.com/trace` y `logging.googleapis.com/spanId` cuando hay
 *     contexto de traza, que es lo que agrupa los logs por petición en la consola
 *   · `correlation_id` en cada entrada
 */

import { getTraceContext } from "./correlation.js";

/** Niveles admitidos, en el vocabulario de Cloud Logging. */
export const SEVERITY = Object.freeze({
  DEBUG: "DEBUG",
  INFO: "INFO",
  WARNING: "WARNING",
  ERROR: "ERROR",
  CRITICAL: "CRITICAL"
});

/** Orden de gravedad, para filtrar por LOG_LEVEL. */
const SEVERITY_ORDER = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

const config = {
  minSeverity: "INFO",
  projectId: "",
  serviceName: "",
  serviceVersion: "",
  environment: ""
};

/**
 * Configura el logger. Se llama una vez al arrancar, ANTES de emitir cualquier log
 * —igual que `setup_logging()` se llama antes de crear la app FastAPI—.
 *
 * @param {Object} options
 */
export const setupLogging = ({ logLevel, projectId, serviceName, serviceVersion, environment } = {}) => {
  const level = String(logLevel || "INFO").toUpperCase();
  config.minSeverity = SEVERITY_ORDER.includes(level) ? level : "INFO";
  config.projectId = projectId || "";
  config.serviceName = serviceName || "";
  config.serviceVersion = serviceVersion || "";
  config.environment = environment || "";
};

/** ¿Esta severidad supera el umbral configurado? */
const passesThreshold = (severity) =>
  SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(config.minSeverity);

/**
 * Emite una entrada de log estructurada.
 *
 * @param {string} severity
 * @param {string} message
 * @param {Object} [fields] Campos adicionales.
 */
export const log = (severity, message, fields = {}) => {
  if (!passesThreshold(severity)) return;

  const entry = {
    severity,
    message,
    timestamp: new Date().toISOString(),
    service: config.serviceName,
    version: config.serviceVersion,
    environment: config.environment,
    ...fields
  };

  const trace = getTraceContext();
  if (trace?.correlationId) {
    entry.correlation_id = trace.correlationId;
  }
  // El campo de traza solo es útil si conocemos el proyecto: Cloud Logging espera la
  // forma completa `projects/<id>/traces/<trace-id>`.
  if (trace?.traceId && config.projectId) {
    entry["logging.googleapis.com/trace"] = `projects/${config.projectId}/traces/${trace.traceId}`;
    if (trace.spanId) {
      entry["logging.googleapis.com/spanId"] = trace.spanId;
    }
  }

  // Una línea por entrada: Cloud Logging parsea JSON por línea.
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

export const debug = (message, fields) => log(SEVERITY.DEBUG, message, fields);
export const info = (message, fields) => log(SEVERITY.INFO, message, fields);
export const warning = (message, fields) => log(SEVERITY.WARNING, message, fields);
export const error = (message, fields) => log(SEVERITY.ERROR, message, fields);
export const critical = (message, fields) => log(SEVERITY.CRITICAL, message, fields);
