/**
 * Temporizador del mensaje de seguimiento ("¿Te puedo ayudar con algo más?").
 *
 * Extraído de `ChatContext.jsx`. Además de aislar la responsabilidad, arregla una
 * fuga de temporizador: la versión anterior no limpiaba el `setTimeout` al desmontar
 * el componente, así que si el ciudadano cerraba el widget dentro de la ventana de
 * 20 segundos el callback seguía vivo e intentaba actualizar estado de un componente
 * ya desmontado.
 */

import { useCallback, useEffect, useRef } from "react";
import { createMessage } from "../domain/messages/messageFactory.js";

/** Retardo por defecto antes de ofrecer más ayuda. */
export const DEFAULT_FOLLOW_UP_DELAY_MS = 20_000;

/** Texto que identifica un mensaje de seguimiento ya emitido. */
const FOLLOW_UP_MARKER = "¿Te puedo ayudar con algo más?";

/**
 * @param {Object} params
 * @param {Function} params.setMessages
 * @param {Object} params.config
 * @param {boolean} params.isServicesEnabled
 */
export const useFollowUp = ({ setMessages, config, isServicesEnabled }) => {
  const timerRef = useRef(null);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Limpiar al desmontar: evita actualizar estado de un componente ya retirado.
  useEffect(() => clear, [clear]);

  const schedule = useCallback(
    (delayMs = DEFAULT_FOLLOW_UP_DELAY_MS) => {
      clear();
      timerRef.current = setTimeout(() => {
        setMessages((prev) => {
          if (prev.length === 0) return prev;

          const last = prev[prev.length - 1];
          // Solo ofrecer ayuda tras una respuesta del bot, y nunca dos veces seguidas.
          if (last.sender !== "bot" || last.text?.includes(FOLLOW_UP_MARKER)) {
            return prev;
          }

          const replies = isServicesEnabled
            ? (config.quickReplies || []).map((r) => r.label)
            : null;

          const followUp = createMessage({
            sender: "bot",
            text: isServicesEnabled
              ? `${FOLLOW_UP_MARKER} Escribe tu duda o selecciona una opción rápida:`
              : FOLLOW_UP_MARKER,
            quickReplies: replies
          });

          return [...prev.map((m) => (m.quickReplies ? { ...m, quickReplies: null } : m)), followUp];
        });
      }, delayMs);
    },
    [clear, setMessages, config, isServicesEnabled]
  );

  return { schedule, clear };
};
