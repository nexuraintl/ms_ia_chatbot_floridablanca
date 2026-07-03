import React from "react";
import { ChatProvider } from "./context/ChatContext";
import { ChatbotConsole } from "./components/organisms/ChatbotConsole";
import { ChatWindow } from "./components/organisms/ChatWindow";

function App() {
  return (
    <ChatProvider>
      <ChatbotConsole />
      <ChatWindow />
    </ChatProvider>
  );
}

export default App;
