/**
 * Carga de los enlaces del mapa del sitio de la página anfitriona.
 * Capa de adaptadores.
 *
 * Extraído del `useEffect` de 95 líneas que había en `ChatContext.jsx`.
 *
 * Nota de seguridad: estos enlaces provienen del portal donde el widget está
 * embebido, así que se tratan como datos NO CONFIABLES. Aquí solo se recolectan y se
 * filtran por forma; la decisión de si un enlace puede llegar a renderizarse como
 * `<a href>` la toma `domain/security/urlPolicy.js` en el momento del render.
 */

/**
 * Este módulo usa `fetch` directamente en lugar del cliente HTTP compartido porque el
 * mapa del sitio devuelve HTML, no JSON, y `httpClient` está especializado en JSON.
 */

/** Rutas candidatas donde suele vivir el mapa del sitio. */
const SITEMAP_PATHS = ["/mapa-del-sitio", "/mapa-sitio", "/mapa-de-sitio", "/sitemap"];

/** Selectores del contenedor probable del mapa del sitio. */
const SITEMAP_CONTAINERS = ".mapa-del-sitio, .sitemap, main, #main-content, #content, body";

/** Selectores de navegación usados como respaldo si no hay mapa del sitio. */
const NAV_SELECTORS = "nav a[href], header a[href], main a[href], footer a[href], .menu a[href]";

/** Tope de enlaces conservados. */
const MAX_LINKS = 60;
const MAX_FALLBACK_LINKS = 50;

/** Longitud mínima del HTML para considerar que una ruta devolvió un mapa real. */
const MIN_SITEMAP_HTML_LENGTH = 500;

/** Extensiones que no son secciones navegables. */
const ASSET_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|pdf|zip|docx?|xlsx?)$/i;

/**
 * ¿Es un enlace utilizable como sección del portal?
 * @param {{title: string, url: string}} item
 */
const isUsableLink = (item) =>
  item.title.length > 2 &&
  item.url.startsWith("http") &&
  !item.url.includes("#") &&
  !item.url.includes("javascript:") &&
  !ASSET_EXTENSIONS.test(item.url);

/**
 * Deduplica por URL preservando el orden de aparición.
 * @param {{title: string, url: string}[]} links
 */
const dedupeByUrl = (links) => {
  const seen = new Set();
  const out = [];
  for (const link of links) {
    if (!seen.has(link.url)) {
      seen.add(link.url);
      out.push(link);
    }
  }
  return out;
};

/**
 * Normaliza un href relativo a absoluto contra el origen.
 * @param {string} href
 * @param {string} origin
 */
const toAbsolute = (href, origin) => {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `${origin}${href}`;
  return `${origin}/${href.replace(/^\.\//, "")}`;
};

/**
 * Extrae enlaces de un documento HTML ya parseado. Función pura respecto a la red.
 *
 * @param {Document} doc
 * @param {string} origin
 * @returns {{title: string, url: string}[]}
 */
export const extractLinksFromDocument = (doc, origin) => {
  const container = doc.querySelector(SITEMAP_CONTAINERS) || doc;
  const anchors = Array.from(container.querySelectorAll("a[href]"));

  const links = anchors
    .map((a) => ({
      title: (a.innerText || a.textContent || a.getAttribute("title") || "")
        .trim()
        .replace(/\s+/g, " "),
      url: toAbsolute(a.getAttribute("href") || "", origin)
    }))
    .filter(isUsableLink);

  return dedupeByUrl(links).slice(0, MAX_LINKS);
};

/**
 * Recolecta enlaces de la navegación del documento actual.
 *
 * @param {Document} doc
 * @returns {{title: string, url: string}[]}
 */
export const extractLinksFromNavigation = (doc) =>
  Array.from(doc.querySelectorAll(NAV_SELECTORS))
    .map((a) => ({
      title: (a.innerText || a.getAttribute("title") || "").trim(),
      url: a.href || ""
    }))
    .filter(isUsableLink)
    .slice(0, MAX_FALLBACK_LINKS);

/**
 * Crea el repositorio de enlaces del mapa del sitio.
 *
 * @param {Object} [deps]
 * @param {Document} [deps.doc]
 * @param {Window} [deps.win]
 * @returns {{ load: () => Promise<{title: string, url: string}[]> }}
 */
export const createSitemapRepository = ({ doc = globalThis.document, win = globalThis.window } = {}) => ({
  /**
   * Intenta localizar el mapa del sitio del portal; si no existe, cae a la navegación
   * del DOM actual. Nunca lanza: un fallo aquí no debe impedir que el chat funcione.
   *
   * @returns {Promise<{title: string, url: string}[]>}
   */
  async load() {
    if (!doc || !win) return [];
    const origin = win.location?.origin || "";
    if (!origin) return [];

    for (const path of SITEMAP_PATHS) {
      try {
        // El mapa del sitio devuelve HTML, así que no se puede usar el cliente JSON.
        const res = await fetch(`${origin}${path}`, { method: "GET" });
        if (!res.ok) continue;

        const html = await res.text();
        const looksLikeSitemap =
          html.length > MIN_SITEMAP_HTML_LENGTH &&
          !html.includes("404") &&
          !html.includes("Página no encontrada");

        if (!looksLikeSitemap) continue;

        const parsed = new DOMParser().parseFromString(html, "text/html");
        const links = extractLinksFromDocument(parsed, origin);
        if (links.length > 0) return links;
      } catch {
        // Ruta no disponible: probar la siguiente.
      }
    }

    // Respaldo: los enlaces navegables de la página actual.
    return extractLinksFromNavigation(doc);
  }
});
