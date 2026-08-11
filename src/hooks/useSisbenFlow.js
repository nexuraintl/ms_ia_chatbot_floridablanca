/**
 * Flujo de consulta de Sisbén (actualmente contra el simulador `services/apiMock.js`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTA SOBRE CÓDIGO INALCANZABLE ELIMINADO
 *
 * La función `submitChatForm` original manejaba tres tipos de formulario:
 * `"sisben"`, `"predial"` y `"rpa"`. Solo el primero era alcanzable.
 *
 * Los formularios se crean con la propiedad `form: { type }`, y en todo el proyecto
 * el único sitio que la usaba era `startSisbenFlow` con `type: "sisben"`. El trámite
 * de predial se migró a `customComponent: "predial_form"` (que tiene su propio
 * manejador) y nada creaba nunca un formulario de tipo `"rpa"`.
 *
 * Es decir: las ramas `predial` y `rpa` de `submitChatForm` —unas 45 líneas, incluida
 * una llamada extra a la API de Gemini para redactar la confirmación del robot— eran
 * inalcanzables desde la interfaz. No se trasladan aquí. Las funciones
 * `getPredialInfo` y `runRpaProcess` siguen existiendo en `services/apiMock.js` por si
 * se quieren reconectar; simplemente ya no hay un despachador que finja poder llamarlas.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback } from "react";
import { getSisbenInfo } from "../services/apiMock.js";

/**
 * @param {Object} deps
 * @param {(msg: Object) => string} deps.addMessage
 * @param {(loading: boolean) => void} deps.setIsLoading
 * @param {(delay?: number) => void} deps.scheduleFollowUp
 */
export const useSisbenFlow = ({ addMessage, setIsLoading, scheduleFollowUp }) => {
  /** Muestra el formulario de documento. */
  const startSisben = useCallback(() => {
    addMessage({
      sender: "bot",
      text: "Para consultar tu Sisbén en Floridablanca, ingresa tu número de documento de identidad:",
      form: {
        type: "sisben",
        fields: [
          { name: "documento", placeholder: "Número de cédula o tarjeta", type: "text", required: true }
        ]
      }
    });
  }, [addMessage]);

  /**
   * Procesa el formulario de Sisbén.
   *
   * @param {string} formType
   * @param {{documento: string}} formData
   */
  const submitForm = useCallback(
    async (formType, formData) => {
      if (formType !== "sisben") {
        console.warn(`[Sisbén] Tipo de formulario no soportado: "${formType}".`);
        return;
      }

      setIsLoading(true);
      try {
        const result = await getSisbenInfo(formData.documento);

        addMessage({
          sender: "bot",
          text:
            `Ciudadano: ${result.nombre}. Clasificación Sisbén IV: Grupo ${result.grupo} ` +
            `(${result.clasificacion}). Actualizado el ${result.ultimaActualizacion}.`,
          attachment: {
            type: "image",
            src: result.imagenGrupo,
            label: `Certificado Grupo ${result.grupo}`,
            fileUrl: result.certificadoUrl,
            fileLabel: "📥 Descargar Certificado de Afiliación PDF"
          }
        });
      } catch (error) {
        addMessage({
          sender: "bot",
          text: `⚠️ ${error?.message || "No pude consultar el Sisbén en este momento."}`
        });
      } finally {
        setIsLoading(false);
        scheduleFollowUp();
      }
    },
    [addMessage, setIsLoading, scheduleFollowUp]
  );

  return { startSisben, submitForm };
};
