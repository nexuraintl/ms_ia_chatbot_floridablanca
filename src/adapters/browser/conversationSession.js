import { createConversationId } from "../../domain/conversation/conversationRecord.js";

/** Solo identificadores y contadores; nunca datos del ciudadano. */
export const createConversationSession = ({ tenantId, fresh = false, storage,
  now = () => new Date().toISOString(), makeId = createConversationId }) => {
  if (storage === undefined) {
    try { storage = globalThis.sessionStorage; } catch { /* almacenamiento restringido */ }
  }
  const key = `avi_chatbot.conversation:${tenantId}`;
  let saved;
  if (!fresh) {
    try { saved = JSON.parse(storage?.getItem(key) || "null"); } catch { /* almacenamiento restringido */ }
  }
  if (!saved || typeof saved.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(saved.id) ||
      !Number.isSafeInteger(saved.nextSequence) || saved.nextSequence < 0 ||
      !Number.isFinite(Date.parse(saved.startedAt))) {
    saved = { id: makeId(), startedAt: now(), nextSequence: 0 };
  }
  const persist = () => {
    try { storage?.setItem(key, JSON.stringify(saved)); } catch { /* sesión en memoria */ }
  };
  persist();
  return {
    id: saved.id,
    startedAt: saved.startedAt,
    reserveSequence() {
      const sequence = saved.nextSequence++;
      persist();
      return sequence;
    }
  };
};
