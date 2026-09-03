import { useState, useEffect, useMemo, useRef } from "react";
import { useChat } from "../../context/ChatContext";
import {
  Terminal as TerminalIcon,
  Cpu,
  Key,
  Code,
  Copy,
  Check,
  Globe,
  Settings,
  Sun,
  Moon,
  Activity,
  Archive,
  MessagesSquare,
  ShieldCheck,
  ClipboardList,
  Info
} from "lucide-react";
import { redactPII } from "../../domain/security/piiRedactor";
import { sanitizeLogString } from "../../domain/security/textSanitizer";
import { isValidGeminiApiKey } from "../../hooks/usePreferences";
import { useSessionMetrics } from "../../hooks/useSessionMetrics";
import { summarizeConversation, formatDuration } from "../../domain/observability/conversationStats";
import { environment } from "../../config/environment";
import config from "../../config/chatbotConfig.json";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SE MONITOREA AQUÍ (Y QUÉ SE DEJÓ DE MONITOREAR)
 *
 * La versión anterior encabezaba el panel con tres tarjetas: TOKENS CONSUMIDOS,
 * TOKENS AHORRADOS y EFICIENCIA DE COSTOS. Ninguna medía algo verificable:
 *
 *   · "TOKENS AHORRADOS" era `150 - tokensDeLaRespuesta`, la diferencia contra un
 *     presupuesto imaginario. El proveedor local devolvía la constante 120.
 *   · "EFICIENCIA DE COSTOS" multiplicaba esa cifra inventada por un precio fijo
 *     escrito en este archivo. Producía un número en dólares con apariencia de dato
 *     contable, que es justo lo que alguien copia a un informe de gestión.
 *   · Sin clave de API, "TOKENS CONSUMIDOS" contaba consumo de una API que nunca se
 *     llamó, porque el catálogo local también reportaba tokens estimados.
 *   · Los tres contadores vivían en estado de React: cualquier recarga los ponía a cero.
 *
 * Se reemplazaron por lo que un operador de la Alcaldía necesita comprobar de un vistazo
 * y este widget sí sabe con certeza:
 *
 *   1. QUIÉN ESTÁ RESPONDIENDO. Sin clave, el chatbot responde con el catálogo local.
 *      Antes no había ninguna señal en la interfaz y se confundía con la IA real.
 *   2. SI LA EVIDENCIA SE ESTÁ GUARDANDO. El registro de la atención es la prueba de
 *      la gestión; los registros sin entregar son la señal de que el backend no confirma.
 *   3. CÓMO VA LA ATENCIÓN EN CURSO. Mensajes, duración e identificación del ciudadano.
 *   4. SI EL SERVICIO RESPONDE BIEN. Respuestas degradadas y latencia real medida.
 *   5. QUÉ TRÁMITES SE INICIARON Y CUÁLES TERMINARON, con el motivo del último fallo.
 *   6. QUÉ DEFENSAS ACTUARON: datos personales enmascarados y enlaces bloqueados.
 *   7. EL CONSUMO DE LA API, separando lo que reporta Google de lo que estimamos, y sin
 *      convertirlo a dinero: el precio por token no está en el navegador.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Paleta de estados. Se mantiene la del proyecto para no introducir colores nuevos. */
const TONE = Object.freeze({
  ok: { color: "#16a34a", bg: "rgba(22, 163, 74, 0.12)", border: "rgba(22, 163, 74, 0.3)" },
  warn: { color: "#d97706", bg: "rgba(217, 119, 6, 0.12)", border: "rgba(217, 119, 6, 0.3)" },
  error: { color: "#dc2626", bg: "rgba(239, 68, 68, 0.12)", border: "rgba(239, 68, 68, 0.3)" },
  info: { color: "#0284c7", bg: "rgba(2, 132, 199, 0.12)", border: "rgba(2, 132, 199, 0.3)" },
  idle: { color: "var(--text-muted)", bg: "transparent", border: "var(--border-color)" }
});

