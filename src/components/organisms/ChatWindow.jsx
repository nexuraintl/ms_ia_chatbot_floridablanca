import React, { useRef, useEffect, useState } from "react";
import { useChat } from "../../context/ChatContext";
import { ChatBubble } from "../molecules/ChatBubble";
import { QuickReplies } from "../molecules/QuickReplies";
import { StatusDot } from "../atoms/StatusDot";
import { Badge } from "../atoms/Badge";
import { Send, X, MessageSquare, RefreshCw, HelpCircle } from "lucide-react";

export const ChatWindow = () => {
  const {
    isOpen,
    messages,
    isTextInputEnabled,
    isLoading,
    openChat,
    closeChat,
    toggleChat,
    sendMessage,
    selectQuickReply,
    submitChatForm,
    resetChat
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
    sendMessage(inputText);
    setInputText("");
  };

  if (!isOpen) {
    return (
      <button
        onClick={openChat}
        style={{
          position: "fixed",
          bottom: "24px",
          right: "24px",
          width: "60px",
          height: "60px",
          borderRadius: "50%",
          backgroundColor: "#15803d",
          color: "#ffffff",
          border: "2px solid rgba(74, 222, 128, 0.4)",
          cursor: "pointer",
          boxShadow: "0 8px 30px rgba(0, 0, 0, 0.3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          transition: "transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)"
        }}
        className="floating-chat-trigger"
      >
        <MessageSquare size={26} />
        <span
          style={{
            position: "absolute",
            top: "0",
            right: "0",
            width: "12px",
            height: "12px",
            borderRadius: "50%",
            backgroundColor: "#22c55e",
            border: "2px solid #0f172a"
          }}
        />
      </button>
    );
  }

  // Obtener las respuestas rápidas del último mensaje
  const lastMessage = messages[messages.length - 1];
  const quickReplies = lastMessage?.quickReplies || null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "24px",
        right: "24px",
        width: "380px",
        height: "560px",
        maxHeight: "calc(100vh - 48px)",
        maxWidth: "calc(100vw - 48px)",
        borderRadius: "16px",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        backgroundColor: "rgba(15, 23, 42, 0.8)", // Slate 900 con transparencia
        backdropFilter: "blur(20px)",
        boxShadow: "0 12px 40px rgba(0, 0, 0, 0.4)",
        display: "flex",
        flexDirection: "column",
        zIndex: 9999,
        overflow: "hidden",
        fontFamily: "inherit"
      }}
      className="animate-slide-up"
    >
      {/* Cabecera del Chat */}
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
          background: "linear-gradient(135deg, rgba(21, 128, 61, 0.2), rgba(15, 23, 42, 0.4))",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div
            style={{
              width: "36px",
              height: "36px",
              borderRadius: "50%",
              backgroundColor: "rgba(74, 222, 128, 0.1)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid rgba(74, 222, 128, 0.2)"
            }}
          >
            <span style={{ fontSize: "1.2rem" }}>🌲</span>
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <h4 style={{ margin: 0, fontSize: "0.95rem", fontWeight: "600", color: "#f8fafc" }}>
                Asistente
              </h4>
              <StatusDot online={true} />
            </div>
            <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>Respuesta rápida con Gemini</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {/* Botón de reset */}
          <button
            onClick={resetChat}
            title="Reiniciar conversación"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "#94a3b8",
              padding: "4px"
            }}
          >
            <RefreshCw size={16} />
          </button>

          {/* Botón de cerrar */}
          <button
            onClick={closeChat}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "#94a3b8",
              padding: "4px"
            }}
          >
            <X size={18} />
          </button>
        </div>
      </div>



      {/* Área de Mensajes */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          scrollBehavior: "smooth"
        }}
        className="chat-messages-area"
      >
        {messages.map((message) => (
          <ChatBubble
            key={message.id}
            message={message}
            onSubmitForm={submitChatForm}
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
                backgroundColor: "rgba(255, 255, 255, 0.06)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
                padding: "10px 14px",
                borderRadius: "16px 16px 16px 2px",
                display: "flex",
                alignItems: "center",
                gap: "4px"
              }}
            >
              <div className="typing-dot" />
              <div className="typing-dot" style={{ animationDelay: "0.2s" }} />
              <div className="typing-dot" style={{ animationDelay: "0.4s" }} />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Botones de Opciones Rápidas */}
      {quickReplies && (
        <QuickReplies replies={quickReplies} onSelect={selectQuickReply} />
      )}

      {/* Pie del Chat / Entrada de Mensaje */}
      <form
        onSubmit={handleSend}
        style={{
          padding: "12px 16px",
          borderTop: "1px solid rgba(255, 255, 255, 0.06)",
          backgroundColor: "rgba(15, 23, 42, 0.5)",
          display: "flex",
          gap: "8px",
          alignItems: "center"
        }}
      >
        <div style={{ flex: 1, position: "relative", display: "flex", alignItems: "center" }}>
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            disabled={!isTextInputEnabled}
            placeholder={
              isTextInputEnabled
                ? "Pregunta lo que quieras sobre Floridablanca..."
                : "Elige una opción rápida..."
            }
            style={{
              width: "100%",
              padding: "10px 40px 10px 14px",
              borderRadius: "20px",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              backgroundColor: isTextInputEnabled
                ? "rgba(255, 255, 255, 0.04)"
                : "rgba(255, 255, 255, 0.01)",
              color: isTextInputEnabled ? "#ffffff" : "#64748b",
              fontSize: "0.85rem",
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
            width: "36px",
            height: "36px",
            borderRadius: "50%",
            backgroundColor: isTextInputEnabled && inputText.trim() !== "" ? "#15803d" : "rgba(255, 255, 255, 0.02)",
            color: isTextInputEnabled && inputText.trim() !== "" ? "#ffffff" : "#475569",
            border: "none",
            cursor: isTextInputEnabled && inputText.trim() !== "" ? "pointer" : "not-allowed",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "all 0.2s"
          }}
        >
          <Send size={16} />
        </button>
      </form>

      {/* Estilos locales para las animaciones */}
      <style>{`
        .typing-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          backgroundColor: #94a3b8;
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
