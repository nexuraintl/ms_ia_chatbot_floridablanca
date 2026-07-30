import { useState } from "react";
import { consultarPqrsd } from "../../services/pqrsdService";
import { useChat } from "../../context/ChatContext";

export const PqrsdConsultCard = ({ initialRadicado = "", initialCodigo = "", onCancel }) => {
  const { selectQuickReply } = useChat();
  const [radicado, setRadicado] = useState(initialRadicado);
  const [codigoAutenticacion, setCodigoAutenticacion] = useState(initialCodigo);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [data, setData] = useState(null);

  const handleConsultar = async (e) => {
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

    setIsSubmitting(true);
    try {
      const res = await consultarPqrsd(radicado, codigoAutenticacion);
      setData(res);
    } catch (err) {
      setErrorMsg(err.message || "Ocurrió un error consultando el estado del radicado.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const getBadgeClass = (estado) => {
    if (!estado) return "badge-default";
    const lower = estado.toLowerCase();
    if (lower.includes("resuelt") || lower.includes("cerrad") || lower.includes("finaliz")) return "badge-success";
    if (lower.includes("revisi") || lower.includes("tramit") || lower.includes("proceso")) return "badge-warning";
    return "badge-info";
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
              required
            />
          </div>
        </div>

        <div className="pqrsd-actions">
          <button 
            type="submit" 
            className="btn-submit"
            disabled={isSubmitting}
          >
            {isSubmitting ? "⏳ Consultando..." : "🔍 Consultar"}
          </button>
          {onCancel && (
            <button 
              type="button" 
              className="btn-cancel"
              onClick={onCancel}
              disabled={isSubmitting}
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

      {/* Resultados de la consulta */}
      {data && (
        <div className="consult-results" style={{ marginTop: "14px" }}>
          {!data.found ? (
            <div className="pqrsd-warning">
              ⚠️ {data.message || "No se encontró un registro con los datos ingresados."}
            </div>
          ) : (
            <div className="pqrsd-details-container">
              {data.datos_correspondencia && (
                <div className="correspondencia-info">
                  <div className="info-header">
                    <h5>Radicado #{data.datos_correspondencia.radicado}</h5>
                    <span className={`status-badge ${getBadgeClass(data.datos_correspondencia.estado)}`}>
                      {data.datos_correspondencia.estado || "En proceso"}
                    </span>
                  </div>

                  <div className="info-grid">
                    <div className="info-row">
                      <span className="label">Asunto:</span>
                      <span className="val">{data.datos_correspondencia.asunto}</span>
                    </div>
                    <div className="info-row">
                      <span className="label">Tipo:</span>
                      <span className="val">{data.datos_correspondencia.tipo_correspondencia}</span>
                    </div>
                    <div className="info-row">
                      <span className="label">Fecha Radicación:</span>
                      <span className="val">
                        {data.datos_correspondencia.fecha_radicacion
                          ? new Date(data.datos_correspondencia.fecha_radicacion).toLocaleString()
                          : "N/A"}
                      </span>
                    </div>
                    <div className="info-row">
                      <span className="label">Remitente:</span>
                      <span className="val">{data.datos_correspondencia.remitente} ({data.datos_correspondencia.email})</span>
                    </div>
                    {data.datos_correspondencia.respuesta && (
                      <div className="info-row respuesta-box">
                        <span className="label">Respuesta Oficial:</span>
                        <span className="val">{data.datos_correspondencia.respuesta}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Anexos */}
              {data.anexos && data.anexos.length > 0 && (
                <div className="anexos-section">
                  <h6>📎 Documentos Anexos ({data.anexos.length})</h6>
                  <ul>
                    {data.anexos.map((anexo, idx) => (
                      <li key={idx}>
                        <span>📄 {anexo.NombreArchivo || anexo.Procedencia}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Flujo de trazabilidad */}
              {data.flujo && data.flujo.length > 0 && (
                <div className="flujo-section">
                  <h6>📌 Trazabilidad / Histórico del Trámite</h6>
                  <div className="timeline">
                    {data.flujo.map((paso, idx) => (
                      <div key={idx} className="timeline-item">
                        <div className="timeline-dot"></div>
                        <div className="timeline-content">
                          <div className="resp-nombre">
                            {paso.Responsable?.NombreConcatenado || "Responsable Asignado"}
                          </div>
                          <div className="resp-area">
                            {paso.Responsable?.Area} - {paso.Responsable?.Cargo}
                          </div>
                          <div className="resp-fechas">
                            <span>📅 Asignado: {paso.FechaAsignacionString || "N/A"}</span>
                            {paso.FechaRespuestaString && (
                              <span> | ✅ Respondió: {paso.FechaRespuestaString}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
