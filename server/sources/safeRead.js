import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { officialUrl, publicAddress } from './sourcePolicy.js';

const DOCUMENT_PORTAL = 'https://portal.floridablanca.suiteneptuno.com';
/** DNS fijado a la conexión; cada salto se valida. Solo el lector del catálogo
 * puede usar su sesión pública temporal en el endpoint documentado de descarga. */
export const createSafeReader = ({ hosts, lookupImpl = lookup, requestImpl = https.request,
  maxBytes = 4 * 1024 * 1024, timeoutMs = 6000 } = {}) => async (rawUrl, { signal, portalSession, publicDocumentId } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let target = rawUrl;
  for (let hop = 0; hop <= 3; hop++) {
    const safe = officialUrl(target, hosts);
    if (!safe) throw new Error('source_url_rejected');
    const url = new URL(safe);
    const portalRequest = url.origin === DOCUMENT_PORTAL && url.pathname.toLowerCase() === '/documentacion/index';
    const responseLimit = portalSession && url.searchParams.get('handler') === 'DownloadArchivo' ? Math.max(maxBytes, 8 * 1024 * 1024) : maxBytes;
    if ((portalSession || publicDocumentId !== undefined) && !portalRequest) throw new Error('source_session_target_rejected');
    const menuRequest = publicDocumentId !== undefined;
    if (menuRequest && (hop > 0 || url.search !== '?handler=MenuById' || !/^\d{1,8}$/.test(String(publicDocumentId)) ||
        !portalSession?.csrfToken || /[\r\n]/.test(portalSession.csrfToken))) throw new Error('source_document_request_rejected');
    const cookie = portalSession?.cookie || '';
    if (cookie.length > 4096 || /[\r\n]/.test(cookie)) throw new Error('source_session_rejected');
    const form = menuRequest ? new URLSearchParams({ id: String(publicDocumentId), __RequestVerificationToken: portalSession.csrfToken }).toString() : '';
    if (form.length > 4096) throw new Error('source_document_request_rejected');
    let dnsTimer;
    const addresses = await Promise.race([
      lookupImpl(url.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('source_dns_timeout')), Math.max(1, deadline - Date.now())); })
    ]).finally(() => clearTimeout(dnsTimer));
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('source_address_rejected');
    if (signal?.aborted || Date.now() >= deadline) throw new Error('source_timeout');
    const address = addresses[0];
    const result = await new Promise((resolve, reject) => {
      const req = requestImpl(url, { method: menuRequest ? 'POST' : 'GET', signal, headers: {
        'User-Agent': 'florIA/1.0 (official public information)', Accept: 'text/html,application/pdf,text/plain',
        'Accept-Encoding': 'identity',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(menuRequest ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) } : {})
      }, lookup: (_host, options, callback) => options?.all
        ? callback(null, [address]) : callback(null, address.address, address.family) }, res => {
        if ([301,302,303,307,308].includes(res.statusCode)) {
          if (menuRequest) { res.resume(); reject(new Error('source_document_redirect_rejected')); return; }
          res.resume(); resolve({ location: res.headers.location }); return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error('source_http_' + res.statusCode)); return; }
        if (Number(res.headers['content-length']) > responseLimit || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
          res.destroy(); reject(new Error('source_too_large')); return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', chunk => {
          size += chunk.length;
          if (size > responseLimit) { res.destroy(new Error('source_too_large')); return; }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ url: safe, body: Buffer.concat(chunks), contentType: String(res.headers['content-type'] || ''),
          ...(portalRequest ? { publicCookies: (res.headers['set-cookie'] || []).filter(value => /^(?:__RequestVerificationToken(?:_[A-Za-z0-9_-]+)?|ASP\.NET_SessionId|\.AspNetCore\.(?:Antiforgery\.[A-Za-z0-9_-]+|Session))=/.test(value)).map(value => value.split(';')[0]).slice(0,2) } : {}) }));
      });
      req.setTimeout(Math.max(1, deadline - Date.now()), () => req.destroy(new Error('source_timeout')));
      const timer = setTimeout(() => req.destroy(new Error('source_timeout')), Math.max(1, deadline - Date.now()));
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject); req.end(form || undefined);
    });
    if (!result.location) return result;
    target = new URL(result.location, url).href;
  }
  throw new Error('source_redirect_limit');
};
