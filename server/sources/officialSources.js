import { createSafeReader } from './safeRead.js';
import { officialUrl, DEFAULT_SOURCE_HOSTS } from './sourcePolicy.js';
import { extractDocument } from './extractDocument.js';
import { publicSearchQuery, normalize } from '../../shared/conversationContext.js';
import { readPortalCatalog, calendarDocumentCandidates, downloadPortalDocument, DOCUMENT_CATALOG_URL } from './portalDocuments.js';

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
  const documentCache = new Map();
  return {
    async retrieve(context, { discover, inspectScannedDocument, signal } = {}) {
      if (!config.enabled) return { sources: [], searched: false, status: 'disabled', errors: [] };
      const query = publicSearchQuery(context);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(abort, config.timeoutMs);
      const sources = [], errors = [], visited = new Set();
      let document = null;
      let searched = false, reads = 0;
      const portalUrl = config.portalSearchUrl ? new URL(config.portalSearchUrl) : null;
      if (portalUrl) portalUrl.searchParams.set("q", query);
      let queue = [...config.seedUrls];
      const inspectQueue = async (limit = config.maxReads) => {
        while (queue.length && reads < limit && sources.length < config.maxSources && !controller.signal.aborted) {
          const url = officialUrl(queue.shift(), config.hosts);
          if (!url || visited.has(url)) continue;
          visited.add(url);
          const host = new URL(url).hostname;
          const question = normalize(context.currentText);
          // El horario de otra entidad oficial no responde al de la Alcaldía.
          if (context.aspect === 'horario atencion' &&
              ((host.includes('transitofloridablanca.gov.co') && !/transito|dttf/.test(question)) ||
               (host.includes('concejomunicipalfloridablanca.gov.co') && !/concejo/.test(question)))) continue;
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
              if (context.aspect?.includes('calendario') && url === DOCUMENT_CATALOG_URL) {
                const catalog = readPortalCatalog(response);
                const candidates = catalog ? calendarDocumentCandidates(catalog.documents, context.year) : [];
                for (const candidate of candidates) {
                  if (document || reads + 2 > config.maxReads) break;
                  try {
                    let downloaded = documentCache.get(candidate.id);
                    if (!downloaded || now() - downloaded.fetchedAt > 30 * 60 * 1000) {
                      const file = await downloadPortalDocument({ read, catalog, document: candidate, signal: controller.signal,
                        onRead: () => { if (reads >= config.maxReads) throw new Error('source_read_limit'); reads++; } });
                      let extracted;
                      try { extracted = await extractImpl(file.response, config.hosts, { signal: controller.signal }); }
                      catch (err) {
                        if (err.message !== 'pdf_requires_ocr' || !inspectScannedDocument) throw err;
                        extracted = await inspectScannedDocument(file.response.body, candidate, controller.signal);
                      }
                      if (!extracted.year) {
                        const headerText = normalize(extracted.text.slice(0, 2500));
                        const headerYear = Number(headerText.match(/(?:vigencia|ano\s+gravable)[^\d]{0,30}(20\d{2})/)?.[1]);
                        const resolution = candidate.title.match(/(?:No\.?\s*)?(\d{3,6})\b/)?.[1];
                        if (headerYear && /floridablanca/.test(headerText) && resolution &&
                            new RegExp(`resolucion[^\\d]{0,30}${resolution}\\b`).test(headerText)) {
                          extracted.year = headerYear; extracted.resolution = resolution;
                        }
                      }
                      downloaded = { ...file, text: extracted.text, year: extracted.year, resolution: extracted.resolution, fetchedAt: now() };
                      if (documentCache.size >= 8) documentCache.delete(documentCache.keys().next().value);
                      documentCache.set(candidate.id, downloaded);
                    }
                    if (downloaded.year === context.year) {
                      document = { body: downloaded.response.body, title: downloaded.title, year: downloaded.year,
                        resolution: downloaded.resolution, sourceUrl: DOCUMENT_CATALOG_URL };
                      sources.push({ id: 'web-document', title: downloaded.title, url: DOCUMENT_CATALOG_URL,
                        text: downloaded.text, confidence: 'document_header_ocr', fetchedAt: new Date(downloaded.fetchedAt).toISOString(),
                        requestedYear: context.year, issuer: 'Municipio de Floridablanca', verification: 'Encabezado del PDF descargado; confirma vigencia y título, no transcribe todas las fechas ni modificaciones.' });
                    }
                  } catch (err) { errors.push(/^(source_|pdf_)[a-z0-9_]+$/.test(err.message) ? err.message : 'source_document_failed'); }
                }
              }
            }
            const catalog = new URL(doc.url).hostname === 'portal.floridablanca.suiteneptuno.com' && new URL(doc.url).pathname.toLowerCase() === '/documentacion/index';
            const excerpt = catalog ? doc.text.slice(0, 4000) : relevantText(
              context.aspect === 'horario atencion' ? `${doc.text}\n${doc.contactText || ''}` : doc.text, query);
            const homePage = new URL(doc.url).pathname === '/';
            const yearRelevant = !context.year || !context.aspect?.includes('calendario') ||
              new RegExp(`(?:calendario\\s+tributario|vigencia|año\\s+gravable)[^\\n]{0,100}\\b${context.year}\\b`, 'i').test(normalize(excerpt));
            const competent = !new URL(doc.url).hostname.endsWith('dian.gov.co') || /\buvt\b/.test(normalize(context.currentText));
            if (excerpt.length > 100 && (yearRelevant || catalog) && competent && url !== portalUrl?.href &&
                (!catalog || context.aspect?.includes('calendario')) &&
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
        // Las consultas documentales empiezan siempre por el catálogo, aunque haya
        // páginas genéricas de una consulta anterior guardadas en caché.
        queue = context.aspect?.includes('calendario') ? [...config.seedUrls] : [...cachedSources.map(doc => doc.url), ...queue];
        const cachedDocument = [...documentCache.values()].find(doc => doc.year === context.year && now() - doc.fetchedAt < 30 * 60 * 1000);
        if (context.aspect?.includes('calendario') && cachedDocument) {
          document = { body: cachedDocument.response.body, title: cachedDocument.title, year: cachedDocument.year,
            resolution: cachedDocument.resolution, sourceUrl: DOCUMENT_CATALOG_URL };
          sources.push({ id: 'web-document', title: cachedDocument.title, url: DOCUMENT_CATALOG_URL, text: cachedDocument.text,
            confidence: 'document_header_ocr', fetchedAt: new Date(cachedDocument.fetchedAt).toISOString(), requestedYear: context.year });
        } else if (context.aspect?.includes('calendario')) cache.delete(DOCUMENT_CATALOG_URL);
        if (portalUrl && !cachedSources.length) {
          searched = true;
          if (context.aspect?.includes('calendario')) queue.splice(1, 0, portalUrl.href);
          else queue.unshift(portalUrl.href);
        }
        if (!document) await inspectQueue(Math.min(2, config.maxReads));
        if (config.searchEnabled && discover && !sources.some(source => source.confidence !== 'official_catalog') && !controller.signal.aborted) {
          searched = true;
          try { queue = [...await discover(query, controller.signal), ...queue]; }
          catch { errors.push('search_unavailable'); }
        }
        if (!document) await inspectQueue();
        return { sources, document, searched, status: sources.length ? 'found' : controller.signal.aborted ? 'timeout' : errors.length ? 'unavailable' : 'no_results', errors };
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
  };
};
