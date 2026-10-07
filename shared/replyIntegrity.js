/** No confundir puntuación final con cobertura. Estos son detectores conservadores. */
export const readCandidate = (data) => {
  const candidate = data?.candidates?.[0];
  return { text: (candidate?.content?.parts || []).filter(p => !p.thought && typeof p.text === 'string')
    .map(p => p.text).join('\n').trim(), finishReason: candidate?.finishReason || 'UNKNOWN',
    blockReason: data?.promptFeedback?.blockReason || null };
};
export const validateReply = ({ text, finishReason, blockReason }, question = '') => {
  if (blockReason || ['SAFETY', 'SPII', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(finishReason)) return 'blocked';
  if (!text) return 'empty';
  if (!['STOP', 'UNKNOWN'].includes(finishReason)) return finishReason === 'MAX_TOKENS' ? 'truncated' : 'interrupted';
  if (/(?:\b(?:de|del|la|el|los|las|sus|tus|con|para|y|o|por)|[:,;])\s*$/i.test(text)) return 'incomplete';
  if ((text.match(/\*\*/g) || []).length % 2 || (text.match(/\]\(/g) || []).length > (text.match(/\]\([^\n]*?\)/g) || []).length) return 'incomplete';
  if (/documentos|requisitos/i.test(question) && /beneficios/i.test(question) &&
    !(/documentos|requisitos|solicitud/i.test(text) && /beneficio|cuotas|plazo|facilidad|descuento|no.*confirm|sin.*confirm/i.test(text))) return 'missing_components';
  if (/^(?:para (?:conocer|obtener|saber).{0,90})?(?:te (?:recomiendo|sugiero)|consulta|contacta|ac[eé]rcate)/i.test(text) && text.length < 400) return 'referral_only';
  return null;
};
export const COMPLETE_FALLBACK = 'No pude completar una respuesta verificada en este momento. Puedes volver a intentarlo; no tengo un resultado confirmado para esta consulta.';
export const sumUsage = (items) => items.reduce((total, item) => {
  for (const [key, value] of Object.entries(item || {})) if (typeof value === 'number') total[key] = (total[key] || 0) + value;
  return total;
}, {});
