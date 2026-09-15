/* eslint-disable react-refresh/only-export-components */
import { createRoot } from "react-dom/client";
import { ChatProvider, useChat } from "./context/ChatContext";
import { ChatWindow } from "./components/organisms/ChatWindow";

/**
 * El CSS se incrusta como TEXTO en el bundle y se inyecta en un `<style>`, no se enlaza
 * con un `<link>` a un archivo aparte.
 *
 * Tres razones, todas comprobadas en el portal de pruebas:
 *
 *   1. CSP DEL PORTAL. Un `<link>` a otro dominio lo bloquea la politica del portal:
 *      `style-src` no lista el host del chatbot, y meterlo exigiria que CADA portal
 *      municipal anadiera el dominio a su CSP. Un `<style>` en linea, en cambio, entra por
 *      `'unsafe-inline'`, que es lo que ya permiten y lo habitual.
 *
 *   2. NADIE ENLAZABA EL CSS. Con `import "./index.css"` Vite lo emite aparte y deja que el
 *      consumidor lo enlace: para `index.html` lo hace Vite, para este punto de entrada
 *      nadie. El widget incrustado salia sin una sola regla.
 *
 *   3. RUTAS RELATIVAS AL PORTAL. La URL que emite Vite es absoluta desde la raiz, y en un
 *      `<link>` dentro de un portal ajeno resuelve contra el origen DEL PORTAL.
 *
 * El coste es que el CSS viaja dentro de `embed.js`: 13,8 KB, unos 3,2 KB comprimidos. A
 * cambio desaparecen una peticion de red y las tres dependencias de arriba.
 */
import cssText from "./index.css?inline";

const EmbeddedApp = ({ chatRoot }) => {
  const { theme } = useChat();

  // Actualizar atributo data-theme en el contenedor montado
  if (chatRoot) {
    chatRoot.setAttribute("data-theme", theme || "light");
  }

  return <ChatWindow />;
};

/** Identificador del `<style>`, para no duplicarlo si el script se carga dos veces. */
const STYLE_ELEMENT_ID = "chatbot-floridablanca-styles";

/** Inyecta los estilos del widget si no estan ya en la pagina. */
const ensureStyles = () => {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = cssText;
  document.head.appendChild(style);
};

const initEmbeddableChatbot = () => {
  // Antes de montar: los estilos ya vienen dentro del bundle, así que quedan aplicados
  // antes del primer pintado y no hay parpadeo sin estilos.
  ensureStyles();

  let chatRoot = document.getElementById("chatbot-service-root");
  if (!chatRoot) {
    chatRoot = document.createElement("div");
    chatRoot.id = "chatbot-service-root";
    document.body.appendChild(chatRoot);
  }
  
  // Garantizar clases de aislamiento para el contenedor embebido
  chatRoot.className = "antigravity-chatbot-root embedded-widget";

  const root = createRoot(chatRoot);
  root.render(
    <ChatProvider>
      <EmbeddedApp chatRoot={chatRoot} />
    </ChatProvider>
  );
  
  console.log("Chatbot Widget del Microservicio inyectado y montado correctamente.");
};

initEmbeddableChatbot();
