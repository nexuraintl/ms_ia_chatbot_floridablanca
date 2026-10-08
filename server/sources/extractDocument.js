import { load } from 'cheerio';
import { Worker } from 'node:worker_threads';
import { officialUrl } from './sourcePolicy.js';
export const extractDocument = async ({ url, body, contentType }, hosts, { signal } = {}) => {
  if (body.subarray(0,5).toString() === '%PDF-' || /application\/pdf/.test(contentType)) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./pdfWorker.js', import.meta.url), { workerData: body,
        resourceLimits: { maxOldGenerationSizeMb: 128 }, execArgv: [], stdout: true, stderr: true });
      worker.stdout?.resume(); worker.stderr?.resume();
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('pdf_timeout')); }, 5000);
      const abort = () => { clearTimeout(timer); worker.terminate(); reject(new Error('pdf_aborted')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate(); };
      worker.once('message', result => { finish(); result.error ? reject(new Error(result.error)) : resolve(result); });
      worker.once('error', err => { finish(); reject(err); });
      worker.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error('pdf_worker_exit')); } });
    });
  }
  if (!/text\/(html|plain)|application\/xhtml/.test(contentType)) throw new Error('source_type_rejected');
  const $ = load(body.toString('utf8'));
  $('script,style,noscript,iframe').remove();
  const links = $('a[href]').map((_, node) => {
    try { return { title: ($(node).text().trim() || $(node).attr('title') || $(node).find('img').attr('alt') || '').slice(0,160), url: officialUrl(new URL($(node).attr('href'), url).href, hosts) }; }
    catch { return null; }
  }).get().filter(link => link?.url && link.title).slice(0,1000);
  // Los horarios y canales de atención suelen estar en el pie oficial del portal.
  const contactText = $('footer').text().replace(/\s+/g, ' ').trim().slice(0,4000);
  $('nav,header,footer,form').remove();
  $('tr').each((_, row) => $(row).replaceWith($(row).find('th,td').map((_, cell) => $(cell).text().trim()).get().join(' | ') + '\n'));
  $('p,h1,h2,h3,li,br').each((_, node) => $(node).append('\n'));
  const publicationDate = $('meta[property="article:published_time"],meta[name="DC.date"],meta[name="date"]').first().attr('content') || null;
  return { publicationDate, contactText, title: $('title').text().trim().slice(0,160) || 'Página oficial',
    text: ($('main').text() || $('body').text() || $.root().text()).replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n').trim().slice(0,60_000), links };
};
