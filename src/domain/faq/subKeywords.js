/**
 * Palabras clave que discriminan cuál respuesta concreta de `respuestas_base` aplica
 * dentro de una intención de FAQ ya identificada.
 *
 * Extraído de `services/gemini.js`, donde convivía con el cliente HTTP y el prompt
 * del sistema. Es un dato de configuración, no lógica: aquí queda aislado para poder
 * editarlo sin tocar código de red.
 */
export const SUBKEY_KEYWORDS = Object.freeze({
  // Impuesto Predial
  concepto_obligados: ["obligado", "obligatorios", "que is", "quien", "concepto", "consiste", "definicion", "significa"],
  consulta_pago_linea: ["pago en linea", "pagar en linea", "pagar predial", "pago", "linea", "factura", "pse", "descargar", "pagar", "donde", "recibo", "pdf"],
  codigo_predial: ["codigo predial", "codigo", "identificador", "numero", "catastral", "catastro"],
  fechas_descuentos: ["pronto pago", "fecha", "descuento", "limite", "plazo", "vencimiento", "calendario"],
  actualizacion_propietario: ["cambiar propietario", "propietario", "dueño", "actualizar", "nombre", "cambiar", "escritura", "tradicion", "compre"],
  acuerdos_pago: ["acuerdo de pago", "acuerdos de pago", "acuerdo", "acuerdos", "facilidad", "facilidades", "deuda", "mora", "financiar", "atrasado"],

  // Impuesto ICA
  consulta_estado_cuenta: ["estado de cuenta", "estado", "cuenta", "historico", "declarar", "declaracion", "nit", "rit", "contraseña"],
  clasificacion_contribuyentes: ["regimen simplificado", "regimen comun", "simplificado", "comun", "regimen", "clasificacion", "contribuyente"],
  actividades_gravadas: ["actividad industrial", "actividad comercial", "actividad", "industrial", "comercial", "servicio", "gravada", "industria", "comercio"],

  // Retención ReteICA
  funcionamiento_reteica: ["funcionamiento", "reteica", "que es", "como funciona", "consiste"],
  obligados_retener: ["agente retenedor", "obligados", "retener", "agente", "quien"],
  declaracion_sin_movimiento: ["sin movimiento", "en ceros", "cero", "vacio"],
  portal_virtual: ["portal virtual", "portal", "virtual", "nit", "contraseña", "declarar", "pagar"],

  // Cancelación RIT
  inactivacion_cese: ["cese de actividades", "cancelar", "inactivar", "cerrar", "cese", "negocio", "actividades"],
  requisitos_obligatorios: ["requisitos obligatorios", "requisito", "papel", "documento", "pdf", "formulario", "copia"],
  procedimiento_radicacion: ["como radicar", "procedimiento", "radicacion", "paso", "como", "donde", "tramite", "radicar"],
  politica_deudas: ["deuda", "pendiente", "atrasado", "saldo"],

  // Atención PQRSD
  transito_multas: ["multas de transito", "transito", "multa", "comparendo", "foto", "vehiculo", "transporte", "fotomulta"],
  sisben_tramites: ["tramite sisben", "sisben", "encuesta", "censada", "hogar", "cuidado", "encuestador", "nucleo", "censar"],
  certificado_estrato: ["certificado estrato", "estrato", "estratificacion", "certificado", "socioeconomica", "planeacion"],
  desarrollo_economico: ["desarrollo economico", "empleo", "trabajo", "turismo", "formalizar", "desarrollo", "banco", "bolsa"],

  // FAQ Generales
  planta_docente: ["concurso docente", "planta docente", "docente", "profesor", "planta", "concurso", "merito", "colegio", "escuela"],
  tramites_terceros: ["tramites terceros", "poder notarial", "terceros", "poder", "apoderado", "representante", "notaria", "runt", "autorizar"],
  directorio_turistico: ["directorio turistico", "promocion", "negocio", "directorio", "restaurante", "hotel", "asadero", "turismo"],
  plazos_legales: ["plazos legales", "plazo", "tiempo", "habil", "respuesta", "peticion", "derecho", "legal"]
});
