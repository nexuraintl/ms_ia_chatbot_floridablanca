/**
 * Guardia de alcance tematico. Capa de dominio, funcion pura.
 *
 * Decide si un mensaje merece una llamada a la IA. Cada llamada arrastra el prompt de
 * sistema, el bloque de FAQ y el contexto de pagina, asi que una consulta fuera del
 * ambito municipal cuesta lo mismo que una legitima. Ver docs/MANUAL.md.
 */

import { normalizeForMatching } from "../security/textSanitizer.js";
import { containsFuzzyKeyword } from "../matching/fuzzyMatcher.js";
import { findBestFaq } from "../faq/faqMatcher.js";

/** Motivos de la decision. Se reportan a metricas, no al ciudadano. */
export const TOPIC_REASONS = Object.freeze({
  DISABLED: "disabled",
  EMPTY: "empty",
  MUNICIPAL_TERM: "municipal_term",
  ROUTING_KEYWORD: "routing_keyword",
  FAQ_MATCH: "faq_match",
  COURTESY: "courtesy",
  FOLLOW_UP: "follow_up",
  OFF_TOPIC_TERM: "off_topic_term",
  NO_MUNICIPAL_SIGNAL: "no_municipal_signal"
});

/** Tope de palabras que se consideran de un mensaje, como freno de coste de CPU. */
const MAX_WORDS = 120;

/** Longitud maxima para tratar un mensaje como continuacion de la conversacion. */
export const FOLLOW_UP_WORD_LIMIT = 5;

/**
 * Vocabulario de la administracion municipal. Se compara de forma difusa (tolera
 * erratas) porque un falso positivo aqui solo cuesta unos tokens, mientras que un
 * falso negativo deja a un ciudadano sin respuesta.
 */
export const MUNICIPAL_LEXICON = Object.freeze([
  // Entidad y gobierno
  "alcaldia", "alcalde", "municipio", "municipal", "gobernacion", "concejo", "secretaria",
  "dependencia", "funcionario", "entidad", "administracion", "despacho", "ventanilla",
  "gobierno", "ciudadano", "veeduria", "transparencia", "presupuesto", "contratacion",
  // Territorio
  "floridablanca", "santander", "bucaramanga", "barrio", "comuna", "vereda", "urbanizacion",
  "nomenclatura", "estrato", "predio", "catastro", "catastral", "avaluo", "metropolitana",
  // Tramites
  "tramite", "tramites", "formulario", "radicar", "radicado", "solicitud", "peticion",
  "queja", "reclamo", "sugerencia", "denuncia", "pqrsd", "pqrs", "certificado", "constancia",
  "paz y salvo", "licencia", "permiso", "matricula", "inscripcion", "requisitos", "notificacion",
  "cita", "turno", "horario", "plazo", "ventanilla unica", "neptuno",
  // Tributario
  "impuesto", "predial", "ica", "reteica", "rit", "factura", "recibo", "pago", "pagar",
  "deuda", "mora", "intereses", "descuento", "declaracion", "contribuyente", "tesoreria",
  "hacienda", "tarifa", "liquidacion", "acuerdo de pago", "industria y comercio", "retencion",
  // Programas sociales
  "sisben", "subsidio", "programa social", "adulto mayor", "discapacidad", "victima",
  "familias en accion", "puntaje", "encuesta",
  // Servicios e infraestructura
  "alumbrado", "luminaria", "bache", "pavimento", "anden", "acueducto", "alcantarillado",
  "basura", "aseo", "residuos", "escombros", "poda", "arborizacion", "parque", "semaforo",
  "senalizacion", "obra", "construccion", "curaduria", "espacio publico", "invasion",
  "ruido", "contaminacion", "ambiental", "mascota", "zoonosis", "esterilizacion",
  // Seguridad y convivencia
  "policia", "comisaria", "inspeccion", "convivencia", "vecino", "seguridad", "bomberos",
  "emergencia", "gestion del riesgo", "riesgo",
  // Movilidad
  "transito", "movilidad", "multa", "comparendo", "fotomulta", "conduccion", "vehiculo",
  "grua", "parqueo", "transporte", "prescripcion",
  // Salud, educacion, cultura y deporte
  "salud", "hospital", "vacunacion", "colegio", "institucion educativa", "docente", "beca",
  "biblioteca", "cultura", "turismo", "deporte", "escenario deportivo", "obleas",
  // Empleo y economia
  "empleo", "vacante", "hoja de vida", "emprendimiento", "camara de comercio", "negocio",
  // Marco normativo
  "ley", "decreto", "resolucion", "acuerdo municipal", "normativa"
]);

/**
 * Cortesia y preguntas sobre el propio asistente. Se permiten para que la conversacion
 * no se sienta hostil.
 */
export const COURTESY_LEXICON = Object.freeze([
  "hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "buen dia", "saludos",
  "gracias", "adios", "hasta luego", "chao", "listo", "vale", "perfecto", "entendido",
  "ayuda", "ayudame", "quien eres", "que puedes hacer", "que haces", "como funcionas"
]);

/**
 * Temas inequivocamente ajenos al municipio. Se comparan de forma exacta: un bloqueo
 * equivocado es peor que una llamada de mas.
 */
