/**
 * Servicio para consumir los endpoints del microservicio RPA de PQRSD
 * (Alcaldía de Floridablanca / Suite Neptuno).
 */

const BASE_URL = import.meta.env.VITE_RPA_PQRSD_API_URL || "http://localhost:8000";

/**
 * Obtiene la lista de catálogos (Tipos de correspondencia y Dependencias/Áreas).
 * Endpoint: GET /api/v1/pqrsd/catalogos
 */
export const getCatalogos = async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/pqrsd/catalogos`, {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Error ${response.status}: No se pudieron cargar los catálogos de PQRSD.`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error al consultar catálogos PQRSD:", error);
    // Retornar catálogos por defecto si el servidor falla o está inaccesible
    return {
      success: false,
      error: error.message,
      tipos_correspondencia: [
        { Id: 6, Nombre: "Petición" },
        { Id: 7, Nombre: "Queja" },
        { Id: 8, Nombre: "Reclamo" },
        { Id: 9, Nombre: "Sugerencia" },
        { Id: 10, Nombre: "Denuncia" }
      ],
      dependencias_areas: [
        { Id: 8, Nombre: "Secretaría General" },
        { Id: 1, Nombre: "Despacho del Alcalde" },
        { Id: 2, Nombre: "Secretaría de Gobierno" },
        { Id: 3, Nombre: "Secretaría de Hacienda" },
        { Id: 4, Nombre: "Secretaría de Infraestructura" }
      ]
    };
  }
};

/**
 * Consulta el estado, detalles, anexos y flujo de trazabilidad de un radicado.
 * Endpoint: POST /api/v1/pqrsd/consultar
 * 
 * @param {string} radicado - Número de radicado (ej: "2026488450")
 * @param {string} codigoAutenticacion - Código de autenticación (ej: "202UhXbRIu2026488450")
 */
export const consultarPqrsd = async (radicado, codigoAutenticacion) => {
  try {
    const response = await fetch(`${BASE_URL}/api/v1/pqrsd/consultar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        radicado: String(radicado).trim(),
        codigo_autenticacion: String(codigoAutenticacion).trim(),
      }),
    });

    if (!response.ok) {
      if (response.status === 422) {
        throw new Error("Por favor verifica que hayas ingresado correctamente el Radicado y el Código de Autenticación.");
      }
      if (response.status === 502) {
        throw new Error("El portal oficial de la Alcaldía no se encuentra disponible temporalmente. Inténtalo más tarde.");
      }
      throw new Error(`Error en el servicio PQRSD (${response.status})`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error consultando PQRSD:", error);
    throw error;
  }
};

/**
 * Radica una nueva PQRSD enviando datos y archivos adjuntos vía multipart/form-data.
 * Endpoint: POST /api/v1/pqrsd/crear
 * 
 * @param {Object} params - Datos de la solicitud PQRSD
 */
export const crearPqrsd = async ({
  asunto,
  email,
  telefonoCelular,
  esAnonimo = true,
  numeroIdentificacion = "",
  placa = "",
  tipoCorrespondenciaObj = { Id: 6, Nombre: "Petición" },
  dependenciaObj = { Id: 8, Nombre: "Secretaría General" },
  archivos = []
}) => {
  try {
    const formData = new FormData();

    formData.append("asunto", asunto);
    formData.append("email", email);
    formData.append("telefono_celular", telefonoCelular);
    formData.append("es_anonimo", String(esAnonimo));

    if (tipoCorrespondenciaObj) {
      formData.append("tipo_correspondencia_json_str", JSON.stringify(tipoCorrespondenciaObj));
    }
    if (dependenciaObj) {
      formData.append("dependencia_json_str", JSON.stringify(dependenciaObj));
    }
    if (!esAnonimo && numeroIdentificacion) {
      formData.append("numero_identificacion", numeroIdentificacion);
    }
    if (placa) {
      formData.append("placa", placa);
    }

    // Adjuntar archivos si existen
    if (archivos && archivos.length > 0) {
      for (let i = 0; i < archivos.length; i++) {
        formData.append("archivos", archivos[i]);
      }
    }

    const response = await fetch(`${BASE_URL}/api/v1/pqrsd/crear`, {
      method: "POST",
      body: formData, // No definir Content-Type manualmente para preservar boundary
    });

    if (!response.ok) {
      if (response.status === 422) {
        throw new Error("Faltan campos obligatorios o la información ingresada no es válida.");
      }
      if (response.status === 502) {
        throw new Error("No se pudo conectar con la plataforma municipal para generar el radicado.");
      }
      throw new Error(`Error en el registro PQRSD (${response.status})`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error("Error creando PQRSD:", error);
    throw error;
  }
};
