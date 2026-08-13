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
import { degradedReply } from "../../ports/AiProviderPort.js";
import { buildGeminiPayload } from "./geminiRequest.js";
import { estimateApiUsage, readActualUsage } from "../../domain/tokens/tokenEstimator.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash-lite";

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

    // La construcción del cuerpo —y con ella el aislamiento del contexto de página— vive
    // en `geminiRequest.js`, compartida con el proveedor que pasa por el proxy.
    const { payload, faqMatch } = buildGeminiPayload({ history, pageContext, faqCatalog });

    try {
      const data = await post(
        `${API_BASE}/${encodeURIComponent(model)}:generateContent`,
        payload,
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
