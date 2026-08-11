import { useState } from "react";
import { ShieldCheck, UserRound } from "lucide-react";

/**
 * Formulario de identificación del ciudadano.
 *
 * Recoge nombre y correo junto con la autorización expresa de tratamiento de datos.
 *
 * Sobre la casilla de autorización: es obligatoria y viene DESMARCADA por defecto. La
 * Ley 1581 de 2012 exige autorización previa, expresa e informada, y una casilla ya
 * marcada no es una manifestación de voluntad de nadie — es una que el ciudadano no
 * llegó a tomar. Por el mismo motivo el texto completo se muestra en pantalla en lugar
 * de esconderse detrás de un enlace.
 */
export const IdentityCard = ({
  title,
  subtitle,
  consentText,
  policyUrl,
  isSkippable = false,
  isSubmitting = false,
  onSubmit,
  onSkip
}) => {
  const [form, setForm] = useState({ name: "", email: "" });
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState({});

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: undefined }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();

    if (!accepted) {
      setErrors({ consent: "Debes autorizar el tratamiento de tus datos para continuar." });
      return;
    }

    const result = onSubmit?.(form);
    if (result && result.ok === false) {
      setErrors(result.errors || {});
    }
  };

  const fieldStyle = (hasError) => ({
    width: "100%",
    padding: "10px 12px",
    borderRadius: "8px",
    border: `1px solid ${hasError ? "#dc2626" : "#d1d5db"}`,
    fontSize: "14px",
    boxSizing: "border-box",
    backgroundColor: "#ffffff",
    color: "#111827"
  });

  const labelStyle = {
    display: "block",
    fontSize: "12px",
    fontWeight: 600,
    marginBottom: "4px",
    color: "#374151"
  };

  const errorStyle = { color: "#b91c1c", fontSize: "11.5px", marginTop: "3px", display: "block" };

  return (
    <div
      className="form-card animate-fade-in"
      style={{
        background: "var(--card-bg, #ffffff)",
        borderRadius: "16px",
        padding: "20px",
        boxShadow: "0 10px 25px rgba(0,0,0,0.08)",
        border: "1px solid rgba(0,0,0,0.06)",
        maxWidth: "420px",
        margin: "10px 0"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px" }}>
        <div
          style={{
            width: "38px",
            height: "38px",
            borderRadius: "10px",
            background: "linear-gradient(135deg, #059669 0%, #10b981 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            flexShrink: 0
          }}
        >
          <UserRound size={20} />
        </div>
        <div>
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "var(--text-color, #1f2937)" }}>
            {title || "Antes de empezar"}
          </h3>
          <span style={{ fontSize: "12px", color: "#6b7280" }}>
            Alcaldía de Floridablanca (Santander)
          </span>
        </div>
      </div>

      {subtitle && (
        <p style={{ margin: "0 0 14px 0", fontSize: "13px", color: "#4b5563", lineHeight: 1.45 }}>
          {subtitle}
        </p>
      )}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div>
          <label htmlFor="identity-name" style={labelStyle}>
            Nombre completo *
          </label>
          <input
            id="identity-name"
            type="text"
            name="name"
            autoComplete="name"
            value={form.name}
            onChange={handleChange}
            placeholder="Ej. Ana María Gómez"
            disabled={isSubmitting}
            style={fieldStyle(Boolean(errors.name))}
          />
          {errors.name && <span style={errorStyle}>{errors.name}</span>}
        </div>

        <div>
          <label htmlFor="identity-email" style={labelStyle}>
            Correo electrónico *
          </label>
          <input
            id="identity-email"
            type="email"
            name="email"
            autoComplete="email"
            value={form.email}
            onChange={handleChange}
            placeholder="tu@correo.com"
            disabled={isSubmitting}
            style={fieldStyle(Boolean(errors.email))}
          />
          {errors.email && <span style={errorStyle}>{errors.email}</span>}
        </div>

        {/* Autorización expresa: desmarcada por defecto y obligatoria. */}
        <div
          style={{
            background: "#f9fafb",
            border: `1px solid ${errors.consent ? "#fecaca" : "#e5e7eb"}`,
            borderRadius: "8px",
            padding: "10px 12px"
          }}
        >
          <label
            style={{
              display: "flex",
              gap: "8px",
              alignItems: "flex-start",
              fontSize: "11.5px",
              color: "#4b5563",
              lineHeight: 1.5,
              cursor: "pointer"
            }}
          >
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => {
                setAccepted(e.target.checked);
                if (errors.consent) setErrors((prev) => ({ ...prev, consent: undefined }));
              }}
              disabled={isSubmitting}
              style={{
                marginTop: "2px",
                width: "16px",
                height: "16px",
                minWidth: "16px",
                minHeight: "16px",
                flexShrink: 0,
                cursor: "pointer",
                accentColor: "#059669"
              }}
            />
            <span style={{ flex: 1 }}>{consentText}</span>
          </label>

          {policyUrl && (
            <a
              href={policyUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-block",
                marginTop: "6px",
                marginLeft: "22px",
                fontSize: "11.5px",
                color: "#059669",
                fontWeight: 600
              }}
            >
              Ver la Política de Tratamiento de Datos
            </a>
          )}

          {errors.consent && <span style={errorStyle}>{errors.consent}</span>}
        </div>

        <div style={{ display: "flex", gap: "10px", marginTop: "2px" }}>
          {isSkippable && (
            <button
              type="button"
              onClick={onSkip}
              disabled={isSubmitting}
              style={{
                flex: 1,
                padding: "10px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                background: "#ffffff",
                color: "#374151",
                fontWeight: 600,
                fontSize: "13px",
                cursor: "pointer"
              }}
            >
              Continuar sin registrarme
            </button>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              flex: isSkippable ? 1.4 : 1,
              padding: "10px",
              borderRadius: "8px",
              border: "none",
              background: "linear-gradient(135deg, #059669 0%, #10b981 100%)",
              color: "#ffffff",
              fontWeight: 700,
              fontSize: "14px",
              cursor: isSubmitting ? "not-allowed" : "pointer",
              boxShadow: "0 4px 12px rgba(16, 185, 129, 0.3)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "6px"
            }}
          >
            <ShieldCheck size={15} />
            {isSubmitting ? "Guardando..." : "Continuar"}
          </button>
        </div>
      </form>
    </div>
  );
};
