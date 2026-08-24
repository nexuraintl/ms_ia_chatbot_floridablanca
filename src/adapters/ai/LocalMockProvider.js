/**
 * Adaptador de IA que responde localmente, sin red. Implementa `ports/AiProviderPort`.
 *
 * Se usa cuando no hay clave de API configurada, de modo que el chatbot sigue siendo
 * demostrable y desarrollable sin credenciales ni gasto.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CORRECCIÓN DE TRES RAMAS MUERTAS
 *
 * La versión anterior (`queryMockGemini`) recibía el contexto de página como un STRING
 * formateado y lo volvía a parsear con expresiones regulares. Las etiquetas que
 * emitía `getPageContext()` y las que buscaba el mock se habían desincronizado:
 *
 *   busca `[SECCIONES Y ENLACES EXTRAÍDOS DEL MAPA DEL SITIO]` … emitía `[ENLACES RELEVANTES ENCONTRADOS PARA LA CONSULTA]`
 *   busca `- Título: "…"`                                     … emitía `- Título de la página: "…"`
 *   busca `- Enlace Mapa del Sitio: …`                        … emitía `- URL Mapa del Sitio: …`
 *
 * Resultado: la búsqueda de enlaces del mapa del sitio y la respuesta a "¿dónde
 * estoy?" nunca se ejecutaban, y el mock caía siempre al fallback del buscador.
 * La suite `security-tests` (sección 9) documenta y verifica esto.
 *
 * Ahora el contexto llega como OBJETO y se leen campos, no cadenas. El acoplamiento
 * por formato de texto desaparece, y con él toda esta clase de fallo.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { findBestFaq, selectBestAnswer } from "../../domain/faq/faqMatcher.js";
import { SUBKEY_KEYWORDS } from "../../domain/faq/subKeywords.js";
import { normalizeForMatching } from "../../domain/security/textSanitizer.js";
import { estimateLocalUsage } from "../../domain/tokens/tokenEstimator.js";
import { EMPTY_PAGE_CONTEXT } from "../../domain/pageContext/pageContext.js";

/** Latencia simulada para que la UI de "escribiendo…" se comporte igual que con la API. */
const SIMULATED_LATENCY_MS = 800;

const GREETINGS = ["hola", "buenos dias", "buenas tardes", "buenas noches", "buen dia", "saludos"];

const LINK_REQUEST_WORDS = ["link", "enlace", "url", "pasame", "dame", "donde", "redireccion", "buscar"];

const LOCATION_QUESTIONS = [
  "donde estoy",
  "que pagina",
  "que seccion",
  "donde me encuentro",
  "que es esta pagina"
];

const REGIONAL_WORDS = [
  "region", "santander", "floridablanca", "clima", "historia",
  "gastronomia", "cultura", "turismo", "comida", "que me dices"
];

const REPLY_GREETING =
  "¡Hola! Bienvenido al portal del Asistente Virtual Inteligente. " +
  "¿En qué trámite o consulta municipal te puedo colaborar hoy?";

const REPLY_REGIONAL =
  "Floridablanca es un municipio vibrante ubicado en el departamento de Santander, Colombia. " +
  "Conocido como la 'Capital Mundial del Dulce' por su famosa tradición en la elaboración de obleas " +
  "y dulces típicos, forma parte del Área Metropolitana de Bucaramanga. Cuenta con un clima templado " +
  "agradable, una amplia oferta gastronómica, parques ecológicos como el Jardín Botánico Eloy " +
  "Valenzuela y un gran desarrollo comercial y residencial.";

const REPLY_DEFAULT =
  "Entendido. Puedo colaborarte respondiendo preguntas sobre el municipio, su cultura e historia, " +
  "o bien orientándote en trámites como Sisbén, Impuesto Predial, ICA y PQRSDF.";

const includesAny = (text, candidates) => candidates.some((c) => text.includes(c));

/**
 * Busca en los enlaces del contexto uno cuyo título comparta una palabra
 * significativa con la consulta.
 *
 * @param {string} normalizedQuery
 * @param {import("../../domain/pageContext/pageContext.js").PageLink[]} links
 * @returns {import("../../domain/pageContext/pageContext.js").PageLink|null}
 */
