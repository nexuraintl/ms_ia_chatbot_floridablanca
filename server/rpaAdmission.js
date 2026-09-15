/**
 * Control de admision de tramites de factura.
 *
 * El servicio de factura corre con `--max-instances=1` y dos workers de Playwright: admite
 * DOS tramites simultaneos y el tercero espera en cola. No falla, pero suma, y un chatbot con
 * veinte conversaciones a la vez convierte esa cola en minutos de espera que el ciudadano no
 * entiende.
 *
 * Aqui se reserva un cupo antes de lanzar el tramite, de forma que el tercer ciudadano reciba
 * "estas en espera" en lugar de un silencio de dos minutos.
 *
 * LIMITE CONOCIDO: el contador vive en la memoria del proceso, asi que solo es un techo real
 * con `--max-instances=1` en este chatbot. Con varias instancias cada una cuenta lo suyo y el
 * techo efectivo se multiplica. La version distribuida necesita Firestore o Redis; el
 * contrato de este modulo esta pensado para poder sustituirlo sin tocar el proxy.
 */

/** Cupos simultaneos. Es el techo del servicio de factura, no una eleccion nuestra. */
export const DEFAULT_MAX_CONCURRENT = 2;

/**
 * Vida maxima de un cupo. Red de seguridad: si nunca se observa el final del tramite, el cupo
 * se libera igual. Un tramite completo son 25-45s medidos; 180s cubre el peor camino sin
 * dejar cupos bloqueados hasta que expire el job (15 min).
 */
const DEFAULT_LEASE_MS = 180_000;

/**
 * Crea el control de admision.
 *
 * @param {Object} [opts]
 * @param {number} [opts.maxConcurrent]
 * @param {number} [opts.leaseMs]
 * @param {() => number} [opts.now]
 */
export const createAdmissionControl = ({
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  leaseMs = DEFAULT_LEASE_MS,
  now = () => Date.now()
} = {}) => {
  /** @type {Map<string, {expiresAt: number}>} Cupos vivos, indexados por su identificador. */
  const slots = new Map();

  let sequence = 0;

  /** Retira los cupos cuyo contrato ya vencio. */
  const evictExpired = () => {
    const t = now();
    for (const [key, slot] of slots) {
      if (slot.expiresAt <= t) slots.delete(key);
    }
  };

  return {
    get maxConcurrent() {
      return maxConcurrent;
    },

    /**
     * Reserva un cupo.
     *
     * @returns {{admitted: true, slotId: string, inFlight: number}
     *          | {admitted: false, inFlight: number, queuePosition: number, retryAfterSeconds: number}}
     */
    acquire() {
      evictExpired();

      if (maxConcurrent > 0 && slots.size >= maxConcurrent) {
        // La posicion es informativa para el mensaje al ciudadano: no hay una cola real, se
        // le pide reintentar. Una cola de verdad exige estado compartido.
        return {
          admitted: false,
          inFlight: slots.size,
          queuePosition: slots.size - maxConcurrent + 1,
          retryAfterSeconds: 45
        };
      }

      sequence += 1;
      const slotId = `slot-${sequence}`;
      slots.set(slotId, { expiresAt: now() + leaseMs });
      return { admitted: true, slotId, inFlight: slots.size };
    },

    /**
     * Reetiqueta un cupo con el `job_id` real, para poder liberarlo cuando se observe el
     * final del tramite.
     *
     * @param {string} slotId
     * @param {string} jobId
     */
    bind(slotId, jobId) {
      const slot = slots.get(slotId);
      if (!slot || !jobId) return false;
      slots.delete(slotId);
      slots.set(`job:${jobId}`, slot);
      return true;
    },

    /**
     * Libera un cupo. Se llama tanto con el identificador provisional (si el tramite no
     * arranco) como con el `job_id` al observar un estado terminal.
     *
     * @param {string} key
     */
    release(key) {
      if (!key) return false;
      return slots.delete(key) || slots.delete(`job:${key}`);
    },

    /** Cupos ocupados ahora mismo. */
    snapshot() {
      evictExpired();
      return { in_flight: slots.size, max_concurrent: maxConcurrent };
    },

    /** Solo para pruebas. */
    reset() {
      slots.clear();
      sequence = 0;
    }
  };
};

/**
 * ¿Este estado de job significa que el tramite termino? Se usa para liberar el cupo antes de
 * que venza su contrato.
 *
 * Ojo: `status: "done"` es el ciclo de vida del JOB, no el desenlace del TRAMITE. Para
 * liberar el cupo da igual como termino; para contarle al ciudadano no, y de eso se encarga
 * el frontend leyendo `result.status`.
 *
 * @param {unknown} payload Cuerpo de `GET /v1/jobs/{id}`.
 * @returns {boolean}
 */
export const isTerminalJobPayload = (payload) => {
  const status = String(payload?.status || "").toLowerCase();
  return status === "done" || status === "error";
};
