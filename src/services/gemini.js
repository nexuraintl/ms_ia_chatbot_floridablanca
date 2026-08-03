import faqData from "../config/NewFaqConfig.json" with { type: "json" };
import { sanitizeText } from "../utils/securityUtils.js";

// Configuración de la API de Gemini y System Prompt optimizado
const SYSTEM_PROMPT = `
Eres el asistente virtual oficial de atención ciudadana municipal. Tu labor es responder y guiar a los ciudadanos.
REGLAS CRÍTICAS DE RESPUESTA:
1. Responde siempre de forma clara, directa y amable en español de Colombia (máximo 2 a 3 líneas).
2. SÍ ESTÁS COMPLETAMENTE AUTORIZADO A COMPARTIR ENLACES Y URLS. Cuando el usuario pida un link, página, trámite o sección, proporciónale la URL en formato Markdown: [Nombre del Enlace](https://url-del-sitio).
3. Utiliza la lista de [SECCIONES Y ENLACES EXTRAÍDOS DEL MAPA DEL SITIO] enviados en el contexto para seleccionar y entregar la URL EXACTA del trámite o tema por el que pregunta el usuario.
4. REGLA DE BÚSQUEDA Y FALLBACK (/buscar/?q=): Si el usuario pregunta por un trámite, sección o tema específico que NO se encuentra listado en el Mapa del Sitio, genera el enlace hacia el buscador oficial del portal usando la plantilla enviada en el contexto: [Buscar "tema" en el portal]({DOMINIO}/buscar/?q={TERMINO_ENCODEADO}).
5. NUNCA digas "No puedo compartir enlaces directos". Entrega siempre el enlace directo del mapa del sitio o el enlace generado del buscador oficial del portal.
`;

const getFaqContext = (userMessage) => {
  const safeUserMsg = sanitizeText(userMessage).substring(0, 1000);
  const cleanText = safeUserMsg
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?¿¡]/g, "");

  let bestMatchedFaq = null;
  let maxIntentScore = 0;

  for (const item of faqData) {
    let intentScore = 0;
    
    for (const keyword of item.palabras_clave) {
      const cleanKeyword = keyword.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      
      if (cleanText.includes(cleanKeyword)) {
        intentScore += cleanKeyword.split(/\s+/).length * 2;
      } else {
        const kwWords = cleanKeyword.split(/\s+/).filter(w => w.length > 2);
        if (kwWords.length > 0) {
          const matchedWordsCount = kwWords.filter(kwWord => {
            if (kwWord.length <= 4) {
              return cleanText.includes(kwWord);
            }
            return cleanText.includes(kwWord.substring(0, 4));
          }).length;
          
          if (matchedWordsCount === kwWords.length) {
            intentScore += matchedWordsCount;
          }
        }
      }
    }

    if (intentScore > maxIntentScore) {
      maxIntentScore = intentScore;
      bestMatchedFaq = item;
    }
  }

  if (bestMatchedFaq && maxIntentScore > 0) {
    let contextStr = `Categoría: ${bestMatchedFaq.categoria}\nTema: ${bestMatchedFaq.intencion}\nInformación Oficial de la Alcaldía:\n`;
    for (const [key, val] of Object.entries(bestMatchedFaq.respuestas_base)) {
      contextStr += `- [${key}]: ${val}\n`;
    }
    return contextStr;
  }

  return null;
};