/** Nombre legible de cada trámite enrutable. */
const FLOW_LABELS = Object.freeze({
  sisben: "Sisbén",
  predial: "Predial",
  pqrsd_crear: "PQRSD",
  pqrsd_consultar: "PQRSD",
  pqrsd: "PQRSD"
});

/**
 * Trámites realmente configurados, derivados de `chatbotConfig.json > routing`.
 *
 * El interruptor de servicios anunciaba "Sisbén, Predial y RPA" en texto fijo. Cuando
 * Sisbén se retiró del enrutamiento y de las respuestas rápidas, el rótulo siguió
 * ofreciéndolo: la interfaz prometía un trámite que ya no se podía iniciar. Derivarlo de
 * la configuración evita que vuelva a desincronizarse.
 */
const CONFIGURED_FLOWS_LABEL =
  Array.from(
    new Set(
      Object.keys(config.routing || {})
        .map((id) => FLOW_LABELS[id])
        .filter(Boolean)
    )
  ).join(" · ") || "Ninguno configurado";

/** Estilo base compartido por las tarjetas y los paneles. */
const panelStyle = {
  backgroundColor: "var(--card-bg)",
  border: "1px solid var(--border-color)",
  borderRadius: "14px",
  boxShadow: "0 4px 15px rgba(0, 0, 0, 0.04)"
};

/**
 * Tarjeta de estado: rótulo, valor grande, detalle y una nota opcional.
 *
 * @param {Object} props
 * @param {string} props.label
 * @param {React.ReactNode} props.value
 * @param {string} props.detail
 * @param {string} [props.note]
 * @param {keyof TONE} [props.tone]
 * @param {React.ComponentType<{size?: number, style?: Object}>} props.icon
 */
const StatusCard = ({ label, value, detail, note, tone = "idle", icon: Icon }) => {
  const palette = TONE[tone] || TONE.idle;

  return (
    <div style={{ ...panelStyle, padding: "18px 20px", display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "0.72rem", fontWeight: "700", color: "var(--text-muted)", letterSpacing: "0.6px" }}>
          {label}
        </span>
        <Icon size={17} style={{ color: palette.color, flexShrink: 0 }} />
      </div>

      <span style={{ fontSize: "1.45rem", fontWeight: "800", color: palette.color, lineHeight: 1.15 }}>
        {value}
      </span>

      <span style={{ fontSize: "0.76rem", color: "var(--text-muted)", lineHeight: "1.45" }}>{detail}</span>

      {note && (
        <span
          style={{
            fontSize: "0.72rem",
            fontWeight: "600",
            color: palette.color,
            backgroundColor: palette.bg,
            border: `1px solid ${palette.border}`,
            borderRadius: "6px",
            padding: "3px 8px",
            alignSelf: "flex-start"
          }}
        >
          {note}
        </span>
      )}
    </div>
  );
};

/** Encabezado de un panel de la mitad inferior. */
const PanelHeader = ({ icon: Icon, title, hint }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginBottom: "14px" }}>
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <Icon size={17} style={{ color: "#16a34a" }} />
      <h3 style={{ margin: 0, fontSize: "0.88rem", fontWeight: "700", color: "var(--text-main)" }}>{title}</h3>
    </div>
    {hint && <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{hint}</span>}
  </div>
);

/** Fila "etiqueta — valor" de los paneles de detalle. */
const DetailRow = ({ label, value, tone = "idle", footnote }) => {
  const palette = TONE[tone] || TONE.idle;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        padding: "9px 0",
        borderBottom: "1px solid var(--border-color)"
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px" }}>
        <span style={{ fontSize: "0.8rem", color: "var(--text-main)" }}>{label}</span>
        <span style={{ fontSize: "0.85rem", fontWeight: "700", color: palette.color, whiteSpace: "nowrap" }}>
          {value}
        </span>
      </div>
      {footnote && (
        <span style={{ fontSize: "0.71rem", color: "var(--text-muted)", lineHeight: "1.4" }}>{footnote}</span>
      )}
    </div>
  );
};

