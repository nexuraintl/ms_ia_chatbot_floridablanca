/**
 * Correlación y contexto de traza (GOB-GCP-STD-01).
 *
 * Equivalente en Node del `api/core/middleware.py` que el estándar define para FastAPI.
 * Cumple los mismos requisitos:
 *
 *   · Genera `X-Correlation-ID` con UUID v4 si el header no viene en la petición
 *   · Lo PROPAGA sin sobrescribir si ya viene (el emisor original manda)
 *   · Lo devuelve en la cabecera de la respuesta
 *   · Parsea `X-Cloud-Trace-Context` (formato GCP: TRACE_ID/SPAN_ID;o=TRACE_TRUE)
 *   · Parsea `traceparent` (formato W3C: 00-<trace-id>-<span-id>-<flags>)
 *   · Almacena el contexto en un almacén accesible por el formatter de logging
 *
 * Sobre el almacenamiento del contexto: en Python el estándar usa `ContextVar`. El
 * equivalente en Node es `AsyncLocalStorage`, que mantiene el contexto a lo largo de
 * toda la cadena asíncrona de una petición sin tener que ir pasándolo por parámetro.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const storage = new AsyncLocalStorage();

/** Cabeceras, según el estándar. */
export const CORRELATION_HEADER = "x-correlation-id";
export const CONVERSATION_HEADER = "x-conversation-id";

/**
 * Contexto de traza de la petición en curso.
 * @returns {{correlationId: string, traceId: string, spanId: string}|undefined}
 */
export const getTraceContext = () => storage.getStore();

/**
 * Parsea `X-Cloud-Trace-Context`, el formato que inyecta el balanceador de GCP.
 * Forma: `105445aa7843bc8bf206b12000100000/1;o=1`
 *
 * @param {string|undefined} header
 * @returns {{traceId: string, spanId: string}|null}
 */
export const parseCloudTraceContext = (header) => {
  if (!header || typeof header !== "string") return null;
  const [tracePart] = header.split(";");
  const [traceId, spanId] = tracePart.split("/");
  if (!traceId) return null;
  return { traceId, spanId: spanId || "" };
};

/**
 * Parsea `traceparent` del estándar W3C Trace Context.
 * Forma: `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`
 *
 * @param {string|undefined} header
 * @returns {{traceId: string, spanId: string}|null}
 */
export const parseTraceparent = (header) => {
  if (!header || typeof header !== "string") return null;
  const parts = header.trim().split("-");
  if (parts.length < 4) return null;
  const [, traceId, spanId] = parts;
  // Un trace-id todo a ceros es inválido según la especificación.
  if (!traceId || /^0+$/.test(traceId)) return null;
  return { traceId, spanId: spanId || "" };
};

/**
 * Resuelve el contexto de traza de una petición, dando prioridad al formato de GCP
 * porque es el que inyecta la propia infraestructura de Cloud Run.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {{correlationId: string, traceId: string, spanId: string}}
 */
export const resolveContext = (req) => {
  const incoming = req.headers[CORRELATION_HEADER];
  // Propagar sin sobrescribir: si el emisor ya definió un identificador, ése manda.
  const correlationId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();

  const trace =
    parseCloudTraceContext(req.headers["x-cloud-trace-context"]) ||
    parseTraceparent(req.headers.traceparent) ||
    { traceId: "", spanId: "" };

  return { correlationId, traceId: trace.traceId, spanId: trace.spanId };
};

/**
 * Ejecuta un manejador dentro del contexto de traza de la petición.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {() => void} handler
 */
export const withCorrelation = (req, res, handler) => {
  const context = resolveContext(req);
  // Devolver siempre el identificador, para que quien llamó pueda buscarlo en logs.
  res.setHeader("X-Correlation-ID", context.correlationId);
  storage.run(context, handler);
};
