import { createRoot } from "react-dom/client";
import { ChatProvider } from "./context/ChatContext";
import { ChatWindow } from "./components/organisms/ChatWindow";
import "./index.css";

const initEmbeddableChatbot = () => {

  let chatRoot = document.getElementById("chatbot-service-root");
  if (!chatRoot) {
    chatRoot = document.createElement("div");
    chatRoot.id = "chatbot-service-root";
    chatRoot.className = "antigravity-chatbot-root";
    document.body.appendChild(chatRoot);
  }

  const root = createRoot(chatRoot);
  root.render(
    <ChatProvider>
      <ChatWindow />
    </ChatProvider>
  );
  
  console.log("Chatbot Widget del Microservicio inyectado y montado correctamente.");
};

initEmbeddableChatbot();
