/**
 * Inspector del DOM de la página anfitriona. Capa de adaptadores.
 *
 * Aísla TODO el acceso a `document` y `window` relacionado con el contexto de página.
 * Antes esto vivía dentro de `ChatContext.getPageContext()`, lo que tenía dos costes:
 *
 *   · No se podía probar sin un navegador. La construcción del prompt —justo la parte
 *     con la superficie de inyección— era la única lógica no testeable del proyecto.
 *   · Mezclaba tres responsabilidades: leer el DOM, puntuar relevancia de enlaces y
 *     formatear el prompt.
 *
 * Ahora: este adaptador solo LEE y devuelve datos crudos. El saneamiento y los topes
 * los aplica `createPageContext`; la relevancia la calcula `rankLinksByRelevance`, que
 * es una función pura exportada aparte y sí testeable.
 */

import { createPageContext } from "../../domain/pageContext/pageContext.js";
import { normalizeForMatching } from "../../domain/security/textSanitizer.js";

/** Palabras que no aportan señal al buscar enlaces relevantes. */
const STOP_WORDS = [
  "para", "como", "donde", "quiero", "puedo", "hacer", "pasame", "enlace",
  "link", "buscar", "pagina", "sitio", "favor", "dame", "esta", "este"
];

/** Palabras que se eliminan al construir la consulta del buscador del portal. */
const SEARCH_NOISE = /(pasame|dame|el|link|enlace|de|por|favor|dónde|donde|está|busco)/gi;

/** Máximo de enlaces relevantes devueltos. */
const MAX_RELEVANT_LINKS = 3;

/**
 * Puntúa y ordena enlaces por relevancia frente a la consulta. Función PURA.
 *
 * @param {string} userText
 * @param {{title: string, url: string}[]} links
 * @param {number} [limit]
 * @returns {{title: string, url: string}[]}
 */
export const rankLinksByRelevance = (userText, links, limit = MAX_RELEVANT_LINKS) => {
  if (!userText || !Array.isArray(links) || links.length === 0) return [];

  const normalized = normalizeForMatching(userText);
  const words = normalized
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.includes(w));

  if (words.length === 0) return [];

  const scored = [];
  for (const link of links) {
    if (!link?.title || !link?.url) continue;
    const title = normalizeForMatching(link.title);
    const url = String(link.url).toLowerCase();
    let score = 0;

    for (const w of words) {
      // El título pesa el doble que la URL: un match en el texto visible es
      // mejor señal que uno en el slug.
      if (title.includes(w)) score += w.length * 2;
      if (url.includes(w)) score += w.length;
    }

    if (score > 0) scored.push({ ...link, score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ title, url }) => ({ title, url }));
};

/**
 * Construye la URL del buscador del portal a partir de la consulta del ciudadano.
 * @param {string} origin
 * @param {string} userMessage
 * @returns {string}
 */
export const buildPortalSearchUrl = (origin, userMessage) => {
  const cleaned = String(userMessage || "").replace(SEARCH_NOISE, "").trim();
  const query = encodeURIComponent(cleaned || "tramites");
  return `${origin}/buscar/?q=${query}`;
};

/**
 * Crea el inspector.
 *
 * @param {Object} [deps]
 * @param {Document} [deps.doc]
 * @param {Window} [deps.win]
 * @returns {{ inspect: (userMessage: string, sitemapLinks: {title,url}[]) => import("../../domain/pageContext/pageContext.js").PageContext }}
 */
export const createDomPageInspector = ({ doc = globalThis.document, win = globalThis.window } = {}) => ({
  /**
   * Lee el DOM y devuelve un `PageContext` ya saneado y acotado.
   *
   * @param {string} userMessage
   * @param {{title: string, url: string}[]} sitemapLinks
   */
  inspect(userMessage = "", sitemapLinks = []) {
    if (!doc || !win) return createPageContext({});

    try {
      const origin = win.location?.origin || "";
      const relevantLinks = rankLinksByRelevance(userMessage, sitemapLinks);

      return createPageContext({
        title: doc.title || "",
        description: doc.querySelector('meta[name="description"]')?.getAttribute("content") || "",
        headings: Array.from(doc.querySelectorAll("h1, h2, h3"))
          .map((h) => (h.innerText || h.textContent || "").trim())
          .filter(Boolean),
        currentUrl: win.location?.href || "",
        origin,
        sitemapUrl: origin ? `${origin}/mapa-del-sitio` : "",
        // Solo se ofrece el buscador si no encontramos un enlace concreto.
        fallbackSearchUrl:
          relevantLinks.length === 0 && origin ? buildPortalSearchUrl(origin, userMessage) : null,
        relevantLinks
      });
    } catch (error) {
      console.warn("⚠️ [PageInspector] No se pudo leer el contexto de la página:", error?.message);
      return createPageContext({});
    }
  }
});
