/**
 * Coincidencia difusa tolerante a errores tipográficos. Capa de dominio.
 *
 * Movido desde `utils/stringUtils.js`: es lógica de negocio del enrutamiento de
 * intenciones, no una utilidad genérica de cadenas. La carpeta `utils/` tendía a
 * convertirse en un cajón de sastre sin dueño.
 *
 * Los topes de coste de CPU se conservan tal cual estaban —son correctos y la suite
 * de seguridad los verifica— y se documenta por qué cada uno es necesario.
 */

/** Tope de longitud para el cálculo de Levenshtein: el coste es O(N*M). */
const MAX_STRING_LEN = 100;

/** Tope de palabras evaluadas por mensaje. */
const MAX_WORDS = 100;

/** Tope de caracteres del mensaje considerado. */
const MAX_TEXT_LEN = 2000;

/**
 * Distancia de edición de Levenshtein: número mínimo de inserciones, eliminaciones o
 * sustituciones para transformar `a` en `b`.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Distancia, o Infinity si las entradas no son cadenas.
 */
export const getLevenshteinDistance = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return Infinity;

  // Truncar antes de construir la matriz: sin este tope, una entrada de 50.000
  // caracteres reservaría una matriz de 2.500 millones de celdas.
  const strA = a.length > MAX_STRING_LEN ? a.substring(0, MAX_STRING_LEN) : a;
  const strB = b.length > MAX_STRING_LEN ? b.substring(0, MAX_STRING_LEN) : b;

  const matrix = [];

  for (let i = 0; i <= strB.length; i++) matrix[i] = [i];
  for (let j = 0; j <= strA.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= strB.length; i++) {
    for (let j = 1; j <= strA.length; j++) {
      if (strB.charAt(i - 1) === strA.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // sustitución
          matrix[i][j - 1] + 1,     // inserción
          matrix[i - 1][j] + 1      // eliminación
        );
      }
    }
  }

  return matrix[strB.length][strA.length];
};

/**
 * ¿Coincide una palabra del usuario con una palabra clave, admitiendo erratas?
 *
 * @param {string} userWord
 * @param {string} keyword
 * @param {number} [maxDistance]
 * @returns {boolean}
 */
export const isFuzzyMatch = (userWord, keyword, maxDistance = 1) => {
  if (!userWord || !keyword) return false;

  // Las palabras muy cortas no admiten margen: con 3 letras, distancia 1 haría que
  // "ica" casara con "ida", "ita", "ica"... y todo sería un falso positivo.
  if (keyword.length <= 3) return userWord === keyword;

  // Atajo decisivo para el coste: si la diferencia de longitud ya excede el margen,
  // la distancia también lo excede. Esto evita ejecutar Levenshtein en la mayoría
  // de los pares y es lo que mantiene el peor caso en el orden de microsegundos.
  if (Math.abs(userWord.length - keyword.length) > maxDistance) return false;

  return getLevenshteinDistance(userWord, keyword) <= maxDistance;
};

/**
 * ¿Alguna palabra del texto coincide de forma difusa con alguna palabra clave?
 * Una palabra clave con espacios se trata como frase: todas sus palabras
 * significativas deben aparecer.
 *
 * @param {string} text Texto ya normalizado (minúsculas, sin acentos).
 * @param {string[]} keywordsArray
 * @param {number} [maxDistance]
 * @returns {boolean}
 */
export const containsFuzzyKeyword = (text, keywordsArray, maxDistance = 1) => {
  if (!text || !Array.isArray(keywordsArray) || keywordsArray.length === 0) return false;

  const userWords = text
    .substring(0, MAX_TEXT_LEN)
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, MAX_WORDS);

  return keywordsArray.some((keyword) => {
    if (typeof keyword !== "string") return false;

    if (keyword.includes(" ")) {
      const kwWords = keyword.split(/\s+/).filter((w) => w.length > 2);
      if (kwWords.length === 0) return false;
      return kwWords.every((kwWord) =>
        userWords.some((userWord) => isFuzzyMatch(userWord, kwWord, maxDistance))
      );
    }

    return userWords.some((userWord) => isFuzzyMatch(userWord, keyword, maxDistance));
  });
};
