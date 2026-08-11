/**
 * Adaptador del proveedor de IA contra la API de Google Gemini.
 * Implementa `ports/AiProviderPort`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADVERTENCIA DE SEGURIDAD — LA CLAVE VIVE EN EL NAVEGADOR
 *
 * Este adaptador llama a `generativelanguage.googleapis.com` directamente desde el
 * cliente, así que la clave de API es visible para cualquiera que abra las
 * herramientas de desarrollo. Eso no se puede arreglar desde el frontend: si el
 * navegador puede autenticarse, el usuario puede leer la credencial.
 *
 * Mitigaciones aplicadas aquí:
 *   · La clave viaja en la cabecera `x-goog-api-key`, no en la query string, para que
 *     no quede registrada en historiales de navegación, logs de proxy ni cabeceras
 *     `Referer`.
 *   · La clave NUNCA se lee de `import.meta.env` en el arranque, de modo que no queda
 *     incrustada en el bundle de producción. Solo se usa la que el operador introduce
 *     en la consola, que queda en su propio navegador.
 *
 * Mitigaciones que hay que aplicar FUERA del código:
 *   · Restringir la clave por referente HTTP y por API en Google Cloud Console.
 *   · Fijarle una cuota diaria baja para acotar el gasto si se filtra.
 *   · Rotarla si alguna vez se publicó un build que la incluyera.
 *
 * La solución definitiva es un proxy de backend que guarde la clave del lado del
 * servidor. El puerto `AiProviderPort` existe precisamente para que ese cambio sea
 * añadir un adaptador nuevo, sin tocar nada más.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { post, HttpError } from "../http/httpClient.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { degradedReply } from "../../ports/AiProviderPort.js";
import { toDataTurn } from "../../domain/pageContext/promptSerializer.js";
import { findBestFaq, formatFaqAsContext } from "../../domain/faq/faqMatcher.js";
import { estimateApiUsage, readActualUsage } from "../../domain/tokens/tokenEstimator.js";
import { sanitizeText } from "../../domain/security/textSanitizer.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash-lite";

/** Tope de turnos de conversación enviados, para acotar coste y ventana. */
const MAX_HISTORY_TURNS = 20;

/** Tope de caracteres por turno. */
const MAX_TURN_CHARS = 4000;

/**
 * Traduce los turnos internos al formato de `contents` de Gemini.
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
 * Crea el adaptador de Gemini.
 *
 * @param {Object} deps
 * @param {() => string} deps.getApiKey  Lectura diferida de la clave, para que un
 *        cambio en la consola surta efecto sin reconstruir el proveedor.
 * @param {import("../../domain/faq/faqMatcher.js").FaqItem[]} deps.faqCatalog
 * @param {string} [deps.model]
 * @returns {import("../../ports/AiProviderPort.js").AiProvider}
 */
export const createGeminiApiProvider = ({ getApiKey, faqCatalog = [], model = DEFAULT_MODEL }) => ({
  name: "gemini-api",

  async generateReply({ history, pageContext }) {
    const apiKey = typeof getApiKey === "function" ? getApiKey() : "";
    if (!apiKey) {
      // La fábrica no debería habernos elegido sin clave; degradamos por si acaso.
      return degradedReply();
    }

    const userMessage = history?.[history.length - 1]?.text || "";

    // Contexto de FAQ: CONFIABLE (proviene del repositorio del proyecto),
    // así que puede entrar en la instrucción de sistema.
    const faqMatch = findBestFaq(userMessage, faqCatalog);
    const systemPrompt = buildSystemPrompt({
      faqContext: faqMatch ? formatFaqAsContext(faqMatch) : ""
    });

    const contents = toGeminiContents(history);

    // Contexto de la página: NO CONFIABLE. Va como turno de datos delimitado, antes
    // del último mensaje del usuario, y explícitamente fuera de systemInstruction.
    const dataTurn = toDataTurn(pageContext);
    if (dataTurn) {
      contents.splice(Math.max(0, contents.length - 1), 0, dataTurn);
    }

    try {
      const data = await post(
        `${API_BASE}/${encodeURIComponent(model)}:generateContent`,
        {
          contents,
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: { maxOutputTokens: 200, temperature: 0.6 }
        },
        {
          headers: {
            // Cabecera en lugar de `?key=`: no queda en historiales ni en Referer.
            "x-goog-api-key": apiKey
          }
        }
      );

      const replyText = String(data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
      if (!replyText) return degradedReply();

      // Preferir el consumo real que reporta la API sobre nuestra estimación.
      const usage = readActualUsage(data) ?? estimateApiUsage(history, replyText);

      return {
        text: replyText,
        contextIntent: faqMatch?.intencion ?? null,
        // Esta llamada sí gastó cuota de Google: la consola puede contarla.
        billable: true,
        ...usage
      };
    } catch (error) {
      // Solo el detalle técnico va a consola. El ciudadano recibe el texto genérico:
      // los mensajes de error de la API pueden describir el estado de la credencial.
      if (error instanceof HttpError) {
        console.error(`❌ [Gemini] ${error.message}`, error.status ? `status=${error.status}` : "");
      } else {
        console.error("❌ [Gemini] Error inesperado:", error?.message);
      }
      return degradedReply();
    }
  }
});
