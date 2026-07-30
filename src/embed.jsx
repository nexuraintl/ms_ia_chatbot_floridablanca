/* eslint-disable react-refresh/only-export-components */
import { createRoot } from "react-dom/client";
import { ChatProvider, useChat } from "./context/ChatContext";
import { ChatWindow } from "./components/organisms/ChatWindow";
import "./index.css";

const EmbeddedApp = ({ chatRoot }) => {
  const { theme } = useChat();

  // Actualizar atributo data-theme en el contenedor montado
  if (chatRoot) {
    chatRoot.setAttribute("data-theme", theme || "light");
  }

  return <ChatWindow />;
};

const initEmbeddableChatbot = () => {
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
