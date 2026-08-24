/**
 * Adaptador del microservicio RPA de PQRSD (Alcaldía de Floridablanca / Suite Neptuno).
 *
 * Habla con el proxy del backend del chatbot, no con el Cloud Run: el servicio exige un
 * identity token de Google y el navegador no puede acuñar uno. Ver docs/INTEGRACION_RPA.md.
 *
 * Dos detalles del contrato que no se deducen del código de estado:
 *   · `found: false` llega con HTTP 200. Se distingue por el campo, no por el código.
 *   · `anexos` y `flujo` pueden venir vacíos en una consulta exitosa: son accesorios.
 *
 * Usa el cliente HTTP compartido (timeout incluido) y valida los adjuntos antes de enviarlos.
 *
 * Validación de archivos: la versión anterior aceptaba `Array.from(e.target.files)`
 * sin comprobar nada —cualquier tipo, cualquier tamaño, cualquier cantidad— y lo
 * enviaba directo al backend. La validación de cliente no sustituye a la del servidor,
 * pero evita que un ciudadano espere dos minutos por una subida que el backend va a
 * rechazar, y acota el uso de ancho de banda.
 */

import { get, post, HttpError } from "../adapters/http/httpClient.js";
import { environment } from "../config/environment.js";

const BASE_URL = environment.pqrsdApiUrl;

/** Timeout amplio: el RPA opera contra el portal municipal. */
const RPA_TIMEOUT_MS = 60_000;

/** Radicar con anexos tarda más: hay hasta 25 MB que subir antes de que el RPA empiece. */
const CREATE_TIMEOUT_MS = 180_000;

/** Restricciones de los archivos adjuntos. */
export const FILE_CONSTRAINTS = Object.freeze({
  // Los del servicio. Excederlos da 413, así que validarlos aquí ahorra una subida perdida.
  maxFiles: 10,
  maxBytesPerFile: 10 * 1024 * 1024,  // 10 MB
  maxTotalBytes: 25 * 1024 * 1024,    // 25 MB
  allowedExtensions: ["pdf", "jpg", "jpeg", "png", "doc", "docx", "xls", "xlsx", "txt"],
  allowedMimeTypes: [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain"
  ]
});

/**
 * Catálogos por defecto si el microservicio no responde, para que el formulario
 * siga siendo utilizable.
 */
const FALLBACK_CATALOGOS = Object.freeze({
  success: false,
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
});

/**
 * Valida un conjunto de archivos contra las restricciones declaradas.
 *
 * @param {File[]} files
 * @returns {{ valid: boolean, error: string|null }}
 */
export const validateAttachments = (files) => {
  const list = Array.from(files || []);
  if (list.length === 0) return { valid: true, error: null };

  if (list.length > FILE_CONSTRAINTS.maxFiles) {
    return {
      valid: false,
      error: `Puedes adjuntar como máximo ${FILE_CONSTRAINTS.maxFiles} archivos.`
    };
  }

  let total = 0;
  for (const file of list) {
    total += file.size;

    if (file.size > FILE_CONSTRAINTS.maxBytesPerFile) {
      const mb = (FILE_CONSTRAINTS.maxBytesPerFile / 1024 / 1024).toFixed(0);
      return { valid: false, error: `"${file.name}" supera el límite de ${mb} MB por archivo.` };
    }

    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const extOk = FILE_CONSTRAINTS.allowedExtensions.includes(ext);
    // El tipo MIME que informa el navegador es orientativo, no una garantía: se acepta
    // vacío (algunos navegadores no lo rellenan) pero se rechaza si es uno no permitido.
    const mimeOk = !file.type || FILE_CONSTRAINTS.allowedMimeTypes.includes(file.type);

    if (!extOk || !mimeOk) {
      return {
        valid: false,
        error: `"${file.name}" no es un tipo permitido. Se aceptan: ${FILE_CONSTRAINTS.allowedExtensions.join(", ")}.`
      };
    }
  }

  if (total > FILE_CONSTRAINTS.maxTotalBytes) {
    const mb = (FILE_CONSTRAINTS.maxTotalBytes / 1024 / 1024).toFixed(0);
    return { valid: false, error: `El total de los adjuntos supera ${mb} MB.` };
  }

  return { valid: true, error: null };
};

