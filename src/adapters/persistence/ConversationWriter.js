import { createEnvelope, createMessageRecord, isRecordable } from "../../domain/conversation/conversationRecord.js";

/** Serializa cabecera → mensajes → cierre y conserva registros que no pudieron encolarse. */
export const createConversationWriter = ({ repository, tenantId, onStatus = () => {} }) => {
  const conversations = new Map();
  let tail = Promise.resolve();
  let disposed = false;

  const drain = context => {
    const run = tail.catch(() => {}).then(async () => {
      clearTimeout(context.retryTimer);
      if (context.envelopeKey !== context.sentEnvelopeKey) {
        const key = context.envelopeKey;
        await repository.openConversation(context.envelope);
        context.sentEnvelopeKey = key;
      }
      const records = [...context.pending.values()];
      if (records.length) {
        // Outbox confirma esta tanda de forma atómica. Solo entonces se marca registrada.
        await repository.appendMessages(records);
        for (const record of records) {
          context.pending.delete(record.messageId);
          context.recorded.add(record.messageId);
        }
      }
      if (context.closing && !context.closed && repository.closeConversation) {
        await repository.closeConversation({ tenantId, conversationId: context.envelope.conversationId });
        context.closed = true;
      }
      const status = await repository.flush();
      onStatus(status?.pending ?? 0);
    });
    tail = run;
    return run.catch(error => {
      onStatus(context.pending.size);
      if (!disposed) context.retryTimer = setTimeout(() => drain(context).catch(() => {}), 2000);
      throw error;
    });
  };

  return {
    record({ session, messages, identity, consent, pageUrl = "" }) {
      disposed = false;
      let context = conversations.get(session.id);
      if (!context) {
        context = { pending: new Map(), recorded: new Set(), sentEnvelopeKey: null, closing: false, closed: false };
        conversations.set(session.id, context);
      }
      context.envelope = createEnvelope({ tenantId, conversationId: session.id,
        startedAt: session.startedAt, identity, consent, pageUrl });
      context.envelopeKey = JSON.stringify(context.envelope);
      for (const message of messages) {
        if (!isRecordable(message) || context.recorded.has(message.id) || context.pending.has(message.id)) continue;
        context.pending.set(message.id, createMessageRecord({ tenantId, conversationId: session.id,
          sequence: session.reserveSequence(), message }));
      }
      return drain(context);
    },
    close(session) {
      const context = conversations.get(session.id);
      if (!context) return Promise.resolve();
      context.closing = true;
      return drain(context);
    },
    dispose() {
      disposed = true;
      for (const context of conversations.values()) clearTimeout(context.retryTimer);
    }
  };
};
