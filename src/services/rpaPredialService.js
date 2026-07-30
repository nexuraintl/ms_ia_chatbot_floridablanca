/**
 * Servicio para consumir la API RPA de Impuesto Predial (Alcaldía de Floridablanca).
 */

const BASE_URL = import.meta.env.VITE_RPA_PREDIAL_API_URL || "http://localhost:8000";

/**
 * Obtiene los municipios disponibles y los tipos de búsqueda válidos para Floridablanca.
 * Endpoint: GET /api/clientes
 */
export const getClientes = async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/clientes`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Error ${response.status}: No se pudo obtener la lista de clientes.`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.warn("⚠️ Servidor RPA no alcanzable. Usando configuración por defecto de Floridablanca:", error.message);
    return {
      status: "success",
      clientes: [
        {
          id: "floridablanca",
          name: "Floridablanca (Santander)",
          search_types: [
            "Código Predial",
            "Número Cuenta",
            "Código NPN",
            "Código NUPRE",
            "Matrícula Inmobiliaria"
          ]
        }
      ]
    };
  }
};

/**
 * Inicia la resolución anticipada del reCAPTCHA (Prewarm).
 * Endpoint: POST /api/prewarm?cliente=floridablanca
 * 
 * @param {string} cliente - Identificador del cliente (por defecto "floridablanca")
 */
export const prewarmCaptcha = async (cliente = "floridablanca") => {
  try {
    const url = `${BASE_URL}/api/prewarm?cliente=${encodeURIComponent(cliente)}`;
    await fetch(url, {
      method: "POST",
      headers: {
        "Accept": "application/json",
      },
    });
  } catch (error) {
    // El prewarm es preventivo y silencioso; no corta el flujo principal
    console.warn("No se pudo iniciar el prewarm del captcha:", error.message);
  }
};

/**
 * Inicia la generación de la factura de predial en modo asíncrono.
 * Endpoint: POST /api/generar_factura?mode=async
 * 
 * @param {Object} payload
 * @param {string} payload.searchType - Tipo de búsqueda (ej. "Código Predial")
 * @param {string} payload.searchValue - Valor buscado (ej. cédula, código, matrícula)
 * @param {string} payload.phone - Celular obligatorio
 * @param {string} payload.email - Email obligatorio
 * @param {string} payload.cliente - Municipio (por defecto "floridablanca")
 */
export const generarFacturaAsync = async ({
  searchType,
  searchValue,
  phone,
  email,
  cliente = "floridablanca"
}) => {
  try {
    const response = await fetch(`${BASE_URL}/api/generar_factura?mode=async`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        search_type: searchType,
        search_value: searchValue,
        phone,
        email,
        cliente,
        mode: "async"
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 422) {
        throw new Error(data.message || `El tipo de búsqueda "${searchType}" no es válido para ${cliente} o faltan campos.`);
      }
      throw new Error(data.message || `Error en el servidor RPA Predial (${response.status})`);
    }

    return data; // { status: "accepted", job_id: "...", poll: "...", stream: "..." }
  } catch (error) {
    console.error("Error al iniciar generación de factura Predial:", error);
    throw error;
  }
};

/**
 * Escucha el stream de eventos SSE en tiempo real para un job determinado.
 * Endpoint: GET /api/jobs/{jobId}/stream
 * 
 * @param {string} jobId - ID del Job
 * @param {Function} onEvent - Callback para cada evento recibido: (evt) => void
 * @param {Function} onError - Callback en caso de error de conexión/stream
 * @returns {Function} - Función de limpieza para cerrar el stream
 */
export const listenJobStream = (jobId, onEvent, onError) => {
  const streamUrl = `${BASE_URL}/api/jobs/${encodeURIComponent(jobId)}/stream`;
  const eventSource = new EventSource(streamUrl);
  const processedEvents = new Set();

  eventSource.onmessage = (e) => {
    if (!e.data) return;
    try {
      const evt = JSON.parse(e.data);
      const eventKey = `${evt.ts || 0}_${evt.event}`;

      // Deduplicar eventos en caso de reconexión SSE
      if (processedEvents.has(eventKey)) return;
      processedEvents.add(eventKey);

      onEvent(evt);

      // Eventos terminales
      if (evt.event === "done" || evt.event === "error" || evt.event === "stream_timeout") {
        eventSource.close();
      }
    } catch (err) {
      console.error("Error al parsear evento SSE Predial:", err);
    }
  };

  eventSource.onerror = (err) => {
    console.error("Error de conexión SSE en Predial:", err);
    if (onError) onError(err);
    eventSource.close();
  };

  return () => {
    eventSource.close();
  };
};

/**
 * Selecciona un predio cuando la búsqueda retornó múltiples resultados.
 * Endpoint: POST /api/seleccionar_predio?mode=async
 * 
 * @param {Object} payload
 * @param {string} payload.sessionId - ID de sesión devuelto en multiple_predios
 * @param {number} payload.index - Índice del predio seleccionado
 * @param {string} payload.phone - Teléfono del usuario
 * @param {string} payload.email - Email del usuario
 * @param {string} payload.mode - Modo de ejecución ("async" por defecto)
 */
export const seleccionarPredio = async ({
  sessionId,
  index,
  phone,
  email,
  mode = "async"
}) => {
  try {
    const response = await fetch(`${BASE_URL}/api/seleccionar_predio?mode=${mode}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        session_id: sessionId,
        index: Number(index),
        phone,
        email,
        mode
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error("La sesión de selección ha expirado por inactividad (>5 min). Por favor realiza la búsqueda de nuevo.");
      }
      if (response.status === 422) {
        throw new Error("El predio seleccionado no es válido. Intenta nuevamente.");
      }
      throw new Error(data.message || `Error al seleccionar predio (${response.status})`);
    }

    return data;
  } catch (error) {
    console.error("Error seleccionando predio:", error);
    throw error;
  }
};

/**
 * Formatea un string de monto numérico a Pesos Colombianos.
 * Ejemplo: "66122546" -> "$ 66.122.546"
 * 
 * @param {string|number} amountStr 
 * @returns {string}
 */
export const formatPesos = (amountStr) => {
  if (!amountStr && amountStr !== 0) return "$0";
  const num = parseInt(String(amountStr).replace(/\D/g, ""), 10);
  if (isNaN(num)) return "$0";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0
  }).format(num);
};

/**
 * Construye la URL completa para descargar una factura en PDF.
 * @param {string} filename 
 */
export const getFacturaPdfUrl = (filename) => {
  if (!filename) return "#";
  return `${BASE_URL}/facturas/${encodeURIComponent(filename)}`;
};
