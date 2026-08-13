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
import { sessionMetrics, METRIC_EVENTS } from "../domain/observability/sessionMetrics.js";
import { environment } from "../config/environment.js";
import faqCatalog from "../config/NewFaqConfig.json" with { type: "json" };

/**
 * Reloj monótono para medir latencia. `performance.now()` no salta si el sistema ajusta
 * la hora en mitad de una petición; `Date.now()` sí, y podría dar una latencia negativa.
 * @returns {number}
 */
const monotonicNow = () =>
  typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();

/**
 * @param {Object} deps
 * @param {string} deps.apiKey
 * @param {{title: string, url: string}[]} deps.sitemapLinks
 */
export const useAiConversation = ({ apiKey, sitemapLinks }) => {
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
   *
   * Con `VITE_AI_PROXY_URL` definida gana el proxy del backend, que es donde viven la
   * clave y el control de gasto; la clave local solo se usa en desarrollo.
   */
  const provider = useMemo(
    () => createAiProvider({ getApiKey: () => apiKey, faqCatalog, proxyUrl: environment.aiProxyUrl }),
    [apiKey]
  );

  /**
   * Pide una respuesta al proveedor y registra la medición.
   *
   * La latencia se mide alrededor de `generateReply`, es decir incluye la red y la
   * inferencia pero no el render. Es el número que corresponde vigilar: es lo que el
   * ciudadano espera mirando el indicador de "escribiendo…".
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

      const startedAt = monotonicNow();
      const reply = await provider.generateReply({ history, pageContext, activeContext });
      const latencyMs = monotonicNow() - startedAt;

      sessionMetrics.record(METRIC_EVENTS.AI_REPLY, {
        provider: provider.name,
        latencyMs,
        degraded: reply.isError === true,
        // El proveedor declara si consumió cuota remota; no se deduce de su nombre.
        billable: reply.billable === true,
        tokensUsed: reply.tokensUsed,
        isEstimate: reply.isEstimate,
        // Cuando el backend corta la IA por cuota, esto es lo único que lo delata: el
        // ciudadano no ve ningún aviso, así que el operador necesita verlo en el panel.
        servedByFallback: reply.servedByFallback === true,
        fallbackReason: reply.fallbackReason
      });

      if (reply.tokensUsed > 0) {
        // La telemetría redacta la PII del prompt antes de enviarlo.
        telemetry.record({ prompt: userText, used: reply.tokensUsed, saved: reply.savedTokens });
      }

      return reply;
    },
    [pageInspector, sitemapLinks, provider, telemetry]
  );

  return { ask, providerName: provider.name };
};
