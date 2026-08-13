/**
 * Adaptador de IA contra el proxy del backend. Implementa `ports/AiProviderPort`.
 *
 * Es el proveedor que cierra H-01: con `VITE_AI_PROXY_URL` definida la clave se queda en
 * el servidor y no llega al navegador. Además habilita el control de gasto, que necesita
 * ver la IP y contar por sesión.
 *
 * Ante un límite alcanzado no decide nada: traduce el motivo y `retryAfterSeconds` a un
 * campo `fallback` y deja la degradación a `QuotaAwareProvider`.
 */

import { post, HttpError } from "../http/httpClient.js";
import { degradedReply } from "../../ports/AiProviderPort.js";
import { buildGeminiPayload } from "./geminiRequest.js";
import { estimateApiUsage, readActualUsage } from "../../domain/tokens/tokenEstimator.js";

/** Ruta del proxy en el backend. Debe coincidir con `AI_CHAT_PATH` del servidor. */
const CHAT_PATH = "/api/ai/chat";

/**
 * Motivos que el proxy puede devolver. Se replican aquí porque son el CONTRATO del
 * endpoint, no un detalle interno del servidor.
 */
export const PROXY_REASONS = Object.freeze({
  RATE_LIMITED: "rate_limited",
  QUOTA_EXHAUSTED: "quota_exhausted",
  AI_UNAVAILABLE: "ai_unavailable"
});

/**
 * Cuánto esperar cuando el proxy no indica `retryAfterSeconds`. Cubre el caso de un
 * backend sin credencial o con Gemini caído: reintentar en cada mensaje solo gastaría
 * peticiones para volver a fallar.
 */
const DEFAULT_RETRY_SECONDS = 300;

/**
 * Normaliza la URL base del proxy: sin barra final, para no generar `//api/ai/chat`.
 * @param {string} url
 */
const normalizeBase = (url) => String(url || "").replace(/\/+$/, "");

/**
 * Extrae la señal de degradación de un error del proxy.
 *
 * @param {unknown} error
 * @returns {{reason: string, retryAfterSeconds: number}|null}
 */
const readFallbackSignal = (error) => {
  if (!(error instanceof HttpError)) return null;

  const reason = error.body?.reason;
  if (!Object.values(PROXY_REASONS).includes(reason)) return null;

  const hinted = Number(error.body?.retryAfterSeconds);
  return {
    reason,
    retryAfterSeconds: Number.isFinite(hinted) && hinted > 0 ? hinted : DEFAULT_RETRY_SECONDS
  };
};

/**
 * Crea el adaptador del proxy.
 *
 * @param {Object} deps
 * @param {string} deps.proxyUrl   Origen del backend. Vacío significa mismo origen.
 * @param {import("../../domain/faq/faqMatcher.js").FaqItem[]} [deps.faqCatalog]
 * @returns {import("../../ports/AiProviderPort.js").AiProvider}
 */
export const createGeminiProxyProvider = ({ proxyUrl = "", faqCatalog = [] } = {}) => ({
  name: "ai-proxy",

  async generateReply({ history, pageContext }) {
    const { payload, faqMatch } = buildGeminiPayload({ history, pageContext, faqCatalog });

    try {
      // `post` ya aporta timeout, cabeceras de correlación —de las que el servidor saca el
      // identificador de sesión— y errores tipados que no arrastran el cuerpo al chat.
      const data = await post(`${normalizeBase(proxyUrl)}${CHAT_PATH}`, payload);

      const text = String(data?.text || "").trim();
      if (text === "") return degradedReply();

      // El proxy reenvía `usageMetadata` íntegro, así que el consumo que muestra el panel
      // sigue siendo el que reporta Google y no una estimación.
      const usage = readActualUsage(data) ?? estimateApiUsage(history, text);

      return {
        text,
        contextIntent: faqMatch?.intencion ?? null,
        billable: true,
        ...usage
      };
    } catch (error) {
      const fallback = readFallbackSignal(error);

      if (fallback) {
        // Límite alcanzado o servicio no disponible. No es un error que deba verse: se
        // devuelve la señal para que el decorador atienda con el banco de preguntas.
        return { ...degradedReply(), fallback };
      }

      if (error instanceof HttpError) {
        console.error(`❌ [AI proxy] ${error.message}`, error.status ? `status=${error.status}` : "");
      } else {
        console.error("❌ [AI proxy] Error inesperado:", error?.message);
      }

      // Un fallo de transporte también se atiende con el catálogo local, pero sin
      // suspender al proveedor: puede ser un corte momentáneo de red del ciudadano.
      return { ...degradedReply(), fallback: { reason: "transport", retryAfterSeconds: 0 } };
    }
  }
});
