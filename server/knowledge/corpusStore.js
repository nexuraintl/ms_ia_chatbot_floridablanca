/**
 * Carga del corpus del Estatuto Tributario. Lectura desde disco, una sola vez.
 *
 * El corpus lo genera `tools/knowledge/build_corpus.py` a partir del PDF oficial. Si el
 * archivo falta, el servicio sigue en pie sin base de conocimiento: se registra el aviso
 * y el proxy conserva su comportamiento anterior.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { info, warning } from "../logging.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_CORPUS_PATH = path.resolve(__dirname, "corpus.json");

/** Campos que un fragmento debe traer para ser utilizable. */
const isUsableChunk = (chunk) =>
  chunk &&
  typeof chunk.id === "string" &&
  chunk.id !== "" &&
  typeof chunk.texto === "string" &&
  chunk.texto.trim() !== "";

/** `undefined` = aun no se intento; `null` = no hay corpus disponible. */
let cached;

/**
 * Lee y valida el corpus. No lanza: un corpus ilegible degrada, no tumba el servicio.
 *
 * @param {string} [corpusPath]
 * @returns {{fuente: Object, chunks: Object[]}|null}
 */
export const loadCorpus = (corpusPath = DEFAULT_CORPUS_PATH) => {
  let raw;
  try {
    raw = fs.readFileSync(corpusPath, "utf8");
  } catch {
    warning("knowledge_corpus_missing", { path: path.basename(corpusPath) });
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warning("knowledge_corpus_invalid", { detail: "JSON ilegible" });
    return null;
  }

  const chunks = Array.isArray(parsed?.chunks) ? parsed.chunks.filter(isUsableChunk) : [];
  if (chunks.length === 0) {
    warning("knowledge_corpus_empty", {});
    return null;
  }

  const discarded = (parsed.chunks?.length || 0) - chunks.length;
  info("knowledge_corpus_loaded", {
    chunks: chunks.length,
    discarded,
    documento: parsed?.fuente?.documento || "sin declarar"
  });

  return { fuente: parsed.fuente || {}, chunks };
};

/**
 * Corpus vigente del proceso.
 * @returns {{fuente: Object, chunks: Object[]}|null}
 */
export const getCorpus = () => {
  if (cached === undefined) cached = loadCorpus();
  return cached;
};

/** Reinicia la cache. Existe para las pruebas. */
export const resetCorpusCache = () => {
  cached = undefined;
};
