import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { officialUrl, publicAddress } from './sourcePolicy.js';

/** DNS fijado a la conexión; cada salto se valida de nuevo, sin cookies ni credenciales. */
export const createSafeReader = ({ hosts, lookupImpl = lookup, requestImpl = https.request,
  maxBytes = 4 * 1024 * 1024, timeoutMs = 6000 } = {}) => async (rawUrl, { signal } = {}) => {
  const deadline = Date.now() + timeoutMs;
  let target = rawUrl;
  for (let hop = 0; hop <= 3; hop++) {
    const safe = officialUrl(target, hosts);
    if (!safe) throw new Error('source_url_rejected');
    const url = new URL(safe);
    let dnsTimer;
    const addresses = await Promise.race([
      lookupImpl(url.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('source_dns_timeout')), Math.max(1, deadline - Date.now())); })
    ]).finally(() => clearTimeout(dnsTimer));
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('source_address_rejected');
    if (signal?.aborted || Date.now() >= deadline) throw new Error('source_timeout');
    const address = addresses[0];
    const result = await new Promise((resolve, reject) => {
      const req = requestImpl(url, { method: 'GET', signal, headers: {
        'User-Agent': 'florIA/1.0 (official public information)', Accept: 'text/html,application/pdf,text/plain',
        'Accept-Encoding': 'identity'
      }, lookup: (_host, options, callback) => options?.all
        ? callback(null, [address]) : callback(null, address.address, address.family) }, res => {
        if ([301,302,303,307,308].includes(res.statusCode)) {
          res.resume(); resolve({ location: res.headers.location }); return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error('source_http_' + res.statusCode)); return; }
        if (Number(res.headers['content-length']) > maxBytes || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
          res.destroy(); reject(new Error('source_too_large')); return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) { res.destroy(new Error('source_too_large')); return; }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ url: safe, body: Buffer.concat(chunks), contentType: String(res.headers['content-type'] || '') }));
      });
      req.setTimeout(Math.max(1, deadline - Date.now()), () => req.destroy(new Error('source_timeout')));
      const timer = setTimeout(() => req.destroy(new Error('source_timeout')), Math.max(1, deadline - Date.now()));
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject); req.end();
    });
    if (!result.location) return result;
    target = new URL(result.location, url).href;
  }
  throw new Error('source_redirect_limit');
};
