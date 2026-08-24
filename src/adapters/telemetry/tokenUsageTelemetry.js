/**
 * Telemetría de consumo de tokens. Capa de adaptadores.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARREGLO DE FUGA DE DATOS PERSONALES
 *
 * La versión anterior enviaba el mensaje del ciudadano EN CLARO:
 *
 *     await fetch("/api/log-tokens", { body: JSON.stringify({ prompt, used, saved }) })
 *
 * y el plugin de Vite lo escribía tal cual en `token_usage.log`. Si alguien escribía
 * "mi cédula es 1098765432 y mi celular 3101234567", eso quedaba persistido en disco
 * sin enmascarar. Las funciones `maskEmail`/`maskPhone`/`maskIdentification` ya
 * existían en el proyecto, pero solo se aplicaban al render de la consola —es decir,
 * a lo que se ve, no a lo que se guarda.
 *
 * Para un proyecto de una alcaldía eso es un incumplimiento de la Ley 1581 de 2012
 * (Habeas Data): se está tratando y almacenando un dato sensible sin necesidad ni
 * base de conservación.
 *
 * Ahora la redacción se aplica en este BORDE DE SALIDA, antes de que el dato salga del
 * navegador, y el registro no es imprescindible: si falla, no rompe la conversación.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { redactPII } from "../../domain/security/piiRedactor.js";
import { sanitizeLogString } from "../../domain/security/textSanitizer.js";

/** Tope de longitud del prompt registrado. */
const MAX_LOGGED_PROMPT = 200;

/** Timeout corto: la telemetría nunca debe retrasar la respuesta al ciudadano. */
const TELEMETRY_TIMEOUT_MS = 3000;

/**
 * Crea el cliente de telemetría.
 *
 * @param {Object} [deps]
 * @param {string} [deps.endpoint]
 * @param {boolean} [deps.enabled]  Permite desactivarla por completo en producción.
 * @returns {{ record: (entry: {prompt: string, used: number, saved: number}) => Promise<void> }}
 */
export const createTokenUsageTelemetry = ({
  endpoint = "/api/log-tokens",
  enabled = true
} = {}) => ({
  /**
   * Registra el consumo de una interacción, con el prompt ya redactado.
   *
   * @param {{ prompt: string, used: number, saved: number }} entry
   */
  async record({ prompt, used, saved }) {
    if (!enabled) return;

    // Redactar ANTES de serializar. El orden importa: primero se quita la PII,
    // luego se aplana a una línea, luego se recorta.
    const safePrompt = sanitizeLogString(redactPII(String(prompt || "")), MAX_LOGGED_PROMPT);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);

    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: safePrompt,
          used: Math.max(0, Number(used) || 0),
          saved: Math.max(0, Number(saved) || 0)
        }),
        signal: controller.signal
      });
    } catch {
      // La telemetría es accesoria: un fallo aquí no debe alterar la conversación
      // ni generar ruido en la consola del ciudadano.
    } finally {
      clearTimeout(timer);
    }
  }
});

/**
 * Telemetría inerte, para pruebas o para desactivar el registro sin ramificar el
 * código que la consume (patrón objeto nulo — evita `if (telemetry)` en la aplicación).
 */
export const nullTelemetry = {
  async record() {
    /* no-op */
  }
};
