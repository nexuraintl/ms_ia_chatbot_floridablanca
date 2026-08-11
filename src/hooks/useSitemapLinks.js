/**
 * Carga en segundo plano de los enlaces del portal anfitrión.
 *
 * Extraído del `useEffect` de 95 líneas que había en `ChatContext.jsx`. Aquí solo
 * queda el ciclo de vida de React; la recolección vive en
 * `adapters/browser/sitemapRepository.js`.
 *
 * Se añade una guarda de montaje que la versión anterior no tenía: la carga recorre
 * hasta cuatro rutas HTTP, y si el widget se desmonta mientras está en curso el
 * `setState` posterior provocaba una advertencia de React y una fuga.
 */

import { useEffect, useState } from "react";
import { createSitemapRepository } from "../adapters/browser/sitemapRepository.js";

/**
 * @returns {{ sitemapLinks: {title: string, url: string}[], isLoading: boolean }}
 */
export const useSitemapLinks = () => {
  const [sitemapLinks, setSitemapLinks] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    const repository = createSitemapRepository();

    repository
      .load()
      .then((links) => {
        if (!isMounted) return;
        setSitemapLinks(links);
        if (links.length > 0) {
          console.info(`🗺️ [Sitemap] ${links.length} enlaces del portal disponibles para el contexto.`);
        }
      })
      .catch((error) => {
        // Un fallo aquí solo degrada la calidad de las sugerencias de enlaces.
        console.warn("⚠️ [Sitemap] No se pudieron cargar los enlaces del portal:", error?.message);
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  return { sitemapLinks, isLoading };
};
