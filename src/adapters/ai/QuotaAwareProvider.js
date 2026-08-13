/**
 * Degradación silenciosa al banco de preguntas. Implementa `ports/AiProviderPort`.
 *
 * Al agotarse la cuota no se avisa al ciudadano: se apaga Gemini para él y el bot sigue
 * con el banco de FAQ. Decir "no tienes créditos" no le sirve de nada y es una invitación
 * a probar cómo saltárselo.
 *
 * Es un decorador del mismo puerto que envuelve, así que `useAiConversation` no cambia ni
 * sabe que existe. Mismo patrón que `OutboxConversationRepository`.
 *
 * La suspensión la decide el servidor vía `retryAfterSeconds`; el cliente no lleva la
 * cuenta. Un fallo de transporte no suspende: puede ser la red del ciudadano. El momento
 * de reanudación va en `sessionStorage` para que recargar no reintente en balde.
 */

import { assertImplementsAiProvider } from "../../ports/AiProviderPort.js";
import { createStorage, STORAGE_KEYS } from "../browser/localStorageAdapter.js";

/**
 * Almacenamiento de sesión, no persistente: la suspensión describe el estado de HOY de
 * este navegador, y arrastrarla entre sesiones dejaría a alguien sin IA sin motivo.
 */
const createSessionStorageAdapter = () => {
  try {
    return createStorage({ store: globalThis.sessionStorage });
  } catch {
    // Sin `sessionStorage` (modo privado restrictivo): la suspensión vive en memoria.
    return createStorage({ store: undefined });
  }
};

/**
 * Crea el proveedor con degradación.
 *
 * @param {Object} deps
 * @param {import("../../ports/AiProviderPort.js").AiProvider} deps.primary
 *        Proveedor de IA real (normalmente el proxy).
 * @param {import("../../ports/AiProviderPort.js").AiProvider} deps.fallback
 *        Proveedor local que responde desde el banco de preguntas.
 * @param {() => number} [deps.now]
 * @param {Object} [deps.storage]  Inyectable para pruebas.
 * @returns {import("../../ports/AiProviderPort.js").AiProvider}
 */
export const createQuotaAwareProvider = ({
  primary,
  fallback,
  now = () => Date.now(),
  storage = createSessionStorageAdapter()
}) => {
  assertImplementsAiProvider(primary);
  assertImplementsAiProvider(fallback);

  /** Marca de tiempo (ms) hasta la que no se vuelve a molestar al proveedor real. */
  let suspendedUntil = Number(storage.get(STORAGE_KEYS.aiSuspendedUntil)) || 0;

  /** @param {number} until */
  const suspendUntil = (until) => {
    suspendedUntil = until;
    storage.set(STORAGE_KEYS.aiSuspendedUntil, String(until));
  };

  const isSuspended = () => suspendedUntil > now();

  return {
    // El nombre refleja quién responde AHORA, porque es lo que el panel muestra al
    // operador en la tarjeta MOTOR DE RESPUESTA.
    get name() {
      return isSuspended() ? `${fallback.name}(cuota)` : primary.name;
    },

    /** ¿La IA está apagada para esta sesión? Lo consulta el panel, no el ciudadano. */
    get isSuspended() {
      return isSuspended();
    },

    /** Segundos que quedan de suspensión. 0 si no hay ninguna. */
    get suspendedForSeconds() {
      return isSuspended() ? Math.ceil((suspendedUntil - now()) / 1000) : 0;
    },

    /** Reanuda la IA de inmediato. Pensado para el operador y para las pruebas. */
    resume() {
      suspendedUntil = 0;
      storage.remove(STORAGE_KEYS.aiSuspendedUntil);
    },

    async generateReply(request) {
      // Ya suspendido: se atiende con el banco sin gastar una petición en confirmar algo
      // que el servidor ya dijo.
      if (isSuspended()) {
        return { ...(await fallback.generateReply(request)), servedByFallback: true };
      }

      const reply = await primary.generateReply(request);

      // Respuesta normal.
      if (!reply.fallback) return reply;

      // El proveedor real declinó. Se anota la suspensión si el servidor la pidió y se
      // responde con el banco: el ciudadano recibe una respuesta útil, no un aviso.
      const seconds = Number(reply.fallback.retryAfterSeconds) || 0;
      if (seconds > 0) {
        suspendUntil(now() + seconds * 1000);
      }

      const local = await fallback.generateReply(request);
      return {
        ...local,
        servedByFallback: true,
        // Se conserva el motivo para que el panel pueda explicárselo al operador. Nunca se
        // convierte en texto para el ciudadano.
        fallbackReason: reply.fallback.reason
      };
    }
  };
};
