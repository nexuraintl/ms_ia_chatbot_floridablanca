import { createHash } from 'node:crypto';

export const AI_DOCUMENT_PATH = '/api/ai/documents/';
/** Copias de documentos públicos: sin sesión, datos ciudadanos ni enlaces temporales. */
export const createDocumentStore = ({ now = () => Date.now(), ttlMs = 30 * 60 * 1000,
  maxBytes = 64 * 1024 * 1024, maxDocuments = 12 } = {}) => {
  const documents = new Map();
  let bytes = 0;
  const remove = id => { bytes -= documents.get(id).body.length; documents.delete(id); };
  const prune = () => { for (const [id, doc] of documents) if (doc.expiresAt <= now()) remove(id); };
  return {
    put(body, metadata) {
      prune();
      if (!Buffer.isBuffer(body) || body.length > 8 * 1024 * 1024 || body.subarray(0, 5).toString() !== '%PDF-') throw new Error('source_document_not_pdf');
      const id = createHash('sha256').update(body).digest('hex');
      if (documents.has(id)) remove(id);
      while (documents.size && (documents.size >= maxDocuments || bytes + body.length > maxBytes)) remove(documents.keys().next().value);
      if (body.length > maxBytes) throw new Error('source_document_cache_limit');
      documents.set(id, { ...metadata, body, expiresAt: now() + ttlMs }); bytes += body.length;
      return `${AI_DOCUMENT_PATH}${id}.pdf`;
    },
    get(path) {
      prune();
      const id = /^\/api\/ai\/documents\/([a-f0-9]{64})\.pdf$/.exec(path)?.[1];
      return id ? documents.get(id) || null : null;
    }
  };
};
