// Base de datos simulada de ciudadanos y sus trámites
const predialDB = {
  "12345678": {
    propietario: "Juan Fernando Gómez",
    cedulaCatastral: "01-02-0054-0012-000",
    direccion: "Carrera 21 # 18-42, Floridablanca",
    valor: 450000,
    estado: "Pendiente",
    periodo: "Vigencia 2026",
    productoImagen: "https://images.unsplash.com/photo-1564013799919-ab600027ffc6?auto=format&fit=crop&w=400&q=80", // Imagen de una hermosa casa en el campo
    facturaUrl: "#descargar-factura-predial-1234"
  },
  "87654321": {
    propietario: "María Camila Restrepo",
    cedulaCatastral: "01-04-0120-0089-000",
    direccion: "Vereda El Carmen, Lote 4",
    valor: 820000,
    estado: "Pagado",
    periodo: "Vigencia 2026",
    productoImagen: "https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=400&q=80",
    facturaUrl: "#descargar-recibo-predial-8765"
  }
};

const sisbenDB = {
  "12345678": {
    nombre: "Juan Fernando Gómez",
    grupo: "A3",
    clasificacion: "Pobreza extrema",
    ultimaActualizacion: "14-01-2025",
    imagenGrupo: "https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?auto=format&fit=crop&w=400&q=80", // Imagen de certificado/datos
    certificadoUrl: "#descargar-certificado-sisben-1234"
  },
  "87654321": {
    nombre: "María Camila Restrepo",
    grupo: "B7",
    clasificacion: "Pobreza moderada",
    ultimaActualizacion: "08-11-2024",
    imagenGrupo: "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?auto=format&fit=crop&w=400&q=80",
    certificadoUrl: "#descargar-certificado-sisben-8765"
  }
};

// Simulador de API Predial
export const getPredialInfo = async (documento) => {
  await new Promise((resolve) => setTimeout(resolve, 800)); // Latencia

  const info = predialDB[documento];
  if (!info) {
    throw new Error("No se encontró ningún predio registrado para este número de identificación.");
  }
  return info;
};

// Simulador de API Sisbén
export const getSisbenInfo = async (documento) => {
  await new Promise((resolve) => setTimeout(resolve, 800)); // Latencia

  const info = sisbenDB[documento];
  if (!info) {
    throw new Error("Ciudadano no registrado en la base de datos del Sisbén del municipio.");
  }
  return info;
};

// Simulador de Ejecución RPA
export const runRpaProcess = async (params, onStep) => {
  const steps = [
    { message: "🤖 [RPA] Iniciando robot de extracción...", delay: 800 },
    { message: "🔍 [RPA] Validando credenciales y conectando al servidor municipal...", delay: 1000 },
    { message: "📊 [RPA] Extrayendo base de datos para el período " + params.periodo + "...", delay: 1200 },
    { message: "📂 [RPA] Generando PDF consolidado y aplicando firma digital...", delay: 1000 },
    { message: "📧 [RPA] Enviando reporte por correo electrónico a " + params.email + "...", delay: 800 }
  ];

  for (const step of steps) {
    await new Promise((resolve) => setTimeout(resolve, step.delay));
    onStep(step.message);
  }

  // Resultado del proceso RPA
  return {
    success: true,
    message: `Reporte de ventas de ${params.periodo} generado exitosamente y enviado a ${params.email}.`,
    fileUrl: "#descargar-reporte-rpa-generado",
    fileName: `reporte_${params.periodo.replace(" ", "_")}.pdf`
  };
};
