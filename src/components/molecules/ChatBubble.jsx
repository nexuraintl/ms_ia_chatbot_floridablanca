import React from "react";
import { ChatForm } from "../organisms/ChatForm";
import { FileText, Download, Image as ImageIcon } from "lucide-react";

export const ChatBubble = ({ message, onSubmitForm }) => {
  const { sender, text, timestamp, form, attachment } = message;

  // Estilos según el remitente
  const isUser = sender === "user";
  const isSystem = sender === "system";

  if (isSystem) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          margin: "8px 0",
          width: "100%",
          boxSizing: "border-box"
        }}
        className="animate-fade-in"
      >
        <div
          style={{
            backgroundColor: "rgba(217, 119, 6, 0.08)", // Fondo ámbar/dorado sutil para RPA
            color: "#f59e0b",
            border: "1px solid rgba(217, 119, 6, 0.2)",
            borderRadius: "6px",
            padding: "6px 12px",
            fontSize: "0.75rem",
            fontFamily: "monospace",
            maxWidth: "90%",
            textAlign: "center",
            display: "inline-block",
            boxShadow: "0 2px 6px rgba(0,0,0,0.15)"
          }}
        >
          {text}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        margin: "8px 0",
        width: "100%",
        boxSizing: "border-box"
      }}
      className={`chat-bubble-wrapper ${isUser ? "user" : "bot"} animate-fade-in`}
    >
      <div
        style={{
          maxWidth: "80%",
          padding: "10px 14px",
          borderRadius: isUser ? "16px 16px 2px 16px" : "16px 16px 16px 2px",
          backgroundColor: isUser ? "#14532d" : "rgba(255, 255, 255, 0.06)",
          color: isUser ? "#f3f4f6" : "#e5e7eb",
          border: isUser ? "1px solid rgba(74, 222, 128, 0.2)" : "1px solid rgba(255, 255, 255, 0.08)",
          backdropFilter: isUser ? "none" : "blur(12px)",
          boxShadow: "0 4px 15px rgba(0, 0, 0, 0.15)",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          position: "relative",
          boxSizing: "border-box"
        }}
      >
        {/* Texto del mensaje */}
        <span style={{ fontSize: "0.9rem", lineHeight: "1.4", wordBreak: "break-word" }}>
          {text}
        </span>

        {/* Formulario adjunto */}
        {form && (
          <ChatForm
            formType={form.type}
            fields={form.fields}
            onSubmit={onSubmitForm}
          />
        )}

        {/* Archivos / Imágenes adjuntos (Req 5) */}
        {attachment && (
          <div
            style={{
              marginTop: "6px",
              borderRadius: "8px",
              overflow: "hidden",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              backgroundColor: "rgba(0, 0, 0, 0.2)",
              display: "flex",
              flexDirection: "column"
            }}
          >
            {attachment.type === "image" && (
              <>
                <img
                  src={attachment.src}
                  alt={attachment.label}
                  style={{
                    width: "100%",
                    maxHeight: "130px",
                    objectFit: "cover"
                  }}
                />
                <div
                  style={{
                    padding: "6px 8px",
                    fontSize: "0.75rem",
                    color: "#9ca3af",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px"
                  }}
                >
                  <ImageIcon size={12} />
                  <span>{attachment.label}</span>
                </div>
              </>
            )}

            {/* Enlace de descarga de archivo */}
            {attachment.fileUrl && (
              <a
                href={attachment.fileUrl}
                onClick={(e) => {
                  e.preventDefault();
                  alert(`Simulando la descarga del archivo: ${attachment.fileLabel || "documento.pdf"}`);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  padding: "8px",
                  fontSize: "0.8rem",
                  backgroundColor: "rgba(74, 222, 128, 0.1)",
                  color: "#4ade80",
                  textDecoration: "none",
                  borderTop: "1px solid rgba(255, 255, 255, 0.05)",
                  transition: "all 0.2s"
                }}
                className="btn-download"
              >
                {attachment.type === "file" ? <FileText size={14} /> : <Download size={14} />}
                <span>{attachment.fileLabel || "Descargar Archivo"}</span>
              </a>
            )}
          </div>
        )}

        {/* Timestamp */}
        <span
          style={{
            alignSelf: "flex-end",
            fontSize: "0.7rem",
            color: isUser ? "rgba(243, 244, 246, 0.6)" : "rgba(156, 163, 175, 0.7)",
            marginTop: "2px"
          }}
        >
          {timestamp}
        </span>
      </div>
    </div>
  );
};