/**
 * Catálogos de tipos de correspondencia y dependencias.
 * Endpoint: GET /v1/pqrsd/catalogos
 *
 * @returns {Promise<Object>}
 */
export const getCatalogos = async () => {
  try {
    return await get(`${BASE_URL}/v1/pqrsd/catalogos`);
  } catch (error) {
    console.warn("[PQRSD] Catálogos no disponibles, usando valores por defecto:", error?.message);
    return { ...FALLBACK_CATALOGOS, error: error?.message };
  }
};

/**
 * Consulta el estado, anexos y trazabilidad de un radicado.
 * Endpoint: POST /v1/pqrsd/consultar
 *
 * El par (radicado, código de autenticación) es la credencial que da acceso al
 * expediente completo del ciudadano, así que nunca se registra en consola.
 *
 * @param {string} radicado
 * @param {string} codigoAutenticacion
 * @returns {Promise<Object>}
 */
export const consultarPqrsd = async (radicado, codigoAutenticacion) => {
  try {
    return await post(
      `${BASE_URL}/v1/pqrsd/consultar`,
      {
        radicado: String(radicado).trim(),
        codigo_autenticacion: String(codigoAutenticacion).trim()
      },
      { timeoutMs: RPA_TIMEOUT_MS }
    );
  } catch (error) {
    // Sin datos de la consulta en el log: son credenciales del ciudadano.
    console.error(`[PQRSD] Fallo en consulta (status=${error?.status ?? "n/d"})`);

    // `cause` preserva el error original para depuración sin que su texto llegue al
    // ciudadano: solo se muestra el `message`, nunca la causa.
    if (error?.status === 422) {
      throw new Error(
        "Verifica que hayas ingresado correctamente el Radicado y el Código de Autenticación.",
        { cause: error }
      );
    }
    if (error?.status === 502) {
      throw new Error(
        "El portal oficial de la Alcaldía no se encuentra disponible temporalmente. Inténtalo más tarde.",
        { cause: error }
      );
    }
    throw new Error(
      error instanceof HttpError && error.publicMessage
        ? error.publicMessage
        : "No pude consultar la PQRSD en este momento. Intenta de nuevo en unos minutos.",
      { cause: error }
    );
  }
};

/**
 * Radica una nueva PQRSD, con adjuntos opcionales.
 * Endpoint: POST /v1/pqrsd/crear
 *
 * Genera un trámite oficial real que alguien tendrá que atender y que no se puede anular.
 * Esta llamada no se reintenta nunca de forma automática.
 *
 * @param {Object} params
 * @returns {Promise<Object>}
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
  const validation = validateAttachments(archivos);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

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
  for (const file of Array.from(archivos)) {
    formData.append("archivos", file);
  }

  try {
    // `httpClient` detecta FormData y no fija Content-Type, para preservar el boundary.
    // Timeout propio: 25 MB de anexos no caben en el de una consulta.
    return await post(`${BASE_URL}/v1/pqrsd/crear`, formData, {
      timeoutMs: CREATE_TIMEOUT_MS
    });
  } catch (error) {
    console.error(`[PQRSD] Fallo al radicar (status=${error?.status ?? "n/d"})`);

    if (error?.status === 413) {
      const mb = (FILE_CONSTRAINTS.maxTotalBytes / 1024 / 1024).toFixed(0);
      throw new Error(`Los archivos adjuntos superan el límite de ${mb} MB en total.`, {
        cause: error
      });
    }
    if (error?.status === 422) {
      throw new Error("Faltan campos obligatorios o la información ingresada no es válida.", {
        cause: error
      });
    }
    if (error?.status === 502) {
      // Nunca reintentar aquí: el radicado pudo quedar creado en el portal y un reenvío lo
      // duplicaría. Hay que verificar antes de volver a intentarlo. Ver docs, regla 1.
      throw new Error(
        "No se pudo confirmar el radicado con la plataforma municipal. Antes de volver a " +
          "enviarlo, consulta si ya quedó registrado: reenviarlo podría duplicar el trámite.",
        { cause: error }
      );
    }
    throw new Error(
      error instanceof HttpError && error.publicMessage
        ? error.publicMessage
        : "No pude radicar la PQRSD en este momento. Intenta de nuevo en unos minutos.",
      { cause: error }
    );
  }
};
