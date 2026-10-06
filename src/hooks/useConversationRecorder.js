import { useCallback, useEffect, useMemo, useState } from "react";
import { createConversationRepository } from "../adapters/persistence/createConversationRepository.js";
import { createConversationWriter } from "../adapters/persistence/ConversationWriter.js";
import { createConversationSession } from "../adapters/browser/conversationSession.js";
import { environment } from "../config/environment.js";

export const useConversationRecorder = ({ messages, config, identity, consent }) => {
  const repository = useMemo(() => createConversationRepository({
    mode: environment.persistenceMode || config.persistence?.mode,
    endpoint: environment.conversationApiUrl
  }), [config.persistence?.mode]);
  const isEnabled = repository.name !== "null";
  const tenantId = config.tenantId || "default";
  const [session, setSession] = useState(() => createConversationSession({ tenantId }));
  const [pending, setPending] = useState(0);
  const writer = useMemo(() => createConversationWriter({ repository, tenantId, onStatus: setPending }),
    [repository, tenantId]);

  useEffect(() => {
    if (!isEnabled) return;
    writer.record({ session, messages, identity, consent, pageUrl: globalThis.window?.location?.href || "" })
      .catch(() => console.warn("[Registro] No se pudo encolar; se reintentará."));
  }, [writer, isEnabled, session, messages, identity, consent]);

  useEffect(() => () => writer.dispose(), [writer]);

  const startNewConversation = useCallback(() => {
    if (isEnabled) writer.close(session).catch(() => console.warn("[Registro] Cierre pendiente de encolar."));
    setSession(createConversationSession({ tenantId, fresh: true }));
  }, [isEnabled, writer, session, tenantId]);

  return {
    isEnabled,
    repositoryName: repository.name,
    conversationId: session.id,
    pendingRecords: pending,
    startNewConversation,
    flush: repository.flush
  };
};
