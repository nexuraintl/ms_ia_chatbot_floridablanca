/**
 * Armado de la instruccion de sistema con los fragmentos recuperados. Funciones puras.
 *
 * El presupuesto de caracteres se reparte aqui: las reglas primero, y lo que queda para
 * el conocimiento. El proxy recorta a `maxSystemChars` con `slice`, asi que un bloque que
 * no quepa se cortaria a mitad de frase; por eso el corte se decide en este modulo, por
 * fragmento completo.
 */

import { BASE_RULES, GROUNDING_RULES, NO_MATCH_NOTICE } from "./promptRules.js";

/** Margen que se deja libre bajo el tope del proxy. */
const SAFETY_MARGIN_CHARS = 250;

/** Minimo util para un bloque de conocimiento: por debajo, mejor no enviar ninguno. */
const MIN_KNOWLEDGE_CHARS = 500;

export const BLOCK_HEADER = "[ESTATUTO TRIBUTARIO MUNICIPAL - INFORMACIÓN OFICIAL VERIFICABLE]";

/** Etiqueta de procedencia que ve el modelo, por nivel de confianza del fragmento. */
const CONFIDENCE_LABELS = {
  curada: "fuente: respuesta oficial revisada",
  verificada: "fuente: tabla del Estatuto verificada",
  ocr_texto: "fuente: texto del Estatuto",
  ocr_geometria: "fuente: tabla escaneada"
};

/**
 * Encabezado de un fragmento: de donde sale y con que confianza.
 * @param {Object} chunk
 */
export const formatChunkHeader = (chunk) => {
  const parts = [];
  if (chunk.articulo > 0) parts.push(`Artículo ${chunk.articulo}`);
  if (chunk.epigrafe) parts.push(chunk.epigrafe);
  if (chunk.tema) parts.push(chunk.tema);
  const label = CONFIDENCE_LABELS[chunk.confianza] || "fuente: Estatuto";
  return `--- ${parts.join(" | ") || chunk.id} (${label})`;
};

/**
 * Bloque de conocimiento acotado. Se incluyen fragmentos completos mientras quepan.
 *
 * @param {{chunk: Object}[]} results
 * @param {number} maxChars
 * @returns {{text: string, incluidos: string[]}}
 */
export const buildKnowledgeBlock = (results, maxChars) => {
  const pieces = [];
  const incluidos = [];
  let used = BLOCK_HEADER.length;

  for (const { chunk } of results) {
    const entry = `${formatChunkHeader(chunk)}\n${chunk.texto}`;
    if (used + entry.length + 2 > maxChars) continue;
    pieces.push(entry);
    incluidos.push(chunk.id);
    used += entry.length + 2;
  }

  if (pieces.length === 0) return { text: "", incluidos: [] };
  return { text: `${BLOCK_HEADER}\n${pieces.join("\n\n")}`, incluidos };
};

/**
 * Instruccion de sistema completa.
 *
 * @param {Object} params
 * @param {{chunk: Object}[]} params.results  Fragmentos recuperados, ya ordenados.
 * @param {number} params.maxChars            Tope del proxy (`LIMITS.maxSystemChars`).
 * @returns {{text: string, incluidos: string[]}}
 */
export const buildSystemInstruction = ({ results = [], maxChars = 8000 } = {}) => {
  const withGrounding = `${BASE_RULES}\n\n${GROUNDING_RULES}`;
  const available = maxChars - withGrounding.length - SAFETY_MARGIN_CHARS;

  if (results.length === 0 || available < MIN_KNOWLEDGE_CHARS) {
    return { text: `${BASE_RULES}\n\n${NO_MATCH_NOTICE}`, incluidos: [] };
  }

  const block = buildKnowledgeBlock(results, available);
  if (block.text === "") {
    return { text: `${BASE_RULES}\n\n${NO_MATCH_NOTICE}`, incluidos: [] };
  }

  return { text: `${withGrounding}\n\n${block.text}`, incluidos: block.incluidos };
};
