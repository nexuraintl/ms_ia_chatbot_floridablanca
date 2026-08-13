/**
 * Métricas de la sesión de atención. Capa de dominio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE ESTE MÓDULO
 *
 * La consola mostraba tres tarjetas —TOKENS CONSUMIDOS, TOKENS AHORRADOS y
 * EFICIENCIA DE COSTOS— construidas sobre dos contadores de React que vivían en
 * `ChatContext`. Ninguna de las tres medía algo comprobable:
 *
 *   · `tokensSavedTotal` era `max(0, 150 - tokensDeLaRespuesta)`, es decir la
 *     diferencia contra un presupuesto imaginario de 150 tokens. El proveedor local
 *     devolvía directamente la constante 120. No es una medición, es una constante
 *     disfrazada de métrica.
 *   · "EFICIENCIA DE COSTOS" multiplicaba ese número inventado por un precio fijo
 *     escrito en el componente. El resultado era una cifra en dólares presentada como
 *     ahorro real: exactamente el tipo de dato que alguien copia a un informe.
 *   · Sin clave de API el proveedor local reportaba `40 + longitud/4` tokens por
 *     respuesta, así que "TOKENS CONSUMIDOS" contaba consumo de una API a la que nunca
 *     se llamó.
 *   · Todo vivía en estado de React, así que cualquier recarga lo devolvía a cero.
 *
 * Este módulo mide en su lugar lo que un operador puede verificar y necesita saber:
 * cuántas respuestas se dieron, cuántas salieron degradadas, cuánto tardaron, qué
 * trámites se iniciaron y cuáles terminaron, y cuántos tokens reportó realmente la API.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REGLAS DE HONESTIDAD DE LAS CIFRAS
 *
 *   1. Los tokens solo se acumulan cuando el proveedor declara que la llamada consumió
 *      cuota remota (`billable`). Una respuesta del catálogo local suma a
 *      `localReplies`, nunca a los tokens.
 *   2. Lo que reporta la API (`usageMetadata`) y lo que estimamos por longitud de texto
 *      se acumulan SEPARADOS. Un total mezclado no se puede auditar.
 *   3. No se calcula dinero. El precio por token depende del modelo, del volumen y del
 *      contrato, y ninguno de esos datos está en el navegador.
 *
 * Es JavaScript puro: no importa React ni toca el navegador, así que se puede ejercitar
 * desde la suite de pruebas sin montar un componente.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Eventos que la aplicación puede reportar. */
export const METRIC_EVENTS = Object.freeze({
  /** Una respuesta del proveedor de IA (real o degradada). */
  AI_REPLY: "ai_reply",
  /** Se lanzó un trámite. */
  FLOW_STARTED: "flow_started",
  /** El trámite entregó su resultado (factura, radicado, trazabilidad). */
  FLOW_COMPLETED: "flow_completed",
  /** El trámite no pudo completarse. */
  FLOW_FAILED: "flow_failed"
});

/** Tope de muestras de latencia conservadas, para acotar la memoria de una sesión larga. */
const MAX_LATENCY_SAMPLES = 200;

/** Tope de longitud del detalle de error guardado, para no arrastrar trazas enteras. */
const MAX_DETAIL_CHARS = 160;

/**
 * @typedef {Object} FlowCounters
 * @property {string} id
 * @property {string} label
 * @property {number} started
 * @property {number} completed
 * @property {number} failed
 * @property {string|null} lastError  Último motivo de fallo, ya apto para mostrar.
 */

/**
 * @typedef {Object} MetricsSnapshot
 * @property {number} startedAt          Marca de inicio de la sesión (ms epoch).
 * @property {string|null} provider      Último proveedor que respondió.
 * @property {Object} ai
 * @property {Object} tokens
 * @property {FlowCounters[]} flows
 */

/**
 * Estado inicial. Se usa también en `reset()`, de modo que reiniciar la conversación
 * reinicia las métricas y no arrastra las de la atención anterior.
 *
 * @param {number} startedAt
 */
