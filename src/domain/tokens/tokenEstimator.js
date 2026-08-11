/**
 * Estimación de consumo de tokens. Capa de dominio.
 *
 * Extraído de `services/gemini.js`, donde el cálculo estaba entremezclado con el
 * cliente HTTP.
 *
 * Advertencia sobre la métrica: es una APROXIMACIÓN por longitud de caracteres
 * (~4 caracteres por token), no el conteo real que reporta la API. Gemini devuelve
 * `usageMetadata` con las cifras exactas; mientras no se lea ese campo, los números
 * de la consola son indicativos y no deben usarse para facturación ni para reportes
 * de ahorro presentados como reales.
 *
 * `savedTokens` es especialmente frágil: era `150 - completionTokens`, es decir la
 * diferencia contra un presupuesto hipotético de 150 tokens. Podía dar negativo y se
 * sumaba tal cual al acumulado, de modo que una respuesta larga RESTABA del "ahorro
 * total". Se acota a cero.
 */

/** Caracteres por token, aproximación para español. */
const CHARS_PER_TOKEN = 4;

/** Sobrecoste fijo estimado del system prompt e instrucciones. */
const SYSTEM_OVERHEAD_TOKENS = 120;

/** Presupuesto de referencia contra el que se calcula el "ahorro". */
const BASELINE_COMPLETION_TOKENS = 150;

/**
 * Estima los tokens de un texto.
 * @param {unknown} text
 * @returns {number}
 */
export const estimateTokens = (text) =>
  typeof text === "string" ? Math.floor(text.length / CHARS_PER_TOKEN) : 0;

/**
 * Estima el consumo de una interacción completa contra la API.
 *
 * @param {{ sender: string, text: string }[]} history
 * @param {string} replyText
 * @returns {{ tokensUsed: number, savedTokens: number, isEstimate: true }}
 */
export const estimateApiUsage = (history, replyText) => {
  const historyChars = (Array.isArray(history) ? history : []).reduce(
    (acc, m) => acc + (typeof m?.text === "string" ? m.text.length : 0),
    0
  );
  const promptTokens = Math.floor(historyChars / CHARS_PER_TOKEN) + SYSTEM_OVERHEAD_TOKENS;
  const completionTokens = estimateTokens(replyText);

  return {
    tokensUsed: promptTokens + completionTokens,
    // Nunca negativo: una respuesta más larga que el presupuesto significa
    // ahorro cero, no ahorro negativo.
    savedTokens: Math.max(0, BASELINE_COMPLETION_TOKENS - completionTokens),
    isEstimate: true
  };
};

/**
 * Consumo de una respuesta atendida localmente (sin llamar a la API).
 * El "ahorro" aquí sí es real en el sentido de que no se gastó cuota remota.
 *
 * @param {string} replyText
 * @returns {{ tokensUsed: number, savedTokens: number, isEstimate: true }}
 */
export const estimateLocalUsage = (replyText) => {
  const completionTokens = estimateTokens(replyText);
  return {
    tokensUsed: 40 + completionTokens,
    savedTokens: 120,
    isEstimate: true
  };
};

/**
 * Lee el consumo REAL desde la respuesta de la API si está disponible.
 * Se prefiere siempre sobre la estimación.
 *
 * @param {Object} apiResponse Cuerpo JSON devuelto por Gemini.
 * @returns {{ tokensUsed: number, savedTokens: number, isEstimate: false }|null}
 */
export const readActualUsage = (apiResponse) => {
  const usage = apiResponse?.usageMetadata;
  if (!usage) return null;

  const prompt = Number(usage.promptTokenCount) || 0;
  const completion = Number(usage.candidatesTokenCount) || 0;
  const total = Number(usage.totalTokenCount) || prompt + completion;
  if (total <= 0) return null;

  return {
    tokensUsed: total,
    savedTokens: Math.max(0, BASELINE_COMPLETION_TOKENS - completion),
    isEstimate: false
  };
};
