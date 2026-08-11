/**
 * Decorador que añade durabilidad y reintentos a cualquier repositorio de
 * conversaciones. Implementa `ConversationRepositoryPort`.
 *
 * Es un decorador y no una clase base a propósito: el repositorio envuelto solo tiene
 * que saber hablar con su destino, y la política de entrega —cola, orden, reintentos,
 * vaciado al cerrar la pestaña— se define una sola vez aquí. Eso permite cambiar el
 * destino (HTTP hoy, otra cosa mañana) sin volver a resolver el problema de la entrega.
 *
 * GARANTÍA: entrega "al menos una vez". Un registro puede llegar duplicado si se
 * confirma justo cuando la red se corta, pero no se pierde. Es la elección correcta
 * para evidencia legal, y el motivo por el que el backend DEBE deduplicar por
 * `messageId` (ver `HttpConversationRepository`).
 *
 * ORDEN: los elementos se procesan estrictamente en orden de inserción y el vaciado se
 * detiene ante el primer fallo. Esto es deliberado: la cabecera de la conversación debe
 * llegar antes que sus mensajes, y saltarse un elemento fallido dejaría huecos en la
 * secuencia.
 */

import { assertImplementsConversationRepository } from "../../ports/ConversationRepositoryPort.js";
import { createOutboxStore } from "./outboxStore.js";

/** Elementos enviados por tanda. */
const BATCH_SIZE = 50;

/** Retardos de reintento, en milisegundos. Crecen hasta un minuto. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

const KIND_ENVELOPE = "envelope";
const KIND_MESSAGE = "message";

/**
 * @param {Object} deps
 * @param {import("../../ports/ConversationRepositoryPort.js").ConversationRepository} deps.delegate
 * @returns {import("../../ports/ConversationRepositoryPort.js").ConversationRepository}
 */
export const createOutboxConversationRepository = ({ delegate }) => {
  assertImplementsConversationRepository(delegate);

  /** @type {Awaited<ReturnType<typeof createOutboxStore>>|null} */
  let store = null;
  let storePromise = null;
  let isFlushing = false;
  let retryIndex = 0;
  let retryTimer = null;

  /** Obtiene la cola, creándola una sola vez. */
  const getStore = () => {
    if (store) return Promise.resolve(store);
    if (!storePromise) {
      storePromise = createOutboxStore().then((s) => {
        store = s;
        return s;
      });
    }
    return storePromise;
  };

  const clearRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  /** Programa un reintento con retardo creciente. */
  const scheduleRetry = () => {
    clearRetry();
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    retryIndex += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      flush().catch(() => {
        /* `flush` ya gestiona sus errores */
      });
    }, delay);
  };

  /**
   * Agrupa elementos consecutivos del mismo tipo y conversación, para enviarlos juntos.
   * Solo agrupa CONSECUTIVOS: reordenar rompería la garantía de orden.
   *
   * @param {Array<{key: any, kind: string, payload: Object}>} items
   * @returns {Array<{kind: string, keys: any[], payloads: Object[]}>}
   */
  const groupConsecutive = (items) => {
    const groups = [];
    for (const item of items) {
      const last = groups[groups.length - 1];
      const sameGroup =
        last &&
        last.kind === item.kind &&
        item.kind === KIND_MESSAGE &&
        last.payloads[0]?.conversationId === item.payload.conversationId;

      if (sameGroup) {
        last.keys.push(item.key);
        last.payloads.push(item.payload);
      } else {
        groups.push({ kind: item.kind, keys: [item.key], payloads: [item.payload] });
      }
    }
    return groups;
  };

  /**
   * Intenta entregar lo pendiente.
   * @returns {Promise<{pending: number}>}
   */
  const flush = async () => {
    if (isFlushing) {
      const s = await getStore();
      return { pending: await s.count() };
    }

    // Sin conexión no se intenta: solo generaría errores y ruido en consola.
    if (globalThis.navigator && globalThis.navigator.onLine === false) {
      const s = await getStore();
      scheduleRetry();
      return { pending: await s.count() };
    }

    isFlushing = true;
    try {
      const s = await getStore();
      const batch = await s.getBatch(BATCH_SIZE);

      if (batch.length === 0) {
        clearRetry();
        retryIndex = 0;
        return { pending: 0 };
      }

      for (const group of groupConsecutive(batch)) {
        try {
          if (group.kind === KIND_ENVELOPE) {
            await delegate.openConversation(group.payloads[0]);
          } else {
            await delegate.appendMessages(group.payloads);
          }
          // Solo se borra de la cola tras confirmación.
          await s.remove(group.keys);
        } catch {
          // Detenerse en el primer fallo preserva el orden de entrega.
          scheduleRetry();
          return { pending: await s.count() };
        }
      }

      // Tanda completa: reiniciar el retardo y ver si queda más.
      retryIndex = 0;
      const pending = await s.count();
      if (pending > 0) {
        // Encadenar sin esperar, para no bloquear a quien llamó.
        setTimeout(() => flush().catch(() => {}), 0);
      } else {
        clearRetry();
      }
      return { pending };
    } finally {
      isFlushing = false;
    }
  };

  /**
   * Encola un elemento y dispara un intento de entrega.
   * @param {string} kind
   * @param {Object} payload
   */
  const enqueue = async (kind, payload) => {
    const s = await getStore();
    await s.put({ kind, payload, queuedAt: new Date().toISOString() });
    // No se espera el envío: la conversación no debe detenerse por la persistencia.
    flush().catch(() => {});
  };

  // Vaciar cuando la pestaña pasa a segundo plano. `visibilitychange` y `pagehide` son
  // fiables; `beforeunload` no se dispara en móviles y no se usa.
  if (globalThis.document?.addEventListener) {
    const onHide = () => {
      if (globalThis.document.visibilityState === "hidden") {
        flush().catch(() => {});
      }
    };
    globalThis.document.addEventListener("visibilitychange", onHide);
    globalThis.addEventListener?.("pagehide", () => flush().catch(() => {}));
    globalThis.addEventListener?.("online", () => {
      retryIndex = 0;
      flush().catch(() => {});
    });
  }

  return {
    name: `outbox(${delegate.name})`,

    async openConversation(envelope) {
      await enqueue(KIND_ENVELOPE, envelope);
    },

    async appendMessages(records) {
      if (!Array.isArray(records) || records.length === 0) return;
      // Se encola uno por uno para que cada mensaje sea confirmable de forma
      // independiente: si una tanda falla a medias, no se reenvía lo ya aceptado.
      for (const record of records) {
        await enqueue(KIND_MESSAGE, record);
      }
    },

    flush
  };
};
