import { useState, useEffect } from "react";
import { getClientes, prewarmCaptcha } from "../../services/rpaPredialService";
import { useChat } from "../../context/ChatContext";

export const PredialForm = ({ onSubmit, onCancel }) => {
  // Si el ciudadano ya se identificó, no volver a pedirle el correo.
  const { identityPrefill } = useChat();

  const [searchTypes, setSearchTypes] = useState([
    "Código Predial",
    "Número Cuenta",
    "Código NPN",
    "Código NUPRE",
    "Matrícula Inmobiliaria"
  ]);
  const [loadingTypes, setLoadingTypes] = useState(true);

  const [formData, setFormData] = useState({
    searchType: "Código Predial",
    searchValue: "",
    phone: "",
    email: identityPrefill?.email || ""
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    let isMounted = true;
    
    // Disparar Prewarm en Floridablanca al cargar el formulario
    prewarmCaptcha("floridablanca");

    const fetchClientInfo = async () => {
      setLoadingTypes(true);
      try {
        const data = await getClientes();
        if (isMounted && data && data.clientes) {
          const floridablanca = data.clientes.find(c => c.id === "floridablanca");
          if (floridablanca && floridablanca.search_types) {
            setSearchTypes(floridablanca.search_types);
            setFormData(prev => ({
              ...prev,
              searchType: floridablanca.search_types[0] || "Código Predial"
            }));
          }
        }
      } catch (err) {
        console.warn("Usando tipos de búsqueda prederminados de Floridablanca:", err);
      } finally {
        if (isMounted) setLoadingTypes(false);
      }
    };

    fetchClientInfo();
    return () => { isMounted = false; };
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!formData.searchValue.trim()) {
      setErrorMsg("Debes ingresar un número de identificación o código para buscar.");
      return;
    }

    if (!formData.phone.trim() || formData.phone.trim().length < 7) {
      setErrorMsg("Ingresa un número de celular válido para la notificación oficial.");
      return;
    }

    if (!formData.email.trim() || !formData.email.includes("@")) {
      setErrorMsg("Ingresa un correo electrónico válido para la notificación oficial.");
      return;
    }

    setIsSubmitting(true);
    onSubmit({
      searchType: formData.searchType,
      searchValue: formData.searchValue.trim(),
      phone: formData.phone.trim(),
      email: formData.email.trim(),
      cliente: "floridablanca"
    });
  };

  return (
    <div className="form-card animate-fade-in" style={{
      background: "var(--card-bg, #ffffff)",
      borderRadius: "16px",
      padding: "20px",
      boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
      border: "1px solid rgba(0,0,0,0.06)",
      maxWidth: "420px",
      margin: "10px 0"
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
        <div style={{
          width: "38px",
          height: "38px",
          borderRadius: "10px",
          background: "linear-gradient(135deg, #059669 0%, #10b981 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontSize: "18px"
        }}>
          🏡
        </div>
        <div>
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "var(--text-color, #1f2937)" }}>
            Consulta de Impuesto Predial
          </h3>
          <span style={{ fontSize: "12px", color: "#6b7280" }}>
            Alcaldía de Floridablanca (Santander)
          </span>
        </div>
      </div>

      {errorMsg && (
        <div style={{
          padding: "10px 14px",
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: "8px",
          color: "#991b1b",
          fontSize: "13px",
          marginBottom: "14px"
        }}>
          ⚠️ {errorMsg}
        </div>
      )}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px", color: "#374151" }}>
            Tipo de Búsqueda
          </label>
          <select
            name="searchType"
            value={formData.searchType}
            onChange={handleChange}
            disabled={loadingTypes || isSubmitting}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid #d1d5db",
              fontSize: "14px",
              backgroundColor: "#f9fafb"
            }}
          >
            {searchTypes.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px", color: "#374151" }}>
            {formData.searchType} *
          </label>
          <input
            type="text"
            name="searchValue"
            value={formData.searchValue}
            onChange={handleChange}
            placeholder={`Ingresa ${formData.searchType}...`}
            disabled={isSubmitting}
            required
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid #d1d5db",
              fontSize: "14px",
              boxSizing: "border-box"
            }}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px", color: "#374151" }}>
              Teléfono Celular *
            </label>
            <input
              type="tel"
              name="phone"
              value={formData.phone}
              onChange={handleChange}
              placeholder="Ej. 3101234567"
              disabled={isSubmitting}
              required
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                fontSize: "13px",
                boxSizing: "border-box"
              }}
            />
          </div>

          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, marginBottom: "4px", color: "#374151" }}>
              Correo Electrónico *
            </label>
            <input
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="tu@correo.com"
              disabled={isSubmitting}
              required
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                fontSize: "13px",
                boxSizing: "border-box"
              }}
            />
          </div>
        </div>

        <div style={{
          fontSize: "11px",
          color: "#6b7280",
          background: "#f3f4f6",
          padding: "8px 10px",
          borderRadius: "6px"
        }}>
          💡 El municipio de Floridablanca requiere teléfono y correo para notificar el registro de la factura.
        </div>

        <div style={{ display: "flex", gap: "10px", marginTop: "6px" }}>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isSubmitting}
              style={{
                flex: 1,
                padding: "10px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                background: "#ffffff",
                color: "#374151",
                fontWeight: 600,
                cursor: "pointer"
              }}
            >
              Cancelar
            </button>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              flex: 2,
              padding: "10px",
              borderRadius: "8px",
              border: "none",
              background: "linear-gradient(135deg, #059669 0%, #10b981 100%)",
              color: "#ffffff",
              fontWeight: 700,
              fontSize: "14px",
              cursor: isSubmitting ? "not-allowed" : "pointer",
              boxShadow: "0 4px 12px rgba(16, 185, 129, 0.3)"
            }}
          >
            {isSubmitting ? "Buscando información..." : "🔍 Consultar Predial"}
          </button>
        </div>
      </form>
    </div>
  );
};