export const queryGemini = async (messageHistory, apiKey, pageContext = "", activeContext = null) => {
  const userMessage = messageHistory[messageHistory.length - 1]?.text || "";

  if (!apiKey || apiKey.trim() === "") {
    console.log("ℹ️ [Chatbot] No se detectó API Key -> Usando respuestas MOCK locales");
    return queryMockGemini(userMessage, pageContext, activeContext);
  }

  console.log("✨ [Gemini API] Enviando petición a la API de Gemini con el mensaje:", userMessage);

  try {
    // Formatear el historial de mensajes para Gemini
    // Gemini espera roles: 'user' o 'model'
    const contents = messageHistory.map((msg) => ({
      role: msg.sender === "user" ? "user" : "model",
      parts: [{ text: msg.text }]
    }));

    // Obtener contexto de FAQ de Floridablanca si hay alguna coincidencia
    const faqContext = getFaqContext(userMessage);

    let systemPromptWithContext = SYSTEM_PROMPT;
    if (faqContext) {
      systemPromptWithContext += `\n\n[INFORMACIÓN MUNICIPAL OFICIAL PARA RESPONDER CON PRECISIÓN]:\n${faqContext}`;
    }
    if (pageContext) {
      systemPromptWithContext += `\n\nContexto de la página actual donde estoy embebido:\n${pageContext}`;
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: contents,
          systemInstruction: {
            parts: [{ text: systemPromptWithContext }]
          },
          generationConfig: {
            maxOutputTokens: 150,
            temperature: 0.2
          }
        })
      }
    );

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error?.message || "Error en la API de Gemini.");
    }

    const data = await response.json();
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    
    console.log("🚀 [Gemini API] Respuesta recibida de Gemini:", replyText.trim());

    const promptTokens = Math.floor(messageHistory.reduce((acc, m) => acc + m.text.length, 0) / 4) + 120;
    const completionTokens = Math.floor(replyText.length / 4);
    
    return {
      text: replyText.trim(),
      tokensUsed: promptTokens + completionTokens,
      savedTokens: 150 - completionTokens
    };
  } catch (error) {
    console.error("❌ [Gemini API] Error al conectar con Gemini:", error);
    return {
      text: "⚠️ En este momento presento congestión para responder tu consulta libre. Por favor, intenta de nuevo en unos instantes o selecciona una opción de la lista.",
      tokensUsed: 0,
      savedTokens: 0,
      isError: true
    };
  }
};

const SUBKEY_KEYWORDS = {
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
};

