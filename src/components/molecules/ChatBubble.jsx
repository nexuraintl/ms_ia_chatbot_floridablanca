import { ChatForm } from "../organisms/ChatForm";
import { FileText, Download, Image as ImageIcon, ExternalLink, ShieldAlert } from "lucide-react";
import { resolveCustomComponent } from "../registry/customComponentRegistry";
import { RichText } from "./RichText";
import { forBackendResource, sanitizeUrlScheme } from "../../domain/security/urlPolicy";

/**
 * Burbuja de mensaje del chat.
 *
 * Refactor: ya no conoce ninguna tarjeta de trámite concreta (lo resuelve
 * `customComponentRegistry`) ni contiene el analizador de Markdown (está en
 * `RichText`). Su única responsabilidad es la presentación de la burbuja.
 */
export const ChatBubble = ({ message, onSubmitForm, onSubmitPredialForm, onSelectPredio }) => {
  const { sender, text, timestamp, form, attachment, customComponent, buttonUrl, buttonText } = message;

  const isUser = sender === "user";
  const isSystem = sender === "system";

  // Los mensajes de sistema (logs de RPA) se muestran centrados y sin formato rico.
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

  // Los enlaces de botón y de archivo provienen de los backends propios (pasarela PSE,
  // factura PDF), no del modelo, así que se validan como recurso de backend: se exige
  // esquema seguro pero no lista blanca de dominio, que rompería pagos legítimos.
  const safeButtonUrl = buttonUrl ? forBackendResource(buttonUrl).href : null;
  const safeFileUrl = attachment?.fileUrl ? forBackendResource(attachment.fileUrl).href : null;
  const safeImageSrc = attachment?.src ? sanitizeUrlScheme(attachment.src) : null;

  const customEntry = resolveCustomComponent(customComponent);

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
          maxWidth: customComponent ? "100%" : isUser ? "82%" : "90%",
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
        {/* Texto con formato ligero (negrillas, viñetas y enlaces verificados) */}
        {text && (
          <span style={{ fontSize: "0.98rem", lineHeight: "1.5", wordBreak: "break-word" }}>
            <RichText content={text} isUser={isUser} />
          </span>
        )}

        {/* Componente interactivo, resuelto por el registro */}
        {customEntry && (
          <customEntry.Component
            {...customEntry.mapProps(message, { onSubmitPredialForm, onSelectPredio })}
          />
        )}

        {/* Botón de enlace externo (pago PSE) */}
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

        {/* Formulario simple (Sisbén) */}
        {form && <ChatForm formType={form.type} fields={form.fields} onSubmit={onSubmitForm} />}

        {/* Adjuntos */}
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
            {attachment.type === "image" && safeImageSrc && safeImageSrc !== "#" && (
              <>
                <img
                  src={safeImageSrc}
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

            {safeFileUrl && (
              <a
                href={safeFileUrl}
                target={safeFileUrl.startsWith("#") ? "_self" : "_blank"}
                rel="noopener noreferrer"
                onClick={(e) => {
                  // Los datos simulados usan anclas como marcador de descarga.
                  if (safeFileUrl.startsWith("#")) {
                    e.preventDefault();
                    console.info(
                      `[Demo] Descarga simulada: ${attachment.fileLabel || "documento.pdf"}`
                    );
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

            {/* Adjunto rechazado por esquema no seguro */}
            {attachment.type === "image" && (!safeImageSrc || safeImageSrc === "#") && (
              <div
                style={{
                  padding: "8px",
                  fontSize: "0.75rem",
                  color: "#f59e0b",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px"
                }}
              >
                <ShieldAlert size={12} />
                <span>Imagen bloqueada por seguridad.</span>
              </div>
            )}
          </div>
        )}

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
