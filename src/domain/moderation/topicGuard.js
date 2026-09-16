/**
 * Guardia de alcance tematico. Capa de dominio, funcion pura.
 *
 * Decide si un mensaje merece una llamada a la IA. Cada llamada arrastra el prompt de
 * sistema, el bloque de FAQ y el contexto de pagina, asi que una consulta fuera del
 * ambito municipal cuesta lo mismo que una legitima.
 *
 * Bloquea SOLO ante evidencia de que la consulta es ajena. El reves —exigir prueba de
 * que es municipal— se probo y dejaba fuera consultas legitimas: los asuntos de una
 * alcaldia no caben en una lista de palabras. Ver docs/MANUAL.md.
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
  FOLLOW_UP: "follow_up",
  OFF_TOPIC_TERM: "off_topic_term",
  TRIVIA_QUESTION: "trivia_question",
  NO_OFF_TOPIC_SIGNAL: "no_off_topic_signal"
});

/** Tope de palabras que se consideran de un mensaje, como freno de coste de CPU. */
const MAX_WORDS = 120;

/** Longitud maxima para tratar un mensaje como continuacion de la conversacion. */
export const FOLLOW_UP_WORD_LIMIT = 5;

/**
 * Vocabulario de la administracion municipal. No es la definicion de lo municipal
 * —seria imposible— sino un atajo: lo que caiga aqui se aprueba sin mas analisis.
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
  "cita", "turno", "horario", "plazo", "ventanilla unica", "neptuno", "escritura", "notaria",
  // Tributario
  "impuesto", "predial", "ica", "reteica", "rit", "factura", "recibo", "pago", "pagar",
  "deuda", "mora", "intereses", "descuento", "declaracion", "contribuyente", "tesoreria",
  "hacienda", "tarifa", "liquidacion", "acuerdo de pago", "industria y comercio", "retencion",
  // Programas sociales
  "sisben", "subsidio", "programa", "programas", "adulto", "adultos", "discapacidad",
  "victima", "familias en accion", "puntaje", "encuesta",
  // Servicios e infraestructura
  "alumbrado", "luminaria", "bache", "pavimento", "anden", "acueducto", "alcantarillado",
  "basura", "aseo", "residuos", "escombros", "poda", "arborizacion", "parque", "semaforo",
  "senalizacion", "obra", "construccion", "curaduria", "espacio publico", "invasion",
  "ruido", "contaminacion", "ambiental", "mascota", "zoonosis", "esterilizacion",
  "inundacion", "inundo", "lluvia", "arroyo",
  // Seguridad y convivencia
  "policia", "comisaria", "inspeccion", "convivencia", "vecino", "seguridad", "bomberos",
  "emergencia", "gestion del riesgo", "riesgo",
  // Movilidad
  "transito", "movilidad", "multa", "comparendo", "fotomulta", "conduccion", "vehiculo",
  "grua", "parqueo", "transporte", "prescripcion", "pico y placa",
  // Salud, educacion, cultura y deporte
  "salud", "hospital", "vacunacion", "colegio", "institucion educativa", "docente", "beca",
  "biblioteca", "cultura", "turismo", "deporte", "escenario deportivo", "obleas", "cupo",
  // Empleo y economia
  "empleo", "vacante", "hoja de vida", "emprendimiento", "camara de comercio", "negocio",
  // Marco normativo
  "ley", "decreto", "resolucion", "acuerdo municipal", "normativa", "cedula"
]);

/**
 * Temas inequivocamente ajenos al municipio. Se comparan de forma exacta: un bloqueo
 * equivocado es peor que una llamada de mas.
 */
