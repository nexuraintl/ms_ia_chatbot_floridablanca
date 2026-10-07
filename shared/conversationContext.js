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
  ['sancion no declarar', /no declar|sin declar|(?:no|sin)\s+(?:haber\s+)?present\w*\b.{0,45}\bdeclaracion\b/],
  ['sancion extemporaneidad', /extempor|(?:declar|present).*tarde|declaracion.*fuera.*plazo/],
  ['sancion inexactitud', /inexact/],
  ['sancion', /sanci[oó]?n|\bmultas?\b/],
  ['tarifas', /tarifa|por mil|milaje/]
];
export const topicIn = (text) => TOPICS.find(([, re]) => re.test(normalize(text)))?.[0] || null;
export const SANCTION_TYPE_QUESTION = "¿Te refieres a la sanción por declarar tarde (extemporaneidad), por no presentar la declaración o por inexactitud? El porcentaje depende del tipo de sanción; dime cuál aplica a tu caso para revisar la regla del ICA.";

/** Respuestas abreviadas a la aclaración ya pendiente, sin volver a pedir el dato. */
const sanctionChoice = (text, aspect) => {
  if (aspect !== 'sancion') return null;
  const choice = text.trim().replace(/[.!?¿¡]+$/g, '').trim();
  if (/^(?:la\s+)?(?:primera|1|opcion\s+1)(?:\s+opcion)?$/.test(choice) ||
      /\btarde\b|fuera (?:del? )?plazo/.test(choice)) return 'sancion extemporaneidad';
  if (/^(?:la\s+)?(?:segunda|2|opcion\s+2)(?:\s+opcion)?$/.test(choice) ||
      /\bomision\b|(?:no|sin)\s+(?:la\s+)?(?:he\s+|haber\s+)?present\w*\b/.test(choice)) return 'sancion no declarar';
  if (/^(?:la\s+)?(?:tercera|3|opcion\s+3)(?:\s+opcion)?$/.test(choice) ||
      /\binexactitud\b|datos incorrectos|errores en (?:la )?declaracion/.test(choice)) return 'sancion inexactitud';
  return null;
};
const isTopicSubstitution = text => /^(?:y\s+)?(?:(?:de|del|para|sobre|en)\s+)?(?:(?:el|la)\s+)?(?:ica|reteica|predial|industria\s+y\s+comercio)[?.!]*$/.test(text.trim());

export const resolveConversationContext = (turns = [], hints = {}) => {
  let topic = TOPICS.some(([name]) => name === hints?.topic) ? hints.topic : null;
  let aspect = ASPECTS.some(([name]) => name === hints?.aspect) ? hints.aspect : null;
  let year = Number.isInteger(hints?.year) && hints.year >= 2000 && hints.year <= 2100 ? hints.year : null;
  const userTurns = turns.filter(t => (t.role === 'user' || t.sender === 'user') &&
    !String(t.text || t.parts?.[0]?.text || '').includes('<<<DATOS_NO_CONFIABLES_DE_LA_PAGINA>>>')).slice(-20);
  for (const turn of userTurns) {
    const text = normalize(turn.text || turn.parts?.[0]?.text || '').slice(0, 1000);
    const nextTopic = topicIn(text);
    let nextAspect = ASPECTS.find(([, re]) => re.test(text))?.[0];
    const explicitYear = text.match(/\b(20\d{2})\b/)?.[1];
    if (nextTopic && nextTopic !== topic) {
      // Una petición autónoma cambia el tema; «y de ICA» conserva el aspecto anterior.
      if (!isTopicSubstitution(text)) { aspect = null; year = null; }
      topic = nextTopic;
    }
    if (/^(?:que es|que significa|en que consiste|que actividades|cuales son las actividades)\b/.test(text)) { aspect = null; year = null; }
    nextAspect = sanctionChoice(text, aspect) || nextAspect;
    if (nextAspect) {
      if (aspect?.includes('calendario') && !nextAspect.includes('calendario') && !explicitYear) year = null;
      // «¿Y el porcentaje de esa sanción?» mantiene el tipo ya aclarado.
      if (!(nextAspect === 'sancion' && aspect?.startsWith('sancion ') && !/otra sancion|otro tipo|cambiar.*sancion/.test(text))) aspect = nextAspect;
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
