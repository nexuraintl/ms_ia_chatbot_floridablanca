import { ChatProvider, useChat } from "./context/ChatContext";
import { ChatbotConsole } from "./components/organisms/ChatbotConsole";
import { ChatWindow } from "./components/organisms/ChatWindow";

function MainApp() {
  const { theme } = useChat();

  return (
    <div className="antigravity-chatbot-root" data-theme={theme}>
      <ChatbotConsole />
      <ChatWindow />
    </div>
  );
}

function App() {
  return (
    <ChatProvider>
      <MainApp />
    </ChatProvider>
  );
}

export default App;
