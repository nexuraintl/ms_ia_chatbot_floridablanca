import faqData from "../config/faqConfig.json";

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
  
  const cleanText = userMessage.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  let reply = "";
  
  // Buscar coincidencia en las intenciones del archivo JSON de FAQs
  const matchedFaq = faqData.find(item => 
    item.keywords.some(keyword => cleanText.includes(keyword))
  );

  if (matchedFaq) {
    reply = matchedFaq.response;

    // Caso especial para preguntas de ubicación ("donde estoy")
    if (matchedFaq.keywords.includes("donde estoy") && pageContext) {
      const matchTitle = pageContext.match(/- Título: "([^"]+)"/);
      const title = matchTitle ? matchTitle[1] : null;
      if (title) {
        reply = `Estás en la sección "${title}". Puedo ayudarte a responder dudas sobre la información de esta página.`;
      }
    }
  } else {
    reply = "Entendido. Como tu asistente virtual, ¿te gustaría consultar sobre trámites (Sisbén, Predial), turismo o la historia de Floridablanca?";
  }

  const completionTokens = Math.floor(reply.length / 4);

  return {
    text: reply,
    tokensUsed: 40 + completionTokens,
    savedTokens: 120
  };
};