export const OFF_TOPIC_LEXICON = Object.freeze([
  "futbol", "mundial", "nba", "champions", "seleccion colombia", "partido de anoche",
  "pelicula", "peliculas", "serie", "netflix", "anime", "videojuego", "minecraft",
  "cancion", "canciones", "poema", "poesia", "ensayo", "chiste", "chistes",
  "horoscopo", "zodiaco", "tarot",
  "receta", "recetas", "cocinar", "reposteria",
  "programar", "codigo fuente", "python", "javascript", "algoritmo", "ecuacion",
  "derivada", "integral", "tarea del colegio", "haz mi tarea",
  "bitcoin", "criptomoneda", "trading", "forex",
  "traduce", "traduceme", "traducir",
  "gato", "perro mas", "dinosaurio", "planeta", "sistema solar", "universo"
]);

/**
 * Forma de pregunta de cultura general. Es lo que distingue "¿cuál es el gato más grande
 * del mundo?" de "¿cuál es el trámite para un certificado?": la primera pregunta por un
 * hecho del mundo, no por algo que la Alcaldía resuelva.
 */
export const TRIVIA_PATTERNS = Object.freeze([
  /\bmas\s+\w+\s+(del|de la)\s+(mundo|universo|planeta|historia|pais|galaxia)\b/,
  /\bcual\s+(es|era|fue)\s+(el|la|los|las)\s+\w+\s+mas\s+\w+/,
  /\b(quien|quienes)\s+(invento|inventaron|descubrio|descubrieron|creo|crearon|escribio|escribieron|pinto|compuso|fundo|gano|ganaron)\b/,
  /\bcapital\s+de\s+\w+/,
  /\bcuantos?\s+(habitantes|kilometros|planetas|paises|continentes|especies)\b/,
  /\ben\s+que\s+ano\s+(se\s+)?(invento|descubrio|nacio|murio|ocurrio|fundo\s+el\s+mundo)\b/
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
 * Politica: se permite salvo que haya evidencia de lo contrario. Un bloqueo equivocado
 * deja a un ciudadano sin respuesta; una llamada de mas cuesta unos tokens.
 *
 * @param {string} text
 * @param {Object} [opts]
 * @param {boolean} [opts.enabled]
 * @param {import("../faq/faqMatcher.js").FaqItem[]} [opts.faqCatalog]
 * @param {Record<string, string[]>|null} [opts.routingMap]
 * @param {string[]} [opts.allowKeywords] Vocabulario adicional del tenant.
 * @param {string[]} [opts.blockKeywords] Temas vetados adicionales del tenant.
 * @param {string|null} [opts.activeContext] Intencion en curso, si la hay.
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
    activeContext = null
  } = {}
) => {
  if (!enabled) return { allowed: true, reason: TOPIC_REASONS.DISABLED };

  const normalized = normalizeForMatching(text);
  if (!normalized) return { allowed: true, reason: TOPIC_REASONS.EMPTY };

  const words = normalized.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);

  // 1. Señal municipal directa: aprueba sin más análisis.
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

  // 2. Tema vetado: ni siquiera dentro de una conversación abierta.
  if (matchesExactTerm(normalized, words, [...OFF_TOPIC_LEXICON, ...blockKeywords])) {
    return { allowed: false, reason: TOPIC_REASONS.OFF_TOPIC_TERM };
  }

  // 3. Forma de pregunta de cultura general. Una continuación corta de un tema abierto
  //    se salva: "¿y cuál es la más alta?" sobre el predial es una repregunta legítima.
  if (TRIVIA_PATTERNS.some((pattern) => pattern.test(normalized))) {
    if (activeContext && words.length <= FOLLOW_UP_WORD_LIMIT) {
      return { allowed: true, reason: TOPIC_REASONS.FOLLOW_UP };
    }
    return { allowed: false, reason: TOPIC_REASONS.TRIVIA_QUESTION };
  }

  // 4. Sin evidencia de que sea ajena: pasa. Los asuntos de una alcaldía son demasiados
  //    para exigirle a cada consulta que demuestre serlo.
  return { allowed: true, reason: TOPIC_REASONS.NO_OFF_TOPIC_SIGNAL };
};
