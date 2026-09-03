/**
 * Recuperacion lexica sobre el corpus del Estatuto (BM25). Funciones puras.
 *
 * BM25 y no embeddings a proposito: el vocabulario de una consulta tributaria coincide
 * literalmente con el del Estatuto ("predial", "reteica", "paz y salvo"), no hay coste
 * por consulta y no sale texto del ciudadano hacia un servicio de terceros. Si mas
 * adelante hacen falta embeddings, se sustituye este modulo sin tocar el resto.
 */

/** Parametros estandar de BM25. */
const K1 = 1.2;
const B = 0.75;

/** Peso de cada campo al indexar: el epigrafe describe el tema mejor que el cuerpo. */
const FIELD_WEIGHTS = { epigrafe: 3, tema: 2, texto: 1 };

/** Empujon para el fragmento cuyo numero de articulo cita la consulta. */
const ARTICLE_MATCH_BOOST = 12;

/**
 * Ventaja de las respuestas curadas sobre el articulado.
 *
 * Ante la misma consulta, BM25 prefiere el articulo que repite mas veces el termino: para
 * "¿qué es la UVT?" gana una tabla de tarifas llena de "UVT" y no la respuesta escrita
 * para explicarlo. Una respuesta curada esta redactada en el lenguaje del ciudadano y fue
 * revisada por la entidad, asi que en empate debe ganar.
 */
const CURATED_BOOST = 1.4;

/**
 * Fraccion maxima del corpus en la que puede aparecer un termino para considerarlo
 * especifico. Un resultado que solo casa por terminos genericos ("dias", "termino") no
 * es una coincidencia de contenido: es lo que hace que un saludo recupere articulos.
 */
const SPECIFIC_TERM_MAX_RATIO = 0.15;

/**
 * Numero de terminos a partir del cual se exige que al menos uno sea especifico.
 *
 * Con una o dos palabras la consulta ES el termino ("¿qué es la UVT?" deja solo "uvt",
 * que aparece en todo el Estatuto y por tanto no es especifico): exigir especificidad ahi
 * dejaria sin respuesta una pregunta legitima. Con tres o mas palabras si hay senal
 * suficiente para descartar la coincidencia por vocabulario generico.
 */
const SPECIFICITY_MIN_TERMS = 3;

/**
 * Articulos citados en la consulta. El plural es la senal de enumeracion: con
 * "articulos 106 y 107" se toman los dos, mientras que en "articulo 33 y 5 por mil" el
 * 5 no es un articulo y no debe fijarse.
 */
const ARTICLE_QUERY_RE = /art[íi]?c?u?l?o?(s?)\s*(\d{1,3}(?:\s*(?:,|y|e)\s*\d{1,3})*)/gi;

/**
 * @param {string} query
 * @returns {Set<number>}
 */
export const citedArticles = (query) => {
  const found = new Set();
  for (const match of String(query || "").matchAll(ARTICLE_QUERY_RE)) {
    const numbers = match[2].split(/[^\d]+/).filter((part) => part !== "").map(Number);
    for (const numero of match[1] ? numbers : numbers.slice(0, 1)) found.add(numero);
  }
  return found;
};

const STOPWORDS = new Set([
  "a", "al", "algo", "algun", "alguna", "algunas", "alguno", "algunos", "ante", "antes",
  "como", "con", "contra", "cual", "cuales", "cuando", "de", "del", "desde", "donde",
  "dos", "el", "ella", "ellas", "ellos", "en", "entre", "era", "es", "esa", "esas",
  "ese", "eso", "esos", "esta", "estan", "estas", "este", "esto", "estos", "ha", "hace",
  "hasta", "hay", "la", "las", "le", "les", "lo", "los", "mas", "me", "mi", "mis", "mucho",
  "muy", "no", "nos", "o", "otra", "otras", "otro", "otros", "para", "pero", "poco", "por",
  "porque", "que", "quien", "se", "segun", "ser", "si", "sin", "sobre", "solo", "son",
  "su", "sus", "tambien", "tan", "te", "tiene", "todo", "todos", "tu", "un", "una",
  "unas", "uno", "unos", "y", "ya", "yo",
  // Cortesia: no tienen significado tributario, y sin ellas un saludo no recupera nada.
  // No se incluyen palabras que el Estatuto sí usa, como "dia", "tarde" o "favor".
  "hola", "gracias", "buenas", "buenos", "buena", "bueno", "saludos", "saludo",
  "chao", "adios", "bienvenido", "bienvenida", "noche", "noches"
]);

