/**
 * Calcula la distancia de edición (Levenshtein) entre dos cadenas.
 * Representa el número mínimo de operaciones requeridas para transformar 'a' en 'b'.
 */
export const getLevenshteinDistance = (a, b) => {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // Sustitución
          matrix[i][j - 1] + 1,     // Inserción
          matrix[i - 1][j] + 1      // Eliminación
        );
      }
    }
  }

  return matrix[b.length][a.length];
};

/**
 * Verifica si una palabra ingresada por el usuario coincide con la palabra clave
 * permitiendo un margen de error tipográfico (Fuzzy Match).
 */
export const isFuzzyMatch = (userWord, keyword, maxDistance = 1) => {
  // Las palabras muy cortas no deberían tener margen de error para evitar falsos positivos ridículos (ej. 'si' vs 'no')
  if (keyword.length <= 3) {
    return userWord === keyword;
  }
  
  // Optimización: si la diferencia de longitud es mayor al margen de error, es imposible que coincida
  if (Math.abs(userWord.length - keyword.length) > maxDistance) {
    return false;
  }

  const distance = getLevenshteinDistance(userWord, keyword);
  return distance <= maxDistance;
};

/**
 * Escanea un texto completo buscando si alguna de sus palabras coincide de forma "fuzzy"
 * con alguna de las palabras clave proporcionadas.
 * 
 * @param {string} text - Texto limpio ingresado por el usuario
 * @param {Array<string>} keywordsArray - Arreglo de palabras clave objetivo
 * @param {number} maxDistance - Errores tipográficos permitidos por palabra
 * @returns {boolean} - true si encuentra una coincidencia
 */
export const containsFuzzyKeyword = (text, keywordsArray, maxDistance = 1) => {
  if (!text || !keywordsArray || keywordsArray.length === 0) return false;
  
  const userWords = text.split(/\s+/).filter(w => w.length > 0);
  
  return keywordsArray.some(keyword => {
    // Si la palabra clave es una frase
    if (keyword.includes(" ")) {
      const kwWords = keyword.split(/\s+/).filter(w => w.length > 2);
      if (kwWords.length === 0) return false;
      
      // Para que la frase coincida, TODAS sus palabras significativas deben estar en el texto (fuzzy)
      const allWordsMatch = kwWords.every(kwWord => {
        return userWords.some(userWord => isFuzzyMatch(userWord, kwWord, maxDistance));
      });
      return allWordsMatch;
    }
    
    // Si es una sola palabra
    return userWords.some(userWord => isFuzzyMatch(userWord, keyword, maxDistance));
  });
};
