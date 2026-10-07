import { load } from 'cheerio';

export const DOCUMENT_CATALOG_URL = 'https://portal.floridablanca.suiteneptuno.com/Documentacion/Index';

/** Reconoce únicamente el catálogo público y su función conocida, sin ejecutar JS. */
export const readPortalCatalog = response => {
  if (response.url !== DOCUMENT_CATALOG_URL || !/text\/html/.test(response.contentType)) return null;
  const $ = load(response.body.toString('utf8'));
  const csrfToken = $('input[name="__RequestVerificationToken"]').first().attr('value') || '';
  const cookie = (response.publicCookies || []).join('; ');
  const documents = $('a[onclick]').map((_, node) => {
    const id = /^\s*descargarArchivo\((\d{1,8})\)\s*;?\s*$/.exec($(node).attr('onclick') || '')?.[1];
    return id ? { id, title: $(node).text().trim().slice(0, 200) } : null;
  }).get().filter(Boolean).slice(0, 100);
  return { session: { csrfToken, cookie }, documents };
};

export const calendarDocumentCandidates = (documents, year) => documents
  .filter(doc => /presentaci[oó]n.*pagos.*impuestos|calendario.*tributario/i.test(doc.title))
  .map(doc => ({ ...doc, year: Number(doc.title.match(/\b20\d{2}\b/)?.[0]) || 0 }))
  .filter(doc => !year || doc.year <= year)
  .sort((a, b) => b.year - a.year).slice(0, 2);

/** MenuById prepara una descarga pública; nunca envía datos del ciudadano. */
export const downloadPortalDocument = async ({ read, catalog, document, signal, onRead = () => {} }) => {
  if (!catalog?.session.csrfToken || !catalog.session.cookie) throw new Error('source_document_session_missing');
  onRead();
  const menu = await read(`${DOCUMENT_CATALOG_URL}?handler=MenuById`, {
    signal, portalSession: catalog.session, publicDocumentId: document.id
  });
  if (!/application\/json/.test(menu.contentType)) throw new Error('source_document_metadata_rejected');
  let metadata;
  try { metadata = JSON.parse(menu.body.toString('utf8')); } catch { throw new Error('source_document_metadata_rejected'); }
  if (String(metadata.estado) !== '1' || typeof metadata.handle !== 'string' || metadata.handle.length > 512 ||
      typeof metadata.fileName !== 'string' || metadata.fileName.length > 300 || !/\.pdf$/i.test(metadata.fileName)) throw new Error('source_document_metadata_rejected');
  const url = new URL(DOCUMENT_CATALOG_URL);
  url.search = new URLSearchParams({ handler: 'DownloadArchivo', file: metadata.handle, fileName: metadata.fileName }).toString();
  const cookies = new Map([...catalog.session.cookie.split('; ').filter(Boolean), ...(menu.publicCookies || [])]
    .map(value => [value.split('=')[0], value]));
  const downloadSession = { ...catalog.session, cookie: [...cookies.values()].join('; ') };
  onRead();
  const response = await read(url.href, { signal, portalSession: downloadSession });
  if (response.body.subarray(0, 5).toString() !== '%PDF-') throw new Error('source_document_not_pdf');
  return { response, title: document.title, documentId: document.id };
};
