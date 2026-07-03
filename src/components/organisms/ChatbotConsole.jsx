import React, { useState, useEffect, useRef } from "react";
import { useChat } from "../../context/ChatContext";
import { Terminal as TerminalIcon, Cpu, Key, Code, Copy, Check, TrendingDown, Sparkles, Globe, ShieldAlert, Award, Settings } from "lucide-react";

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
    setIsServicesEnabled
  } = useChat();
  const [copied, setCopied] = useState(false);
  const [localKey, setLocalKey] = useState(apiKey);
  const terminalEndRef = useRef(null);

  // Sincronizar localKey cuando la apiKey cambia en el contexto
  useEffect(() => {
    setLocalKey(apiKey);
  }, [apiKey]);

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
    updateApiKey(localKey);
    alert("API Key de Gemini actualizada exitosamente.");
  };

  // Calcular ahorro monetario simulado (0.000015 USD por token ahorrado en flash/prompts)
  const usdSaved = (tokensSavedTotal * 0.000015).toFixed(5);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "row",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        backgroundColor: "#090d16",
        color: "#cbd5e1",
        fontFamily: "'Outfit', 'Inter', sans-serif"
      }}
    >
      {/* PANEL LATERAL DE CONFIGURACIÓN */}
      <div
        style={{
          width: "320px",
          backgroundColor: "rgba(15, 23, 42, 0.45)",
          borderRight: "1px solid rgba(255, 255, 255, 0.06)",
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
        <div style={{ display: "flex", alignItems: "center", gap: "12px", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: "20px" }}>
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
            <h2 style={{ margin: 0, fontSize: "1.15rem", fontWeight: "800", color: "#f8fafc", letterSpacing: "0.5px" }}>
              FLORIDABLANCA
            </h2>
            <span style={{ fontSize: "0.75rem", color: "#22c55e", fontWeight: "600", textTransform: "uppercase", letterSpacing: "1px" }}>
              Capital Dulce
            </span>
          </div>
        </div>

        {/* Sección 1: API Key Manager */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Key size={18} style={{ color: "#d97706" }} />
            <h3 style={{ margin: 0, fontSize: "0.9rem", fontWeight: "600", color: "#f1f5f9" }}>Google Gemini Key</h3>
          </div>
          <p style={{ margin: 0, fontSize: "0.78rem", color: "#64748b", lineHeight: "1.4" }}>
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
                border: "1px solid rgba(255, 255, 255, 0.08)",
                backgroundColor: "rgba(0, 0, 0, 0.25)",
                color: "#ffffff",
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
                    color: "#f87171",
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
          <span style={{ fontSize: "0.72rem", color: "#475569" }}>
            ¿No tienes clave? Consíguela en <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer" style={{ color: "#22c55e", textDecoration: "underline" }}>Google AI Studio</a>.
          </span>
        </div>

        {/* Sección de Módulos (Habilitar/Deshabilitar características del chatbot) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Settings size={18} style={{ color: "#10b981" }} />
            <h3 style={{ margin: 0, fontSize: "0.9rem", fontWeight: "600", color: "#f1f5f9" }}>Módulos Habilitados</h3>
          </div>
          
          {/* Toggle: FAQ / Gemini IA */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: "600", color: "#e2e8f0" }}>Preguntas Frecuentes (IA)</span>
              <span style={{ fontSize: "0.7rem", color: "#64748b" }}>Respuesta libre con Gemini</span>
            </div>
            <button
              onClick={() => setIsGeminiEnabled(!isGeminiEnabled)}
              type="button"
              style={{
                width: "44px",
                height: "22px",
                borderRadius: "11px",
                backgroundColor: isGeminiEnabled ? "#15803d" : "#334155",
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
                  boxShadow: "0 1px 3px rgba(0,0,0,0.4)"
                }}
              />
            </button>
          </div>

          {/* Toggle: Servicios / Trámites */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: "600", color: "#e2e8f0" }}>Trámites y Servicios</span>
              <span style={{ fontSize: "0.7rem", color: "#64748b" }}>Sisbén, Predial y RPA</span>
            </div>
            <button
              onClick={() => setIsServicesEnabled(!isServicesEnabled)}
              type="button"
              style={{
                width: "44px",
                height: "22px",
                borderRadius: "11px",
                backgroundColor: isServicesEnabled ? "#15803d" : "#334155",
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
                  boxShadow: "0 1px 3px rgba(0,0,0,0.4)"
                }}
              />
            </button>
          </div>
        </div>

        {/* Sección 2: Integración (Embed) */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "auto", borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Code size={18} style={{ color: "#3b82f6" }} />
            <h3 style={{ margin: 0, fontSize: "0.9rem", fontWeight: "600", color: "#f1f5f9" }}>Script de Integración</h3>
          </div>
          <p style={{ margin: 0, fontSize: "0.78rem", color: "#64748b", lineHeight: "1.4" }}>
            Copia este script para inyectar el chatbot en cualquier sitio web externo:
          </p>
          <div
            style={{
              padding: "10px",
              borderRadius: "8px",
              backgroundColor: "rgba(0, 0, 0, 0.3)",
              border: "1px solid rgba(255, 255, 255, 0.05)",
              fontSize: "0.72rem",
              fontFamily: "monospace",
              wordBreak: "break-all",
              color: "#cbd5e1",
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
                background: "rgba(255, 255, 255, 0.08)",
                border: "none",
                borderRadius: "4px",
                padding: "4px",
                cursor: "pointer",
                color: copied ? "#22c55e" : "#94a3b8"
              }}
              title="Copiar código"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.72rem", color: "#64748b" }}>
            <Globe size={12} />
            <span>Soporta Cross-Origin completo (CORS)</span>
          </div>
        </div>
      </div>

      {/* ÁREA PRINCIPAL: MÉTRICAS Y TERMINAL */}
      <div
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: "1.8rem", fontWeight: "800", color: "#ffffff", letterSpacing: "-0.5px" }}>
              Panel de Control del Asistente Virtual
            </h1>
            <p style={{ margin: "4px 0 0 0", fontSize: "0.9rem", color: "#64748b" }}>
              Monitorea el consumo de la API de Gemini, logs del sistema y simulación de automatizaciones RPA.
            </p>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              backgroundColor: "rgba(34, 197, 94, 0.1)",
              border: "1px solid rgba(34, 197, 94, 0.2)",
              padding: "6px 14px",
              borderRadius: "20px"
            }}
          >
            <span
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: "#22c55e",
                boxShadow: "0 0 8px #22c55e"
              }}
            />
            <span style={{ fontSize: "0.78rem", color: "#4ade80", fontWeight: "600", letterSpacing: "0.5px" }}>
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
              backgroundColor: "rgba(30, 41, 59, 0.25)",
              border: "1px solid rgba(255, 255, 255, 0.06)",
              borderRadius: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              boxShadow: "0 4px 15px rgba(0, 0, 0, 0.1)"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: "600", color: "#64748b" }}>TOKENS CONSUMIDOS</span>
              <Cpu size={16} style={{ color: "#3b82f6" }} />
            </div>
            <span style={{ fontSize: "1.8rem", fontWeight: "800", color: "#ffffff" }}>
              {tokensUsedTotal.toLocaleString()}
            </span>
            <span style={{ fontSize: "0.72rem", color: "#475569" }}>
              Consumo real en peticiones Gemini
            </span>
          </div>

          {/* Tarjeta 2: Tokens Ahorrados */}
          <div
            style={{
              padding: "20px",
              backgroundColor: "rgba(30, 41, 59, 0.25)",
              border: "1px solid rgba(255, 255, 255, 0.06)",
              borderRadius: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              boxShadow: "0 4px 15px rgba(0, 0, 0, 0.1)"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: "600", color: "#64748b" }}>TOKENS AHORRADOS</span>
              <TrendingDown size={16} style={{ color: "#22c55e" }} />
            </div>
            <span style={{ fontSize: "1.8rem", fontWeight: "800", color: "#22c55e" }}>
              {tokensSavedTotal.toLocaleString()}
            </span>
            <span style={{ fontSize: "0.72rem", color: "#475569" }}>
              Optimizados por respuestas cortas
            </span>
          </div>

          {/* Tarjeta 3: Ahorro Monetario Estimado */}
          <div
            style={{
              padding: "20px",
              backgroundColor: "rgba(30, 41, 59, 0.25)",
              border: "1px solid rgba(255, 255, 255, 0.06)",
              borderRadius: "12px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              boxShadow: "0 4px 15px rgba(0, 0, 0, 0.1)"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: "600", color: "#64748b" }}>EFICIENCIA DE COSTOS</span>
              <Sparkles size={16} style={{ color: "#eab308" }} />
            </div>
            <span style={{ fontSize: "1.8rem", fontWeight: "800", color: "#eab308" }}>
              ${usdSaved}
            </span>
            <span style={{ fontSize: "0.72rem", color: "#475569" }}>
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
              backgroundColor: "#0f172a",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              borderBottom: "none",
              padding: "10px 18px",
              borderRadius: "10px 10px 0 0"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <TerminalIcon size={16} style={{ color: "#22c55e" }} />
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
              backgroundColor: "#020617",
              border: "1px solid rgba(255, 255, 255, 0.08)",
              padding: "16px",
              borderRadius: "0 0 10px 10px",
              overflowY: "auto",
              fontFamily: "'Courier New', Courier, monospace",
              fontSize: "0.78rem",
              lineHeight: "1.5",
              color: "#34d399",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              maxHeight: "360px",
              boxShadow: "inset 0 4px 20px rgba(0, 0, 0, 0.8)"
            }}
          >
            <div style={{ color: "#64748b" }}>
              [SYSTEM_LOG] [{new Date().toLocaleDateString()}] Inicializando terminal de logs...
            </div>
            <div style={{ color: "#64748b" }}>
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

              return (
                <div key={m.id || idx} style={{ color: logColor }}>
                  {prefix} [{senderLabel}] {m.text}
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
            backgroundColor: "rgba(30, 41, 59, 0.15)",
            border: "1px solid rgba(255, 255, 255, 0.04)",
            borderRadius: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "8px"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Award size={16} style={{ color: "#10b981" }} />
            <h4 style={{ margin: 0, fontSize: "0.85rem", color: "#f1f5f9" }}>Cómo funciona la IA Contextual</h4>
          </div>
          <p style={{ margin: 0, fontSize: "0.8rem", color: "#64748b", lineHeight: "1.5" }}>
            El chatbot ahora detecta de forma automática la estructura, títulos y fragmentos de texto de la página en la cual se encuentra embebido. Cuando conversas con él, se le envía esta información de fondo, lo que le permite responder con precisión a preguntas como <strong>"¿dónde estoy?"</strong> o <strong>"¿qué secciones tiene esta página?"</strong> sin necesidad de bases de datos estáticas externas.
          </p>
        </div>
      </div>
    </div>
  );
};
