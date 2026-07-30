import { useRef, useEffect, useState } from "react";
import { useChat } from "../../context/ChatContext";
import { ChatBubble } from "../molecules/ChatBubble";
import { QuickReplies } from "../molecules/QuickReplies";
import { StatusDot } from "../atoms/StatusDot";
import { Send, X, MessageSquare, RefreshCw, Sun, Moon } from "lucide-react";

export const ChatWindow = () => {
  const {
    isOpen,
    messages,
    isTextInputEnabled,
    isLoading,
    openChat,
    closeChat,
    sendMessage,
    selectQuickReply,
    submitChatForm,
    handlePredialFormSubmit,
    handleSelectPredio,
    resetChat,
    theme,
    toggleTheme
  } = useChat();

  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef(null);

  // Auto-scroll al final del chat
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleSend = (e) => {
    e.preventDefault();
    if (inputText.trim() === "") return;
    const sanitized = inputText.substring(0, 1000).trim();
    sendMessage(sanitized);
    setInputText("");
  };

  if (!isOpen) {
    return (
      <button
        onClick={openChat}
        title="Abrir Chat de Atención Virtual"
        style={{
          position: "fixed",
          bottom: "24px",
          right: "24px",
          width: "64px",
          height: "64px",
          borderRadius: "50%",
          backgroundColor: "#15803d",
          color: "#ffffff",
          border: "2px solid rgba(255, 255, 255, 0.4)",
          cursor: "pointer",
          boxShadow: "0 10px 30px rgba(21, 128, 61, 0.4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          transition: "transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)"
        }}
        className="floating-chat-trigger"
      >
        <MessageSquare size={28} />
        <span
          style={{
            position: "absolute",
            top: "2px",
            right: "2px",
            width: "14px",
            height: "14px",
            borderRadius: "50%",
            backgroundColor: "#22c55e",
            border: "2px solid #ffffff"
          }}
        />
      </button>
    );
  }

  // Obtener las respuestas rápidas del último mensaje
  const lastMessage = messages[messages.length - 1];
  const quickReplies = lastMessage?.quickReplies || null;

  return (
    <div className="floating-chat-window animate-slide-up">
      {/* Cabecera del Chat */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid var(--border-color)",
          background: "var(--chat-header-bg)",
          color: "var(--chat-header-text)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexShrink: 0
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              width: "42px",
              height: "42px",
              borderRadius: "50%",
              backgroundColor: "rgba(255, 255, 255, 0.2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid rgba(255, 255, 255, 0.3)"
            }}
          >
            <span style={{ fontSize: "1.3rem" }}>🌲</span>
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <h4 style={{ margin: 0, fontSize: "1.05rem", fontWeight: "700", color: "#ffffff", letterSpacing: "0.3px" }}>
                Atención Ciudadana
              </h4>
              <StatusDot online={true} />
            </div>
            <span style={{ fontSize: "0.78rem", color: "rgba(255, 255, 255, 0.85)" }}>Floridablanca • Gemini AI</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {/* Botón de Cambiar Tema Light / Dark */}
          <button
            onClick={toggleTheme}
            title={theme === "light" ? "Cambiar a Modo Oscuro" : "Cambiar a Modo Claro"}
            style={{
              background: "rgba(255, 255, 255, 0.15)",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
              color: "#ffffff",
              padding: "6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background-color 0.2s"
            }}
          >
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </button>

          {/* Botón de reset */}
          <button
            onClick={resetChat}
            title="Reiniciar conversación"
            style={{
              background: "rgba(255, 255, 255, 0.15)",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
              color: "#ffffff",
              padding: "6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background-color 0.2s"
            }}
          >
            <RefreshCw size={18} />
          </button>

          {/* Botón de cerrar */}
          <button
            onClick={closeChat}
            title="Cerrar chat"
            style={{
              background: "rgba(255, 255, 255, 0.15)",
              border: "none",
              borderRadius: "8px",
              cursor: "pointer",
              color: "#ffffff",
              padding: "6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background-color 0.2s"
            }}
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Área de Mensajes */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "18px 18px",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          scrollBehavior: "smooth",
          backgroundColor: "var(--chat-body-bg)"
        }}
        className="chat-messages-area"
      >
        {messages.map((message) => (
          <ChatBubble
            key={message.id}
            message={message}
            onSubmitForm={submitChatForm}
            onSubmitPredialForm={handlePredialFormSubmit}
            onSelectPredio={(index) => handleSelectPredio(index, message.sessionId, message.predialContext)}
          />
        ))}

        {/* Indicador de Carga / Escribiendo */}
        {isLoading && (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-start",
              margin: "8px 0"
            }}
          >
            <div
              style={{
                backgroundColor: "var(--bot-bubble-bg)",
                border: "1px solid var(--bot-bubble-border)",
                padding: "12px 16px",
                borderRadius: "18px 18px 18px 2px",
                display: "flex",
                alignItems: "center",
                gap: "6px",
                boxShadow: "var(--bot-bubble-shadow)"
              }}
            >
              <div className="typing-dot" />
              <div className="typing-dot" style={{ animationDelay: "0.2s" }} />
              <div className="typing-dot" style={{ animationDelay: "0.4s" }} />
            </div>
          </div>
        )}

        {/* Botones de Opciones Rápidas dentro de los mensajes */}
        {quickReplies && !isLoading && (
          <QuickReplies replies={quickReplies} onSelect={selectQuickReply} />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Pie del Chat / Entrada de Mensaje */}
      <form
        onSubmit={handleSend}
        style={{
          padding: "12px 16px 8px 16px",
          borderTop: "1px solid var(--border-color)",
          backgroundColor: "var(--input-container-bg)",
          display: "flex",
          gap: "10px",
          alignItems: "center",
          flexShrink: 0
        }}
      >
        <div style={{ flex: 1, position: "relative", display: "flex", alignItems: "center" }}>
          <input
            type="text"
            value={inputText}
            maxLength={1000}
            onChange={(e) => setInputText(e.target.value)}
            disabled={!isTextInputEnabled}
            placeholder={
              isTextInputEnabled
                ? "Pregunta lo que quieras sobre Floridablanca..."
                : "Elige una opción rápida..."
            }
            style={{
              width: "100%",
              padding: "12px 16px",
              borderRadius: "24px",
              border: "1px solid var(--input-border)",
              backgroundColor: "var(--input-bg)",
              color: "var(--input-text)",
              fontSize: "0.95rem",
              outline: "none",
              transition: "all 0.2s",
              boxSizing: "border-box",
              cursor: isTextInputEnabled ? "text" : "not-allowed"
            }}
          />
        </div>
        <button
          type="submit"
          disabled={!isTextInputEnabled || inputText.trim() === ""}
          style={{
            width: "42px",
            height: "42px",
            borderRadius: "50%",
            backgroundColor: isTextInputEnabled && inputText.trim() !== "" ? "#15803d" : "var(--input-bg)",
            color: isTextInputEnabled && inputText.trim() !== "" ? "#ffffff" : "var(--text-muted)",
            border: isTextInputEnabled && inputText.trim() !== "" ? "none" : "1px solid var(--input-border)",
            cursor: isTextInputEnabled && inputText.trim() !== "" ? "pointer" : "not-allowed",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "all 0.2s",
            boxShadow: isTextInputEnabled && inputText.trim() !== "" ? "0 4px 12px rgba(21, 128, 61, 0.3)" : "none"
          }}
        >
          <Send size={18} />
        </button>
      </form>

      {/* Pie Legal: Tratamiento de Datos Personales */}
      <div
        style={{
          padding: "4px 16px 10px 16px",
          backgroundColor: "var(--input-container-bg)",
          fontSize: "0.72rem",
          color: "var(--text-muted)",
          textAlign: "center",
          lineHeight: "1.35",
          flexShrink: 0
        }}
        className="data-privacy-notice"
      >
        🔒 Al enviar tu mensaje o seleccionar una opción, aceptas los <strong>Términos y Condiciones</strong> y el <strong>Tratamiento de Datos Personales</strong> (Ley 1581 de 2012).
      </div>

      {/* Estilos locales para las animaciones */}
      <style>{`
        .typing-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background-color: var(--text-muted);
          animation: bounce-typing 1.4s infinite ease-in-out both;
        }
        @keyframes bounce-typing {
          0%, 80%, 100% { transform: scale(0); }
          40% { transform: scale(1.0); }
        }
        .animate-slide-up {
          animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        @keyframes slideUp {
          from {
            transform: translateY(20px);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
        .animate-fade-in {
          animation: fadeIn 0.25s ease-out forwards;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(5px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};
