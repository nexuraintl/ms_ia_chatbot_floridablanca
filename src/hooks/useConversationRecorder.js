/**
 * Grabación del registro de conversación.
 *
 * Observa la lista de mensajes y envía al repositorio los que aún no se han registrado.
 * Depende del PUERTO `ConversationRepositoryPort`, no de un destino concreto: hoy puede
 * estar apagado, imprimiendo en consola o enviando a Cloud Run, y este hook no cambia.
 *
 * Diseño de la detección de mensajes nuevos: se lleva un `Set` de ids ya registrados en
 * una referencia. No se compara por longitud del array —`messages` no solo crece, también
 * se modifica cuando se retiran los `quickReplies` de los mensajes anteriores— ni por
 * índice, porque un reinicio de conversación reordena todo. El id es lo único estable.
 *
 * El contador de secuencia también vive en una referencia y es monótono por conversación:
 * permite al backend detectar huecos, es decir, mensajes que nunca llegaron.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createConversationId,
  createEnvelope,
  createMessageRecord,
  isRecordable
} from "../domain/conversation/conversationRecord.js";
import { createConversationRepository } from "../adapters/persistence/createConversationRepository.js";
import { environment } from "../config/environment.js";

/** Clave de sesión donde se guarda el id de conversación (identificador opaco, sin PII). */
const SESSION_KEY = "avi_chatbot.conversation_id";

/**
 * Recupera el id de conversación de la sesión, o crea uno nuevo.
 * Permite que una recarga siga escribiendo en la misma conversación en lugar de
 * partir el registro en dos.
 *
 * @returns {string}
 */
const resolveConversationId = () => {
  try {
    const stored = globalThis.sessionStorage?.getItem(SESSION_KEY);
    if (stored) return stored;
    const fresh = createConversationId();
    globalThis.sessionStorage?.setItem(SESSION_KEY, fresh);
    return fresh;
  } catch {
    // Sin sessionStorage (modo privado restrictivo): id solo para esta carga.
    return createConversationId();
  }
};

/**
 * @param {Object} params
 * @param {import("../domain/messages/messageFactory.js").ChatMessage[]} params.messages
 * @param {Object} params.config
 * @param {import("../domain/identity/citizenIdentity.js").CitizenIdentity|null} params.identity
 * @param {import("../domain/consent/consentRecord.js").ConsentRecord|null} params.consent
 */
export const useConversationRecorder = ({ messages, config, identity, consent }) => {
  /**
   * El repositorio se construye una sola vez. La variable de entorno tiene prioridad
   * sobre la configuración del tenant, para poder activar el registro por entorno.
   */
  const repository = useMemo(
    () =>
      createConversationRepository({
        mode: environment.persistenceMode || config.persistence?.mode,
        endpoint: environment.conversationApiUrl
      }),
    [config.persistence?.mode]
  );

  const isEnabled = repository.name !== "null";
  const tenantId = config.tenantId || "default";

  /**
   * El id de conversación es ESTADO y no una referencia, porque se expone en el
   * contexto y por tanto es relevante para el render. Leer `ref.current` durante el
   * render no garantiza que los consumidores se actualicen cuando cambia.
   */
  const [conversationId, setConversationId] = useState(resolveConversationId);

  // Estos sí son referencias: solo se leen y escriben dentro de efectos, nunca durante
  // el render, y no deben provocar re-renders al cambiar.
  const recordedIdsRef = useRef(new Set());
  const sequenceRef = useRef(0);
  const envelopeSentRef = useRef(false);

  const [pending, setPending] = useState(0);

  /** Envía (o reenvía) la cabecera de la conversación. */
  const sendEnvelope = useCallback(() => {
    if (!isEnabled) return;
    repository
      .openConversation(
        createEnvelope({
          tenantId,
          conversationId,
          identity,
          consent,
          pageUrl: globalThis.window?.location?.href || ""
        })
      )
      .catch((error) => {
        console.warn("⚠️ [Registro] No se pudo abrir la conversación:", error?.message);
      });
  }, [isEnabled, repository, tenantId, conversationId, identity, consent]);

  /**
   * Reenviar la cabecera cuando aparece la identidad o la autorización.
   * El backend debe hacer upsert por `conversationId`, así que reenviarla es seguro y
   * es lo que vincula los mensajes anónimos previos con la persona que se identificó.
   */
  useEffect(() => {
    if (!isEnabled) return;
    if (!envelopeSentRef.current || identity || consent) {
      envelopeSentRef.current = true;
      sendEnvelope();
    }
  }, [isEnabled, identity, consent, sendEnvelope]);

  /** Registrar los mensajes nuevos. */
  useEffect(() => {
    if (!isEnabled || messages.length === 0) return;

    const fresh = messages.filter(
      (m) => isRecordable(m) && !recordedIdsRef.current.has(m.id)
    );
    if (fresh.length === 0) return;

    const records = fresh.map((message) => {
      recordedIdsRef.current.add(message.id);
      return createMessageRecord({
        tenantId,
        conversationId,
        sequence: sequenceRef.current++,
        message
      });
    });

    repository
      .appendMessages(records)
      .then(() => repository.flush())
      .then((status) => setPending(status?.pending ?? 0))
      .catch((error) => {
        console.warn("⚠️ [Registro] No se pudieron guardar mensajes:", error?.message);
      });
  }, [messages, isEnabled, repository, tenantId, conversationId]);

  /**
   * Empieza una conversación nueva. Se llama al reiniciar el chat: el registro anterior
   * queda cerrado en el backend y los mensajes siguientes van a una conversación
   * distinta, en lugar de mezclarse con la anterior.
   */
  const startNewConversation = useCallback(() => {
    const fresh = createConversationId();
    recordedIdsRef.current = new Set();
    sequenceRef.current = 0;
    envelopeSentRef.current = false;
    setConversationId(fresh);
    try {
      globalThis.sessionStorage?.setItem(SESSION_KEY, fresh);
    } catch {
      /* sin sessionStorage: el id vive solo en memoria */
    }
  }, []);

  return {
    isEnabled,
    repositoryName: repository.name,
    conversationId,
    pendingRecords: pending,
    startNewConversation,
    flush: repository.flush
  };
};
