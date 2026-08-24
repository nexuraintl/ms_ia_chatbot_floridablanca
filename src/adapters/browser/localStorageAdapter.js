/**
 * Acceso a almacenamiento persistente del navegador. Capa de adaptadores.
 *
 * Envuelve `localStorage` por tres razones:
 *
 *   1. `localStorage` lanza excepción en modo privado de algunos navegadores y cuando
 *      la cuota está agotada. Las llamadas directas que había en `ChatContext` no
 *      estaban protegidas y podían tumbar el arranque del widget.
 *   2. El widget se embebe en portales de terceros, así que conviene prefijar las
 *      claves para no colisionar con las del portal anfitrión.
 *   3. Permite sustituirlo por un almacenamiento en memoria en pruebas.
 */

/** Prefijo de las claves, para no chocar con el almacenamiento del portal anfitrión. */
const KEY_PREFIX = "avi_chatbot.";

/** Claves conocidas. Centralizadas para evitar literales repartidos por el código. */
export const STORAGE_KEYS = Object.freeze({
  apiKey: "gemini_api_key",
  theme: "chatbot_theme",
  /**
   * Momento hasta el que la IA queda apagada para esta sesión, por límite del backend.
   * Se guarda en `sessionStorage`, no en `localStorage`: describe el estado de hoy de este
   * navegador y no debe sobrevivir al cierre de la pestaña.
   */
  aiSuspendedUntil: "ai_suspended_until"
});

/**
 * Almacenamiento en memoria, usado como respaldo cuando `localStorage` no está
 * disponible. Mantiene el widget funcional dentro de la sesión.
 */
const createMemoryStore = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
};

/**
 * ¿Está `localStorage` realmente usable? Comprobarlo requiere escribir: en Safari en
 * modo privado el objeto existe pero `setItem` lanza QuotaExceededError.
 */
const probeLocalStorage = () => {
  try {
    const store = globalThis.localStorage;
    if (!store) return null;
    const probe = `${KEY_PREFIX}__probe__`;
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
};

/**
 * Crea el adaptador de almacenamiento.
 *
 * @param {Object} [deps]
 * @param {Storage} [deps.store]
 * @returns {{ get: (key: string) => string|null, set: (key: string, value: string) => void, remove: (key: string) => void, isPersistent: boolean }}
 */
export const createStorage = ({ store } = {}) => {
  const backing = store ?? probeLocalStorage();
  const isPersistent = Boolean(backing);
  const target = backing ?? createMemoryStore();

  if (!isPersistent) {
    console.warn(
      "⚠️ [Storage] localStorage no disponible (modo privado o cuota agotada). " +
      "Las preferencias solo durarán esta sesión."
    );
  }

  return {
    isPersistent,

    get(key) {
      try {
        return target.getItem(`${KEY_PREFIX}${key}`);
      } catch {
        return null;
      }
    },

    set(key, value) {
      try {
        target.setItem(`${KEY_PREFIX}${key}`, String(value));
      } catch {
        /* cuota agotada: la preferencia simplemente no persiste */
      }
    },

    remove(key) {
      try {
        target.removeItem(`${KEY_PREFIX}${key}`);
      } catch {
        /* nada que hacer */
      }
    }
  };
};
