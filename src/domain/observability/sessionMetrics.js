/**
 * Métricas de la sesión de atención. Capa de dominio, JavaScript puro.
 *
 * Reglas de honestidad de las cifras: los tokens solo se acumulan cuando el proveedor
 * declara consumo remoto (`billable`); lo que reporta la API y lo estimado por longitud
 * se acumulan SEPARADOS, porque un total mezclado no se puede auditar; y no se calcula
 * dinero, que depende del modelo y del contrato.
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
 * Estado inicial, usado también en `reset()`.
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
 * Percentil sobre una lista ya ordenada, por rango más cercano por arriba: con 3
 * muestras el p95 es el mayor, no una interpolación.
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
 * Crea un registro de métricas de sesión. Almacén observable: `subscribe` repinta la
 * consola sin que ningún componente sondee.
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
   * Instantánea memorizada. `useSyncExternalStore` exige la MISMA referencia entre
   * lecturas sin cambios; un objeto nuevo por lectura daría renders infinitos.
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
     * Reporta un evento. Nunca lanza: un fallo de instrumentación no rompe la atención.
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
 * Instancia por defecto. Singleton de módulo, igual que `urlPolicy` y `correlation`.
 * Las pruebas construyen la suya con `createSessionMetrics()`.
 */
export const sessionMetrics = createSessionMetrics();
