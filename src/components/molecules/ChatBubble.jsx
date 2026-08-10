import { ChatForm } from "../organisms/ChatForm";
import { PqrsdCreateCard } from "./PqrsdCreateCard";
import { PqrsdConsultCard } from "./PqrsdConsultCard";
import { PqrsdResultCard } from "./PqrsdResultCard";
import { PredialForm } from "./PredialForm";
import { PredioCardList } from "./PredioCardList";
import { FileText, Download, Image as ImageIcon, ExternalLink } from "lucide-react";
import { sanitizeUrl } from "../../utils/securityUtils";

const parseInlineMarkdown = (text, isUser, lineIdx) => {
  if (!text) return [];

  // Matcher para: [link](url), **bold** y URLs sueltas
  const tokenRegex = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(\*\*([\s\S]+?)\*\*)|(https?:\/\/[^\s\)]+)/g;

  const elements = [];
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      elements.push(text.substring(lastIndex, match.index));
    }

    if (match[1]) {
      // Enlace Markdown [Label](URL)
      const label = match[2];
      const safeUrl = sanitizeUrl(match[3]);
      elements.push(
        <a
          key={`link-${lineIdx}-${match.index}`}
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: isUser ? "#ffffff" : "#1d4ed8",
            fontWeight: 700,
            textDecoration: "underline",
            wordBreak: "break-all"
          }}
        >
          {label} 🔗
        </a>
      );
    } else if (match[4]) {
      // Texto en negrilla **bold**
      const boldText = match[5];
      elements.push(
        <strong key={`bold-${lineIdx}-${match.index}`} style={{ fontWeight: 700 }}>
          {boldText}
        </strong>
      );
    } else if (match[6]) {
      // URL directa
      const safeUrl = sanitizeUrl(match[6]);
      elements.push(
        <a
          key={`rawlink-${lineIdx}-${match.index}`}
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: isUser ? "#ffffff" : "#1d4ed8",
            fontWeight: 700,
            textDecoration: "underline",
            wordBreak: "break-all"
          }}
        >
          {match[6]} 🔗
        </a>
      );
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    elements.push(text.substring(lastIndex));
  }

  return elements;
};

const renderFormattedText = (content, isUser) => {
  if (!content) return null;

  const lines = content.split("\n");

  return lines.map((line, lineIdx) => {
    let cleanLine = line;
    let isBullet = false;

    // Detectar viñetas tipo "* " o "- " o "* **"
    if (/^\s*[\*\-]\s+/.test(cleanLine)) {
      isBullet = true;
      cleanLine = cleanLine.replace(/^\s*[\*\-]\s+/, "");
    }

    const parsedElements = parseInlineMarkdown(cleanLine, isUser, lineIdx);

    return (
      <span
        key={lineIdx}
        style={{
          display: "block",
          marginBottom: lineIdx < lines.length - 1 ? "4px" : "0",
          paddingLeft: isBullet ? "12px" : "0"
        }}
      >
        {isBullet && (
          <span style={{ fontWeight: "bold", marginRight: "6px", color: isUser ? "#ffffff" : "#3b82f6" }}>
            •
          </span>
        )}
        {parsedElements}
      </span>
    );
  });
};

export const ChatBubble = ({ message, onSubmitForm, onSubmitPredialForm, onSelectPredio }) => {
  const { sender, text, timestamp, form, attachment, customComponent, sessionId, predios, buttonUrl, buttonText } = message;

  // Estilos según el remitente
  const isUser = sender === "user";
  const isSystem = sender === "system";

  if (isSystem) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          margin: "4px 0",
          width: "100%",
          boxSizing: "border-box"
        }}
        className="animate-fade-in"
      >
        <div
          style={{
            backgroundColor: "rgba(217, 119, 6, 0.08)",
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

  const safeButtonUrl = buttonUrl ? sanitizeUrl(buttonUrl) : null;
  const safeFileUrl = attachment?.fileUrl ? sanitizeUrl(attachment.fileUrl) : null;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        margin: "2px 0",
        width: "100%",
        boxSizing: "border-box"
      }}
      className={`chat-bubble-wrapper ${isUser ? "user" : "bot"} animate-fade-in`}
    >
      <div
        style={{
          maxWidth: customComponent ? "100%" : (isUser ? "82%" : "90%"),
          padding: customComponent ? "6px 6px" : "12px 16px",
          borderRadius: isUser ? "18px 18px 2px 18px" : "18px 18px 18px 2px",
          backgroundColor: isUser ? "var(--user-bubble-bg)" : "var(--bot-bubble-bg)",
          color: isUser ? "var(--user-bubble-text)" : "var(--bot-bubble-text)",
          border: isUser ? "1px solid var(--user-bubble-border)" : "1px solid var(--bot-bubble-border)",
          boxShadow: isUser ? "var(--user-bubble-shadow)" : "var(--bot-bubble-shadow)",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          position: "relative",
          boxSizing: "border-box"
        }}
      >
        {/* Texto del mensaje */}
        {text && (
          <span style={{ fontSize: "0.98rem", lineHeight: "1.5", wordBreak: "break-word" }}>
            {renderFormattedText(text, isUser)}
          </span>
        )}

        {/* Componentes personalizados de PQRSD */}
        {customComponent === "pqrsd_crear" && (
          <PqrsdCreateCard />
        )}

        {customComponent === "pqrsd_consult" && (
          <PqrsdConsultCard />
        )}

        {customComponent === "pqrsd_result" && (
          <PqrsdResultCard data={message.pqrsdData} />
        )}

        {/* Componente interactivo de Impuesto Predial */}
        {customComponent === "predial_form" && (
          <PredialForm onSubmit={onSubmitPredialForm} />
        )}

        {/* Múltiples predios encontrados */}
        {customComponent === "predial_multiples" && (
          <PredioCardList
            sessionId={sessionId}
            predios={predios}
            onSelectPredio={onSelectPredio}
          />
        )}

        {/* Botón de Enlace Externo (ej: Pago PSE) */}
        {safeButtonUrl && safeButtonUrl !== "#" && (
          <a
            href={safeButtonUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              padding: "10px 16px",
              marginTop: "4px",
              borderRadius: "8px",
              background: "linear-gradient(135deg, #059669 0%, #10b981 100%)",
              color: "#ffffff",
              fontWeight: 700,
              fontSize: "0.85rem",
              textDecoration: "none",
              boxShadow: "0 4px 12px rgba(16, 185, 129, 0.3)"
            }}
          >
            <ExternalLink size={16} />
            <span>{buttonText || "Ir a Pagar en Línea (PSE)"}</span>
          </a>
        )}

        {/* Formulario adjunto anterior */}
        {form && (
          <ChatForm
            formType={form.type}
            fields={form.fields}
            onSubmit={onSubmitForm}
          />
        )}

        {/* Archivos / Imágenes adjuntos */}
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
                  alt={attachment.label || "Imagen adjunta"}
                  style={{
                    width: "100%",
                    maxHeight: "220px",
                    objectFit: "contain",
                    backgroundColor: "#ffffff",
                    padding: "8px"
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
                  <span>{attachment.label || "Código QR para pago"}</span>
                </div>
              </>
            )}

            {/* Enlace de descarga de archivo */}
            {safeFileUrl && (
              <a
                href={safeFileUrl}
                target={safeFileUrl.startsWith("#") ? "_self" : "_blank"}
                rel="noopener noreferrer"
                onClick={(e) => {
                  if (safeFileUrl.startsWith("#")) {
                    e.preventDefault();
                    alert(`Simulando la descarga del archivo: ${attachment.fileLabel || "documento.pdf"}`);
                  }
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
