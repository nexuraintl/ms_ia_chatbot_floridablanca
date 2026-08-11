import { useState, useEffect, useRef } from "react";
import { useChat } from "../../context/ChatContext";
import { Terminal as TerminalIcon, Cpu, Key, Code, Copy, Check, TrendingDown, Sparkles, Globe, Award, Settings, Sun, Moon } from "lucide-react";
import { redactPII } from "../../domain/security/piiRedactor";
import { sanitizeLogString } from "../../domain/security/textSanitizer";
import { isValidGeminiApiKey } from "../../hooks/usePreferences";

export const ChatbotConsole = () => {
  const { 
    apiKey, 
    updateApiKey, 
    tokensUsedTotal, 
    tokensSavedTotal, 
    messages,
    isGeminiEnabled,
    setIsGeminiEnabled,
    isServicesEnabled,
    setIsServicesEnabled,
    theme,
    toggleTheme
  } = useChat();
  const [copied, setCopied] = useState(false);
  const [localKey, setLocalKey] = useState(apiKey);
  const [prevApiKey, setPrevApiKey] = useState(apiKey);
  const terminalEndRef = useRef(null);

  // Sincronizar localKey cuando la apiKey cambia en el contexto sin re-renders en cascada
  if (apiKey !== prevApiKey) {
    setPrevApiKey(apiKey);
    setLocalKey(apiKey);
  }

  // Auto-scroll en la terminal de logs
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleCopyCode = () => {
    const code = `<script type="module" src="http://localhost:5173/src/embed.jsx"></script>`;
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSaveKey = (e) => {
    e.preventDefault();

    // Antes se avisaba del formato incorrecto y se guardaba de todas formas, lo que
    // dejaba al operador creyendo que la clave era válida. Ahora el aviso decide.
    if (localKey && !isValidGeminiApiKey(localKey)) {
      const proceed = window.confirm(
        "⚠️ La clave ingresada no coincide con el formato de Google AI Studio (AIzaSy...).\n\n" +
        "¿Deseas guardarla de todas formas?"
      );
      if (!proceed) return;
    }

    updateApiKey(localKey);
    alert(
      localKey
        ? "API Key de Gemini actualizada. Recuerda restringirla por dominio y cuota en Google Cloud Console: al llamar a Gemini desde el navegador, la clave es visible para quien use este equipo."
        : "API Key eliminada. El chatbot responderá con el catálogo local de respuestas."
    );
  };

  // Calcular ahorro monetario simulado (0.000015 USD por token ahorrado en flash/prompts)
  const usdSaved = (tokensSavedTotal * 0.000015).toFixed(5);

  return (
    <div
      className="chatbot-console-container"
      style={{
        display: "flex",
        flexDirection: "row",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        backgroundColor: "var(--bg-color)",
        color: "var(--text-main)",
        fontFamily: "'Outfit', 'Inter', sans-serif"
      }}
    >
      {/* PANEL LATERAL DE CONFIGURACIÓN */}
      <div
        className="console-sidebar"
        style={{
          width: "320px",
          backgroundColor: "var(--sidebar-bg)",
          borderRight: "1px solid var(--border-color)",
          backdropFilter: "blur(20px)",
          padding: "28px 24px",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
          height: "100vh",
          boxSizing: "border-box",
          position: "sticky",
          top: 0
        }}
      >
        {/* Marca Municipal */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border-color)", paddingBottom: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "10px",
                backgroundColor: "#15803d",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 4px 14px rgba(21, 128, 61, 0.4)"
              }}
            >
              <span style={{ fontSize: "1.4rem" }}>🌸</span>
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: "1.15rem", fontWeight: "800", color: "var(--text-main)", letterSpacing: "0.5px" }}>
                FLORIDABLANCA
              </h2>
              <span style={{ fontSize: "0.75rem", color: "#16a34a", fontWeight: "600", textTransform: "uppercase", letterSpacing: "1px" }}>
                Capital Dulce
              </span>
            </div>
          </div>

          {/* Botón Switcher Light / Dark */}
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === "light" ? "Cambiar a Modo Oscuro" : "Cambiar a Modo Claro"}
            style={{
              background: "var(--input-bg)",
              border: "1px solid var(--border-color)",
              borderRadius: "8px",
              padding: "8px",
              cursor: "pointer",
              color: "var(--text-main)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center"
            }}
          >
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
          </button>
        </div>

        {/* Sección 1: API Key Manager */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Key size={18} style={{ color: "#d97706" }} />
            <h3 style={{ margin: 0, fontSize: "0.9rem", fontWeight: "600", color: "var(--text-main)" }}>Google Gemini Key</h3>
          </div>
          <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--text-muted)", lineHeight: "1.4" }}>
            Ingresa tu credencial para habilitar las consultas inteligentes reales del Chatbot.
          </p>
          <form onSubmit={handleSaveKey} style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px" }}>
            <input
              type="password"
              value={localKey}
              onChange={(e) => setLocalKey(e.target.value)}
              placeholder="AIzaSy..."
              style={{
                width: "100%",
                padding: "10px 14px",
                borderRadius: "8px",
                border: "1px solid var(--input-border)",
                backgroundColor: "var(--input-bg)",
                color: "var(--input-text)",
                fontSize: "0.85rem",
                outline: "none",
                transition: "all 0.2s",
                boxSizing: "border-box"
              }}
              className="input-premium"
            />
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="submit"
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  borderRadius: "6px",
                  backgroundColor: "#15803d",
                  color: "#ffffff",
                  border: "none",
                  fontWeight: "600",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                  transition: "all 0.2s"
                }}
                className="btn-interactive"
              >
                Guardar Clave
              </button>
              {apiKey && (
                <button
                  type="button"
                  onClick={() => {
                    updateApiKey("");
                    setLocalKey("");
                  }}
                  style={{
                    padding: "8px 12px",
                    borderRadius: "6px",
                    backgroundColor: "rgba(239, 68, 68, 0.15)",
                    color: "#dc2626",
                    border: "1px solid rgba(239, 68, 68, 0.3)",
                    fontWeight: "600",
                    fontSize: "0.8rem",
                    cursor: "pointer",
                    transition: "all 0.2s"
                  }}
                  className="btn-interactive"
                >
                  Remover
                </button>
              )}
            </div>
          </form>
          <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
            ¿No tienes clave? Consíguela en <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer" style={{ color: "#16a34a", textDecoration: "underline" }}>Google AI Studio</a>.
          </span>
        </div>

        {/* Sección de Módulos (Habilitar/Deshabilitar características del chatbot) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", borderTop: "1px solid var(--border-color)", paddingTop: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Settings size={18} style={{ color: "#16a34a" }} />
            <h3 style={{ margin: 0, fontSize: "0.9rem", fontWeight: "600", color: "var(--text-main)" }}>Módulos Habilitados</h3>
          </div>
          
          {/* Toggle: FAQ / Gemini IA */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: "600", color: "var(--text-main)" }}>Preguntas Frecuentes (IA)</span>
              <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Respuesta libre con Gemini</span>
            </div>
            <button
              onClick={() => setIsGeminiEnabled(!isGeminiEnabled)}
              type="button"
              style={{
                width: "44px",
                height: "22px",
                borderRadius: "11px",
                backgroundColor: isGeminiEnabled ? "#15803d" : "#cbd5e1",
                border: "none",
                cursor: "pointer",
                position: "relative",
                padding: "2px",
                transition: "background-color 0.2s"
              }}
            >
              <div
                style={{
                  width: "18px",
                  height: "18px",
                  borderRadius: "50%",
                  backgroundColor: "#ffffff",
                  position: "absolute",
                  top: "2px",
                  left: isGeminiEnabled ? "24px" : "2px",
                  transition: "left 0.2s",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.3)"
                }}
              />
            </button>
          </div>

          {/* Toggle: Servicios / Trámites */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: "600", color: "var(--text-main)" }}>Trámites y Servicios</span>
              <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Sisbén, Predial y RPA</span>
            </div>
            <button
              onClick={() => setIsServicesEnabled(!isServicesEnabled)}
              type="button"
              style={{
                width: "44px",
                height: "22px",
                borderRadius: "11px",
                backgroundColor: isServicesEnabled ? "#15803d" : "#cbd5e1",
                border: "none",
                cursor: "pointer",
                position: "relative",
                padding: "2px",
                transition: "background-color 0.2s"
              }}
            >
              <div
                style={{
                  width: "18px",
                  height: "18px",
                  borderRadius: "50%",
                  backgroundColor: "#ffffff",
                  position: "absolute",
                  top: "2px",
                  left: isServicesEnabled ? "24px" : "2px",
                  transition: "left 0.2s",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.3)"
                }}
              />
            </button>
          </div>
        </div>

        {/* Sección 2: Integración (Embed) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "auto", borderTop: "1px solid var(--border-color)", paddingTop: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Code size={18} style={{ color: "#0284c7" }} />
            <h3 style={{ margin: 0, fontSize: "0.9rem", fontWeight: "600", color: "var(--text-main)" }}>Script de Integración</h3>
          </div>
          <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--text-muted)", lineHeight: "1.4" }}>
            Copia este script para inyectar el chatbot en cualquier sitio web externo:
          </p>
          <div
            style={{
              padding: "10px",
              borderRadius: "8px",
              backgroundColor: "var(--input-bg)",
              border: "1px solid var(--border-color)",
              fontSize: "0.72rem",
              fontFamily: "monospace",
              wordBreak: "break-all",
              color: "var(--text-main)",
              position: "relative",
              userSelect: "all"
            }}
          >
            {`<script type="module" src="http://localhost:5173/src/embed.jsx"></script>`}
            <button
              onClick={handleCopyCode}
              type="button"
              style={{
                position: "absolute",
                top: "6px",
                right: "6px",
                background: "var(--card-bg)",
                border: "1px solid var(--border-color)",
                borderRadius: "4px",
                padding: "4px",
                cursor: "pointer",
                color: copied ? "#16a34a" : "var(--text-muted)"
              }}
              title="Copiar código"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.72rem", color: "var(--text-muted)" }}>
            <Globe size={12} />
            <span>Soporta Cross-Origin completo (CORS)</span>
          </div>
        </div>
      </div>

      {/* ÁREA PRINCIPAL: MÉTRICAS Y TERMINAL */}
      <div
        className="console-main-area"
        style={{
          flex: 1,
          padding: "32px 40px",
          display: "flex",
          flexDirection: "column",
          gap: "28px",
          overflowY: "auto",
          height: "100vh",
          boxSizing: "border-box"
        }}
      >
        {/* Cabecera Principal */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "1.8rem", fontWeight: "800", color: "var(--text-main)", letterSpacing: "-0.5px" }}>
              Panel de Control del Asistente Virtual
            </h1>
            <p style={{ margin: "4px 0 0 0", fontSize: "0.9rem", color: "var(--text-muted)" }}>
              Monitorea el consumo de la API de Gemini, logs del sistema y simulación de automatizaciones RPA.
            </p>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              backgroundColor: "rgba(21, 128, 61, 0.1)",
              border: "1px solid rgba(21, 128, 61, 0.25)",
              padding: "6px 14px",
              borderRadius: "20px"
            }}
          >
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: "#16a34a",
                boxShadow: "0 0 8px #16a34a"
              }}
            />
            <span style={{ fontSize: "0.78rem", color: "#16a34a", fontWeight: "600", letterSpacing: "0.5px" }}>
              WIDGET EMBEBIBLE ACTIVO
            </span>
          </div>
        </div>

        {/* REJILLA DE MÉTRICAS */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "20px" }}>
          {/* Tarjeta 1: Tokens Usados */}
          <div
            style={{
              padding: "20px",
              backgroundColor: "var(--card-bg)",
              border: "1px solid var(--border-color)",
              borderRadius: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              boxShadow: "0 4px 15px rgba(0, 0, 0, 0.04)"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: "700", color: "var(--text-muted)" }}>TOKENS CONSUMIDOS</span>
              <Cpu size={18} style={{ color: "#0284c7" }} />
            </div>
            <span style={{ fontSize: "1.8rem", fontWeight: "800", color: "var(--text-main)" }}>
              {tokensUsedTotal.toLocaleString()}
            </span>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              Consumo real en peticiones Gemini
            </span>
          </div>

          {/* Tarjeta 2: Tokens Ahorrados */}
          <div
            style={{
              padding: "20px",
              backgroundColor: "var(--card-bg)",
              border: "1px solid var(--border-color)",
              borderRadius: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              boxShadow: "0 4px 15px rgba(0, 0, 0, 0.04)"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: "700", color: "var(--text-muted)" }}>TOKENS AHORRADOS</span>
              <TrendingDown size={18} style={{ color: "#16a34a" }} />
            </div>
            <span style={{ fontSize: "1.8rem", fontWeight: "800", color: "#16a34a" }}>
              {tokensSavedTotal.toLocaleString()}
            </span>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              Optimizados por respuestas cortas
            </span>
          </div>

          {/* Tarjeta 3: Ahorro Monetario Estimado */}
          <div
            style={{
              padding: "20px",
              backgroundColor: "var(--card-bg)",
              border: "1px solid var(--border-color)",
              borderRadius: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              boxShadow: "0 4px 15px rgba(0, 0, 0, 0.04)"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: "700", color: "var(--text-muted)" }}>EFICIENCIA DE COSTOS</span>
              <Sparkles size={18} style={{ color: "#d97706" }} />
            </div>
            <span style={{ fontSize: "1.8rem", fontWeight: "800", color: "#d97706" }}>
              ${usdSaved}
            </span>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              USD estimados ahorrados por diseño
            </span>
          </div>
        </div>

        {/* TERMINAL DE LOGS DE EVENTOS EN TIEMPO REAL */}
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: "260px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              backgroundColor: theme === "light" ? "#1e293b" : "#0f172a",
              border: "1px solid var(--border-color)",
              borderBottom: "none",
              padding: "10px 18px",
              borderRadius: "10px 10px 0 0"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <TerminalIcon size={16} style={{ color: "#4ade80" }} />
              <span style={{ fontSize: "0.8rem", fontWeight: "700", color: "#f8fafc", fontFamily: "monospace" }}>
                TERMINAL DE LOGS DEL CHATBOT
              </span>
            </div>
            <div style={{ display: "flex", gap: "6px" }}>
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", backgroundColor: "#ef4444" }} />
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", backgroundColor: "#eab308" }} />
              <span style={{ width: "10px", height: "10px", borderRadius: "50%", backgroundColor: "#22c55e" }} />
            </div>
          </div>

          <div
            style={{
              flex: 1,
              backgroundColor: theme === "light" ? "#0f172a" : "#020617",
              border: "1px solid var(--border-color)",
              padding: "16px",
              borderRadius: "0 0 10px 10px",
              overflowY: "auto",
              fontFamily: "'Courier New', Courier, monospace",
              fontSize: "0.8rem",
              lineHeight: "1.5",
              color: "#34d399",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              maxHeight: "360px",
              boxShadow: "inset 0 4px 20px rgba(0, 0, 0, 0.5)"
            }}
          >
            <div style={{ color: "#94a3b8" }}>
              [SYSTEM_LOG] [{new Date().toLocaleDateString()}] Inicializando terminal de logs...
            </div>
            <div style={{ color: "#94a3b8" }}>
              [SYSTEM_LOG] Escuchando eventos del microservicio de chatbot...
            </div>
            
            {messages.map((m, idx) => {
              const prefix = `[${m.timestamp || "00:00:00"}]`;
              let logColor = "#34d399"; // Verde por defecto para bot
              let senderLabel = "BOT";

              if (m.sender === "user") {
                logColor = "#60a5fa"; // Azul para el usuario
                senderLabel = "USER";
              } else if (m.sender === "system") {
                logColor = "#fbbf24"; // Dorado para el robot/RPA
                senderLabel = "SYS-RPA";
              }

              // Enmascarar PII antes de mostrarla en la terminal.
              // La cadena de tres `.replace()` que había aquí no cubría los códigos de
              // autenticación de PQRSD (son alfanuméricos, así que ningún patrón
              // numérico los alcanzaba) y aparecían en claro. `redactPII` centraliza
              // todos los patrones, incluido ese.
              const safeText = sanitizeLogString(redactPII(m.text || ""));

              return (
                <div key={m.id || idx} style={{ color: logColor }}>
                  {prefix} [{senderLabel}] {safeText}
                  {m.form && ` (Formulario enviado: tipo=${m.form.type})`}
                  {m.attachment && ` (Adjunto inyectado: tipo=${m.attachment.type}, file=${m.attachment.fileLabel || "img"})`}
                </div>
              );
            })}
            
            <div ref={terminalEndRef} />
          </div>
        </div>

        {/* Guía Rápida e Información de Demostración */}
        <div
          style={{
            padding: "20px 24px",
            backgroundColor: "var(--card-bg)",
            border: "1px solid var(--border-color)",
            borderRadius: "14px",
            display: "flex",
            flexDirection: "column",
            gap: "8px"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Award size={18} style={{ color: "#16a34a" }} />
            <h4 style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-main)", fontWeight: "700" }}>Cómo funciona la IA Contextual</h4>
          </div>
          <p style={{ margin: 0, fontSize: "0.83rem", color: "var(--text-muted)", lineHeight: "1.5" }}>
            El chatbot ahora detecta de forma automática la estructura, títulos y fragmentos de texto de la página en la cual se encuentra embebido. Cuando conversas con él, se le envía esta información de fondo, lo que le permite responder con precisión a preguntas como <strong>"¿dónde estoy?"</strong> o <strong>"¿qué secciones tiene esta página?"</strong> sin necesidad de bases de datos estáticas externas.
          </p>
        </div>
      </div>
    </div>
  );
};
