/**
 * Conversación libre con el proveedor de IA.
 *
 * Este hook depende del PUERTO `AiProviderPort`, no de Gemini. No sabe si detrás hay
 * una llamada HTTP, un mock local o un proxy de backend; solo llama a `generateReply`.
 * Esa es la razón de existir del puerto: sustituir el proveedor no toca este archivo.
 *
 * El proveedor se reconstruye únicamente cuando cambia la clave, de modo que guardar
 * una credencial en la consola surte efecto en el siguiente mensaje sin recargar.
 */

import { useCallback, useMemo } from "react";
import { createAiProvider } from "../adapters/ai/createAiProvider.js";
import { createDomPageInspector } from "../adapters/browser/DomPageInspector.js";
import { createTokenUsageTelemetry, nullTelemetry } from "../adapters/telemetry/tokenUsageTelemetry.js";
import { environment } from "../config/environment.js";
import faqCatalog from "../config/NewFaqConfig.json" with { type: "json" };

/**
 * @param {Object} deps
 * @param {string} deps.apiKey
 * @param {{title: string, url: string}[]} deps.sitemapLinks
 * @param {(entry: {used: number, saved: number}) => void} deps.onUsage
 */
export const useAiConversation = ({ apiKey, sitemapLinks, onUsage }) => {
  const pageInspector = useMemo(() => createDomPageInspector(), []);

  const telemetry = useMemo(
    () =>
      environment.telemetryEnabled
        ? createTokenUsageTelemetry({ enabled: true })
        : nullTelemetry,
    []
  );

  /**
   * El proveedor depende de la clave, así que se reconstruye cuando esta cambia.
   * `getApiKey` se pasa como función para que el adaptador lea el valor vigente en
   * el momento de la petición y no una copia congelada en el cierre.
   */
  const provider = useMemo(
    () => createAiProvider({ getApiKey: () => apiKey, faqCatalog }),
    [apiKey]
  );

  /**
   * Pide una respuesta al proveedor y registra el consumo.
   *
   * @param {Object} params
   * @param {{sender: string, text: string}[]} params.history
   * @param {string} params.userText
   * @param {string|null} params.activeContext
   * @returns {Promise<import("../ports/AiProviderPort.js").AiReply>}
   */
  const ask = useCallback(
    async ({ history, userText, activeContext }) => {
      // El contexto de página se construye por mensaje porque la relevancia de los
      // enlaces depende de lo que el ciudadano acaba de preguntar.
      const pageContext = pageInspector.inspect(userText, sitemapLinks);

      const reply = await provider.generateReply({ history, pageContext, activeContext });

      if (reply.tokensUsed > 0) {
        // La telemetría redacta la PII del prompt antes de enviarlo.
        telemetry.record({ prompt: userText, used: reply.tokensUsed, saved: reply.savedTokens });
        onUsage?.({ used: reply.tokensUsed, saved: reply.savedTokens });
      }

      return reply;
    },
    [pageInspector, sitemapLinks, provider, telemetry, onUsage]
  );

  return { ask, providerName: provider.name };
};
