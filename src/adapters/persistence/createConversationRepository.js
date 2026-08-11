/**
 * Fábrica del repositorio de conversaciones. Único punto donde se decide DÓNDE se
 * guarda el registro de atención.
 *
 * Mientras el destino real no esté definido, la aplicación funciona igual: cambia el
 * adaptador, no el código que lo usa. Para apuntar al backend definitivo basta definir
 * `VITE_CONVERSATION_API_URL` al compilar; no hay que tocar ningún otro archivo.
 *
 * Modos disponibles:
 *
 *   · `off`      — no se persiste nada. Es el valor por defecto: no se envían datos
 *                  personales a ninguna parte hasta que alguien lo configure a propósito.
 *   · `console`  — imprime en consola exactamente lo que se enviaría. Sirve para
 *                  revisar el contrato y el contenido de los registros sin backend.
 *   · `http`     — envía a un endpoint HTTP, con cola durable y reintentos.
 *
 * Se elige `off` por defecto de forma deliberada. Lo contrario —que un despliegue
 * empiece a acumular conversaciones con nombre y correo porque nadie desactivó la
 * persistencia— es el tipo de error que en un proyecto público sale caro.
 */

import {
  assertImplementsConversationRepository,
  nullConversationRepository
} from "../../ports/ConversationRepositoryPort.js";
import { createHttpConversationRepository } from "./HttpConversationRepository.js";
import { createOutboxConversationRepository } from "./OutboxConversationRepository.js";
import { createConsoleConversationRepository } from "./ConsoleConversationRepository.js";

/** @type {Record<string, (opts: Object) => import("../../ports/ConversationRepositoryPort.js").ConversationRepository>} */
const REPOSITORY_REGISTRY = {
  off: () => nullConversationRepository,
  console: () => createConsoleConversationRepository(),
  http: ({ endpoint }) =>
    createOutboxConversationRepository({
      delegate: createHttpConversationRepository({ baseUrl: endpoint })
    })
};

/**
 * Registra un modo de persistencia adicional sin modificar este archivo.
 * @param {string} mode
 * @param {(opts: Object) => import("../../ports/ConversationRepositoryPort.js").ConversationRepository} factory
 */
export const registerConversationRepository = (mode, factory) => {
  if (typeof mode !== "string" || !mode) {
    throw new TypeError("registerConversationRepository: modo inválido.");
  }
  if (typeof factory !== "function") {
    throw new TypeError("registerConversationRepository: factory inválida.");
  }
  REPOSITORY_REGISTRY[mode] = factory;
};

/**
 * Resuelve qué modo aplica según la configuración.
 *
 * @param {Object} params
 * @param {string} [params.mode]      Modo solicitado por configuración.
 * @param {string} [params.endpoint]  URL del backend.
 * @returns {string}
 */
export const resolvePersistenceMode = ({ mode, endpoint }) => {
  const requested = String(mode || "off").toLowerCase();

  if (!REPOSITORY_REGISTRY[requested]) {
    console.warn(
      `⚠️ [Persistencia] Modo "${requested}" desconocido. Se usará "off" para no ` +
      "enviar datos a un destino no definido."
    );
    return "off";
  }

  // Pedir modo http sin endpoint es un error de configuración, no una invitación a
  // improvisar un destino.
  if (requested === "http" && !endpoint) {
    console.error(
      "❌ [Persistencia] El modo es \"http\" pero no hay endpoint configurado " +
      "(VITE_CONVERSATION_API_URL). No se guardará ningún registro. " +
      "Si esto es un entorno de desarrollo, usa el modo \"console\"."
    );
    return "off";
  }

  return requested;
};

/**
 * Construye el repositorio correspondiente a la configuración vigente.
 *
 * @param {Object} params
 * @param {string} [params.mode]
 * @param {string} [params.endpoint]
 * @returns {import("../../ports/ConversationRepositoryPort.js").ConversationRepository}
 */
export const createConversationRepository = ({ mode, endpoint } = {}) => {
  const resolved = resolvePersistenceMode({ mode, endpoint });
  const repository = REPOSITORY_REGISTRY[resolved]({ endpoint });

  if (resolved !== "off") {
    console.info(`💾 [Persistencia] Registro de conversaciones activo en modo "${resolved}".`);
  }

  return assertImplementsConversationRepository(repository);
};
