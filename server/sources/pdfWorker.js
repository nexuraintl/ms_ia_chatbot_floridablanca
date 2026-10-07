import { parentPort, workerData } from 'node:worker_threads';
import { getDocumentProxy } from 'unpdf';
try {
  const pdf = await getDocumentProxy(new Uint8Array(workerData), { maxImageSize: 16_777_216, isEvalSupported: false });
  if (pdf.numPages > 60) throw new Error('pdf_page_limit');
  let text = '';
  for (let i = 1; i <= pdf.numPages && text.length < 60_000; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += `\n[Página ${i}]\n` + content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('');
    page.cleanup();
  }
  await pdf.cleanup?.();
  if (text.replace(/\[Página \d+\]/g, '').trim().length < 40) throw new Error('pdf_requires_ocr');
  parentPort.postMessage({ text: text.slice(0, 60_000), title: 'Documento PDF oficial', links: [] });
} catch (err) { parentPort.postMessage({ error: ['pdf_requires_ocr', 'pdf_page_limit'].includes(err.message) ? err.message : 'pdf_extraction_failed' }); }
