/**
 * Limitadores de tasa y de cuota. Lógica pura, sin dependencias.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOS LIMITADORES, PORQUE FRENAN COSAS DISTINTAS
 *
 *   · `createRateLimiter`  — ventana corta (segundos o minutos). Frena RÁFAGAS: bots,
 *     bucles de reintento, un script que descubrió el endpoint. Se cuenta por IP.
 *   · `createDailyQuota`   — ventana de un día natural. Reparte la RACIÓN de cada
 *     usuario. Se cuenta por sesión.
 *
 * Un solo limitador no cubre los dos casos: una ventana corta permitiría gastar todo el
 * presupuesto a lo largo del día, y una cuota diaria no impide que un bot la agote en
 * cuatro segundos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA FUGA QUE SE CORRIGE RESPECTO AL LIMITADOR DE `vite.config.js`
 *
 * El limitador del plugin de desarrollo guarda las entradas en un `Map` y NUNCA las
 * elimina: cada IP nueva añade una clave que se queda para siempre. En el servidor de
 * desarrollo da igual, dura minutos y solo lo usa una persona. En un servidor de Cloud Run
 * expuesto a internet es una fuga de memoria: una instancia que vea muchas IPs distintas
 * crece hasta que Cloud Run la mata por consumo, y matarla borra los contadores, que es
 * justo lo que un atacante quiere.
 *
 * Aquí las entradas caducadas se purgan de forma incremental (una barrida cada N
 * operaciones, sin temporizadores) y el mapa tiene tope de tamaño.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ALCANCE: EL ESTADO ES DE LA INSTANCIA
 *
 * Los contadores viven en memoria del proceso. Con `min-instances=0` y
 * `max-instances=10` eso significa que la cuota diaria es APROXIMADA: varias instancias
 * llevan cuentas separadas y un escalado a cero las borra. Es una decisión consciente
 * (evita provisionar Firestore o Memorystore) y está documentada en el plan.
 *
 * Para que cambiarla salga barato, el almacén está detrás de una interfaz mínima —`get`,
 * `set`, `delete`, `entries`— así que sustituirlo por uno respaldado por Firestore no
 * obliga a tocar la lógica de decisión ni el manejador HTTP.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Cada cuántas operaciones se barre el mapa en busca de entradas caducadas. */
const SWEEP_EVERY_OPS = 500;

/**
 * Tope de claves vivas. Alcanzarlo significa tráfico anómalo (o un ataque desde muchas
 * IPs); se descartan las entradas más antiguas en lugar de crecer sin freno.
 */
const MAX_KEYS = 50_000;

/**
 * @typedef {Object} LimitDecision
 * @property {boolean} allowed
 * @property {number} remaining        Operaciones restantes en la ventana.
 * @property {number} retryAfterSeconds Segundos hasta que la ventana se reinicie.
 * @property {number} used
 * @property {number} limit
 */

/**
 * Almacén en memoria con purga incremental.
 *
 * @param {Object} [opts]
 * @param {number} [opts.maxKeys]
 */
const createMemoryStore = ({ maxKeys = MAX_KEYS } = {}) => {
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const entries = new Map();
  let opsSinceSweep = 0;

  /**
   * Elimina las entradas cuya ventana ya expiró.
   * @param {number} now
   */
  const sweep = (now) => {
    for (const [key, entry] of entries) {
      if (now >= entry.resetAt) entries.delete(key);
    }
  };

  return {
    /** Número de claves vivas. Expuesto para las pruebas y para diagnóstico. */
    get size() {
      return entries.size;
    },

    /**
     * @param {string} key
     * @returns {{count: number, resetAt: number}|undefined}
     */
    read(key) {
      return entries.get(key);
    },

    /**
     * @param {string} key
     * @param {{count: number, resetAt: number}} value
     * @param {number} now
     */
    write(key, value, now) {
      opsSinceSweep += 1;
      if (opsSinceSweep >= SWEEP_EVERY_OPS) {
        opsSinceSweep = 0;
        sweep(now);
      }

      // Si tras la purga se sigue en el tope, se sacrifica la entrada más antigua.
      // `Map` conserva el orden de inserción, así que la primera es la más vieja.
      if (!entries.has(key) && entries.size >= maxKeys) {
        sweep(now);
        if (entries.size >= maxKeys) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
      }

      entries.set(key, value);
    },

    /** Vacía el almacén. Solo para pruebas. */
    clear() {
      entries.clear();
      opsSinceSweep = 0;
    }
  };
};

/**
 * Limitador de ventana fija.
 *
 * Se elige ventana fija y no ventana deslizante a propósito: la deslizante exige guardar
 * la marca de tiempo de cada petición (memoria proporcional al tráfico), y para frenar
 * ráfagas la diferencia práctica es despreciable. El caso peor conocido de la ventana
 * fija —hasta 2× el límite a caballo entre dos ventanas— es aceptable cuando el propósito
 * es cortar bots, no facturar.
 *
 * @param {Object} params
 * @param {number} params.windowMs
 * @param {number} params.max            Operaciones permitidas por ventana.
 * @param {() => number} [params.now]    Inyectable para las pruebas.
 * @param {number} [params.maxKeys]
 */
