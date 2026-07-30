import { useState } from "react";

export const PredioCardList = ({ predios = [], onSelectPredio }) => {
  const [selectedIdx, setSelectedIdx] = useState(null);

  const handleSelect = (index) => {
    setSelectedIdx(index);
    onSelectPredio(index);
  };

  return (
    <div className="animate-fade-in" style={{ display: "flex", flexDirection: "column", gap: "12px", margin: "10px 0", maxWidth: "440px" }}>
      <div style={{
        fontSize: "13px",
        fontWeight: 600,
        color: "#374151",
        background: "#eff6ff",
        padding: "10px 14px",
        borderRadius: "10px",
        border: "1px solid #bfdbfe",
        display: "flex",
        alignItems: "center",
        gap: "8px"
      }}>
        <span>🏢</span>
        <span>Se encontraron <strong>{predios.length} predios</strong> asociados a tu consulta. Selecciona el inmueble que deseas consultar (Sesión activa por 5 min):</span>
      </div>

      {predios.map((item) => {
        const index = item.index;
        const data = item.data || {};
        const isSelecting = selectedIdx === index;

        return (
          <div
            key={index}
            style={{
              background: "#ffffff",
              borderRadius: "14px",
              padding: "16px",
              boxShadow: "0 4px 14px rgba(0,0,0,0.06)",
              border: isSelecting ? "2px solid #10b981" : "1px solid #e5e7eb",
              transition: "all 0.2s ease"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <span style={{
                fontSize: "12px",
                fontWeight: 700,
                color: "#059669",
                background: "#ecfdf5",
                padding: "4px 8px",
                borderRadius: "6px"
              }}>
                Predio #{index + 1}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px", marginBottom: "14px" }}>
              {Object.entries(data).map(([key, val]) => {
                if (!val) return null;
                const displayKey = key.startsWith("col_") ? "Detalle" : key;
                return (
                  <div key={key} style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px dashed #f3f4f6", paddingBottom: "4px" }}>
                    <span style={{ color: "#6b7280", fontWeight: 500 }}>{displayKey}:</span>
                    <span style={{ color: "#111827", fontWeight: 600, textAlign: "right" }}>{String(val)}</span>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => handleSelect(index)}
              disabled={selectedIdx !== null}
              style={{
                width: "100%",
                padding: "10px",
                borderRadius: "8px",
                border: "none",
                background: isSelecting ? "#059669" : "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                color: "#ffffff",
                fontWeight: 700,
                fontSize: "13px",
                cursor: selectedIdx !== null ? "not-allowed" : "pointer",
                boxShadow: "0 4px 10px rgba(16, 185, 129, 0.25)"
              }}
            >
              {isSelecting ? "⏳ Generando Factura..." : "👉 Seleccionar este predio"}
            </button>
          </div>
        );
      })}
    </div>
  );
};
