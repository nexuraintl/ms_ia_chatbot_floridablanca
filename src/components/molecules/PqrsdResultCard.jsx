export const PqrsdResultCard = ({ data }) => {
  if (!data) return null;

  const getBadgeClass = (estado) => {
    if (!estado) return "badge-default";
    const lower = estado.toLowerCase();
    if (lower.includes("resuelt") || lower.includes("cerrad") || lower.includes("finaliz")) return "badge-success";
    if (lower.includes("revisi") || lower.includes("tramit") || lower.includes("proceso")) return "badge-warning";
    return "badge-info";
  };

  if (!data.found) {
    return (
      <div className="pqrsd-warning" style={{ margin: 0 }}>
        ⚠️ {data.message || "No se encontró un registro con los datos ingresados."}
      </div>
    );
  }

  const { datos_correspondencia, anexos, flujo } = data;

  return (
    <div className="pqrsd-card result-card" style={{ width: "100%", margin: 0 }}>
      <div className="pqrsd-card-header">
        <span className="icon">📋</span>
        <h4>Resultado de Consulta PQRSD</h4>
      </div>

      <div className="pqrsd-details-container" style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "12px" }}>
        {datos_correspondencia && (
          <div className="correspondencia-info">
            <div className="info-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <h5 style={{ margin: 0, fontSize: "0.95rem" }}>Radicado #{datos_correspondencia.radicado}</h5>
              <span className={`status-badge ${getBadgeClass(datos_correspondencia.estado)}`}>
                {datos_correspondencia.estado || "En proceso"}
              </span>
            </div>

            <div className="info-grid" style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "0.85rem" }}>
              <div className="info-row">
                <span className="label" style={{ fontWeight: 600, color: "var(--text-muted)", marginRight: "6px" }}>Asunto:</span>
                <span className="val">{datos_correspondencia.asunto}</span>
              </div>
              <div className="info-row">
                <span className="label" style={{ fontWeight: 600, color: "var(--text-muted)", marginRight: "6px" }}>Tipo:</span>
                <span className="val">{datos_correspondencia.tipo_correspondencia}</span>
              </div>
              <div className="info-row">
                <span className="label" style={{ fontWeight: 600, color: "var(--text-muted)", marginRight: "6px" }}>Fecha Radicación:</span>
                <span className="val">
                  {datos_correspondencia.fecha_radicacion
                    ? new Date(datos_correspondencia.fecha_radicacion).toLocaleString()
                    : "N/A"}
                </span>
              </div>
              <div className="info-row">
                <span className="label" style={{ fontWeight: 600, color: "var(--text-muted)", marginRight: "6px" }}>Remitente:</span>
                <span className="val">{datos_correspondencia.remitente} ({datos_correspondencia.email})</span>
              </div>
              {datos_correspondencia.respuesta && (
                <div className="info-row respuesta-box" style={{ marginTop: "6px", padding: "8px", borderRadius: "6px", background: "rgba(34, 197, 94, 0.1)", border: "1px solid rgba(34, 197, 94, 0.2)" }}>
                  <span className="label" style={{ fontWeight: 700, color: "#10b981", display: "block", marginBottom: "2px" }}>Respuesta Oficial:</span>
                  <span className="val">{datos_correspondencia.respuesta}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Anexos */}
        {anexos && anexos.length > 0 && (
          <div className="anexos-section" style={{ borderTop: "1px solid var(--border-color)", paddingTop: "10px" }}>
            <h6 style={{ margin: "0 0 6px 0", fontSize: "0.85rem" }}>📎 Documentos Anexos ({anexos.length})</h6>
            <ul style={{ paddingLeft: "16px", margin: 0, fontSize: "0.8rem" }}>
              {anexos.map((anexo, idx) => (
                <li key={idx}>
                  <span>📄 {anexo.NombreArchivo || anexo.Procedencia}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Flujo de trazabilidad */}
        {flujo && flujo.length > 0 && (
          <div className="flujo-section" style={{ borderTop: "1px solid var(--border-color)", paddingTop: "10px" }}>
            <h6 style={{ margin: "0 0 10px 0", fontSize: "0.85rem" }}>📌 Trazabilidad / Histórico del Trámite</h6>
            <div className="timeline">
              {flujo.map((paso, idx) => (
                <div key={idx} className="timeline-item">
                  <div className="timeline-dot"></div>
                  <div className="timeline-content" style={{ fontSize: "0.8rem", lineHeight: "1.4" }}>
                    <div className="resp-nombre" style={{ fontWeight: 600 }}>
                      {paso.Responsable?.NombreConcatenado || "Responsable Asignado"}
                    </div>
                    <div className="resp-area" style={{ color: "var(--text-muted)" }}>
                      {paso.Responsable?.Area} - {paso.Responsable?.Cargo}
                    </div>
                    <div className="resp-fechas" style={{ fontSize: "0.75rem", marginTop: "2px", opacity: 0.8 }}>
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
    </div>
  );
};