/** Formatea una latencia en milisegundos. */
const formatLatency = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} s` : "—");

/**
 * Concuerda el sustantivo con la cifra. Evita los "1 respuestas" y los "(s)" pegados,
 * que en un panel institucional se leen como descuido.
 *
 * @param {number} count
 * @param {string} singular
 * @param {string} plural
 * @returns {string}
 */
const pluralize = (count, singular, plural) => `${count} ${count === 1 ? singular : plural}`;

export const ChatbotConsole = () => {
  const {
    apiKey,
    updateApiKey,
    messages,
    providerName,
    identity,
    identityMode,
    hasConsent,
    conversationId,
    isRecordingEnabled,
    recorderName,
    pendingRecords,
    isGeminiEnabled,
    setIsGeminiEnabled,
    isServicesEnabled,
    setIsServicesEnabled,
    theme,
    toggleTheme
  } = useChat();

  const metrics = useSessionMetrics();

  const [copied, setCopied] = useState(false);
  const [localKey, setLocalKey] = useState(apiKey);
  const [prevApiKey, setPrevApiKey] = useState(apiKey);
  const terminalEndRef = useRef(null);

  /**
   * Reloj de pared para la duración de la sesión. Se refresca cada 30 s: es lo único del
   * panel que cambia sin que ocurra nada, así que no merece un intervalo más corto.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  /** Marca de arranque del panel, fijada una sola vez (antes se recalculaba en cada render). */
  const bootedAt = useMemo(() => new Date().toLocaleString(), []);

  // Sincronizar localKey cuando la apiKey cambia en el contexto sin re-renders en cascada
  if (apiKey !== prevApiKey) {
    setPrevApiKey(apiKey);
    setLocalKey(apiKey);
  }

  // Auto-scroll en la terminal de logs
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /**
   * Estadísticas derivadas de la conversación. Se recalculan cuando cambian los mensajes,
   * no se llevan en contadores: las defensas que miden (redacción de PII, bloqueo de
   * enlaces) se aplican durante el render, y un contador ahí subiría con cada repintado.
   */
  const stats = useMemo(
    () => summarizeConversation(messages, { baseOrigin: globalThis.window?.location?.origin }),
    [messages]
  );

  /**
   * Script de integración, calculado del origen real.
   *
   * Antes era una cadena fija con `localhost:5173/src/embed.jsx`. Copiado a un portal y
   * cambiándole el host, apuntaba a una ruta que no existe en el contenedor —el servidor
   * responde `index.html` a cualquier ruta desconocida— y el navegador intentaba ejecutar
   * HTML como módulo. `assets/embed.js` sí existe y no lleva hash, para que el portal no
   * tenga que actualizar la etiqueta en cada despliegue.
   */
  const embedSnippet = useMemo(() => {
    const origin = environment.backendOrigin || globalThis.window?.location?.origin || "";
    return `<script type="module" src="${origin}/assets/embed.js"></script>`;
  }, []);

  const handleCopyCode = () => {
    navigator.clipboard.writeText(embedSnippet);
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

  // ── Lecturas de estado para las tarjetas ──────────────────────────────────

  /**
   * Quién responde. Son tres situaciones distintas y el operador necesita distinguirlas:
   * la IA a través del backend, la IA directa desde el navegador (solo desarrollo), o el
   * catálogo local. Y un cuarto caso que antes era invisible: la IA cortada por cuota,
   * que para el ciudadano se ve exactamente igual que el catálogo local porque no se le
   * muestra ningún aviso.
   */
  const isProxyProvider = providerName === "ai-proxy";
  const isDirectProvider = providerName === "gemini-api";
  const isRemoteProvider = isProxyProvider || isDirectProvider;
  const isQuotaDegraded = metrics.ai.fallbackActive === true;

  const engineTone = !isGeminiEnabled || isQuotaDegraded ? "warn" : isRemoteProvider ? "ok" : "info";

  /** Motivos del proxy, traducidos para el operador. */
  const FALLBACK_LABELS = {
    quota_exhausted: "cuota diaria agotada en el backend",
    rate_limited: "demasiadas consultas por minuto desde esta red",
    ai_unavailable: "el backend no puede hablar con Gemini",
    transport: "no se pudo alcanzar el backend"
  };

  const recordingTone = !isRecordingEnabled ? "warn" : pendingRecords > 0 ? "error" : "ok";

  const identityLabel = identity ? "Identificado" : identityMode === "off" ? "Anónimo por diseño" : "Anónimo";

  const healthTone =
    metrics.ai.replies === 0 ? "idle" : metrics.ai.degraded > 0 ? "error" : "ok";

  const sessionDuration = formatDuration(Math.max(0, nowMs - metrics.startedAt));

  const totalStarted = metrics.flows.reduce((acc, f) => acc + f.started, 0);
  const totalFailed = metrics.flows.reduce((acc, f) => acc + f.failed, 0);

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
              {/* Etiqueta derivada de la configuración: ver CONFIGURED_FLOWS_LABEL. */}
              <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{CONFIGURED_FLOWS_LABEL}</span>
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
            {embedSnippet}
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

      {/* ÁREA PRINCIPAL: ESTADO OPERATIVO Y TERMINAL */}
      <div
        className="console-main-area"
        style={{
          flex: 1,
          padding: "32px 40px",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
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
              Estado del servicio, evidencia de la atención y trámites de la sesión en curso.
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
            <span style={{ fontSize: "0.75rem", color: "#16a34a", fontWeight: "600", letterSpacing: "0.4px" }}>
              {environment.serviceName} · {environment.serviceVersion} · {environment.environmentName.toUpperCase()}
            </span>
          </div>
        </div>

        {/* REJILLA DE ESTADO OPERATIVO */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "18px" }}>
          {/* 1. Quién está respondiendo. Sin esta tarjeta, el catálogo local se confunde
                 con la IA real y se reportan como respuestas del modelo. */}
          <StatusCard
            label="MOTOR DE RESPUESTA"
            value={isQuotaDegraded ? "Catálogo local" : isRemoteProvider ? "IA Gemini" : "Catálogo local"}
            detail={
              isQuotaDegraded
                ? "La IA está cortada para esta sesión. El ciudadano no ve ningún aviso: sigue recibiendo respuestas del banco de preguntas."
                : isProxyProvider
                  ? "Consultas resueltas por el modelo a través del proxy del backend, que guarda la clave y controla el gasto."
                  : isDirectProvider
                    ? "Llamada directa a Gemini desde el navegador, con la clave del operador. Modo de desarrollo."
                    : "Sin backend ni clave: responde el catálogo de preguntas frecuentes del repositorio."
            }
            note={
              isQuotaDegraded
                ? `Motivo: ${FALLBACK_LABELS[metrics.ai.lastFallbackReason] || metrics.ai.lastFallbackReason || "límite del backend"}`
                : !isGeminiEnabled
                  ? "Respuesta libre deshabilitada"
                  : isDirectProvider && apiKey && !isValidGeminiApiKey(apiKey)
                    ? "La clave guardada no tiene el formato de Google AI Studio"
                    : null
            }
            tone={engineTone}
            icon={Cpu}
          />

          {/* 2. La evidencia de la atención. `pendingRecords > 0` significa que el backend
                 no está confirmando: es el único indicador que anticipa pérdida de registro. */}
          <StatusCard
            label="REGISTRO DE LA ATENCIÓN"
            value={isRecordingEnabled ? "Activo" : "Desactivado"}
            detail={
              isRecordingEnabled
                ? `Destino "${recorderName}". Conversación ${String(conversationId || "").slice(0, 8)}…`
                : `Modo "off": no se envía ningún dato personal a ningún destino.`
            }
            note={
              isRecordingEnabled && pendingRecords > 0
                ? `${pluralize(pendingRecords, "registro", "registros")} en cola sin confirmar`
                : null
            }
            tone={recordingTone}
            icon={Archive}
          />

          {/* 3. Volumen y contexto de la atención en curso. */}
          <StatusCard
            label="ATENCIÓN EN CURSO"
            value={pluralize(stats.total, "mensaje", "mensajes")}
            detail={`${stats.fromCitizen} del ciudadano · ${stats.fromBot} del asistente · ${sessionDuration} de sesión`}
            note={hasConsent ? `${identityLabel} · autorización registrada` : identityLabel}
            tone={identity ? "ok" : "info"}
            icon={MessagesSquare}
          />

          {/* 4. Salud del servicio: la latencia se mide alrededor de la llamada real al
                 proveedor, y las degradadas son las respuestas de contingencia. */}
          <StatusCard
            label="RESPUESTAS DEL ASISTENTE"
            value={
              metrics.ai.replies === 0
                ? "Sin actividad"
                : pluralize(metrics.ai.replies, "respuesta", "respuestas")
            }
            detail={
              metrics.ai.latencySamples === 0
                ? "Todavía no hay mediciones de latencia en esta sesión."
                : `Latencia p50 ${formatLatency(metrics.ai.p50LatencyMs)} · última ${formatLatency(metrics.ai.lastLatencyMs)}`
            }
            note={
              metrics.ai.degraded > 0
                ? `${pluralize(metrics.ai.degraded, "respuesta degradada", "respuestas degradadas")} por fallo del proveedor`
                : null
            }
            tone={healthTone}
            icon={Activity}
          />
        </div>

        {/* DETALLE: TRÁMITES Y VERIFICACIONES */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))", gap: "18px" }}>
          {/* Trámites: el inicio se cuenta en `runFlow`, así que ningún trámite nuevo se
              queda fuera del panel por olvido de instrumentarlo. */}
          <div style={{ ...panelStyle, padding: "20px 22px" }}>
            <PanelHeader
              icon={ClipboardList}
              title="Trámites de esta sesión"
              hint={
                totalStarted === 0
                  ? "Aún no se ha iniciado ningún trámite."
                  : `${pluralize(totalStarted, "trámite iniciado", "trámites iniciados")} · ${totalFailed} con fallo.`
              }
            />

            {metrics.flows.length === 0 ? (
              <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-muted)", lineHeight: "1.5" }}>
                Cuando el ciudadano abra un trámite —Predial o PQRSD— aquí aparecerán los intentos,
                los que entregaron resultado (factura o radicado) y el motivo de los que fallaron.
              </p>
            ) : (
              metrics.flows.map((flow) => (
                <DetailRow
                  key={flow.id}
                  label={flow.label}
                  value={`${flow.started} ▸ ${flow.completed} ✓ ${flow.failed} ✕`}
                  tone={flow.failed > 0 ? "error" : flow.completed > 0 ? "ok" : "info"}
                  footnote={flow.lastError ? `Último fallo: ${flow.lastError}` : null}
                />
              ))
            )}
          </div>

          {/* Defensas y consumo. Las dos primeras cifras se derivan de los mensajes; las de
              tokens vienen del proveedor, separando lo reportado de lo estimado. */}
          <div style={{ ...panelStyle, padding: "20px 22px" }}>
            <PanelHeader
              icon={ShieldCheck}
              title="Defensas y consumo de la API"
              hint="Lo que las capas de seguridad interceptaron en esta conversación."
            />

            <DetailRow
              label="Mensajes con datos personales enmascarados"
              value={stats.withMaskedPii}
              tone={stats.withMaskedPii > 0 ? "ok" : "idle"}
              footnote="Cédulas, correos, celulares y códigos de PQRSD no salen en claro hacia logs ni telemetría."
            />

            <DetailRow
              label="Enlaces no autorizados bloqueados"
              value={stats.blockedLinkHosts.length}
              tone={stats.blockedLinkHosts.length > 0 ? "warn" : "idle"}
              footnote={
                stats.blockedLinkHosts.length > 0
                  ? `Destinos: ${stats.blockedLinkHosts.join(", ")}`
                  : "Ningún enlace fuera de la lista blanca apareció en las respuestas."
              }
            />

            <DetailRow
              label="Tokens reportados por la API"
              value={metrics.tokens.reported.toLocaleString()}
              tone={metrics.tokens.reported > 0 ? "info" : "idle"}
              footnote={
                metrics.ai.apiReplies === 0
                  ? "No se ha llamado a Gemini en esta sesión: el catálogo local no consume cuota."
                  : `Cifra exacta de usageMetadata en ${metrics.tokens.reportedCalls} de ${pluralize(metrics.ai.apiReplies, "llamada", "llamadas")}.`
              }
            />

            {metrics.tokens.estimated > 0 && (
              <DetailRow
                label="Tokens estimados (sin dato de la API)"
                value={metrics.tokens.estimated.toLocaleString()}
                tone="warn"
                footnote={`Aproximación por longitud de texto en ${pluralize(metrics.tokens.estimatedCalls, "llamada", "llamadas")} sin usageMetadata. No usar para facturación.`}
              />
            )}

            {metrics.ai.fallbackReplies > 0 && (
              <DetailRow
                label="Respuestas atendidas por el banco de preguntas"
                value={metrics.ai.fallbackReplies}
                tone="warn"
                footnote="Consultas que la IA no atendió por un límite del backend y resolvió el catálogo local. Para el ciudadano fueron respuestas normales."
              />
            )}

            <DetailRow
              label="Formularios y adjuntos entregados"
              value={`${stats.interactiveCards} / ${stats.attachments}`}
              tone="idle"
              footnote="Tarjetas de trámite mostradas y archivos entregados (facturas, códigos QR)."
            />
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
            {/* Cabecera de arranque con los datos que exige GOB-GCP-STD-01 en /version.
                Antes eran dos líneas decorativas que además recalculaban la fecha en
                cada render. */}
            <div style={{ color: "#94a3b8" }}>
              [BOOT] [{bootedAt}] servicio={environment.serviceName} versión={environment.serviceVersion} ambiente={environment.environmentName}
            </div>
            <div style={{ color: "#94a3b8" }}>
              [BOOT] motor={providerName} registro={recorderName} telemetría={environment.telemetryEnabled ? "activa" : "inactiva"}
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

        {/* Cómo leer las cifras. Va aquí a propósito: la única forma de que una métrica
            no se malinterprete es decir en el mismo panel qué mide y qué no. */}
        <div style={{ ...panelStyle, padding: "18px 22px", display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Info size={17} style={{ color: "#0284c7" }} />
            <h4 style={{ margin: 0, fontSize: "0.88rem", color: "var(--text-main)", fontWeight: "700" }}>
              Cómo leer estas cifras
            </h4>
          </div>
          <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "0.8rem", color: "var(--text-muted)", lineHeight: "1.6" }}>
            <li>
              Corresponden a <strong>la sesión abierta en este navegador</strong>. Se reinician al recargar
              la página y al reiniciar la conversación, porque describen una atención concreta y no un
              acumulado histórico. El acumulado corresponde al backend de registro, no al widget.
            </li>
            <li>
              El consumo de tokens solo suma cuando el proveedor declara que la llamada gastó cuota
              remota. Las respuestas del catálogo local no cuentan, y lo que informa la API se muestra
              aparte de lo estimado por longitud de texto.
            </li>
            <li>
              No se calcula ahorro ni coste en dinero: el precio por token depende del modelo y del
              contrato, datos que no están en el navegador. La cifra que sustituía a esto era el
              resultado de multiplicar un presupuesto imaginario por un precio fijo escrito en el código.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
};