export const createRateLimiter = ({ windowMs, max, now = () => Date.now(), maxKeys }) => {
  const store = createMemoryStore({ maxKeys });

  return {
    get size() {
      return store.size;
    },

    /**
     * Registra una operación y decide si se permite.
     *
     * @param {string} key
     * @returns {LimitDecision}
     */
    hit(key) {
      // Un límite de 0 o negativo se interpreta como "desactivado": es lo que se espera
      // al poner la variable de entorno a 0, y no como "bloquear todo".
      if (!Number.isFinite(max) || max <= 0) {
        return { allowed: true, remaining: Infinity, retryAfterSeconds: 0, used: 0, limit: 0 };
      }

      const current = now();
      const existing = store.read(key);

      if (!existing || current >= existing.resetAt) {
        const resetAt = current + windowMs;
        store.write(key, { count: 1, resetAt }, current);
        return {
          allowed: true,
          remaining: max - 1,
          retryAfterSeconds: Math.ceil(windowMs / 1000),
          used: 1,
          limit: max
        };
      }

      existing.count += 1;
      store.write(key, existing, current);

      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - current) / 1000));
      return {
        allowed: existing.count <= max,
        remaining: Math.max(0, max - existing.count),
        retryAfterSeconds,
        used: existing.count,
        limit: max
      };
    },

    /** Consulta sin consumir. */
    peek(key) {
      const entry = store.read(key);
      const current = now();
      if (!entry || current >= entry.resetAt) return { used: 0, limit: max };
      return { used: entry.count, limit: max };
    },

    reset() {
      store.clear();
    }
  };
};

/**
 * Milisegundos que quedan hasta la medianoche UTC del día en curso.
 *
 * Se usa UTC y no la hora de Bogotá deliberadamente: el reinicio tiene que ser el mismo
 * en todas las instancias sin depender de la zona horaria del contenedor, que en Cloud Run
 * es UTC pero no está garantizado por contrato. La consecuencia es que la cuota se
 * renueva a las 19:00 hora de Colombia; si se prefiere medianoche local, es cuestión de
 * restar el desplazamiento aquí, en un solo sitio.
 *
 * @param {number} now
 * @returns {number}
 */
export const millisecondsUntilUtcMidnight = (now) => {
  const date = new Date(now);
  const nextMidnight = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );
  return nextMidnight - now;
};

/**
 * Cuota de un día natural.
 *
 * Es un limitador de ventana fija cuya ventana termina en la medianoche UTC, para que la
 * ración no dependa de cuándo el usuario hizo su primera consulta: si empieza a las 23:50
 * se le renueva a los diez minutos, que es el comportamiento esperado de "cuota diaria".
 *
 * @param {Object} params
 * @param {number} params.limit
 * @param {() => number} [params.now]
 * @param {number} [params.maxKeys]
 */
export const createDailyQuota = ({ limit, now = () => Date.now(), maxKeys }) => {
  const store = createMemoryStore({ maxKeys });

  return {
    get size() {
      return store.size;
    },

    /**
     * Consume una unidad de cuota.
     *
     * @param {string} key
     * @returns {LimitDecision}
     */
    hit(key) {
      if (!Number.isFinite(limit) || limit <= 0) {
        return { allowed: true, remaining: Infinity, retryAfterSeconds: 0, used: 0, limit: 0 };
      }

      const current = now();
      const existing = store.read(key);

      if (!existing || current >= existing.resetAt) {
        const resetAt = current + millisecondsUntilUtcMidnight(current);
        store.write(key, { count: 1, resetAt }, current);
        return {
          allowed: true,
          remaining: limit - 1,
          retryAfterSeconds: Math.ceil((resetAt - current) / 1000),
          used: 1,
          limit
        };
      }

      existing.count += 1;
      store.write(key, existing, current);

      return {
        allowed: existing.count <= limit,
        remaining: Math.max(0, limit - existing.count),
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - current) / 1000)),
        used: existing.count,
        limit
      };
    },

    peek(key) {
      const entry = store.read(key);
      const current = now();
      if (!entry || current >= entry.resetAt) return { used: 0, limit };
      return { used: entry.count, limit };
    },

    reset() {
      store.clear();
    }
  };
};

/**
 * Cortacircuitos de gasto: acumula los tokens REALMENTE consumidos en el día y corta
 * cuando se pasa del techo.
 *
 * Es la única de las tres capas que mide gasto y no número de peticiones, y es la que
 * cubre el escenario que ninguna cuota por usuario cubre: mucha gente legítima a la vez.
 * Se alimenta de `usageMetadata`, así que cuenta lo que Google va a facturar, no una
 * estimación.
 *
 * @param {Object} params
 * @param {number} params.dailyTokenCeiling  0 o negativo desactiva el cortacircuitos.
 * @param {() => number} [params.now]
 */
export const createTokenBudget = ({ dailyTokenCeiling, now = () => Date.now() }) => {
  let spent = 0;
  let resetAt = 0;

  /** Reinicia el acumulado si cambió el día. */
  const rollover = (current) => {
    if (current >= resetAt) {
      spent = 0;
      resetAt = current + millisecondsUntilUtcMidnight(current);
    }
  };

  const isEnabled = () => Number.isFinite(dailyTokenCeiling) && dailyTokenCeiling > 0;

  return {
    /** ¿Queda presupuesto para atender una petición más? */
    hasBudget() {
      if (!isEnabled()) return true;
      const current = now();
      rollover(current);
      return spent < dailyTokenCeiling;
    },

    /**
     * Registra el consumo real de una llamada.
     * @param {number} tokens
     */
    record(tokens) {
      const amount = Number(tokens);
      if (!Number.isFinite(amount) || amount <= 0) return;
      const current = now();
      rollover(current);
      spent += Math.round(amount);
    },

    /** Estado, para logs y diagnóstico. */
    snapshot() {
      const current = now();
      rollover(current);
      return {
        spent,
        ceiling: isEnabled() ? dailyTokenCeiling : 0,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - current) / 1000))
      };
    },

    reset() {
      spent = 0;
      resetAt = 0;
    }
  };
};