/** Longitud minima de un termino indexable. Las siglas cortas del dominio se salvan. */
const MIN_TERM_LENGTH = 3;
const SHORT_TERMS_KEPT = new Set(["ica", "rit", "uvt", "pot", "iva", "nit"]);

/**
 * Reduce el plural castellano al singular.
 *
 * Sin esto, "tarifas" y "tarifa" son terminos distintos para BM25: el ciudadano pregunta
 * por "las tarifas" y el fragmento que las trae dice "la tarifa", y no casan. No pretende
 * ser correcto linguisticamente —"analisis" queda en "analisi"—, sino CONSISTENTE: la
 * misma regla se aplica a la consulta y al corpus, asi que la coincidencia se produce
 * aunque la raiz resultante no sea una palabra.
 *
 * @param {string} term
 * @returns {string}
 */
const singularize = (term) => {
  if (term.length >= 5 && term.endsWith("es")) return term.slice(0, -2);
  if (term.length >= 4 && term.endsWith("s")) return term.slice(0, -1);
  return term;
};

/**
 * Normaliza y parte en terminos. Sin tildes para que "declaracion" case con "declaración",
 * y en singular para que "tarifas" case con "tarifa".
 *
 * @param {string} text
 * @returns {string[]}
 */
export const tokenize = (text) =>
  String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9ñ]+/g, " ")
    .split(" ")
    .filter((term) => term !== "")
    // Las palabras vacias se descartan ANTES de singularizar: "los" y "las" están en la
    // lista tal cual, y reducirlos a "lo"/"la" los dejaría pasar.
    .filter((term) => !STOPWORDS.has(term))
    .filter((term) => term.length >= MIN_TERM_LENGTH || SHORT_TERMS_KEPT.has(term))
    .map((term) => (SHORT_TERMS_KEPT.has(term) ? term : singularize(term)))
    .filter((term) => !STOPWORDS.has(term));

/**
 * Terminos de un fragmento, con los campos ponderados por repeticion.
 * @param {Object} chunk
 */
const chunkTerms = (chunk) => {
  const terms = [];
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const fieldTerms = tokenize(chunk[field]);
    for (let repeat = 0; repeat < weight; repeat += 1) terms.push(...fieldTerms);
  }
  return terms;
};

/**
 * Construye el indice invertido. Se hace una vez por proceso.
 *
 * @param {Object[]} chunks
 * @returns {{docs: Object[], documentFrequency: Map<string, number>, averageLength: number, total: number}}
 */
