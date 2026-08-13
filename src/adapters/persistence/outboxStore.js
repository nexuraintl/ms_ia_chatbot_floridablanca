/**
 * Cola durable sobre IndexedDB. Capa de adaptadores.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ INDEXEDDB Y NO UN ARRAY EN MEMORIA
 *
 * El registro de conversaciones es evidencia legal, así que la propiedad que importa
 * es **no perder nada**. Una cola en memoria se pierde en cuanto el ciudadano recarga,
 * cierra la pestaña o el navegador se queda sin memoria — y esos son precisamente los
 * momentos en los que el envío queda a medias.
 *
 * IndexedDB sobrevive a la recarga y a un cierre de pestaña. El flujo es:
 *
 *   1. Escribir en la cola  ← el registro ya está a salvo aquí
 *   2. Intentar enviarlo al backend
 *   3. Borrarlo de la cola SOLO tras confirmación
 *
 * Nunca al revés. Si el paso 2 falla, el registro sigue en la cola y se reintenta,
 * incluso en una sesión posterior.
 *
 * LIMITACIÓN QUE HAY QUE TENER PRESENTE: el widget se embebe en portales de terceros,
 * así que esta base de datos vive en el origen del PORTAL ANFITRIÓN. El JavaScript de
 * ese portal puede leerla, y si el ciudadano limpia los datos del sitio, desaparece.
 * Por eso la cola es solo un búfer de entrega: la copia con valor probatorio es la del
 * servidor. Un registro que aún no se ha confirmado no es todavía evidencia.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DB_NAME = "avi_chatbot_outbox";
const DB_VERSION = 1;
const STORE_NAME = "pending";

/** Tope de elementos en cola, para no llenar el almacenamiento del portal anfitrión. */
const MAX_QUEUE_SIZE = 2000;

/**
 * Almacén en memoria, usado cuando IndexedDB no está disponible (modo privado
 * restrictivo, o pruebas en Node). Mantiene la aplicación funcional, pero sin la
 * garantía de durabilidad.
 */
const createMemoryStore = () => {
  const items = new Map();
  let seq = 0;
  return {
    isDurable: false,
    async put(item) {
      const key = item.key ?? `mem-${++seq}`;
      items.set(key, { ...item, key });
      return key;
    },
    async getBatch(limit) {
      return Array.from(items.values()).slice(0, limit);
    },
    async remove(keys) {
      for (const k of keys) items.delete(k);
    },
    async count() {
      return items.size;
    },
    async clear() {
      items.clear();
    }
  };
};

/**
 * Abre la base de datos, o devuelve null si no es posible.
 * @returns {Promise<IDBDatabase|null>}
 */
const openDatabase = () =>
  new Promise((resolve) => {
    const idb = globalThis.indexedDB;
    if (!idb) {
      resolve(null);
      return;
    }

    let request;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // `autoIncrement` da un orden de inserción natural, que es también el orden
        // en el que hay que entregar los registros.
        db.createObjectStore(STORE_NAME, { keyPath: "key", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // Si otra pestaña bloquea la actualización de versión, no colgar el arranque.
    request.onblocked = () => resolve(null);
  });

/**
 * Envuelve una transacción de IndexedDB en una promesa.
 * @param {IDBDatabase} db
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest|null} work
 * @returns {Promise<any>}
 */
const runTransaction = (db, mode, work) =>
  new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE_NAME, mode);
    } catch (error) {
      reject(error);
      return;
    }

    const store = tx.objectStore(STORE_NAME);
    let request;
    try {
      request = work(store);
    } catch (error) {
      reject(error);
      return;
    }

    tx.onabort = () => reject(tx.error || new Error("Transacción abortada"));
    tx.onerror = () => reject(tx.error || new Error("Error de transacción"));

    if (request) {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } else {
      tx.oncomplete = () => resolve(undefined);
    }
  });

/**
 * Crea la cola durable. Si IndexedDB no está disponible cae a memoria, avisando.
 *
 * @returns {Promise<{isDurable: boolean, put: Function, getBatch: Function, remove: Function, count: Function, clear: Function}>}
 */
export const createOutboxStore = async () => {
  const db = await openDatabase();

  if (!db) {
    console.warn(
      "⚠️ [Outbox] IndexedDB no está disponible. La cola de registros funcionará solo " +
      "en memoria: un cierre de pestaña perdería lo que no se haya enviado."
    );
    return createMemoryStore();
  }

  return {
    isDurable: true,

    /**
     * Encola un elemento. Devuelve su clave.
     * @param {Object} item
     */
    async put(item) {
      const total = await runTransaction(db, "readonly", (store) => store.count());
      if (total >= MAX_QUEUE_SIZE) {
        // Tope alcanzado: el backend lleva mucho tiempo inalcanzable. Se avisa en lugar
        // de descartar en silencio, porque descartar evidencia sin ruido es lo peor
        // que puede hacer este módulo.
        console.error(
          `❌ [Outbox] Cola llena (${total} registros sin entregar). ` +
          "El backend de persistencia no está confirmando. Revisar la conectividad: " +
          "los registros nuevos NO se están guardando."
        );
        throw new Error("Cola de registros llena");
      }
      return runTransaction(db, "readwrite", (store) => store.add(item));
    },

    /**
     * Lee los primeros `limit` elementos en orden de inserción.
     * @param {number} limit
     */
    async getBatch(limit = 50) {
      const all = await runTransaction(db, "readonly", (store) => store.getAll());
      return (all || []).slice(0, limit);
    },

    /**
     * Elimina elementos ya confirmados.
     * @param {Array<IDBValidKey>} keys
     */
    async remove(keys) {
      if (!keys || keys.length === 0) return;
      return runTransaction(db, "readwrite", (store) => {
        for (const key of keys) store.delete(key);
        return null; // se resuelve con `oncomplete`
      });
    },

    async count() {
      return runTransaction(db, "readonly", (store) => store.count());
    },

    async clear() {
      return runTransaction(db, "readwrite", (store) => {
        store.clear();
        return null;
      });
    }
  };
};
