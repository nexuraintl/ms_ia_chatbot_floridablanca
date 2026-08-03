import { useState } from "react";
import { useChat } from "../../context/ChatContext";

export const PqrsdConsultCard = ({ initialRadicado = "", initialCodigo = "", onCancel }) => {
  const { selectQuickReply, handlePqrsdConsultSubmit, isLoading } = useChat();
  const [radicado, setRadicado] = useState(initialRadicado);
  const [codigoAutenticacion, setCodigoAutenticacion] = useState(initialCodigo);
  const [errorMsg, setErrorMsg] = useState(null);

  const handleConsultar = (e) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!radicado.trim()) {
      setErrorMsg("Ingresa el número de radicado.");
      return;
    }
    if (!codigoAutenticacion.trim()) {
      setErrorMsg("Ingresa el código de seguridad.");
      return;
    }

    if (handlePqrsdConsultSubmit) {
      handlePqrsdConsultSubmit({
        radicado: radicado.trim(),
        codigoAutenticacion: codigoAutenticacion.trim()
      });
    }
  };

  const handleGoToCreate = () => {
    if (selectQuickReply) {
      selectQuickReply("📑 Radicar PQRSD (Petición/Queja)");
    }
  };

  return (
    <div className="pqrsd-card consult-card">
      <div className="pqrsd-card-header">
        <span className="icon">🔍</span>
        <h4>Consulta y Trazabilidad de PQRSD</h4>
      </div>

      <p style={{ fontSize: "0.83rem", color: "#cbd5e1", margin: "0 0 12px 0", lineHeight: "1.4" }}>
        Digita tu número de radicado y tu código de seguridad suministrado al radicar la PQRSD.
      </p>

      <form onSubmit={handleConsultar} className="pqrsd-form">
        {errorMsg && <div className="pqrsd-error">{errorMsg}</div>}

        <div className="form-row">
          <div className="form-group half">
            <label>Número de Radicado *</label>
            <input 
              type="text"
              placeholder="Ej: 2026488450"
              value={radicado}
              onChange={(e) => setRadicado(e.target.value)}
              disabled={isLoading}
              required
            />
          </div>

          <div className="form-group half">
            <label>Código de Seguridad *</label>
            <input 
              type="text"
              placeholder="Ej: 202UhXbRIu2026488450"
              value={codigoAutenticacion}
              onChange={(e) => setCodigoAutenticacion(e.target.value)}
              disabled={isLoading}
              required
            />
          </div>
        </div>

        <div className="pqrsd-actions">
          <button 
            type="submit" 
            className="btn-submit"
            disabled={isLoading}
          >
            {isLoading ? "⏳ Consultando..." : "🔍 Consultar"}
          </button>
          {onCancel && (
            <button 
              type="button" 
              className="btn-cancel"
              onClick={onCancel}
              disabled={isLoading}
            >
              Cancelar
            </button>
          )}
        </div>
      </form>

      {/* Opción de reorientación si no tiene PQRSD */}
      <div style={{
        marginTop: "14px",
        paddingTop: "10px",
        borderTop: "1px solid rgba(255, 255, 255, 0.08)",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        fontSize: "0.8rem",
        color: "#94a3b8"
      }}>
        <span>¿Aún no tienes una PQRSD radicada? Escribe <strong>"radicar"</strong> en el chat o haz clic aquí:</span>
        <button
          type="button"
          onClick={handleGoToCreate}
          style={{
            background: "rgba(34, 197, 94, 0.12)",
            border: "1px solid rgba(34, 197, 94, 0.3)",
            color: "#4ade80",
            padding: "6px 12px",
            borderRadius: "6px",
            fontSize: "0.8rem",
            fontWeight: "600",
            cursor: "pointer",
            alignSelf: "flex-start",
            transition: "all 0.2s"
          }}
        >
          📑 Radicar
        </button>
      </div>
    </div>
  );
};
