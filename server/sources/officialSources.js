import { createSafeReader } from './safeRead.js';
import { officialUrl, DEFAULT_SOURCE_HOSTS } from './sourcePolicy.js';
import { extractDocument } from './extractDocument.js';
import { publicSearchQuery, normalize } from '../../shared/conversationContext.js';

export const createSourceConfig = (env = process.env) => {
  const hosts = String(env.AI_SOURCE_HOSTS || DEFAULT_SOURCE_HOSTS.join(',')).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const seedUrls = String(env.AI_SOURCE_URLS || 'https://portal.floridablanca.suiteneptuno.com/Documentacion/Index,https://www.floridablanca.gov.co/publicaciones/87/formularios-industria-y-comercio/,https://www.floridablanca.gov.co/mapa-del-sitio').split(',').map(s => officialUrl(s.trim(), hosts)).filter(Boolean);
  return { enabled: env.AI_WEB_ENABLED !== 'false', searchEnabled: env.AI_SEARCH_ENABLED !== 'false',
    hosts, seedUrls, portalSearchUrl: officialUrl(env.AI_PORTAL_SEARCH_URL || 'https://www.floridablanca.gov.co/buscar/', hosts), ttlMs: 60 * 60 * 1000, maxReads: 4, maxSources: 3, timeoutMs: 18_000 };
};
export const relevantText = (text, query) => {
  const words = [...new Set(normalize(query).split(/\W+/).filter(w => w.length > 3))];
  const pieces = String(text).split(/\n/).flatMap(line => line.match(/.{1,900}(?:\s|$)/g) || [line]).filter(Boolean);
  const ranked = pieces.map((piece, index) => ({ piece, index, score: words.filter(w => normalize(piece).includes(w)).length }));
  const best = ranked.filter(p => p.score >= 2).sort((a,b) => b.score-a.score).slice(0,4);
  // Conservar el vecino de tablas y contexto; evitar snippets sin su base de cálculo.
  const indices = new Set(best.flatMap(p => [p.index-1, p.index, p.index+1]));
  return ranked.filter(p => indices.has(p.index)).map(p => p.piece).join('\n').slice(0,4000);
};

export const createOfficialSourceRepository = ({ config = createSourceConfig(), readImpl,
  extractImpl = extractDocument, now = () => Date.now() } = {}) => {
  const read = readImpl || createSafeReader({ hosts: config.hosts });
  const cache = new Map();
  return {
    async retrieve(context, { discover, signal } = {}) {
      if (!config.enabled) return { sources: [], searched: false, status: 'disabled', errors: [] };
      const query = publicSearchQuery(context);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(abort, config.timeoutMs);
      const sources = [], errors = [], visited = new Set();
      let searched = false, reads = 0;
      const portalUrl = config.portalSearchUrl ? new URL(config.portalSearchUrl) : null;
      if (portalUrl) portalUrl.searchParams.set("q", query);
      let queue = [...config.seedUrls];
      const inspectQueue = async (limit = config.maxReads) => {
        while (queue.length && reads < limit && sources.length < config.maxSources && !controller.signal.aborted) {
          const url = officialUrl(queue.shift(), config.hosts);
          if (!url || visited.has(url)) continue;
          visited.add(url);
          try {
            let doc = cache.get(url);
            if (!doc || now() - doc.fetchedAt > config.ttlMs) {
              reads++;
              const response = await read(url, { signal: controller.signal });
              const finalUrl = officialUrl(response.url || url, config.hosts);
              if (!finalUrl) throw new Error('source_url_rejected');
              doc = { ...await extractImpl(response, config.hosts, { signal: controller.signal }), url: finalUrl, fetchedAt: now() };
              if (cache.size >= 100) cache.delete(cache.keys().next().value);
              cache.set(url, doc);
            }
            const catalog = new URL(doc.url).hostname === 'portal.floridablanca.suiteneptuno.com' && new URL(doc.url).pathname.toLowerCase() === '/documentacion/index';
            const excerpt = catalog ? doc.text.slice(0, 4000) : relevantText(doc.text, query);
            const homePage = new URL(doc.url).pathname === '/';
            const yearRelevant = !context.year || !context.aspect?.includes('calendario') || excerpt.includes(String(context.year));
            const competent = !new URL(doc.url).hostname.endsWith('dian.gov.co') || /\buvt\b/.test(normalize(context.currentText));
            if (excerpt.length > 100 && (yearRelevant || catalog) && competent && url !== portalUrl?.href &&
                !(homePage && context.aspect?.includes('calendario'))) sources.push({
              id: `web-${sources.length+1}`, title: catalog ? 'Normatividad y Formularios — Alcaldía de Floridablanca' : doc.title, url: doc.url, text: excerpt,
              fetchedAt: new Date(doc.fetchedAt).toISOString(), requestedYear: context.year,
              confidence: catalog ? 'official_catalog' : 'public_text', issuer: new URL(doc.url).hostname.includes('dian.gov.co') ? 'DIAN' : 'Municipio de Floridablanca', publicationDate: doc.publicationDate || null, verification: catalog
                ? 'Catálogo oficial de documentos. Sirve para enlazar la sección y mencionar sus títulos; NO confirma el contenido, fechas ni año de aplicación de las resoluciones. La descarga requiere interacción con el portal.'
                : 'Comprobar vigencia y modificaciones en el contenido; fecha de lectura no prueba vigencia.'
            });
            const words = normalize(query).split(/\W+/).filter(w => w.length > 3);
            const links = (doc.links || []).map(link => ({ ...link, score: words.filter(w => normalize(link.title).includes(w)).length }))
              .filter(link => link.score > 0).sort((a,b) => b.score-a.score).slice(0,3);
            queue = [...links.map(link => link.url), ...queue];
          } catch (err) { errors.push(/^(source_|pdf_|search_)[a-z0-9_]+$/.test(err.message) ? err.message : 'source_processing_failed'); }
        }
      };
      try {
        // Buscar primero las URLs específicas para no consumir el presupuesto en navegación.
        const cachedSources = [...cache.values()].filter(doc => now()-doc.fetchedAt < config.ttlMs && relevantText(doc.text, query).length > 100);
        queue = [...cachedSources.map(doc => doc.url), ...queue];
        if (portalUrl && !cachedSources.length) {
          searched = true;
          if (context.aspect?.includes('calendario')) queue.splice(1, 0, portalUrl.href);
          else queue.unshift(portalUrl.href);
        }
        await inspectQueue(Math.min(2, config.maxReads));
        if (config.searchEnabled && discover && !sources.some(source => source.confidence !== 'official_catalog') && !controller.signal.aborted) {
          searched = true;
          try { queue = [...await discover(query, controller.signal), ...queue]; }
          catch { errors.push('search_unavailable'); }
        }
        await inspectQueue();
        return { sources, searched, status: sources.length ? 'found' : controller.signal.aborted ? 'timeout' : errors.length ? 'unavailable' : 'no_results', errors };
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
  };
};
