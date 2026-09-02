/* eslint-disable react-refresh/only-export-components */
import { createRoot } from "react-dom/client";
import { ChatProvider, useChat } from "./context/ChatContext";
import { ChatWindow } from "./components/organisms/ChatWindow";

/**
 * La hoja de estilos se pide como URL y se engancha a mano, en vez de importarla con
 * `import "./index.css"`.
 *
 * Con el import normal, Vite emite el CSS en un archivo aparte y deja que el consumidor lo
 * enlace. Para `index.html` lo enlaza Vite; para ESTE punto de entrada, nadie: un portal
 * que incrustaba el widget lo renderizaba sin estilos.
 *
 * No se podía notar desde la consola de desarrollo, porque ahí el `<link>` lo pone
 * `index.html`. Comprobado en el bundle: `assets/embed.js` no contenía ninguna referencia
 * al `.css` emitido, mientras `index.html` sí.
 *
 * Con `?url` el archivo conserva su hash —o sea que se sigue cacheando un año— y la ruta
 * respeta el `base` con el que se compiló.
 */
import cssUrl from "./index.css?url";

const EmbeddedApp = ({ chatRoot }) => {
  const { theme } = useChat();

  // Actualizar atributo data-theme en el contenedor montado
  if (chatRoot) {
    chatRoot.setAttribute("data-theme", theme || "light");
  }

  return <ChatWindow />;
};

/** Identificador del `<link>`, para no duplicarlo si el script se carga dos veces. */
const STYLE_LINK_ID = "chatbot-floridablanca-styles";

/**
 * Engancha la hoja de estilos del widget si no está ya en la página.
 *
 * La URL se resuelve contra `import.meta.url` —la de este propio módulo— y no se usa tal
 * cual. Vite emite `cssUrl` como ruta absoluta desde la raíz (`/…/assets/main-x.css`), y
 * una ruta así puesta en un `<link>` resuelve contra el origen DEL PORTAL, no del chatbot.
 * En un portal de otro dominio eso pide el CSS a un host donde no existe.
 *
 * Resolviéndola contra el módulo funciona en los dos casos: mismo origen y portal ajeno.
 */
const ensureStyles = () => {
  if (document.getElementById(STYLE_LINK_ID)) return;
  const link = document.createElement("link");
  link.id = STYLE_LINK_ID;
  link.rel = "stylesheet";
  link.href = new URL(cssUrl, import.meta.url).href;
  document.head.appendChild(link);
};

const initEmbeddableChatbot = () => {
  // Antes de montar: así el navegador ya está descargando los estilos mientras React
  // construye el árbol, en vez de después.
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