const findMatchingLink = (normalizedQuery, links) => {
  for (const link of links) {
    const words = normalizeForMatching(link.title)
      .split(/\s+/)
      .filter((w) => w.length > 3);
    if (words.some((w) => normalizedQuery.includes(w))) return link;
  }
  return null;
};

/**
 * Crea el proveedor local.
 *
 * @param {Object} deps
 * @param {import("../../domain/faq/faqMatcher.js").FaqItem[]} deps.faqCatalog
 * @param {number} [deps.latencyMs]
 * @returns {import("../../ports/AiProviderPort.js").AiProvider}
 */
export const createLocalMockProvider = ({ faqCatalog = [], latencyMs = SIMULATED_LATENCY_MS } = {}) => ({
  name: "local-mock",

  async generateReply({ history, pageContext, activeContext }) {
    await new Promise((resolve) => setTimeout(resolve, latencyMs));

    const userMessage = history?.[history.length - 1]?.text || "";
    const ctx = pageContext || EMPTY_PAGE_CONTEXT;

    // Expansión contextual: si hay una intención activa, se añade a la consulta para
    // que un "¿y cómo lo pago?" se resuelva dentro del tema en curso.
    const contextSuffix = activeContext ? ` ${activeContext.replace(/_/g, " ")}` : "";
    const normalized = normalizeForMatching(userMessage + contextSuffix);
    const normalizedQuery = normalizeForMatching(userMessage);

    let reply;
    let matchedIntent = null;

    // 1. Saludo
    if (includesAny(normalized, GREETINGS)) {
      reply = REPLY_GREETING;
    }

    // 2. "¿Dónde estoy?"
    //
    // Se evalúa ANTES de la petición de enlaces a propósito. "donde estoy" contiene
    // "donde", que también está en LINK_REQUEST_WORDS, así que con el orden inverso
    // —el que tenía la versión original— esta rama era inalcanzable: la petición de
    // enlace la capturaba primero. La regla general es evaluar los patrones más
    // específicos antes que los más generales.
    else if (includesAny(normalized, LOCATION_QUESTIONS) && (ctx.title || ctx.sitemapUrl)) {
      if (ctx.title && ctx.sitemapUrl) {
        reply = `Te encuentras en la sección "${ctx.title}". Puedes explorar todos los trámites en [Mapa del Sitio](${ctx.sitemapUrl}).`;
      } else if (ctx.title) {
        reply = `Te encuentras en la sección "${ctx.title}". Puedo ayudarte a responder inquietudes sobre la información contenida en esta página.`;
      } else {
        reply = "Estás en el portal del Asistente Virtual Inteligente. Puedo ayudarte a responder dudas sobre esta sección.";
      }
    }

    // 3. Petición explícita de un enlace o trámite
    else if (includesAny(normalized, LINK_REQUEST_WORDS) && !!ctx.origin) {
      const match = findMatchingLink(normalizedQuery, ctx.relevantLinks);
      if (match) {
        reply = `Aquí tienes el enlace directo para realizar tu consulta: [${match.title}](${match.url}).`;
      } else if (ctx.fallbackSearchUrl) {
        reply =
          "Puedes consultar los resultados oficiales para tu trámite en el buscador del portal: " +
          `[Buscar en el Portal](${ctx.fallbackSearchUrl}).`;
      } else {
        reply =
          "Puedes consultar todos los enlaces e información en la sección oficial de Trámites de la página principal.";
      }
    }

    // 4. Catálogo de FAQ
    else {
      const faqMatch = findBestFaq(userMessage + contextSuffix, faqCatalog);
      if (faqMatch) {
        matchedIntent = faqMatch.intencion;
        reply = selectBestAnswer(faqMatch.item, normalized, SUBKEY_KEYWORDS).text;
      } else if (includesAny(normalized, REGIONAL_WORDS)) {
        reply = REPLY_REGIONAL;
      } else {
        reply = REPLY_DEFAULT;
      }
    }

    return {
      text: reply,
      contextIntent: matchedIntent,
      // No hubo red ni cuota: las cifras de tokens de una respuesta local son una
      // referencia interna, no consumo. La consola no las suma al consumo de la API.
      billable: false,
      ...estimateLocalUsage(reply)
    };
  }
});
