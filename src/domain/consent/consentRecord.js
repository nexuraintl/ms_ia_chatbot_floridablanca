/**
 * Registro de autorización de tratamiento de datos. Capa de dominio.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ESTO ES UN MÓDULO Y NO UN BOOLEANO
 *
 * La Ley 1581 de 2012 exige autorización **previa, expresa e informada**, y —lo que
 * suele olvidarse— exige poder **demostrar** que se obtuvo. Un `consentGiven: true`
 * no demuestra nada: no dice cuándo, ni a qué texto, ni para qué finalidades.
 *
 * Si mañana un ciudadano reclama ante la Superintendencia de Industria y Comercio,
 * lo que hay que poder mostrar es: qué texto exacto aceptó, en qué momento, y para
 * qué finalidades. Por eso el aviso de privacidad está **versionado**: si cambia su
 * redacción, las autorizaciones antiguas siguen apuntando a la versión que la persona
 * realmente leyó.
 *
 * Este registro se adjunta a la conversación persistida y viaja con ella.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Versión del aviso de privacidad vigente.
 *
 * INCREMENTAR cada vez que cambie el texto del aviso en `chatbotConfig.json`.
 * Las autorizaciones ya registradas conservan la versión con la que se otorgaron.
 */
export const PRIVACY_NOTICE_VERSION = "2026-08-11.v1";

/**
 * Finalidades para las que se solicita autorización.
 * Deben ser específicas: "para lo que sea necesario" no es una finalidad válida bajo
 * la Ley 1581, que exige informar el propósito concreto del tratamiento.
 */
export const PURPOSES = Object.freeze({
  ATTEND_REQUEST: "atender_solicitud",
  NOTIFY_RESULT: "notificar_resultado",
  KEEP_RECORD: "conservar_registro_atencion"
});

/** Descripciones legibles, para mostrarlas al ciudadano en el formulario. */
export const PURPOSE_LABELS = Object.freeze({
  [PURPOSES.ATTEND_REQUEST]: "Atender tu consulta o trámite",
  [PURPOSES.NOTIFY_RESULT]: "Notificarte el resultado por correo electrónico",
  [PURPOSES.KEEP_RECORD]: "Conservar el registro de la atención prestada"
});

/** Finalidades por defecto de una conversación con captura de identidad. */
export const DEFAULT_PURPOSES = Object.freeze([
  PURPOSES.ATTEND_REQUEST,
  PURPOSES.NOTIFY_RESULT,
  PURPOSES.KEEP_RECORD
]);

/**
 * @typedef {Object} ConsentRecord
 * @property {string} noticeVersion   Versión del aviso que la persona aceptó.
 * @property {string} acceptedAt      Marca de tiempo ISO de la aceptación.
 * @property {string[]} purposes      Finalidades autorizadas.
 * @property {"formulario_identidad"|"uso_del_chat"} mechanism  Cómo se obtuvo.
 * @property {string} noticeChecksum  Huella del texto exacto mostrado.
 */

/**
 * Huella simple y estable del texto del aviso.
 *
 * Es un hash no criptográfico (FNV-1a de 32 bits): sirve para detectar que el texto
 * cambió sin haber subido la versión, no para resistir un ataque. Se prefiere a
 * `crypto.subtle.digest` porque este módulo debe ser sincrónico y funcionar también
 * fuera de un navegador (pruebas en Node).
 *
 * @param {string} text
 * @returns {string}
 */
export const checksumNotice = (text) => {
  const str = String(text ?? "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-${hash.toString(16).padStart(8, "0")}`;
};

/**
 * Crea un registro de autorización.
 *
 * @param {Object} params
 * @param {string} params.noticeText  Texto EXACTO que se le mostró al ciudadano.
 * @param {string[]} [params.purposes]
 * @param {"formulario_identidad"|"uso_del_chat"} [params.mechanism]
 * @param {string} [params.acceptedAt]
 * @returns {ConsentRecord}
 */
export const createConsentRecord = ({
  noticeText,
  purposes = DEFAULT_PURPOSES,
  mechanism = "formulario_identidad",
  acceptedAt = new Date().toISOString()
}) => ({
  noticeVersion: PRIVACY_NOTICE_VERSION,
  acceptedAt,
  purposes: [...purposes],
  mechanism,
  noticeChecksum: checksumNotice(noticeText)
});

/**
 * ¿La autorización cubre una finalidad concreta?
 * @param {ConsentRecord|null} consent
 * @param {string} purpose
 * @returns {boolean}
 */
export const covers = (consent, purpose) => Boolean(consent?.purposes?.includes(purpose));

/**
 * ¿La autorización corresponde al aviso vigente?
 * Si devuelve false, hay que volver a solicitarla: el texto cambió desde que se otorgó.
 *
 * @param {ConsentRecord|null} consent
 * @returns {boolean}
 */
export const isCurrent = (consent) => consent?.noticeVersion === PRIVACY_NOTICE_VERSION;
