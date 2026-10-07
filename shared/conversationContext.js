/** Estado derivado del historial: el navegador no puede imponer el tema al servidor. */
export const normalize = (value) => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const TOPICS = [
  ['reteica', /\breteica\b|retencion.*industria/],
  ['ica', /\bica\b|industria\s+y\s+comercio/],
  ['predial', /\bpredial\b|\bcatastro\b|\bcatastral\b/],
  ['sisben', /\bsisben\b/],
  ['pqrsd', /\bpqrsd?\b|\bradicado\b/]
];
const ASPECTS = [
  ['calendario tributario vencimientos fechas', /calendario|vencimiento|\bfechas?\b|cuando.*declar/],
  ['acuerdo de pago requisitos documentos beneficios', /acuerdo de pago|facilidad de pago/],
  ['sancion no declarar', /no declar|sin declar/],
  ['sancion extemporaneidad', /extempor|declar.*tarde/],
  ['sancion inexactitud', /inexact/],
  ['sancion', /sanci[oó]?n|\bmultas?\b/],
  ['tarifas', /tarifa|por mil|milaje/]
];
export const topicIn = (text) => TOPICS.find(([, re]) => re.test(normalize(text)))?.[0] || null;

export const resolveConversationContext = (turns = [], hints = {}) => {
  let topic = TOPICS.some(([name]) => name === hints?.topic) ? hints.topic : null;
  let aspect = ASPECTS.some(([name]) => name === hints?.aspect) ? hints.aspect : null;
  let year = Number.isInteger(hints?.year) && hints.year >= 2000 && hints.year <= 2100 ? hints.year : null;
  const userTurns = turns.filter(t => (t.role === 'user' || t.sender === 'user') &&
    !String(t.text || t.parts?.[0]?.text || '').includes('<<<DATOS_NO_CONFIABLES_DE_LA_PAGINA>>>')).slice(-20);
  for (const turn of userTurns) {
    const text = normalize(turn.text || turn.parts?.[0]?.text || '').slice(0, 1000);
    const nextTopic = topicIn(text);
    const nextAspect = ASPECTS.find(([, re]) => re.test(text))?.[0];
    const explicitYear = text.match(/\b(20\d{2})\b/)?.[1];
    if (nextTopic && nextTopic !== topic) {
      // Una petición autónoma cambia el tema; «y de ICA» conserva el aspecto anterior.
      if (text.split(/\s+/).length > 5 && !/^y\b/.test(text)) { aspect = null; year = null; }
      topic = nextTopic;
    }
    if (nextAspect) {
      if (aspect?.includes('calendario') && !nextAspect.includes('calendario') && !explicitYear) year = null;
      aspect = nextAspect;
    }
    if (explicitYear) year = Number(explicitYear);
  }
  const current = userTurns.at(-1);
  const currentText = String(current?.text || current?.parts?.[0]?.text || '').slice(0, 1000);
  const wantsCurrentUvt = /(?:valor|cuanto).*uvt|uvt.*(?:valor|pesos|20\d{2})/.test(normalize(currentText));
  if (!year && (aspect?.includes('calendario') || wantsCurrentUvt)) year = Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'America/Bogota' }).format(new Date()));
  const query = [currentText, topic, aspect, year].filter(Boolean).join(' ');
  return { topic, year, aspect, query, currentText,
    needsSanctionType: aspect === 'sancion' && (topic === 'ica' || topic === 'reteica'),
    needsFreshSource: /calendario|acuerdo de pago/.test(aspect || '') || wantsCurrentUvt || /\b(enlace|link|url|documentos?|horarios?|vigente|descuentos?|beneficios?)\b/.test(normalize(currentText)) };
};

/** Solo vocabulario público de la consulta: nunca nombres, NIT, correo ni historial. */
export const publicSearchQuery = (context, municipality = 'Floridablanca') => {
  const clean = normalize(context.currentText);
  const terms = ['esterilizacion', 'vacunacion', 'turismo', 'sisben', 'requisitos', 'documentos',
    'beneficios', 'horario', 'basura', 'alumbrado', 'licencia', 'tramite', 'estatuto tributario',
    'sancion', 'declaracion', 'uvt', 'rit', 'pago', 'subsidio', 'transito', 'biblioteca', 'comisaria', 'adulto mayor', 'salud', 'educacion', 'encuesta', 'cultura', 'deporte', 'bache', 'residuos', 'pico y placa', 'permiso', 'empleo', 'vacante', 'mascota', 'ambiental'];
  return [municipality, context.topic, context.aspect, context.year,
    ...terms.filter(term => clean.includes(term))].filter(Boolean).join(' ').slice(0, 300);
};