const queryMockGemini = async (userMessage, pageContext = "", activeContext = null) => {
  await new Promise((resolve) => setTimeout(resolve, 800));
  console.log("📦 [Mock Service] Generando respuesta local mock para el mensaje:", userMessage);
  
  // Expansión Contextual de Consultas: Añadimos el contexto activo si existe
  const contextString = activeContext ? ` ${activeContext.replace(/_/g, " ")}` : "";
  
  // Limpiar puntuación para facilitar la coincidencia de palabras individuales
  const cleanText = (userMessage + contextString)
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?¿¡]/g, "");
  
  let reply;
  let bestMatchedFaq = null;

  // 1. Manejo de saludos generales
  const greetings = ["hola", "buenos dias", "buenas tardes", "buenas noches", "buen dia", "saludos"];
  const isGreeting = greetings.some(g => cleanText.includes(g));
  
  if (isGreeting) {
    reply = "¡Hola! Bienvenido al portal del Asistente Virtual Inteligente. ¿En qué trámite o consulta municipal te puedo colaborar hoy?";
  } 
  // 2. Peticiones explícitas de links / enlaces / trámites / buscador
  else if ((cleanText.includes("link") || cleanText.includes("enlace") || cleanText.includes("url") || cleanText.includes("pasame") || cleanText.includes("dame") || cleanText.includes("donde") || cleanText.includes("redireccion") || cleanText.includes("buscar")) && pageContext) {
    const matchOrigin = pageContext.match(/- Dominio Origen: ([^\s\n]+)/);
    const origin = matchOrigin ? matchOrigin[1] : "";
    
    // Intentar buscar en las secciones extraídas del mapa del sitio
    const sitemapSectionMatch = pageContext.match(/\[SECCIONES Y ENLACES EXTRAÍDOS DEL MAPA DEL SITIO\]:\n([\s\S]*?)\n\n-/);
    const sitemapText = sitemapSectionMatch ? sitemapSectionMatch[1] : "";
    
    let matchedLink = null;
    let matchedTitle = "";

    if (sitemapText) {
      const lines = sitemapText.split("\n");
      const cleanUserMsg = userMessage.toLowerCase();
      
      for (const line of lines) {
        const match = line.match(/- "([^"]+)": ([^\s\n]+)/);
        if (match) {
          const title = match[1];
          const url = match[2];
          const words = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          if (words.some(w => cleanUserMsg.includes(w))) {
            matchedLink = url;
            matchedTitle = title;
            break;
          }
        }
      }
    }

    if (matchedLink) {
      reply = `Aquí tienes el enlace directo para realizar tu consulta: [${matchedTitle}](${matchedLink}).`;
    } else if (origin) {
      const searchQuery = encodeURIComponent(userMessage.replace(/(pasame|dame|el|link|enlace|de|por|favor|dónde|donde|está|busco)/gi, "").trim() || "tramites");
      const searchUrl = `${origin}/buscar/?q=${searchQuery}`;
      reply = `Puedes consultar los resultados oficiales para tu trámite en el buscador del portal: [Buscar "${userMessage}" en el Portal](${searchUrl}).`;
    } else {
      reply = "Puedes consultar todos los enlaces e información en la sección oficial de Trámites de la página principal.";
    }
  }
  // 3. Caso especial para preguntas de ubicación / contexto de página
  else if ((cleanText.includes("donde estoy") || cleanText.includes("que pagina") || cleanText.includes("que seccion") || cleanText.includes("donde me encuentro") || cleanText.includes("que es esta pagina")) && pageContext) {
    const matchTitle = pageContext.match(/- Título: "([^"]+)"/);
    const matchSitemap = pageContext.match(/- Enlace Mapa del Sitio: ([^\s\n]+)/);
    const title = matchTitle ? matchTitle[1] : null;
    const sitemapUrl = matchSitemap ? matchSitemap[1] : null;

    if (title && sitemapUrl) {
      reply = `Te encuentras en la sección "${title}". Puedes explorar todos los trámites en [Mapa del Sitio](${sitemapUrl}).`;
    } else if (title) {
      reply = `Te encuentras en la sección "${title}". Puedo ayudarte a responder inquietudes sobre la información contenida en esta página.`;
    } else {
      reply = "Estás en el portal del Asistente Virtual Inteligente. Puedo ayudarte a responder dudas sobre esta sección.";
    }
  } 
  // 4. Buscar coincidencia en las intenciones del nuevo archivo JSON de FAQs
  else {
    let maxIntentScore = 0;

    for (const item of faqData) {
      let intentScore = 0;
      
      for (const keyword of item.palabras_clave) {
        const cleanKeyword = keyword.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        
        if (cleanText.includes(cleanKeyword)) {
          // Coincidencia de frase exacta tiene prioridad
          intentScore += cleanKeyword.split(/\s+/).length * 2;
        } else {
          // Coincidencia por palabras individuales evaluando inicios de palabra (evita falsos positivos como 'ica' en 'inicar')
          const kwWords = cleanKeyword.split(/\s+/).filter(w => w.length > 2 || w === "ica" || w === "rit");
          const userWords = cleanText.split(/\s+/);
          
          if (kwWords.length > 0) {
            const matchedWordsCount = kwWords.filter(kwWord => {
              const root = kwWord.length <= 4 ? kwWord : kwWord.substring(0, 4);
              return userWords.some(uw => uw === root || uw.startsWith(root));
            }).length;
            
            if (matchedWordsCount === kwWords.length) {
              intentScore += matchedWordsCount;
            }
          }
        }
      }

      if (intentScore > maxIntentScore) {
        maxIntentScore = intentScore;
        bestMatchedFaq = item;
      }
    }

    if (bestMatchedFaq && maxIntentScore > 0) {
      // Intentar buscar la respuesta más específica dentro de respuestas_base
      const respuestasBase = bestMatchedFaq.respuestas_base;
      const subKeys = Object.keys(respuestasBase);
      
      let bestSubKey = subKeys[0]; // Por defecto, la primera respuesta (concepto general)
      let maxSubMatches = 0;

      const textWords = cleanText.split(/\s+/);

      for (const subKey of subKeys) {
        const keywords = SUBKEY_KEYWORDS[subKey] || [];
        let subScore = 0;
        
        for (const kw of keywords) {
          const cleanKw = kw.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          const kwWordsCount = cleanKw.split(/\s+/).length;
          
          if (cleanKw.includes(" ")) {
            // Phrase match
            if (cleanText.includes(cleanKw)) {
              subScore += kwWordsCount * 3; // Las frases exactas otorgan puntaje muy alto
            }
          } else {
            // Exact word match o con plurales simples ('s', 'es')
            const isMatch = textWords.some(w => 
              w === cleanKw || 
              w === cleanKw + "s" || 
              w === cleanKw + "es" || 
              cleanKw === w + "s" || 
              cleanKw === w + "es"
            );
            if (isMatch) subScore += 1;
          }
        }
        
        if (subScore > maxSubMatches) {
          maxSubMatches = subScore;
          bestSubKey = subKey;
        }
      }

      reply = respuestasBase[bestSubKey];
    } else {
      reply = "Entendido. Como tu asistente virtual de Floridablanca, ¿te gustaría consultar sobre trámites (Sisbén, Impuesto Predial, Impuesto ICA, Cancelación RIT), reportes RPA, turismo o nuestra historia municipal?";
    }
  }

  const completionTokens = Math.floor(reply.length / 4);

  return {
    text: reply,
    contextIntent: bestMatchedFaq ? bestMatchedFaq.intencion : null,
    tokensUsed: 40 + completionTokens,
    savedTokens: 120
  };
};