const createEmptyState = (startedAt) => ({
  startedAt,
  provider: null,
  replies: 0,
  degraded: 0,
  apiReplies: 0,
  localReplies: 0,
  fallbackReplies: 0,
  lastFallbackReason: null,
  fallbackActive: false,
  latencies: [],
  lastLatencyMs: null,
  tokensReported: 0,
  tokensReportedCalls: 0,
  tokensEstimated: 0,
  tokensEstimatedCalls: 0,
  /** @type {Map<string, FlowCounters>} */
  flows: new Map()
});

/**
 * Percentil sobre una lista YA ORDENADA.
 * Se usa el método del rango más cercano por arriba, que es el que se espera de un p50
 * o un p95 con pocas muestras: con 3 valores, el p95 es el mayor y no una interpolación.
 *
 * @param {number[]} sorted
 * @param {number} p  Percentil entre 0 y 100.
 * @returns {number|null}
 */
const percentile = (sorted, p) => {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
};

/**
 * Normaliza un número no negativo.
 * @param {unknown} value
 * @returns {number}
 */
const toCount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * Recorta un texto de detalle a una línea corta.
 * @param {unknown} value
 * @returns {string|null}
 */
const toDetail = (value) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? null : text.slice(0, MAX_DETAIL_CHARS);
};

/**
 * Obtiene (o crea) los contadores de un trámite.
 *
 * @param {Map<string, FlowCounters>} flows
 * @param {string} id
 * @param {string} [label]
 * @returns {FlowCounters}
 */
const flowEntry = (flows, id, label) => {
  const key = String(id || "desconocido");
  const existing = flows.get(key);
  if (existing) {
    // Una etiqueta legible que llega después no debe perderse.
    if (label && existing.label === key) existing.label = label;
    return existing;
  }
  const fresh = { id: key, label: label || key, started: 0, completed: 0, failed: 0, lastError: null };
  flows.set(key, fresh);
  return fresh;
};

/**
 * Crea un registro de métricas de sesión.
 *
 * Es un almacén observable: `subscribe` permite que la consola se repinte cuando algo
 * cambia, sin que ningún componente tenga que sondear.
 *
 * @param {Object} [deps]
 * @param {() => number} [deps.now]                Inyectable para las pruebas.
 * @param {number} [deps.maxLatencySamples]
 */
