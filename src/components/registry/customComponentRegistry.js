/**
 * Registro de componentes interactivos que pueden incrustarse en una burbuja de chat.
 *
 * ANTES `ChatBubble` tenía cinco bloques como este:
 *
 *     {customComponent === "pqrsd_crear"      && <PqrsdCreateCard />}
 *     {customComponent === "pqrsd_consult"    && <PqrsdConsultCard />}
 *     {customComponent === "pqrsd_result"     && <PqrsdResultCard data={message.pqrsdData} />}
 *     {customComponent === "predial_form"     && <PredialForm onSubmit={…} />}
 *     {customComponent === "predial_multiples" && <PredioCardList … />}
 *
 * Añadir una tarjeta obligaba a editar `ChatBubble`, que además tenía que importar
 * todos los componentes de trámite y conocer los props de cada uno. Es decir, un
 * componente de presentación genérico acoplado a cada caso de negocio concreto.
 *
 * AHORA la relación nombre -> componente es un dato. `ChatBubble` busca en el mapa y
 * renderiza; no importa ninguna tarjeta ni sabe qué props necesita cada una. Registrar
 * una tarjeta nueva es añadir una entrada aquí (principio abierto/cerrado).
 */

import { PqrsdCreateCard } from "../molecules/PqrsdCreateCard";
import { PqrsdConsultCard } from "../molecules/PqrsdConsultCard";
import { PqrsdResultCard } from "../molecules/PqrsdResultCard";
import { PredialForm } from "../molecules/PredialForm";
import { PredioCardList } from "../molecules/PredioCardList";
import { IdentityCardConnected } from "../molecules/IdentityCardConnected";

/**
 * @typedef {Object} CustomComponentEntry
 * @property {React.ComponentType<any>} Component
 * @property {(message: Object, handlers: Object) => Object} mapProps
 *           Traduce el mensaje y los manejadores a los props del componente. Mantener
 *           esta traducción aquí evita que `ChatBubble` conozca la forma de cada tarjeta.
 */

/** @type {Record<string, CustomComponentEntry>} */
export const CUSTOM_COMPONENTS = {
  identity_form: {
    Component: IdentityCardConnected,
    mapProps: () => ({})
  },

  pqrsd_crear: {
    Component: PqrsdCreateCard,
    mapProps: () => ({})
  },

  pqrsd_consult: {
    Component: PqrsdConsultCard,
    mapProps: () => ({})
  },

  pqrsd_result: {
    Component: PqrsdResultCard,
    mapProps: (message) => ({ data: message.pqrsdData })
  },

  predial_form: {
    Component: PredialForm,
    mapProps: (_message, handlers) => ({ onSubmit: handlers.onSubmitPredialForm })
  },

  predial_multiples: {
    Component: PredioCardList,
    mapProps: (message, handlers) => ({
      sessionId: message.sessionId,
      predios: message.predios,
      onSelectPredio: handlers.onSelectPredio
    })
  }
};

/**
 * Resuelve el componente correspondiente a un mensaje.
 *
 * @param {string|undefined} name
 * @returns {CustomComponentEntry|null}
 */
export const resolveCustomComponent = (name) => {
  if (!name) return null;
  const entry = CUSTOM_COMPONENTS[name];
  if (!entry) {
    console.warn(`[ChatBubble] No hay componente registrado para "${name}".`);
    return null;
  }
  return entry;
};
