import React from "react";
import { ChatProvider } from "./context/ChatContext";
import { ChatbotConsole } from "./components/organisms/ChatbotConsole";
import { ChatWindow } from "./components/organisms/ChatWindow";

function App() {
  return (
    <div className="antigravity-chatbot-root">
      <ChatProvider>
        <ChatbotConsole />
        <ChatWindow />
      </ChatProvider>
    </div>
  );
}

export default App;
