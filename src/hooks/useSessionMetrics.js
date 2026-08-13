/**
 * Enlace de React con el registro de métricas de sesión.
 *
 * Se usa `useSyncExternalStore` y no un `useState` + `useEffect` porque el almacén vive
 * FUERA de React: lo escriben los hooks de trámite, el proveedor de IA y las tarjetas de
 * formulario, todos en momentos distintos. `useSyncExternalStore` es la API pensada para
 * ese caso: se suscribe, lee una instantánea estable y garantiza que el valor leído
 * durante el render es coherente con el que se pintará.
 *
 * El almacén memoriza su instantánea (ver `getSnapshot` en `sessionMetrics.js`), que es
 * el requisito de esta API: devolver un objeto nuevo en cada lectura provocaría un
 * bucle infinito de renders.
 */

import { useSyncExternalStore } from "react";
import { sessionMetrics } from "../domain/observability/sessionMetrics.js";

/**
 * @param {ReturnType<import("../domain/observability/sessionMetrics.js").createSessionMetrics>} [store]
 *        Almacén alternativo, para pruebas o para aislar una instancia embebida.
 * @returns {import("../domain/observability/sessionMetrics.js").MetricsSnapshot}
 */
export const useSessionMetrics = (store = sessionMetrics) =>
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
