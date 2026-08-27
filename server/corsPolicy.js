/**
 * Autorización de origen para los endpoints que no son estáticos.
 *
 * Estaba dentro de `aiProxy.js`. Se extrae porque el proxy de los RPA necesita la misma
 * decisión y con los mismos criterios: duplicarla llevaría a que una se endurezca y la
 * otra no.
 */

/**
 * ¿El origen está autorizado a llamar al proxy? En orden: mismo origen que el servidor,
 * coincidencia con `ALLOWED_ORIGINS` (una entrada con punto inicial es comodín de sufijo,
 * misma convención que `security.allowedLinkHosts`), o localhost en ambiente local.
 *
 * Nunca se responde con `*`: estos endpoints gastan dinero o mueven datos personales, así
 * que quién puede invocarlos es parte del control.
 *
 * @param {string|undefined} origin
 * @param {string|undefined} host
 * @param {{allowedOrigins: string[], isLocal: boolean}} config
 * @returns {boolean}
 */
export const isOriginAllowed = (origin, host, config) => {
  // Sin cabecera `Origin`: no es una petición de navegador entre orígenes (curl, una
  // prueba, un servidor). No hay nada que autorizar por CORS.
  if (!origin) return true;

  let hostname;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (host && String(host).toLowerCase().split(":")[0] === hostname) return true;

  if (config.isLocal && ["localhost", "127.0.0.1", "::1"].includes(hostname)) return true;

  return config.allowedOrigins.some((entry) => {
    if (entry.startsWith(".")) return hostname === entry.slice(1) || hostname.endsWith(entry);
    // Se admite tanto `https://portal.gov.co` como `portal.gov.co` en la variable.
    try {
      return new URL(entry).hostname === hostname;
    } catch {
      return entry === hostname;
    }
  });
};
