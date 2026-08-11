/**
 * Emparejamiento de la consulta del ciudadano contra el catálogo de FAQs.
 * Capa de dominio: función pura, sin red, sin DOM. Testeable de forma aislada.
 *
 * ANTES: esta lógica estaba DUPLICADA en `services/gemini.js` —una copia en
 * `getFaqContext()` y otra dentro de `queryMockGemini()`— y las dos copias se habían
 * desincronizado:
 *
 *   · `getFaqContext`  usaba `cleanText.includes(raiz)`  -> "ica" casaba dentro de "indica"
 *   · `queryMockGemini` usaba `palabra === raiz || palabra.startsWith(raiz)` -> sin falsos positivos
 *
 * Se unifica en la segunda, que es la correcta: comparar contra los límites de palabra
 * evita que una raíz corta contamine cualquier término que la contenga.
 */

import { normalizeForMatching } from "../security/textSanitizer.js";

/** Longitud a partir de la cual se compara por raíz en lugar de palabra completa. */
const ROOT_LENGTH = 4;

/** Tope de longitud de la consulta considerada, como freno de coste de CPU. */
const MAX_QUERY_LENGTH = 1000;

/**
 * @typedef {Object} FaqItem
 * @property {string} categoria
 * @property {string} intencion
 * @property {string[]} palabras_clave
 * @property {Record<string, string>} respuestas_base
 */

/**
 * @typedef {Object} FaqMatch
 * @property {FaqItem} item
 * @property {number} score
 * @property {string} intencion
 */

/**
 * Puntúa una palabra clave (que puede ser una frase) contra el texto normalizado.
 *
 * @param {string} keyword
 * @param {string} normalizedText
 * @param {string[]} textWords
 * @returns {number}
 */
const scoreKeyword = (keyword, normalizedText, textWords) => {
  const cleanKeyword = normalizeForMatching(keyword);
  if (!cleanKeyword) return 0;

  const allWords = cleanKeyword.split(/\s+/).filter(Boolean);
  if (allWords.length === 0) return 0;

  if (allWords.length > 1) {
    // FRASE: la coincidencia por subcadena es segura porque una frase de varias
    // palabras no aparece por accidente dentro de otra palabra.
    if (normalizedText.includes(cleanKeyword)) return allWords.length * 2;
  } else if (textWords.includes(cleanKeyword)) {
    // PALABRA ÚNICA: se exige coincidencia con límite de palabra.
    //
    // Aquí estaba un falso positivo real: usar `normalizedText.includes()` para una
    // palabra suelta hacía que la clave "ica" casara dentro de "indica" o "aplica",
    // y consultas como "me indica cómo aplicar" se clasificaban como Impuesto ICA.
    return 2;
  }

  // Coincidencia por raíz: TODAS las palabras significativas deben aparecer.
  const significant = allWords.filter((w) => w.length > 2 || w === "ica" || w === "rit");
  if (significant.length === 0) return 0;

  const matched = significant.filter((kwWord) => {
    const root = kwWord.length <= ROOT_LENGTH ? kwWord : kwWord.substring(0, ROOT_LENGTH);
    return textWords.some((w) => w === root || w.startsWith(root));
  }).length;

  return matched === significant.length ? matched : 0;
};

/**
 * Encuentra la FAQ con mayor afinidad para una consulta.
 *
 * @param {string} query Texto del ciudadano (puede incluir contexto expandido).
 * @param {FaqItem[]} catalog
 * @returns {FaqMatch|null}
 */
export const findBestFaq = (query, catalog) => {
  if (!query || !Array.isArray(catalog) || catalog.length === 0) return null;

  const normalizedText = normalizeForMatching(String(query).substring(0, MAX_QUERY_LENGTH));
  if (!normalizedText) return null;
  const textWords = normalizedText.split(/\s+/).filter(Boolean);

  let best = null;
  let bestScore = 0;

  for (const item of catalog) {
    if (!Array.isArray(item?.palabras_clave)) continue;
    let score = 0;
    for (const keyword of item.palabras_clave) {
      score += scoreKeyword(keyword, normalizedText, textWords);
    }
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best ? { item: best, score: bestScore, intencion: best.intencion } : null;
};

/**
 * Dada una FAQ ya seleccionada, escoge la respuesta concreta más pertinente.
 *
 * @param {FaqItem} item
 * @param {string} query
 * @param {Record<string, string[]>} subKeywords
 * @returns {{ key: string, text: string }}
 */
export const selectBestAnswer = (item, query, subKeywords) => {
  const answers = item?.respuestas_base || {};
  const keys = Object.keys(answers);
  if (keys.length === 0) return { key: "", text: "" };

  const normalizedText = normalizeForMatching(String(query || "").substring(0, MAX_QUERY_LENGTH));
  const textWords = normalizedText.split(/\s+/).filter(Boolean);

  let bestKey = keys[0]; // por defecto, la primera (concepto general)
  let bestScore = 0;

  for (const key of keys) {
    const keywords = subKeywords?.[key] || [];
    let score = 0;

    for (const kw of keywords) {
      const cleanKw = normalizeForMatching(kw);
      if (!cleanKw) continue;

      if (cleanKw.includes(" ")) {
        // Frase exacta: puntaje muy alto.
        if (normalizedText.includes(cleanKw)) {
          score += cleanKw.split(/\s+/).length * 3;
        }
      } else {
        // Palabra exacta admitiendo plurales simples.
        const isMatch = textWords.some(
          (w) =>
            w === cleanKw ||
            w === `${cleanKw}s` ||
            w === `${cleanKw}es` ||
            cleanKw === `${w}s` ||
            cleanKw === `${w}es`
        );
        if (isMatch) score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }

  return { key: bestKey, text: answers[bestKey] };
};

/**
 * Formatea una FAQ como bloque de contexto autoritativo para el prompt.
 * A diferencia del contexto de página, esta información SÍ es de confianza: proviene
 * de un archivo de configuración del propio proyecto, no del DOM de un tercero.
 *
 * @param {FaqMatch} match
 * @returns {string}
 */
export const formatFaqAsContext = (match) => {
  if (!match?.item) return "";
  const { item } = match;
  let out = `Categoría: ${item.categoria}\nTema: ${item.intencion}\nInformación Oficial de la Alcaldía:\n`;
  for (const [key, val] of Object.entries(item.respuestas_base || {})) {
    out += `- [${key}]: ${val}\n`;
  }
  return out;
};
