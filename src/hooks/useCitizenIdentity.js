/**
 * Captura de la identidad del ciudadano, configurable por tenant.
 *
 * Modos (`chatbotConfig.json > identity.mode`):
 *
 *   · `off`             — no se piden datos. La conversación queda anónima.
 *   · `progressive`     — se piden solo al entrar a un trámite que los necesita
 *                         (Predial, PQRSD). No hay barrera en el mensaje inicial.
 *   · `gate_skippable`  — se piden al abrir el chat, con opción de continuar sin ellos.
 *   · `gate`            — se piden al abrir el chat y el teclado permanece bloqueado
 *                         hasta que se entreguen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA IDENTIDAD NO SE GUARDA EN EL NAVEGADOR
 *
 * Nombre y correo viven únicamente en memoria durante la sesión. No van a
 * `localStorage` ni a `sessionStorage` a propósito: el widget se embebe en portales de
 * terceros, así que ese almacenamiento pertenece al origen del portal anfitrión y su
 * JavaScript podría leerlo. Guardar ahí datos personales del ciudadano sería
 * entregárselos a un tercero sin que nadie lo autorizara.
 *
 * La consecuencia es que al recargar se vuelven a pedir. Es el precio correcto: la copia
 * que debe persistir es la del servidor, que sí está bajo control de la Alcaldía.
 *
 * Sí se conserva el `conversationId` en `sessionStorage`, porque es un identificador
 * opaco sin información personal, y permite que una recarga siga escribiendo en la
 * misma conversación en lugar de partir el registro en dos.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useMemo, useState } from "react";
import { createIdentity, validateIdentity } from "../domain/identity/citizenIdentity.js";
import { createConsentRecord, DEFAULT_PURPOSES } from "../domain/consent/consentRecord.js";

/** Modos válidos. */
export const IDENTITY_MODES = Object.freeze({
  OFF: "off",
  PROGRESSIVE: "progressive",
  GATE_SKIPPABLE: "gate_skippable",
  GATE: "gate"
});

/** Flujos que requieren datos de contacto porque notifican un resultado. */
const FLOWS_REQUIRING_IDENTITY = new Set(["predial", "pqrsd_crear"]);

/**
 * @param {Object} params
 * @param {Object} params.config  `chatbotConfig.json`
 */
export const useCitizenIdentity = ({ config }) => {
  const settings = config.identity || {};
  const mode = Object.values(IDENTITY_MODES).includes(settings.mode)
    ? settings.mode
    : IDENTITY_MODES.OFF;

  const [identity, setIdentity] = useState(null);
  const [consent, setConsent] = useState(null);

  /** El ciudadano decidió continuar sin identificarse (solo en `gate_skippable`). */
  const [skipped, setSkipped] = useState(false);

  /** Flujo que quedó en espera de los datos, para reanudarlo tras entregarlos. */
  const [pendingFlowId, setPendingFlowId] = useState(null);

  /**
   * ¿Hay que mostrar el formulario al abrir el chat?
   * Solo en los modos de puerta, y mientras no se hayan dado los datos ni se haya
   * omitido de forma explícita.
   */
  const isGateVisible =
    (mode === IDENTITY_MODES.GATE || mode === IDENTITY_MODES.GATE_SKIPPABLE) &&
    !identity &&
    !skipped;

  /** ¿El teclado debe estar bloqueado? Solo la puerta estricta bloquea. */
  const isInputBlocked = mode === IDENTITY_MODES.GATE && !identity;

  /**
   * ¿Este flujo necesita los datos antes de arrancar?
   * @param {string|null} flowId
   * @returns {boolean}
   */
  const flowRequiresIdentity = useCallback(
    (flowId) => {
      if (mode === IDENTITY_MODES.OFF) return false;
      if (identity) return false;
      // En los modos de puerta, quien la omitió no debería volver a ser interrumpido
      // salvo que el trámite lo exija de verdad, que es justamente este caso.
      return FLOWS_REQUIRING_IDENTITY.has(String(flowId));
    },
    [mode, identity]
  );

  /**
   * Registra la identidad junto con la autorización de tratamiento.
   *
   * @param {{name: string, email: string}} input
   * @returns {{ ok: boolean, errors?: Object }}
   */
  const submitIdentity = useCallback(
    (input) => {
      const { valid, errors } = validateIdentity(input);
      if (!valid) return { ok: false, errors };

      const newIdentity = createIdentity(input);

      // La autorización se registra con el texto EXACTO que se mostró, para poder
      // acreditar después a qué dio su consentimiento la persona.
      const newConsent = createConsentRecord({
        noticeText: settings.consentText || "",
        purposes: DEFAULT_PURPOSES,
        mechanism: "formulario_identidad"
      });

      setIdentity(newIdentity);
      setConsent(newConsent);
      setSkipped(false);

      const resumedFlow = pendingFlowId;
      setPendingFlowId(null);

      return { ok: true, identity: newIdentity, resumedFlow };
    },
    [settings.consentText, pendingFlowId]
  );

  /** El ciudadano continúa sin identificarse. */
  const skipIdentity = useCallback(() => {
    setSkipped(true);
    setPendingFlowId(null);
  }, []);

  /** Deja un flujo en espera mientras se piden los datos. */
  const requestIdentityForFlow = useCallback((flowId) => {
    setPendingFlowId(flowId);
  }, []);

  /** Reinicia todo (al reiniciar la conversación). */
  const reset = useCallback(() => {
    setIdentity(null);
    setConsent(null);
    setSkipped(false);
    setPendingFlowId(null);
  }, []);

  /**
   * Valores con los que prellenar los formularios de trámite, para no pedir dos veces
   * lo mismo.
   */
  const prefill = useMemo(
    () => ({ name: identity?.name || "", email: identity?.email || "" }),
    [identity]
  );

  return {
    mode,
    identity,
    consent,
    isGateVisible,
    isInputBlocked,
    isSkippable: mode === IDENTITY_MODES.GATE_SKIPPABLE,
    pendingFlowId,
    settings,
    prefill,
    flowRequiresIdentity,
    requestIdentityForFlow,
    submitIdentity,
    skipIdentity,
    reset
  };
};
