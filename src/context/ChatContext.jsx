import React, { createContext, useContext, useState, useEffect } from "react";
import { queryGemini } from "../services/gemini";
import { getPredialInfo, getSisbenInfo, runRpaProcess } from "../services/apiMock";
import { getSemanticRoute } from "../services/intentRouter";
import config from "../config/chatbotConfig.json";

const ChatContext = createContext();

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChat debe usarse dentro de un ChatProvider");
  }
  return context;
};

export const ChatProvider = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [isTextInputEnabled, setIsTextInputEnabled] = useState(true); // Teclado siempre habilitado por defecto
  const [apiKey, setApiKeyState] = useState(localStorage.getItem("gemini_api_key") || "");
  const [tokensSavedTotal, setTokensSavedTotal] = useState(0);
  const [tokensUsedTotal, setTokensUsedTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [lastSuggestedAction, setLastSuggestedAction] = useState(null);

  // Toggles de Módulos (Habilitar/Deshabilitar en caliente desde la consola)
  const [isGeminiEnabled, setIsGeminiEnabled] = useState(true);
  const [isServicesEnabled, setIsServicesEnabled] = useState(true);

  // Inicializar chat con mensajes de bienvenida adaptados desde JSON
  const initChat = () => {
    setIsTextInputEnabled(true);
    
    const replies = [];
    if (isServicesEnabled) {
      config.quickReplies.forEach(reply => {
        replies.push(reply.label);
      });
    }

    setMessages([
      {
        id: "welcome-1",
        sender: "bot",
        text: config.welcome.message1,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      },
      {
        id: "welcome-2",
        sender: "bot",
        text: isServicesEnabled 
          ? config.welcome.message2_services
          : config.welcome.message2_no_services,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        quickReplies: replies.length > 0 ? replies : null
      }
    ]);
  };

  // Reiniciar el chat si cambia el estado de algún módulo para refrescar las sugerencias
  useEffect(() => {
    initChat();
  }, [isServicesEnabled, isGeminiEnabled]);

  // Actualizar API Key
  const updateApiKey = (key) => {
    setApiKeyState(key);
    localStorage.setItem("gemini_api_key", key);
  };

  // Función para registrar el uso de tokens en un archivo log del servidor (Req 3)
  const logTokenUsage = async (prompt, used, saved) => {
    try {
      await fetch("/api/log-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, used, saved })
      });
    } catch (e) {
      console.warn("No se pudo registrar el token en el servidor local:", e.message);
    }
  };

  // Helper para añadir mensaje
  const addMessage = (msg) => {
    setMessages((prev) => [
      ...prev.map(m => ({ ...m, quickReplies: null })), // Quitar botones de mensajes antiguos
      {
        id: Math.random().toString(36).substr(2, 9),
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        ...msg
      }
    ]);
  };

  // Obtener contexto de la página principal donde está embebido el chatbot
  const getPageContext = () => {
    try {
      const title = document.title || "Portal de Atención Digital";
      const url = window.location.href;
      
      // Intentar obtener descripción de meta tags
      const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || "";
      
      // Obtener textos de encabezados principales para dar contexto de secciones
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map(h => h.innerText.trim())
        .filter(Boolean)
        .slice(0, 10)
        .join(', ');

      // Intentar leer el contenido de la consola o la página en texto (evitando el widget del chat en sí)
      const pageText = document.getElementById("root")?.innerText ? document.getElementById("root").innerText.substring(0, 1000) : "";

      return `[METADATOS DE LA PÁGINA]:
- Título: "${title}"
- URL: ${url}
- Descripción: "${metaDescription}"
- Encabezados detectados: [${headings}]
- Extracto de contenido de la página: "${pageText.replace(/\s+/g, ' ').substring(0, 500)}..."`;
    } catch (e) {
      console.warn("No se pudo obtener el contexto de la página principal:", e);
      return "Contexto de página no disponible.";
    }
  };

  // Funciones de flujo parametrizadas
  const startSisbenFlow = () => {
    addMessage({
      sender: "bot",
      text: "Para consultar tu Sisbén en Floridablanca, ingresa tu número de documento de identidad:",
      form: {
        type: "sisben",
        fields: [{ name: "documento", placeholder: "Número de cédula o tarjeta", type: "text", required: true }]
      }
    });
  };

  const startPredialFlow = () => {
    addMessage({
      sender: "bot",
      text: "Para liquidar tu Impuesto Predial de Floridablanca, digita la cédula del propietario:",
      form: {
        type: "predial",
        fields: [{ name: "documento", placeholder: "Cédula del propietario (ej. 12345678)", type: "text", required: true }]
      }
    });
  };

  const startRpaFlow = () => {
    addMessage({
      sender: "bot",
      text: "Configura el reporte municipal que el robot RPA de Floridablanca procesará:",
      form: {
        type: "rpa",
        fields: [
          { name: "periodo", placeholder: "Año/Mes (ej: Vigencia 2025)", type: "text", required: true },
          { name: "email", placeholder: "Correo receptor del reporte", type: "email", required: true }
        ]
      }
    });
  };

  // Enrutador semántico de intenciones
  const handleSemanticRouting = async (text) => {
    const route = getSemanticRoute(text);
    
    if (route === "sisben") {
      startSisbenFlow();
      setIsLoading(false);
      return true;
    }
    
    if (route === "predial") {
      startPredialFlow();
      setIsLoading(false);
      return true;
    }
    
    if (route === "rpa") {
      startRpaFlow();
      setIsLoading(false);
      return true;
    }
    
    return false;
  };

  // Enviar mensaje de texto libre
  const sendMessage = async (text) => {
    if (!text || text.trim() === "") return;

    // Añadir mensaje del usuario
    addMessage({ sender: "user", text });
    setIsLoading(true);

    try {
      // 1. Intentar enrutamiento semántico local (solo si servicios están habilitados)
      if (isServicesEnabled) {
        const wasRouted = await handleSemanticRouting(text);
        if (wasRouted) return;
      } else {
        // Si servicios están deshabilitados pero el usuario pregunta por un trámite
        const cleanText = text.toLowerCase().trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        const isServiceKeyword = ["sisben", "predial", "rpa", "impuesto", "pagar", "reporte", "robot"].some(k => cleanText.includes(k));
        if (isServiceKeyword) {
          addMessage({
            sender: "bot",
            text: "⚠️ Los servicios y trámites interactivos están inhabilitados temporalmente por el administrador."
          });
          setIsLoading(false);
          return;
        }
      }

      // 2. Si no es un trámite, verificar si la IA de Gemini está habilitada
      if (isGeminiEnabled) {
        const pageContext = getPageContext();

        const conversationHistory = messages
          .filter(m => m.sender === "user" || m.sender === "bot")
          .map(m => ({ sender: m.sender, text: m.text }));
        
        conversationHistory.push({ sender: "user", text });

        const geminiResponse = await queryGemini(conversationHistory, apiKey, pageContext);
        
        addMessage({
          sender: "bot",
          text: geminiResponse.text
        });

        // Registrar en el archivo log y actualizar contadores de tokens (Req 3)
        if (geminiResponse.tokensUsed) {
          logTokenUsage(text, geminiResponse.tokensUsed, geminiResponse.savedTokens);
          setTokensUsedTotal((prev) => prev + geminiResponse.tokensUsed);
          setTokensSavedTotal((prev) => prev + geminiResponse.savedTokens);
        }
      } else {
        addMessage({
          sender: "bot",
          text: "⚠️ La sección de preguntas frecuentes y respuesta libre con IA está inhabilitada en este momento. Por favor utiliza los trámites habilitados."
        });
      }

    } catch (error) {
      addMessage({
        sender: "bot",
        text: "⚠️ Hubo un inconveniente al procesar tu solicitud. Por favor intenta de nuevo."
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Manejar click en Quick Reply
  const selectQuickReply = async (option) => {
    addMessage({ sender: "user", text: option });
    setIsLoading(true);

    // Pequeño delay de experiencia de usuario
    await new Promise((resolve) => setTimeout(resolve, 500));

    if (!isServicesEnabled) {
      addMessage({
        sender: "bot",
        text: "⚠️ Los servicios y trámites interactivos están inhabilitados en este momento."
      });
      setIsLoading(false);
      return;
    }

    // Ejecutar enrutamiento semántico para la opción seleccionada
    const wasRouted = await handleSemanticRouting(option);
    if (!wasRouted) {
      // Si no coincide con un trámite local, enviar a flujo normal de Gemini
      sendMessage(option);
    }
  };

  // Enviar formulario interactivo en el chat (Req 4 y Req 5)
  const submitChatForm = async (formType, formData) => {
    setIsLoading(true);

    try {
      if (formType === "predial") {
        const doc = formData.documento;
        const result = await getPredialInfo(doc);

        addMessage({
          sender: "bot",
          text: `Predio de ${result.propietario} ubicado en ${result.direccion}. Estado: ${result.estado}. Valor: $${result.valor.toLocaleString()}.`,
          attachment: {
            type: "image",
            src: result.productoImagen,
            label: "Predio Registrado",
            fileUrl: result.facturaUrl,
            fileLabel: result.estado === "Pendiente" ? "📥 Descargar Factura PDF" : "📥 Descargar Recibo de Pago"
          }
        });
      } 
      else if (formType === "sisben") {
        const doc = formData.documento;
        const result = await getSisbenInfo(doc);

        addMessage({
          sender: "bot",
          text: `Ciudadano: ${result.nombre}. Clasificación Sisbén IV: Grupo ${result.grupo} (${result.clasificacion}). Actualizado el ${result.ultimaActualizacion}.`,
          attachment: {
            type: "image",
            src: result.imagenGrupo,
            label: `Certificado Grupo ${result.grupo}`,
            fileUrl: result.certificadoUrl,
            fileLabel: "📥 Descargar Certificado de Afiliación PDF"
          }
        });
      } 
      else if (formType === "rpa") {
        // Ejecución de logs animados de RPA en el chat
        addMessage({
          sender: "system",
          text: "🤖 Iniciando robot RPA para compilación de reporte..."
        });

        const rpaResult = await runRpaProcess(formData, (logStep) => {
          // Callback para cada paso de RPA
          setMessages((prev) => [
            ...prev,
            {
              id: Math.random().toString(36).substr(2, 9),
              sender: "system",
              text: logStep,
              timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            }
          ]);
        });

        // Gemini responde en lenguaje natural la confirmación final de forma muy corta (Req 4 + Req 3)
        const systemMessageRpa = `El robot de RPA ha terminado con éxito. Detalle: ${rpaResult.message}.`;
        const geminiRpaText = await queryGemini(
          [{ sender: "system", text: systemMessageRpa }, { sender: "user", text: "Dame confirmación final del RPA." }],
          apiKey
        );

        if (geminiRpaText.tokensUsed) {
          logTokenUsage(`Confirmación RPA (${formData.periodo})`, geminiRpaText.tokensUsed, geminiRpaText.savedTokens);
          setTokensUsedTotal((prev) => prev + geminiRpaText.tokensUsed);
          setTokensSavedTotal((prev) => prev + geminiRpaText.savedTokens);
        }

        addMessage({
          sender: "bot",
          text: geminiRpaText.text,
          attachment: {
            type: "file",
            fileUrl: rpaResult.fileUrl,
            fileLabel: `📥 Descargar ${rpaResult.fileName}`
          }
        });
      }
    } catch (error) {
      addMessage({
        sender: "bot",
        text: `❌ Error: ${error.message}`
      });
    } finally {
      setIsLoading(false);
      // Siempre devolver las opciones rápidas al finalizar un flujo de formulario
      setTimeout(() => {
        const replies = isServicesEnabled 
          ? config.quickReplies.map(reply => reply.label)
          : null;

        addMessage({
          sender: "bot",
          text: isServicesEnabled 
            ? "¿Te puedo ayudar con algo más? Escribe tu duda o selecciona una opción rápida:"
            : "¿Te puedo ayudar con algo más?",
          quickReplies: replies
        });
      }, 1000);
    }
  };

  const openChat = () => setIsOpen(true);
  const closeChat = () => setIsOpen(false);
  const toggleChat = () => setIsOpen(!isOpen);
 
  return (
    <ChatContext.Provider
      value={{
        isOpen,
        messages,
        isTextInputEnabled,
        apiKey,
        tokensSavedTotal,
        tokensUsedTotal,
        isLoading,
        openChat,
        closeChat,
        toggleChat,
        sendMessage,
        selectQuickReply,
        submitChatForm,
        updateApiKey,
        resetChat: initChat,
        isGeminiEnabled,
        setIsGeminiEnabled,
        isServicesEnabled,
        setIsServicesEnabled
      }}
    >
      {children}
    </ChatContext.Provider>
  );
};
