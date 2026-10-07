import { isIP } from 'node:net';
export const DEFAULT_SOURCE_HOSTS = ['floridablanca.gov.co', '.floridablanca.gov.co',
  'concejomunicipalfloridablanca.gov.co', '.concejomunicipalfloridablanca.gov.co', 'www.dian.gov.co', 'portal.floridablanca.suiteneptuno.com', 'transitofloridablanca.gov.co', 'www.transitofloridablanca.gov.co'];
export const hostAllowed = (host, hosts) => hosts.some(entry => entry.startsWith('.')
  ? host === entry.slice(1) || host.endsWith(entry) : host === entry);
export const officialUrl = (value, hosts = DEFAULT_SOURCE_HOSTS) => {
  try {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      isIP(url.hostname) || !hostAllowed(url.hostname, hosts)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
};
/** Solo direcciones públicas. Se rechazan también IPv4 embebidas en IPv6. */
export const publicAddress = (address) => {
  if (isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18,19,51].includes(b)) || (a === 203 && b === 0));
  }
  const lower = address.toLowerCase();
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/.test(lower) && !lower.startsWith('2001:db8:') && !lower.startsWith('2002:');
};
