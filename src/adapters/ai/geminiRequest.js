/**
 * Construcción de la petición a Gemini. Capa de adaptadores.
 *
 * Extraído de `GeminiApiProvider` cuando apareció el segundo proveedor que habla el mismo
 * protocolo: el que llama a Google directamente (desarrollo local) y el que pasa por el
 * proxy del backend (producción). Los dos necesitan exactamente el mismo cuerpo, y
 * duplicarlo habría significado que las reglas anti-inyección de prompt —el orden de los
 * turnos, el aislamiento del contexto de página— se mantuvieran en dos sitios.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTE MÓDULO PROTEGE
 *
 * El contexto de la página anfitriona NO ES CONFIABLE: lo escribe el DOM del portal en el
 * que el widget está embebido. Por eso viaja como turno de datos delimitado
 * (`promptSerializer.toDataTurn`) e INSERTADO ANTES del último mensaje del ciudadano,
 * nunca dentro de `systemInstruction`. Si se colara en la instrucción de sistema, un
 * portal comprometido podría reescribir las reglas del asistente.
 *
 * El contexto de FAQ sí es confiable —viene del repositorio del proyecto— así que ese sí
 * entra en la instrucción de sistema.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { buildSystemPrompt } from "./systemPrompt.js";
import { toDataTurn } from "../../domain/pageContext/promptSerializer.js";
import { findBestFaq, formatFaqAsContext } from "../../domain/faq/faqMatcher.js";
import { sanitizeText } from "../../domain/security/textSanitizer.js";

/** Tope de turnos de conversación enviados, para acotar coste y ventana. */
export const MAX_HISTORY_TURNS = 20;

/** Tope de caracteres por turno. */
export const MAX_TURN_CHARS = 4000;

/**
 * Configuración de generación. `maxOutputTokens` acotado es control de gasto: cada token
 * de salida se paga. El proxy del backend vuelve a acotarlo por su cuenta, porque un
 * cliente modificado podría pedir más.
 */
export const DEFAULT_GENERATION_CONFIG = Object.freeze({
  maxOutputTokens: 200,
  temperature: 0.6
});

/**
 * Traduce los turnos internos al formato `contents` de Gemini.
 * @param {import("../../ports/AiProviderPort.js").ConversationTurn[]} history
 */
const toGeminiContents = (history) =>
  (Array.isArray(history) ? history : [])
    .filter((m) => m && typeof m.text === "string" && m.text.trim() !== "")
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({
      role: m.sender === "user" ? "user" : "model",
      parts: [{ text: sanitizeText(m.text).substring(0, MAX_TURN_CHARS) }]
    }));

/**
 * Construye el cuerpo de la petición y resuelve la coincidencia de FAQ.
 *
 * @param {Object} params
 * @param {import("../../ports/AiProviderPort.js").ConversationTurn[]} params.history
 * @param {import("../../domain/pageContext/pageContext.js").PageContext|null} params.pageContext
 * @param {import("../../domain/faq/faqMatcher.js").FaqItem[]} [params.faqCatalog]
 * @returns {{ payload: Object, faqMatch: Object|null }}
 */
export const buildGeminiPayload = ({ history, pageContext, faqCatalog = [] }) => {
  const userMessage = history?.[history.length - 1]?.text || "";

  // Contexto de FAQ: CONFIABLE (proviene del repositorio del proyecto).
  const faqMatch = findBestFaq(userMessage, faqCatalog);
  const systemPrompt = buildSystemPrompt({
    faqContext: faqMatch ? formatFaqAsContext(faqMatch) : ""
  });

  const contents = toGeminiContents(history);

  // Contexto de página: NO CONFIABLE. Turno de datos delimitado, antes del último mensaje
  // del ciudadano y explícitamente fuera de `systemInstruction`.
  const dataTurn = toDataTurn(pageContext);
  if (dataTurn) {
    contents.splice(Math.max(0, contents.length - 1), 0, dataTurn);
  }

  return {
    faqMatch,
    payload: {
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { ...DEFAULT_GENERATION_CONFIG }
    }
  };
};