export const buildIndex = (chunks) => {
  const docs = [];
  const documentFrequency = new Map();

  for (const chunk of chunks) {
    const terms = chunkTerms(chunk);
    const frequency = new Map();
    for (const term of terms) frequency.set(term, (frequency.get(term) || 0) + 1);
    for (const term of frequency.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
    docs.push({ chunk, frequency, length: terms.length });
  }

  const totalLength = docs.reduce((acc, doc) => acc + doc.length, 0);
  return {
    docs,
    documentFrequency,
    averageLength: docs.length > 0 ? totalLength / docs.length : 0,
    total: docs.length
  };
};

/**
 * Peso IDF de BM25, acotado por abajo para que un termino presente en casi todos los
 * fragmentos no aporte puntaje negativo.
 */
const inverseDocumentFrequency = (documentFrequency, total, term) => {
  const appearances = documentFrequency.get(term) || 0;
  if (appearances === 0) return 0;
  return Math.max(
    0.01,
    Math.log(1 + (total - appearances + 0.5) / (appearances + 0.5))
  );
};

/**
 * Busca los fragmentos mas afines a la consulta.
 *
 * @param {ReturnType<buildIndex>} index
 * @param {string} query
 * @param {Object} [options]
 * @param {number} [options.limit]
 * @param {number} [options.minScore]
 * @param {Set<string>} [options.candidates]  Restringe la busqueda a estos fragmentos.
 * @param {boolean} [options.enforceSpecificity]  Exigir un termino especifico. Se apaga al
 *   reordenar un conjunto ya acotado por tema: ahi la barrera descartaria todo.
 * @returns {{chunk: Object, score: number}[]}
 */
export const search = (
  index,
  query,
  { limit = 4, minScore = 0.5, candidates = null, enforceSpecificity = true } = {}
) => {
  if (!index || index.total === 0) return [];

  const terms = tokenize(query);
  const pinnedArticles = citedArticles(query);
  if (terms.length === 0 && pinnedArticles.size === 0) return [];

  const specificLimit = index.total * SPECIFIC_TERM_MAX_RATIO;
  const requireSpecific = enforceSpecificity && terms.length >= SPECIFICITY_MIN_TERMS;

  const scored = [];
  for (const doc of index.docs) {
    if (candidates && !candidates.has(doc.chunk.id)) continue;
    let score = 0;
    let hasSpecificMatch = false;
    for (const term of terms) {
      const termFrequency = doc.frequency.get(term);
      if (!termFrequency) continue;
      if ((index.documentFrequency.get(term) || 0) <= specificLimit) hasSpecificMatch = true;
      const idf = inverseDocumentFrequency(index.documentFrequency, index.total, term);
      const normalization =
        termFrequency +
        K1 * (1 - B + (B * doc.length) / (index.averageLength || 1));
      score += (idf * termFrequency * (K1 + 1)) / normalization;
    }

    if (doc.chunk.confianza === "curada") score *= CURATED_BOOST;

    // Citar un articulo por su numero es una peticion explicita, no una coincidencia, y
    // pide el texto de la norma: el empujon no se da a las preguntas curadas que lo citan.
    const isPinned = pinnedArticles.has(doc.chunk.articulo) && doc.chunk.tipo !== "faq";
    if (isPinned) score += ARTICLE_MATCH_BOOST;

    const passesGate = !requireSpecific || hasSpecificMatch || isPinned;
    if (score > 0 && passesGate) scored.push({ chunk: doc.chunk, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.filter((item) => item.score >= minScore).slice(0, limit);
};

/**
 * Bandas de confianza, calibradas contra este corpus (ver `docs/BASE_CONOCIMIENTO.md`).
 *
 * No hay umbral que separe limpiamente la charla de una consulta real: una pregunta
 * legitima de una sola palabra ("¿qué es la UVT?") puntua mas bajo que un saludo con
 * varias. Los dos errores no cuestan lo mismo: recuperar de mas en un saludo gasta unos
 * miles de caracteres, mientras que no recuperar en una pregunta real deja al ciudadano
 * sin la norma que la responde. Por eso el piso es bajo y lo que las bandas gradúan es
 * CUANTO contexto se envia, no si se envia.
 */
export const CONFIDENCE_BANDS = Object.freeze([
  { minScore: 8, limit: 4 },
  { minScore: 2, limit: 2 }
]);

/**
 * Fraccion de terminos de la consulta que el corpus conoce.
 *
 * Es la señal que distingue una consulta corta PERTINENTE de una de charla. "y de ICA?"
 * deja un solo termino, y el corpus lo conoce: cobertura 1. "qué tal el clima" deja dos y
 * el corpus solo conoce uno: cobertura 0,5. El puntaje de BM25 no las separa, porque una
 * consulta de un termino puntua bajo por corta, no por irrelevante.
 *
 * @param {ReturnType<buildIndex>} index
 * @param {string} query
 * @returns {number} entre 0 y 1
 */
export const queryCoverage = (index, query) => {
  const terms = tokenize(query);
  if (!index || terms.length === 0) return 0;
  const known = terms.filter((term) => (index.documentFrequency.get(term) || 0) > 0);
  return known.length / terms.length;
};

/** Cobertura desde la que la consulta se considera enteramente del dominio. */
export const FULL_COVERAGE_THRESHOLD = 0.8;

/**
 * Recorta los resultados segun la confianza del mejor.
 *
 * Con cobertura alta no se recorta por banda: el corpus conoce toda la pregunta, asi que
 * el puntaje bajo solo refleja que la consulta es corta. Recortar ahi a dos fragmentos
 * era lo que dejaba "y de ICA?" con el aspecto equivocado.
 *
 * @param {{chunk: Object, score: number}[]} results
 * @param {Object} [options]
 * @param {number} [options.coverage]  Cobertura de la consulta, si se conoce.
 * @returns {{chunk: Object, score: number}[]}
 */
export const selectByConfidence = (results, { coverage = 0 } = {}) => {
  if (!Array.isArray(results) || results.length === 0) return [];
  if (coverage >= FULL_COVERAGE_THRESHOLD) return results;

  const band = CONFIDENCE_BANDS.find((item) => results[0].score >= item.minScore);
  return band ? results.slice(0, band.limit) : [];
};
