// Configuración de la API de Gemini y System Prompt optimizado
const SYSTEM_PROMPT = `
Eres el asistente virtual de la Alcaldía de Floridablanca, Santander. Tu labor es responder a los ciudadanos.
REGLAS CRÍTICAS DE TOKENIZACIÓN Y AHORRO:
1. Responde de forma extremadamente corta y concisa.
2. Limita tus respuestas a un máximo absoluto de 1 o 2 líneas (máximo 15-20 palabras).
3. Responde siempre en español de Colombia, con tono institucional pero cercano.
4. Si la pregunta es sobre trámites como el Predial, Sisbén, Turismo o Historia, sugiérelo brevemente para que el sistema realice la redirección.
`;

export const queryGemini = async (messageHistory, apiKey, pageContext = "") => {
  if (!apiKey || apiKey.trim() === "") {
    return queryMockGemini(messageHistory[messageHistory.length - 1].text, pageContext);
  }

  try {
    // Formatear el historial de mensajes para Gemini
    // Gemini espera roles: 'user' o 'model'
    const contents = messageHistory.map((msg) => ({
      role: msg.sender === "user" ? "user" : "model",
      parts: [{ text: msg.text }]
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: contents,
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT + (pageContext ? `\n\nContexto de la página actual donde estoy embebido:\n${pageContext}` : "") }]
          },
          generationConfig: {
            maxOutputTokens: 60,
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
    
    const promptTokens = Math.floor(messageHistory.reduce((acc, m) => acc + m.text.length, 0) / 4) + 120;
    const completionTokens = Math.floor(replyText.length / 4);
    
    return {
      text: replyText.trim(),
      tokensUsed: promptTokens + completionTokens,
      savedTokens: 150 - completionTokens
    };
  } catch (error) {
    console.error("Error al conectar con Gemini:", error);
    return {
      text: "⚠️ En este momento presento congestión para responder tu consulta libre. Por favor, intenta de nuevo en unos instantes o selecciona una opción de la lista.",
      tokensUsed: 0,
      savedTokens: 0,
      isError: true
    };
  }
};

const queryMockGemini = async (userMessage, pageContext = "") => {
  await new Promise((resolve) => setTimeout(resolve, 800));
  
  const text = userMessage.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  let reply = "";
  
  if (text.includes("donde estoy") || text.includes("que pagina") || text.includes("sobre esta pagina") || text.includes("que seccion")) {
    if (pageContext) {
      // Intentar extraer el título de la página del string de contexto
      const matchTitle = pageContext.match(/- Título: "([^"]+)"/);
      const title = matchTitle ? matchTitle[1] : "Página Desconocida";
      reply = `Estás en la página "${title}". Puedo ayudarte a responder dudas sobre el contenido de esta sección.`;
    } else {
      reply = "Estás en el portal del Asistente Virtual Inteligente de la Alcaldía de Floridablanca.";
    }
  } else if (text.includes("hola") || text.includes("buenos dias") || text.includes("buenas tardes")) {
    reply = "¡Hola! Bienvenido. ¿En qué trámite o consulta te puedo asistir hoy?";
  } else if (text.includes("predial") || text.includes("impuesto") || text.includes("pagar")) {
    reply = "Puedes liquidar y pagar tu Impuesto Predial aquí mismo. ¿Deseas que te redirija al formulario?";
  } else if (text.includes("sisben") || text.includes("puntaje") || text.includes("grupo")) {
    reply = "Consulta tu grupo del Sisbén IV ingresando tu documento. ¿Te llevo a la sección del Sisbén?";
  } else if (text.includes("historia") || text.includes("fundacion") || text.includes("fundó")) {
    reply = "Floridablanca es la Capital Dulce de Colombia, fundada en 1817. Es famosa por el Cerro del Santísimo. ¿Deseas saber más de historia?";
  } else if (text.includes("turismo") || text.includes("santisimo") || text.includes("obleas") || text.includes("que hacer")) {
    reply = "Descubre el Cerro del Santísimo y prueba nuestras famosas obleas tradicionales en el centro.";
  } else if (text.includes("cultura") || text.includes("noticias") || text.includes("evento")) {
    reply = "Floridablanca cuenta con una agenda cultural muy activa, talleres artísticos y festivales de la oblea y el dulce.";
  } else if (text.includes("contacto") || text.includes("telefono") || text.includes("horario") || text.includes("alcaldia")) {
    reply = "Atendemos en la Calle 20 # 20-20. Teléfono: (604) 562-5656. ¿Cargamos el directorio?";
  } else {
    reply = "Entendido. Como asistente de Floridablanca, ¿te gustaría consultar sobre trámites, turismo o historia del municipio?";
  }

  const completionTokens = Math.floor(reply.length / 4);

  return {
    text: reply,
    tokensUsed: 40 + completionTokens,
    savedTokens: 120 // Simulación de tokens ahorrados por el prompt corto
  };
};
