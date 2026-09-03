/**
 * Fachada de la base de conocimiento. Es lo unico que el proxy necesita conocer.
 *
 * El indice se construye una vez por proceso, en la primera consulta. Con ~1.200
 * fragmentos la construccion es de milisegundos, asi que no vale la pena hacerlo en el
 * arranque y retrasar la primera respuesta de salud de Cloud Run.
 */

import { getCorpus } from "./corpusStore.js";
import { buildIndex, search, selectByConfidence, queryCoverage } from "./retriever.js";
import { buildSystemInstruction } from "./promptBuilder.js";

/** Cuantos fragmentos se envian como contexto. Cuatro caben en el presupuesto. */
const DEFAULT_TOP_K = 4;

let indexCache;

const getIndex = () => {
  if (indexCache !== undefined) return indexCache;
  const corpus = getCorpus();
  indexCache = corpus ? buildIndex(corpus.chunks) : null;
  return indexCache;
};

/** ¿Hay corpus cargado? Determina si el servidor arma el prompt o respeta el del cliente. */
export const isKnowledgeAvailable = () => getIndex() !== null;

/** Fragmentos que aporta el tema de la conversacion, ademas de los del mensaje actual. */
const CONTEXT_TOP_K = 2;

/**
 * Candidatos que se traen del mensaje actual antes de reordenar por el aspecto.
 *
 * Un mensaje de una palabra ("y de ICA?") deja a BM25 sin con qué distinguir: los doce
 * fragmentos de ICA puntuan casi igual (3,11 a 2,92). Cuál de ellos sirve lo dice el
 * mensaje ANTERIOR, que es el que trae el aspecto ("tarifas"). Asi que el mensaje actual
 * elige el TEMA y el anterior reordena DENTRO del tema.
 */
const TOPIC_CANDIDATES = 12;

/**
 * Instruccion de sistema para una consulta concreta.
 *
 * Se recupera dos veces y se une: primero por el mensaje actual y despues por el tema de
 * la conversacion. El orden importa porque es el que decide qué se conserva si el
 * presupuesto de caracteres no alcanza: lo que responde a lo que se acaba de preguntar.
 *
 * @param {Object} params
 * @param {string} params.query          Ultimo mensaje del ciudadano.
 * @param {string} [params.contextQuery]  Mensaje anterior, para sostener el tema.
 * @param {number} params.maxChars       Tope de caracteres del proxy.
 * @param {number} [params.topK]
 * @returns {{text: string, incluidos: string[], coincidencias: number}|null}
 */
export const buildKnowledgePrompt = ({ query, contextQuery = "", maxChars, topK = DEFAULT_TOP_K }) => {
  const index = getIndex();
  if (!index) return null;

  const hasContext = Boolean(contextQuery) && contextQuery !== query;

  // 1. El mensaje actual fija el tema.
  const candidates = search(index, query, { limit: TOPIC_CANDIDATES });

  // 2. El mensaje anterior reordena dentro de ese tema, sumando su puntaje al del tema.
  if (hasContext && candidates.length > 1) {
    const aspect = new Map(
      search(index, contextQuery, {
        limit: TOPIC_CANDIDATES,
        candidates: new Set(candidates.map((item) => item.chunk.id)),
        enforceSpecificity: false
      }).map((item) => [item.chunk.id, item.score])
    );
    if (aspect.size > 0) {
      for (const item of candidates) item.score += aspect.get(item.chunk.id) || 0;
      candidates.sort((a, b) => b.score - a.score);
    }
  }

  const fromCurrent = selectByConfidence(candidates.slice(0, topK), {
    coverage: queryCoverage(index, query)
  });

  // 3. Y ademas se traen los del tema anterior, para no perder el hilo.
  const fromContext = hasContext
    ? selectByConfidence(search(index, contextQuery, { limit: CONTEXT_TOP_K }))
    : [];

  const results = [];
  const seen = new Set();
  for (const item of [...fromCurrent, ...fromContext]) {
    if (seen.has(item.chunk.id)) continue;
    seen.add(item.chunk.id);
    results.push(item);
  }

  const instruction = buildSystemInstruction({ results, maxChars });
  return { ...instruction, coincidencias: results.length };
};

/** Reinicia el indice. Existe para las pruebas. */
export const resetKnowledgeCache = () => {
  indexCache = undefined;
};

export { search, buildIndex, citedArticles, queryCoverage } from "./retriever.js";
