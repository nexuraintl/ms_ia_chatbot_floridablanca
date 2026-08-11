/**
 * Contexto de la página anfitriona. Capa de dominio.
 *
 * ANTES: `ChatContext.getPageContext()` construía un string formateado y
 * `queryMockGemini()` lo volvía a parsear con expresiones regulares. Las etiquetas
 * de ambos lados se desincronizaron y tres ramas del mock quedaron inalcanzables
 * (ver `security-tests`, sección 9).
 *
 * AHORA: el contexto es un OBJETO estructurado. Los consumidores leen campos, no
 * regexes. La serialización a texto para el prompt ocurre en un único lugar
 * (`promptSerializer.js`), y solo en la dirección objeto -> texto.
 *
 * Este módulo también impone los topes de tamaño y el saneamiento, porque todo su
 * contenido proviene del DOM de una página que este widget no controla.
 */

import { sanitizeForPrompt, truncate } from "../security/textSanitizer.js";

/**
 * Topes de tamaño. Sin ellos, un anfitrión hostil (o simplemente una página con un
 * `<meta description>` enorme) puede empujar las instrucciones reales fuera de la
 * ventana de contexto del modelo.
 */
export const CONTEXT_LIMITS = Object.freeze({
  title: 120,
  description: 300,
  heading: 80,
  maxHeadings: 5,
  linkTitle: 80,
  maxLinks: 3,
  maxUrlLength: 300
});

/**
 * @typedef {Object} PageLink
 * @property {string} title
 * @property {string} url
 */

/**
 * @typedef {Object} PageContext
 * @property {string} title
 * @property {string} description
 * @property {string[]} headings
 * @property {string} currentUrl
 * @property {string} origin
 * @property {string} sitemapUrl
 * @property {string|null} fallbackSearchUrl
 * @property {PageLink[]} relevantLinks
 */

/** @type {PageContext} */
export const EMPTY_PAGE_CONTEXT = Object.freeze({
  title: "",
  description: "",
  headings: [],
  currentUrl: "",
  origin: "",
  sitemapUrl: "",
  fallbackSearchUrl: null,
  relevantLinks: []
});

/**
 * Construye un `PageContext` saneado y acotado a partir de datos crudos del DOM.
 *
 * Todos los campos de texto pasan por `sanitizeForPrompt`, que elimina caracteres de
 * control e invisibles y neutraliza los delimitadores estructurales con los que un
 * anfitrión podría hacerse pasar por instrucciones del sistema.
 *
 * @param {Partial<PageContext>} raw
 * @returns {PageContext}
 */
export const createPageContext = (raw = {}) => ({
  title: sanitizeForPrompt(raw.title, CONTEXT_LIMITS.title),
  description: sanitizeForPrompt(raw.description, CONTEXT_LIMITS.description),
  headings: (Array.isArray(raw.headings) ? raw.headings : [])
    .map((h) => sanitizeForPrompt(h, CONTEXT_LIMITS.heading))
    .filter(Boolean)
    .slice(0, CONTEXT_LIMITS.maxHeadings),
  currentUrl: truncate(String(raw.currentUrl || ""), CONTEXT_LIMITS.maxUrlLength),
  origin: truncate(String(raw.origin || ""), CONTEXT_LIMITS.maxUrlLength),
  sitemapUrl: truncate(String(raw.sitemapUrl || ""), CONTEXT_LIMITS.maxUrlLength),
  fallbackSearchUrl: raw.fallbackSearchUrl
    ? truncate(String(raw.fallbackSearchUrl), CONTEXT_LIMITS.maxUrlLength)
    : null,
  relevantLinks: (Array.isArray(raw.relevantLinks) ? raw.relevantLinks : [])
    .map((l) => ({
      title: sanitizeForPrompt(l?.title, CONTEXT_LIMITS.linkTitle),
      url: truncate(String(l?.url || ""), CONTEXT_LIMITS.maxUrlLength)
    }))
    .filter((l) => l.title && l.url)
    .slice(0, CONTEXT_LIMITS.maxLinks)
});

/** ¿Hay algo útil que enviar al modelo? */
export const isEmptyPageContext = (ctx) =>
  !ctx || (!ctx.title && !ctx.description && ctx.headings.length === 0 && ctx.relevantLinks.length === 0);