export const OFF_TOPIC_LEXICON = Object.freeze([
  "futbol", "mundial", "nba", "champions", "seleccion colombia",
  "pelicula", "peliculas", "serie", "netflix", "anime", "videojuego", "minecraft",
  "cancion", "canciones", "poema", "poesia", "ensayo", "chiste", "chistes",
  "horoscopo", "zodiaco", "tarot",
  "receta", "recetas", "cocinar", "reposteria",
  "programar", "codigo fuente", "python", "javascript", "algoritmo", "ecuacion",
  "derivada", "integral", "tarea del colegio", "haz mi tarea",
  "bitcoin", "criptomoneda", "trading", "forex",
  "mas grande del mundo", "mas pequeno del mundo", "mas rapido del mundo",
  "capital de francia", "capital de espana", "sistema solar", "dinosaurio",
  "traduce", "traduceme", "escribeme un", "hazme un poema", "cuentame un chiste"
]);

/**
 * Valores por defecto del guardia. `chatbotConfig.topicGuard` los sobrescribe.
 */
export const DEFAULT_TOPIC_GUARD = Object.freeze({
  enabled: true,
  message:
    "Soy el asistente de la Alcaldía de Floridablanca, así que solo puedo orientarte en " +
    "trámites, servicios e información del municipio. Cuéntame qué necesitas de la " +
    "Alcaldía y con gusto te ayudo.",
  allowKeywords: [],
  blockKeywords: []
});

/**
 * Resuelve la configuracion efectiva del guardia.
 *
 * @param {Object} [config] `chatbotConfig.json`
 * @returns {typeof DEFAULT_TOPIC_GUARD}
 */
export const resolveTopicGuardSettings = (config) => ({
  ...DEFAULT_TOPIC_GUARD,
  ...(config?.topicGuard || {})
});

/**
 * Coincidencia exacta: palabra completa, o frase consecutiva si el termino trae espacios.
 *
 * @param {string} normalizedText
 * @param {string[]} words
 * @param {string[]} terms
 * @returns {boolean}
 */
const matchesExactTerm = (normalizedText, words, terms) =>
  terms.some((term) => {
    const clean = normalizeForMatching(term);
    if (!clean) return false;
    return clean.includes(" ") ? normalizedText.includes(clean) : words.includes(clean);
  });

/**
 * @typedef {Object} TopicVerdict
 * @property {boolean} allowed
 * @property {string} reason Uno de `TOPIC_REASONS`.
 */

/**
 * Evalua si un mensaje pertenece al ambito de la Alcaldia.
 *
 * Politica: se permite ante cualquier senal municipal (lexico, ruta de tramite o FAQ),
 * ante cortesia y ante continuaciones cortas de una conversacion ya abierta. Sin ninguna
 * de esas senales se bloquea, para no pagar tokens por una consulta ajena.
 *
 * @param {string} text
 * @param {Object} [opts]
 * @param {boolean} [opts.enabled]
 * @param {import("../faq/faqMatcher.js").FaqItem[]} [opts.faqCatalog]
 * @param {Record<string, string[]>|null} [opts.routingMap]
 * @param {string[]} [opts.allowKeywords] Vocabulario adicional del tenant.
 * @param {string[]} [opts.blockKeywords] Temas vetados adicionales del tenant.
 * @param {string|null} [opts.activeContext] Intencion en curso, si la hay.
 * @param {boolean} [opts.hasPriorExchange] true si el ciudadano ya escribio antes.
 * @returns {TopicVerdict}
 */
export const evaluateTopic = (
  text,
  {
    enabled = true,
    faqCatalog = [],
    routingMap = null,
    allowKeywords = [],
    blockKeywords = [],
    activeContext = null,
    hasPriorExchange = false
  } = {}
) => {
  if (!enabled) return { allowed: true, reason: TOPIC_REASONS.DISABLED };

  const normalized = normalizeForMatching(text);
  if (!normalized) return { allowed: true, reason: TOPIC_REASONS.EMPTY };

  const words = normalized.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);

  // 1. Senal municipal directa. Se evalua primero para que un termino vetado dentro de
  //    una consulta legitima ("impuesto de mi mascota") no la bloquee.
  if (containsFuzzyKeyword(normalized, [...MUNICIPAL_LEXICON, ...allowKeywords])) {
    return { allowed: true, reason: TOPIC_REASONS.MUNICIPAL_TERM };
  }

  if (routingMap) {
    for (const keywords of Object.values(routingMap)) {
      if (containsFuzzyKeyword(normalized, keywords)) {
        return { allowed: true, reason: TOPIC_REASONS.ROUTING_KEYWORD };
      }
    }
  }

  if (findBestFaq(text, faqCatalog)) {
    return { allowed: true, reason: TOPIC_REASONS.FAQ_MATCH };
  }

  // 2. Tema vetado. Va antes de cortesia y continuacion para que un "y el gato?" tras
  //    una respuesta valida no se cuele como seguimiento.
  if (matchesExactTerm(normalized, words, [...OFF_TOPIC_LEXICON, ...blockKeywords])) {
    return { allowed: false, reason: TOPIC_REASONS.OFF_TOPIC_TERM };
  }

  if (containsFuzzyKeyword(normalized, COURTESY_LEXICON)) {
    return { allowed: true, reason: TOPIC_REASONS.COURTESY };
  }

  // 3. Continuacion corta de un tema ya abierto ("¿y cuánto cuesta?").
  if (words.length <= FOLLOW_UP_WORD_LIMIT && (activeContext || hasPriorExchange)) {
    return { allowed: true, reason: TOPIC_REASONS.FOLLOW_UP };
  }

  return { allowed: false, reason: TOPIC_REASONS.NO_MUNICIPAL_SIGNAL };
};
