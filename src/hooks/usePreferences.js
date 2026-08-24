/**
 * Preferencias persistentes del operador: clave de API, tema y módulos activos.
 *
 * Extraído de `ChatContext.jsx`, donde el acceso a `localStorage` estaba directo y sin
 * protección frente a excepciones.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CAMBIO DE SEGURIDAD — LA CLAVE YA NO SE LEE DEL ENTORNO DE COMPILACIÓN
 *
 * Antes:
 *     localStorage.getItem("gemini_api_key") || import.meta.env.VITE_GEMINI_API_KEY || ""
 *
 * Ese `import.meta.env.VITE_GEMINI_API_KEY` es el problema. Vite sustituye las
 * variables `VITE_*` por su valor LITERAL al compilar, así que la credencial quedaba
 * incrustada en `dist/assets/*.js`, un archivo estático que cualquiera puede
 * descargar. Se verificó compilando con una clave de prueba: aparecía en claro.
 *
 * Ahora la clave solo puede entrar por la consola y vive en el navegador de quien la
 * escribe. Sigue siendo visible para esa persona —es inevitable en una llamada
 * directa desde el cliente— pero deja de publicarse a todo internet en cada despliegue.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useMemo, useState } from "react";
import { createStorage, STORAGE_KEYS } from "../adapters/browser/localStorageAdapter.js";

/**
 * Valida la sintaxis aproximada de una clave de Google AI Studio.
 * @param {unknown} key
 * @returns {boolean}
 */
export const isValidGeminiApiKey = (key) => {
  if (typeof key !== "string") return false;
  return /^AIzaSy[A-Za-z0-9_-]{30,50}$/.test(key.trim());
};

export const usePreferences = () => {
  const storage = useMemo(() => createStorage(), []);

  // La clave NUNCA se inicializa desde import.meta.env: ver nota de cabecera.
  const [apiKey, setApiKey] = useState(() => storage.get(STORAGE_KEYS.apiKey) || "");
  const [theme, setThemeState] = useState(() => storage.get(STORAGE_KEYS.theme) || "light");

  // Los interruptores de módulo son de sesión, no persistentes: son un control de
  // demostración y no deberían sobrevivir a una recarga sin que nadie lo note.
  const [isGeminiEnabled, setIsGeminiEnabled] = useState(true);
  const [isServicesEnabled, setIsServicesEnabled] = useState(true);

  const updateApiKey = useCallback(
    (key) => {
      const trimmed = String(key ?? "").trim();
      setApiKey(trimmed);
      if (trimmed) {
        storage.set(STORAGE_KEYS.apiKey, trimmed);
      } else {
        storage.remove(STORAGE_KEYS.apiKey);
      }
    },
    [storage]
  );

  const setTheme = useCallback(
    (next) => {
      const value = next === "dark" ? "dark" : "light";
      setThemeState(value);
      storage.set(STORAGE_KEYS.theme, value);
    },
    [storage]
  );

  const toggleTheme = useCallback(() => {
    setTheme(theme === "light" ? "dark" : "light");
  }, [theme, setTheme]);

  return {
    apiKey,
    updateApiKey,
    isApiKeyValid: isValidGeminiApiKey(apiKey),
    theme,
    setTheme,
    toggleTheme,
    isGeminiEnabled,
    setIsGeminiEnabled,
    isServicesEnabled,
    setIsServicesEnabled,
    isStoragePersistent: storage.isPersistent
  };
};
