/**
 * Registro de flujos de trámite. Capa de aplicación.
 *
 * ANTES, lanzar un trámite era una cadena de seis `if` en
 * `ChatContext.handleSemanticRouting`:
 *
 *     if (serviceToTrigger === "sisben")          { startSisbenFlow();      … }
 *     if (serviceToTrigger === "predial")         { startPredialFlow();     … }
 *     if (serviceToTrigger === "pqrsd_crear")     { startPqrsdCreateFlow(); … }
 *     …
 *
 * y cada rama repetía las mismas tres líneas de limpieza de estado. Añadir un trámite
 * obligaba a modificar esa función, más otra cadena `if` paralela en `submitChatForm`.
 * Eso es exactamente lo que el principio abierto/cerrado busca evitar: el código de
 * despacho debía cambiar cada vez que aparecía un caso nuevo.
 *
 * AHORA cada trámite es una entrada de datos con su función de arranque. El despacho
 * es una búsqueda en un mapa y no vuelve a tocarse. Registrar un trámite nuevo es
 * añadir un objeto a `createFlowRegistry`.
 *
 * Ser el único punto de despacho tiene una ventaja añadida: aquí se cuenta cada trámite
 * iniciado, para el panel de monitoreo. Un trámite nuevo aparece en las métricas sin
 * tener que instrumentarlo, porque todos pasan por `runFlow`.
 */

import { sessionMetrics, METRIC_EVENTS } from "../../domain/observability/sessionMetrics.js";

/**
 * @typedef {Object} FlowDefinition
 * @property {string} id
 * @property {string} label            Nombre legible, para mensajes al ciudadano.
 * @property {() => void} start        Efecto que arranca el flujo (normalmente añade un mensaje con formulario).
 */

/**
 * Construye el registro de flujos.
 *
 * @param {Object} starters  Funciones de arranque, inyectadas por los hooks de flujo.
 * @param {() => void} starters.startSisben
 * @param {() => void} starters.startPredial
 * @param {() => void} starters.startPqrsdCreate
 * @param {() => void} starters.startPqrsdConsult
 * @param {() => void} starters.startPqrsdMenu
 * @returns {Map<string, FlowDefinition>}
 */
export const createFlowRegistry = ({
  startSisben,
  startPredial,
  startPqrsdCreate,
  startPqrsdConsult,
  startPqrsdMenu
}) => {
  /** @type {FlowDefinition[]} */
  const definitions = [
    { id: "sisben", label: "Sisbén", start: startSisben },
    { id: "predial", label: "Impuesto Predial", start: startPredial },
    { id: "pqrsd_crear", label: "Radicación de PQRSD", start: startPqrsdCreate },
    { id: "pqrsd_consultar", label: "Consulta de PQRSD", start: startPqrsdConsult },
    // "pqrsd" y "rpa" son intenciones genéricas: muestran el menú de opciones.
    { id: "pqrsd", label: "PQRSD", start: startPqrsdMenu },
    { id: "rpa", label: "PQRSD", start: startPqrsdMenu }
  ];

  return new Map(definitions.map((def) => [def.id, def]));
};

/**
 * Ejecuta el flujo correspondiente a un identificador.
 *
 * @param {Map<string, FlowDefinition>} registry
 * @param {string|null} flowId
 * @returns {{ executed: boolean, flow: FlowDefinition|null }}
 */
export const runFlow = (registry, flowId) => {
  if (!flowId) return { executed: false, flow: null };

  const flow = registry.get(flowId);
  if (!flow || typeof flow.start !== "function") {
    return { executed: false, flow: null };
  }

  flow.start();
  sessionMetrics.record(METRIC_EVENTS.FLOW_STARTED, { flowId: flow.id, label: flow.label });
  return { executed: true, flow };
};

/**
 * Nombre legible de un flujo, para redactar mensajes al ciudadano.
 *
 * @param {Map<string, FlowDefinition>} registry
 * @param {string|null} flowId
 * @returns {string}
 */
export const getFlowLabel = (registry, flowId) =>
  (flowId && registry.get(flowId)?.label) || "el trámite";