export const createSessionMetrics = ({
  now = () => Date.now(),
  maxLatencySamples = MAX_LATENCY_SAMPLES
} = {}) => {
  /** @type {Set<() => void>} */
  const listeners = new Set();

  let state = createEmptyState(now());

  /**
   * Instantánea memorizada. `useSyncExternalStore` exige que dos lecturas sin cambios
   * devuelvan la MISMA referencia; construir un objeto nuevo en cada lectura provocaría
   * un bucle infinito de renders.
   * @type {MetricsSnapshot|null}
   */
  let cached = null;

  const emit = () => {
    cached = null;
    for (const listener of listeners) listener();
  };

  /** @type {Record<string, (payload: Object) => void>} */
  const recorders = {
    /**
     * @param {Object} payload
     * @param {string} [payload.provider]     Identificador del proveedor que respondió.
     * @param {number} [payload.latencyMs]
     * @param {boolean} [payload.degraded]    true si fue la respuesta de degradación.
     * @param {boolean} [payload.billable]    true si la llamada consumió cuota remota.
     * @param {number} [payload.tokensUsed]
     * @param {boolean} [payload.isEstimate]  true si las cifras son aproximadas.
     * @param {boolean} [payload.servedByFallback] true si respondió el banco de preguntas
     *        porque el backend cortó la IA (cuota, límite de tasa o servicio caído).
     * @param {string} [payload.fallbackReason]
     */
    [METRIC_EVENTS.AI_REPLY]({
      provider,
      latencyMs,
      degraded,
      billable,
      tokensUsed,
      isEstimate,
      servedByFallback,
      fallbackReason
    }) {
      state.replies += 1;
      if (provider) state.provider = String(provider);
      if (degraded) state.degraded += 1;

      // El estado de degradación describe la ÚLTIMA respuesta, porque es lo que el panel
      // necesita contestar: ¿quién está respondiendo ahora mismo?
      state.fallbackActive = servedByFallback === true;
      if (servedByFallback) {
        state.fallbackReplies += 1;
        if (fallbackReason) state.lastFallbackReason = String(fallbackReason);
      }

      if (Number.isFinite(latencyMs) && latencyMs >= 0) {
        const ms = Math.round(latencyMs);
        state.lastLatencyMs = ms;
        state.latencies.push(ms);
        // Ventana deslizante: interesa la latencia reciente, no la de hace media hora.
        if (state.latencies.length > maxLatencySamples) state.latencies.shift();
      }

      if (!billable) {
        // Respondió el catálogo local: no hubo consumo de API que contar.
        state.localReplies += 1;
        return;
      }

      state.apiReplies += 1;
      const tokens = toCount(tokensUsed);
      if (tokens === 0) return;

      if (isEstimate) {
        state.tokensEstimated += tokens;
        state.tokensEstimatedCalls += 1;
      } else {
        state.tokensReported += tokens;
        state.tokensReportedCalls += 1;
      }
    },

    /**
     * @param {{flowId: string, label?: string}} payload
     */
    [METRIC_EVENTS.FLOW_STARTED]({ flowId, label }) {
      flowEntry(state.flows, flowId, label).started += 1;
    },

    /**
     * @param {{flowId: string, label?: string}} payload
     */
    [METRIC_EVENTS.FLOW_COMPLETED]({ flowId, label }) {
      flowEntry(state.flows, flowId, label).completed += 1;
    },

    /**
     * @param {{flowId: string, label?: string, reason?: string}} payload
     */
    [METRIC_EVENTS.FLOW_FAILED]({ flowId, label, reason }) {
      const entry = flowEntry(state.flows, flowId, label);
      entry.failed += 1;
      entry.lastError = toDetail(reason);
    }
  };

  return {
    /**
     * Reporta un evento.
     *
     * Nunca lanza: un fallo de instrumentación no debe romper una atención en curso.
     * Un evento desconocido se avisa por consola y se descarta.
     *
     * @param {string} event  Uno de `METRIC_EVENTS`.
     * @param {Object} [payload]
     */
    record(event, payload = {}) {
      const recorder = recorders[event];
      if (!recorder) {
        console.warn(`[sessionMetrics] Evento desconocido: "${event}".`);
        return;
      }
      try {
        recorder(payload);
        emit();
      } catch (error) {
        console.warn(`[sessionMetrics] No se pudo registrar "${event}":`, error?.message);
      }
    },

    /**
     * Instantánea de solo lectura. Estable entre cambios (ver `cached`).
     * @returns {MetricsSnapshot}
     */
    getSnapshot() {
      if (cached) return cached;

      const sorted = [...state.latencies].sort((a, b) => a - b);

      cached = Object.freeze({
        startedAt: state.startedAt,
        provider: state.provider,
        ai: Object.freeze({
          replies: state.replies,
          degraded: state.degraded,
          apiReplies: state.apiReplies,
          localReplies: state.localReplies,
          fallbackReplies: state.fallbackReplies,
          lastFallbackReason: state.lastFallbackReason,
          fallbackActive: state.fallbackActive,
          lastLatencyMs: state.lastLatencyMs,
          p50LatencyMs: percentile(sorted, 50),
          p95LatencyMs: percentile(sorted, 95),
          latencySamples: sorted.length
        }),
        tokens: Object.freeze({
          reported: state.tokensReported,
          reportedCalls: state.tokensReportedCalls,
          estimated: state.tokensEstimated,
          estimatedCalls: state.tokensEstimatedCalls
        }),
        flows: Object.freeze(
          Array.from(state.flows.values(), (f) => Object.freeze({ ...f }))
        )
      });

      return cached;
    },

    /**
     * Suscribe un oyente. Devuelve la función para darse de baja.
     * @param {() => void} listener
     * @returns {() => void}
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Reinicia las métricas (al reiniciar la conversación). */
    reset() {
      state = createEmptyState(now());
      emit();
    }
  };
};

/**
 * Instancia por defecto de la aplicación.
 *
 * Es un singleton de módulo, igual que la configuración de `urlPolicy` y de
 * `correlation`. La alternativa —pasar el registro por props o por contexto hasta cada
 * hook de trámite— añadiría un parámetro a media docena de firmas para reportar un
 * contador. Los módulos que quieran aislamiento (las pruebas) construyen el suyo con
 * `createSessionMetrics()`.
 */
export const sessionMetrics = createSessionMetrics();
