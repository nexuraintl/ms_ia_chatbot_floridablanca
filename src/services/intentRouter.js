import config from "../config/chatbotConfig.json";
import { containsFuzzyKeyword } from "../utils/stringUtils";

/**
 * Evalúa semánticamente el mensaje del usuario basándose en palabras clave configuradas.
 * 
 * @param {string} text - El mensaje ingresado por el usuario.
 * @returns {string|null} - El nombre del flujo coincidente ("sisben", "predial", "rpa") o null si no coincide.
 */
export const getSemanticRoute = (text) => {
  if (!text) return null;
  
  // Normalizar entrada del usuario (minúsculas, sin acentos)
  const cleanText = text.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Evaluar las intenciones mapeadas en chatbotConfig.json usando Fuzzy Matching
  for (const [flow, keywords] of Object.entries(config.routing)) {
    if (containsFuzzyKeyword(cleanText, keywords)) {
      return flow;
    }
  }

  return null;
};
