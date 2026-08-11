import { useState, useEffect } from "react";
import { getCatalogos, crearPqrsd, validateAttachments, FILE_CONSTRAINTS } from "../../services/pqrsdService";
import { useChat } from "../../context/ChatContext";

export const PqrsdCreateCard = ({ onSubmitSuccess, onCancel }) => {
  const { scheduleFollowUp } = useChat();
  const [loadingCatalogos, setLoadingCatalogos] = useState(true);
  const [catalogos, setCatalogos] = useState({
    tipos: [],
    dependencias: []
  });

  const [formData, setFormData] = useState({
    asunto: "",
    email: "",
    telefonoCelular: "",
    esAnonimo: true,
    numeroIdentificacion: "",
    tipoId: "",
    dependenciaId: ""
  });

  const [files, setFiles] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let isMounted = true;
    const fetchCatalogosData = async () => {
      setLoadingCatalogos(true);
      try {
        const data = await getCatalogos();
        if (isMounted) {
          const tipos = data.tipos_correspondencia || [];
          const dependencias = data.dependencias_areas || [];
          setCatalogos({ tipos, dependencias });
          
          setFormData(prev => ({
            ...prev,
            tipoId: tipos.length > 0 ? tipos[0].Id : 6,
            dependenciaId: dependencias.length > 0 ? dependencias[0].Id : 8
          }));
        }
      } catch (err) {
        console.error("Error fetching catalogos:", err);
      } finally {
        if (isMounted) setLoadingCatalogos(false);
      }
    };

    fetchCatalogosData();
    return () => { isMounted = false; };
  }, []);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value
    }));
  };

  const handleFileChange = (e) => {
    if (!e.target.files) return;

    const selected = Array.from(e.target.files);

    // Validar antes de aceptar: la versión anterior admitía cualquier tipo, tamaño y
    // cantidad, y el ciudadano solo descubría el rechazo tras esperar la subida.
    const { valid, error } = validateAttachments(selected);
    if (!valid) {
      setErrorMsg(error);
      setFiles([]);
      e.target.value = "";
      return;
    }

    setErrorMsg(null);
    setFiles(selected);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!formData.asunto.trim()) {
      setErrorMsg("El asunto es obligatorio.");
      return;
    }
    if (!formData.email.trim()) {
      setErrorMsg("El correo electrónico es obligatorio.");
      return;
    }
    if (!formData.telefonoCelular.trim()) {
      setErrorMsg("El número de teléfono es obligatorio.");
      return;
    }

    const selectedTipoObj = catalogos.tipos.find(t => String(t.Id) === String(formData.tipoId)) || { Id: Number(formData.tipoId) || 6, Nombre: "Petición" };
    const selectedDepObj = catalogos.dependencias.find(d => String(d.Id) === String(formData.dependenciaId)) || { Id: Number(formData.dependenciaId) || 8, Nombre: "Secretaría General" };

    setIsSubmitting(true);
    try {
      const res = await crearPqrsd({
        asunto: formData.asunto,
        email: formData.email,
        telefonoCelular: formData.telefonoCelular,
        esAnonimo: formData.esAnonimo,
        numeroIdentificacion: formData.numeroIdentificacion,
        tipoCorrespondenciaObj: selectedTipoObj,
        dependenciaObj: selectedDepObj,
        archivos: files
      });

      if (res.success) {
        setResult(res);
        if (onSubmitSuccess) {
          onSubmitSuccess(res);
        }
      } else {
        setErrorMsg(res.message || "No se pudo radicar la PQRSD. Intenta nuevamente.");
      }
    } catch (err) {
      setErrorMsg(err.message || "Ocurrió un error inesperado al conectar con el RPA.");
    } finally {
      setIsSubmitting(false);
      if (scheduleFollowUp) scheduleFollowUp(20000);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    alert("¡Copiado al portapapeles!");
  };

  if (result) {
    return (
      <div className="pqrsd-card result-card">
        <div className="pqrsd-card-header success">
          <span className="icon">✅</span>
          <h4>¡PQRSD Radicada Con Éxito!</h4>
        </div>
        <div className="pqrsd-card-body">
          <p className="success-msg">{result.message}</p>
          <div className="result-details">
            <div className="detail-item">
              <span className="label">Número de Radicado:</span>
              <div className="value-box">
                <strong>{result.radicado}</strong>
                <button 
                  type="button" 
                  className="copy-btn"
                  onClick={() => copyToClipboard(result.radicado)}
                  title="Copiar Radicado"
                >
                  📋
                </button>
              </div>
            </div>
            <div className="detail-item">
              <span className="label">Código de Autenticación:</span>
              <div className="value-box">
                <strong className="code-text">{result.codigo_autenticacion}</strong>
                <button 
                  type="button" 
                  className="copy-btn"
                  onClick={() => copyToClipboard(result.codigo_autenticacion)}
                  title="Copiar Código"
                >
                  📋
                </button>
              </div>
            </div>
            {result.fecha_radicacion && (
              <div className="detail-item">
                <span className="label">Fecha de Radicación:</span>
                <span>{new Date(result.fecha_radicacion).toLocaleString()}</span>
              </div>
            )}
          </div>
          <p className="info-note">
            💡 Guarda muy bien tu <strong>Radicado</strong> y tu <strong>Código de Autenticación</strong> para consultar el avance de tu trámite en cualquier momento.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pqrsd-card">
      <div className="pqrsd-card-header">
        <span className="icon">📑</span>
        <h4>Radicar PQRSD (Alcaldía Floridablanca)</h4>
      </div>

      <form onSubmit={handleSubmit} className="pqrsd-form">
        {errorMsg && <div className="pqrsd-error">{errorMsg}</div>}

        {loadingCatalogos ? (
          <div className="loading-spinner-box">
            <span className="spinner">⏳</span> Cargando catálogos de la Alcaldía...
          </div>
        ) : (
          <>
            <div className="form-row">
              <div className="form-group half">
                <label>Tipo de Trámite:</label>
                <select 
                  name="tipoId" 
                  value={formData.tipoId} 
                  onChange={handleChange}
                  disabled={isSubmitting}
                >
                  {catalogos.tipos.map(t => (
                    <option key={t.Id} value={t.Id}>{t.Nombre}</option>
                  ))}
                </select>
              </div>

              <div className="form-group half">
                <label>Dependencia / Área:</label>
                <select 
                  name="dependenciaId" 
                  value={formData.dependenciaId} 
                  onChange={handleChange}
                  disabled={isSubmitting}
                >
                  {catalogos.dependencias.map(d => (
                    <option key={d.Id} value={d.Id}>{d.Nombre}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>Asunto / Descripción de la Solicitud *</label>
              <textarea 
                name="asunto"
                rows="3"
                placeholder="Describe claramente tu petición, queja o reclamo..."
                value={formData.asunto}
                onChange={handleChange}
                disabled={isSubmitting}
                required
              />
            </div>

            <div className="form-row">
              <div className="form-group half">
                <label>Correo Electrónico *</label>
                <input 
                  type="email"
                  name="email"
                  placeholder="ejemplo@correo.com"
                  value={formData.email}
                  onChange={handleChange}
                  disabled={isSubmitting}
                  required
                />
              </div>

              <div className="form-group half">
                <label>Teléfono Celular *</label>
                <input 
                  type="tel"
                  name="telefonoCelular"
                  placeholder="3001234567"
                  value={formData.telefonoCelular}
                  onChange={handleChange}
                  disabled={isSubmitting}
                  required
                />
              </div>
            </div>

            <div className="form-group checkbox-group">
              <label className="checkbox-label">
                <input 
                  type="checkbox"
                  name="esAnonimo"
                  checked={formData.esAnonimo}
                  onChange={handleChange}
                  disabled={isSubmitting}
                />
                Radicar como Anónimo
              </label>
            </div>

            {!formData.esAnonimo && (
              <div className="form-group">
                <label>Número de Identificación (Cédula/NIT):</label>
                <input 
                  type="text"
                  name="numeroIdentificacion"
                  placeholder="Ej: 1098765432"
                  value={formData.numeroIdentificacion}
                  onChange={handleChange}
                  disabled={isSubmitting}
                />
              </div>
            )}

            <div className="form-group">
              <label>Adjuntar Documentos / Fotos (Opcional):</label>
              <input
                type="file"
                multiple
                accept={FILE_CONSTRAINTS.allowedExtensions.map((e) => `.${e}`).join(",")}
                onChange={handleFileChange}
                disabled={isSubmitting}
                className="file-input"
              />
              <span className="file-hint" style={{ fontSize: "0.72rem", opacity: 0.75 }}>
                Máximo {FILE_CONSTRAINTS.maxFiles} archivos de{" "}
                {(FILE_CONSTRAINTS.maxBytesPerFile / 1024 / 1024).toFixed(0)} MB cada uno.
              </span>
              {files.length > 0 && (
                <span className="file-count">📎 {files.length} archivo(s) seleccionado(s)</span>
              )}
            </div>

            <div className="pqrsd-actions">
              <button 
                type="submit" 
                className="btn-submit"
                disabled={isSubmitting}
              >
                {isSubmitting ? "⏳ Radicando..." : "🚀 Radicar"}
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
          </>
        )}
      </form>
    </div>
  );
};
